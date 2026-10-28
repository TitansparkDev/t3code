// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Checks whether an assignment is ready before dispatching a worker.
 * @module preflight
 */
import { artifactPathsOverlap } from "./artifactPaths.ts";
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  DEFAULT_BRANCH_PREFIX,
  capabilityAvailable,
  expandCommand,
  prefixesInUse,
  runShell,
  toolAvailable,
  type GuardSpec,
  type LoadedContract,
  type ToolSpec,
} from "./contract.ts";
import type { FailureClass } from "./failures.ts";
import { parseStoredSpec, type VerificationSpec } from "./verificationSpec.ts";
import { renameBranch, sanitizeBranchName } from "./worktreeManager.ts";

export interface PreflightFinding {
  readonly level: "error" | "warning";
  readonly failureClass: FailureClass;
  readonly code:
    | "worktree-invalid"
    | "branch-guard"
    | "tool-missing"
    | "tool-optional"
    | "capability-unavailable"
    | "artifact-prerequisite"
    | "baseline-missing"
    | "scope-unclear"
    | "contract-invalid"
    | "worktree-shared";
  readonly message: string;
}

export interface ExpandedGuard {
  readonly name: string;
  readonly phase: GuardSpec["phase"];
  readonly command: string;
}

export interface PreflightResult {
  readonly ok: boolean;
  readonly findings: ReadonlyArray<PreflightFinding>;
  /** Automatic corrections made while checking (a branch renamed, a tool installed). */
  readonly repairs: ReadonlyArray<string>;
  /** The branch the worktree is on after any rename. */
  readonly branch: string;
  readonly guards: ReadonlyArray<ExpandedGuard>;
  readonly optionalToolsMissing: ReadonlyArray<string>;
}

function gitOut(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

interface PreflightTaskRow {
  readonly id: string;
  readonly status: string;
  readonly dependencies: string;
  readonly verification_spec: string | null;
  readonly verification_command: string | null;
}

interface ArtifactProducer {
  readonly taskId: string;
  readonly checkId: string | undefined;
  readonly path: string;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${NodePath.sep}`) && relative !== "..");
}

function artifactExists(root: string, pattern: string): boolean {
  let candidates: string[];
  try {
    candidates = /[*?]/.test(pattern)
      ? NodeFS.globSync(pattern, { cwd: root })
      : NodeFS.existsSync(NodePath.resolve(root, pattern))
        ? [pattern]
        : [];
    const realRoot = NodeFS.realpathSync(root);
    return candidates.some((candidate) => {
      const resolved = NodePath.resolve(root, candidate);
      if (!pathWithin(root, resolved)) return false;
      try {
        return pathWithin(realRoot, NodeFS.realpathSync(resolved));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function parseDependencies(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function artifactPreflightFindings(input: {
  readonly db: NodeSqlite.DatabaseSync;
  readonly repoRoot: string;
  readonly taskId: string;
  readonly dependencies: ReadonlyArray<string>;
  readonly spec: VerificationSpec;
}): PreflightFinding[] {
  const current = input.db.prepare("SELECT plan_id FROM tasks WHERE id = ?").get(input.taskId) as
    | { plan_id: string | null }
    | undefined;
  const rows = current?.plan_id
    ? (input.db
        .prepare(
          `SELECT id, status, dependencies, verification_spec, verification_command
             FROM tasks WHERE plan_id = ?`,
        )
        .all(current.plan_id) as PreflightTaskRow[])
    : [];
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const ancestorCache = new Map<string, Set<string>>();
  const ancestors = (id: string, active = new Set<string>()): Set<string> => {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    if (active.has(id)) return new Set();
    const next = new Set(active).add(id);
    const result = new Set<string>();
    for (const dependency of parseDependencies(byId.get(id)?.dependencies ?? "[]")) {
      result.add(dependency);
      for (const ancestor of ancestors(dependency, next)) result.add(ancestor);
    }
    ancestorCache.set(id, result);
    return result;
  };
  const taskDependencies = new Set([...input.dependencies, ...ancestors(input.taskId)]);
  const specs = new Map<string, VerificationSpec>(
    rows.map(
      (row) => [row.id, parseStoredSpec(row.verification_spec, row.verification_command)] as const,
    ),
  );
  specs.set(input.taskId, input.spec);
  const producerRows = rows.some((row) => row.id === input.taskId)
    ? rows
    : [
        ...rows,
        {
          id: input.taskId,
          status: "",
          dependencies: "[]",
          verification_spec: null,
          verification_command: null,
        },
      ];
  const producers: ArtifactProducer[] = producerRows.flatMap((row) =>
    (specs.get(row.id)?.checks ?? []).flatMap((check) =>
      (check.produces ?? []).map((path) => ({ taskId: row.id, checkId: check.id, path })),
    ),
  );
  const checkMap = new Map(
    input.spec.checks.flatMap((check) => (check.id ? [[check.id, check] as const] : [])),
  );
  const checkDependsOn = (consumerId: string | undefined, producerId: string | undefined) => {
    if (!consumerId || !producerId) return false;
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      for (const dependency of checkMap.get(id)?.dependsOn ?? []) {
        if (dependency === producerId || visit(dependency)) return true;
      }
      return false;
    };
    return visit(consumerId);
  };
  const findings: PreflightFinding[] = [];
  for (const check of input.spec.checks) {
    for (const consumed of check.consumes ?? []) {
      const present = artifactExists(input.repoRoot, consumed);
      const candidates = producers.filter(
        (producer) =>
          !(
            producer.taskId === input.taskId &&
            producer.checkId !== undefined &&
            producer.checkId === check.id
          ) && artifactPathsOverlap(producer.path, consumed),
      );
      if (candidates.length > 1) {
        findings.push({
          level: "error",
          failureClass: "prerequisite",
          code: "artifact-prerequisite",
          message: `Check ${check.id ?? "(unnamed)"} consumes ${consumed}, which has multiple declared producers.`,
        });
        continue;
      }
      const producer = candidates[0];
      if (!producer) {
        if (!present) {
          findings.push({
            level: "error",
            failureClass: "prerequisite",
            code: "artifact-prerequisite",
            message: `Check ${check.id ?? "(unnamed)"} consumes ${consumed}, which is missing and has no declared producer.`,
          });
        }
        continue;
      }
      if (producer.taskId === input.taskId) {
        if (!checkDependsOn(check.id, producer.checkId)) {
          findings.push({
            level: "error",
            failureClass: "prerequisite",
            code: "artifact-prerequisite",
            message: `Check ${check.id ?? "(unnamed)"} consumes ${consumed}, but does not depend on its producer check.`,
          });
        }
        continue;
      }
      if (!taskDependencies.has(producer.taskId)) {
        findings.push({
          level: "error",
          failureClass: "prerequisite",
          code: "artifact-prerequisite",
          message: `Check ${check.id ?? "(unnamed)"} consumes ${consumed} from ${producer.taskId}, which is not a task dependency.`,
        });
        continue;
      }
      if (byId.get(producer.taskId)?.status !== "completed" || present) continue;
      findings.push({
        level: "error",
        failureClass: "prerequisite",
        code: "artifact-prerequisite",
        message: `Check ${check.id ?? "(unnamed)"} expects ${consumed} from completed producer ${producer.taskId}, but it is missing from the task baseline.`,
      });
    }
  }
  return findings;
}

const profileFile = (gitCommonDir: string) =>
  NodePath.join(gitCommonDir, "agentqueue", "profile.json");

/** The branch prefix that last passed this repository's own guards (learned, never assumed). */
export function learnedPrefix(gitCommonDir: string): string | null {
  try {
    const value = JSON.parse(NodeFS.readFileSync(profileFile(gitCommonDir), "utf8")) as {
      branchPrefix?: string;
    };
    return typeof value.branchPrefix === "string" ? value.branchPrefix : null;
  } catch {
    return null;
  }
}

function rememberPrefix(gitCommonDir: string, branchPrefix: string): void {
  try {
    NodeFS.mkdirSync(NodePath.dirname(profileFile(gitCommonDir)), { recursive: true });
    NodeFS.writeFileSync(
      profileFile(gitCommonDir),
      JSON.stringify({ branchPrefix, learnedAt: new Date().toISOString() }),
    );
  } catch {
    // Learned facts are an optimisation; the next preflight can learn them again.
  }
}

/** Prefixes to try, in order: what the contract fixes, what last worked, what the repository already uses. */
export function candidatePrefixes(
  loaded: LoadedContract,
  gitCommonDir: string,
  repoRoot: string,
): string[] {
  const learned = learnedPrefix(gitCommonDir);
  const guarded = loaded.contract.guards.some((g) => g.phase === "start" && !g.optional);
  // Only a repository with a guard has a reason to prefer one naming scheme over the default.
  const ordered =
    loaded.explicitPrefixes || !guarded
      ? [...loaded.contract.branchPrefixes]
      : [
          ...(learned ? [learned] : []),
          ...loaded.contract.branchPrefixes.filter((prefix) => prefix !== DEFAULT_BRANCH_PREFIX),
          ...prefixesInUse(repoRoot).filter(
            (prefix) => !/^(agentqueue|main|master|release|hotfix|feature|fix)\//.test(prefix),
          ),
          DEFAULT_BRANCH_PREFIX,
        ];
  return [...new Set(ordered)];
}

export interface GuardVariables {
  readonly taskId: string;
  readonly branch: string;
  readonly base: string;
  readonly worktree: string;
  readonly allowedPaths: ReadonlyArray<string>;
}

function runGuards(
  guards: ReadonlyArray<GuardSpec>,
  phase: GuardSpec["phase"],
  vars: GuardVariables,
  env: Readonly<Record<string, string>> = {},
): { readonly failed: { readonly guard: GuardSpec; readonly output: string } | null } {
  for (const guard of guards) {
    if (guard.phase !== phase) continue;
    const result = runShell(expandCommand(guard.run, vars), vars.worktree, { env });
    if (result.code !== 0 && !guard.optional) return { failed: { guard, output: result.output } };
  }
  return { failed: null };
}

/** What the worker should run itself, with this task's values filled in. */
export function expandGuards(loaded: LoadedContract, vars: GuardVariables): ExpandedGuard[] {
  return loaded.contract.guards.map((guard) => ({
    name: guard.name,
    phase: guard.phase,
    command: expandCommand(guard.run, vars),
  }));
}

/**
 * Finds a branch prefix the repository's guards accept by really trying one. A throwaway
 * worktree on a probe branch is created for each candidate, the start guards run in it, and
 * everything is removed again. The first prefix that passes is remembered.
 */
export function probeBranchPrefix(input: {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly baseRef: string;
  readonly loaded: LoadedContract;
}): {
  readonly prefix: string | null;
  readonly tried: ReadonlyArray<string>;
  readonly detail: string;
} {
  const startGuards = input.loaded.contract.guards.filter(
    (g) => g.phase === "start" && !g.optional,
  );
  const candidates = candidatePrefixes(input.loaded, input.gitCommonDir, input.repoRoot);
  if (startGuards.length === 0) {
    const prefix = candidates[0] ?? DEFAULT_BRANCH_PREFIX;
    return { prefix, tried: [], detail: "the repository declares no branch guard" };
  }
  const tried: string[] = [];
  let lastOutput = "";
  for (const prefix of candidates) {
    tried.push(prefix);
    const branch = `${prefix}aq-probe-${process.pid}-${Date.now()}`;
    const dir = NodePath.join(input.repoRoot, ".worktrees", "agentqueue-probe");
    gitOut(input.repoRoot, ["worktree", "remove", "--force", dir]);
    gitOut(input.repoRoot, ["worktree", "prune"]);
    if (gitOut(input.repoRoot, ["worktree", "add", "-b", branch, dir, input.baseRef]).code !== 0)
      continue;
    try {
      const outcome = runGuards(startGuards, "start", {
        taskId: "probe",
        branch,
        base: input.baseRef,
        worktree: dir,
        allowedPaths: [],
      });
      if (outcome.failed === null) {
        if (!input.loaded.explicitPrefixes) rememberPrefix(input.gitCommonDir, prefix);
        return {
          prefix,
          tried,
          detail: `accepted by ${startGuards.map((g) => g.name).join(", ")}`,
        };
      }
      lastOutput = outcome.failed.output;
    } finally {
      gitOut(input.repoRoot, ["worktree", "remove", "--force", dir]);
      gitOut(input.repoRoot, ["branch", "-D", branch]);
      gitOut(input.repoRoot, ["worktree", "prune"]);
    }
  }
  return {
    prefix: null,
    tried,
    detail: `no branch prefix passes the repository's guard (tried ${tried.join(", ")}): ${lastOutput.slice(-300)}`,
  };
}

/** The executables a verification spec needs: the first word of every command segment. */
export function executablesOf(spec: VerificationSpec): string[] {
  const names = new Set<string>();
  for (const check of spec.checks) {
    for (const segment of check.run.split(/&&|\|/)) {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
      const first = words[0];
      if (
        first &&
        !first.startsWith("./") &&
        !first.includes("/") &&
        first !== "cd" &&
        first !== "test" &&
        first !== "true"
      ) {
        names.add(first);
      }
    }
  }
  return [...names];
}

/** `[host]`-style tags at the end of a task title. */
export function titleTags(title: string): string[] {
  return [...title.matchAll(/\[([A-Za-z][\w-]*)\]/g)].map((match) => match[1]!.toLowerCase());
}

export interface TaskPreflightInput {
  readonly db: NodeSqlite.DatabaseSync;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  /** The branch the task starts from (the plan's integration branch). */
  readonly baseRef: string;
  readonly loaded: LoadedContract;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly scope: ReadonlyArray<string>;
    readonly dependencies: ReadonlyArray<string>;
    readonly verification_spec: string | null;
    readonly verification_command: string | null;
  };
  readonly worktreePath: string;
  readonly branch: string;
  readonly claimToken: string;
  readonly allowedPaths: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  /** Tool availability already established in this pass. */
  readonly toolCache?: Map<string, boolean>;
}

/** Whether a task may be handed out at all, before any worktree exists. */
export function assignabilityFindings(input: {
  readonly loaded: LoadedContract;
  readonly repoRoot: string;
  readonly title: string;
  readonly capabilityCache?: Map<string, boolean>;
}): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  for (const tag of titleTags(input.title)) {
    if (!input.loaded.contract.capabilities[tag]) continue;
    let available = input.capabilityCache?.get(tag);
    if (available === undefined) {
      available = capabilityAvailable(input.loaded.contract, tag, input.repoRoot).available;
      input.capabilityCache?.set(tag, available);
    }
    if (!available) {
      const capability = input.loaded.contract.capabilities[tag]!;
      findings.push({
        level: "error",
        failureClass: "external",
        code: "capability-unavailable",
        message: `Needs the "${tag}" capability${capability.description ? ` (${capability.description})` : ""}, which this environment does not currently provide.`,
      });
    }
  }
  return findings;
}

export function preflightAssignment(input: TaskPreflightInput): PreflightResult {
  const findings: PreflightFinding[] = [];
  const repairs: string[] = [];
  let branch = input.branch;
  const error = (code: PreflightFinding["code"], failureClass: FailureClass, message: string) =>
    findings.push({ level: "error", failureClass, code, message });
  const warn = (code: PreflightFinding["code"], failureClass: FailureClass, message: string) =>
    findings.push({ level: "warning", failureClass, code, message });

  for (const problem of input.loaded.problems) warn("contract-invalid", "configuration", problem);

  // 1. The worktree is a real, linked, correctly named checkout that nobody else owns.
  const top = gitOut(input.worktreePath, ["rev-parse", "--show-toplevel"]);
  const actual = gitOut(input.worktreePath, ["branch", "--show-current"]);
  if (
    top.code !== 0 ||
    NodeFS.realpathSync(top.stdout) !== NodeFS.realpathSync(input.worktreePath)
  ) {
    error("worktree-invalid", "configuration", `${input.worktreePath} is not a git worktree root.`);
  } else if (!NodeFS.statSync(NodePath.join(input.worktreePath, ".git")).isFile()) {
    error(
      "worktree-invalid",
      "configuration",
      `${input.worktreePath} is not a linked worktree (it has its own .git directory).`,
    );
  } else if (actual.stdout === "") {
    error("worktree-invalid", "configuration", `${input.worktreePath} is on a detached HEAD.`);
  } else if (actual.stdout !== branch) {
    branch = actual.stdout;
  }
  const sharing = input.db
    .prepare(
      `SELECT task_id FROM task_claims WHERE released_at IS NULL AND owner_token != ?
         AND (worktree_path = ? OR branch = ?)`,
    )
    .all(input.claimToken, input.worktreePath, branch) as Array<{ task_id: string }>;
  if (sharing.length > 0) {
    error(
      "worktree-shared",
      "configuration",
      `${input.worktreePath} or ${branch} is already owned by ${sharing.map((s) => s.task_id).join(", ")}.`,
    );
  }
  if (findings.some((f) => f.level === "error")) {
    return { ok: false, findings, repairs, branch, guards: [], optionalToolsMissing: [] };
  }

  const spec = parseStoredSpec(input.task.verification_spec, input.task.verification_command);
  findings.push(
    ...artifactPreflightFindings({
      db: input.db,
      repoRoot: input.worktreePath,
      taskId: input.task.id,
      dependencies: input.task.dependencies,
      spec,
    }),
  );
  if (findings.some((finding) => finding.level === "error")) {
    return { ok: false, findings, repairs, branch, guards: [], optionalToolsMissing: [] };
  }

  // 2. The repository's own start guards accept the branch; if not, find a prefix they accept.
  const vars = (name: string): GuardVariables => ({
    taskId: input.task.id,
    branch: name,
    base: input.baseRef,
    worktree: input.worktreePath,
    allowedPaths: input.allowedPaths,
  });
  const startGuards = input.loaded.contract.guards.filter(
    (g) => g.phase === "start" && !g.optional,
  );
  const outcome = runGuards(startGuards, "start", vars(branch), input.env);
  const rejected = outcome.failed;
  if (rejected) {
    const original = branch;
    const tried: string[] = [];
    let fixed = false;
    if (rejected.guard.branchSensitive) {
      for (const prefix of candidatePrefixes(input.loaded, input.gitCommonDir, input.repoRoot)) {
        const name = sanitizeBranchName(input.task.id, input.task.title, prefix);
        if (name === original) continue;
        tried.push(prefix);
        if (!renameBranch(input.repoRoot, branch, name)) continue;
        const retry = runGuards(startGuards, "start", vars(name), input.env);
        if (retry.failed === null) {
          repairs.push(
            `renamed branch ${original} to ${name} so ${rejected.guard.name} accepts it`,
          );
          if (!input.loaded.explicitPrefixes) rememberPrefix(input.gitCommonDir, prefix);
          branch = name;
          fixed = true;
          break;
        }
        renameBranch(input.repoRoot, name, branch);
      }
    }
    if (!fixed) {
      error(
        "branch-guard",
        "configuration",
        `The repository guard "${rejected.guard.name}" rejects this assignment${tried.length ? ` (branch prefixes tried: ${tried.join(", ")})` : ""}: ${rejected.output.slice(-400)}`,
      );
    }
  }

  // 3. Tools the task's checks need exist (or the repository allows installing them).
  const optionalToolsMissing: string[] = [];
  const declared = new Map<string, ToolSpec>(
    input.loaded.contract.tools.map((tool) => [tool.name, tool]),
  );
  for (const name of new Set([...executablesOf(spec), ...declared.keys()])) {
    const tool = declared.get(name) ?? { name, probe: null, optional: false, install: null };
    let present = input.toolCache?.get(name);
    if (present === undefined) {
      present = toolAvailable(tool, input.worktreePath);
      if (!present && tool.install) {
        const installed = runShell(tool.install, input.worktreePath, { timeoutMs: 600_000 });
        present = installed.code === 0 && toolAvailable(tool, input.worktreePath);
        if (present) repairs.push(`installed ${name}`);
      }
      input.toolCache?.set(name, present);
    }
    if (present) continue;
    if (tool.optional) {
      optionalToolsMissing.push(name);
      warn("tool-optional", "prerequisite", `Optional tool "${name}" is not available here.`);
    } else if (executablesOf(spec).includes(name)) {
      error(
        "tool-missing",
        "prerequisite",
        `The task's checks need "${name}", which is not installed in this environment.`,
      );
    } else {
      error(
        "tool-missing",
        "prerequisite",
        `The repository requires the tool "${name}", which is not installed.`,
      );
    }
  }

  // 4. Dependencies are really in the base this worker starts from.
  const baseTip = gitOut(input.repoRoot, ["rev-parse", `refs/heads/${input.baseRef}`]).stdout;
  for (const dependency of input.task.dependencies) {
    const landed = input.db
      .prepare(
        "SELECT commit_hash FROM landing_queue WHERE task_id = ? AND status = 'landed' ORDER BY id DESC LIMIT 1",
      )
      .get(dependency) as { commit_hash: string | null } | undefined;
    if (!landed?.commit_hash || !baseTip) continue; // ticked by hand in the plan: nothing recorded to compare
    if (
      gitOut(input.repoRoot, ["merge-base", "--is-ancestor", landed.commit_hash, baseTip]).code !==
      0
    ) {
      error(
        "baseline-missing",
        "configuration",
        `Dependency ${dependency} is recorded as landed but its commit ${landed.commit_hash.slice(0, 9)} is not on ${input.baseRef}.`,
      );
    }
  }

  if (input.task.scope.length === 0) {
    warn(
      "scope-unclear",
      "scope",
      "The task declares no scope, so its changes are not audited against one.",
    );
  }

  const errors = findings.some((f) => f.level === "error");
  return {
    ok: !errors,
    findings,
    repairs,
    branch,
    guards: errors ? [] : expandGuards(input.loaded, vars(branch)),
    optionalToolsMissing,
  };
}
