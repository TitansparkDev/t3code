// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * From "the worker is done" to "the work is on the base branch".
 *
 * A worker's finished work becomes a *candidate*: the task keeps status `verifying`
 * and an `integration_state` of `pending` (waiting to merge), `conflict` (a repair
 * worker must resolve it), `repairing` (one is on it) or `repair_needed` (automatic
 * repair ran out of attempts). A candidate is never mistaken for unfinished work and
 * its commits are never discarded.
 *
 * Integration happens in a dedicated staging worktree, so the shared checkout is only
 * touched for the final fast-forward, and only when that cannot overwrite anything it
 * has uncommitted. Nothing in the shared checkout is ever reset, stashed or cleaned.
 *
 * @module integration
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { recordEvent } from "./eventStream.ts";
import { releaseClaim, renewLease } from "./claimService.ts";
import {
  expandCommand,
  loadContract,
  matchesAny,
  resourcesNeededBy,
  runShell,
  type RepoContract,
} from "./contract.ts";
import {
  classifyReason,
  decideAfterFailure,
  failureSignature,
  recordFailure,
  type FailureClass,
  type FailureDecision,
} from "./failures.ts";
import {
  auditScope,
  changedPaths,
  decideScope,
  storedAmendments,
  type AmendmentOutcome,
  type ScopeRequest,
} from "./scopeAudit.ts";
import { attributeFailure } from "./baseline.ts";
import { ResourceWaitError } from "./resourceRunner.ts";
import { addFollowUpTask } from "./overseerRepairs.ts";
import { ensureSlot, taskEnvironment } from "./taskEnvironment.ts";
import { parseStoredSpec, runSpec, type SpecResult } from "./verificationSpec.ts";
import { commitPendingChanges } from "./worktreeManager.ts";

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function git(cwd: string, args: ReadonlyArray<string>): GitResult {
  try {
    const stdout = NodeChildProcess.execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error: any) {
    return {
      code: error.status ?? 1,
      stdout: (error.stdout?.toString() ?? "").trim(),
      stderr: (error.stderr?.toString() ?? error.message ?? "").trim(),
    };
  }
}

const IDENTITY = ["-c", "user.name=AgentQueue", "-c", "user.email=agentqueue@localhost"] as const;

/**
 * Holds the repository's landing lock. It is the same `flock` that `plan-work land`
 * takes on `plan-work-landing.lock`, so AgentQueue and legacy workers never land at the
 * same moment. Without a `flock` binary a private lock file is used instead.
 */
export async function acquireLandingLock(
  gitCommonDir: string,
  timeoutMs = 60_000,
): Promise<() => void> {
  const lockFile = NodePath.join(gitCommonDir, "plan-work-landing.lock");
  const helper = NodeChildProcess.spawn(
    "flock",
    [
      "-x",
      "-w",
      String(Math.ceil(timeoutMs / 1000)),
      lockFile,
      "sh",
      "-c",
      "echo locked; exec cat",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const acquired = await new Promise<"locked" | "timeout" | "missing">((resolve) => {
    helper.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ENOENT" ? "missing" : "timeout"),
    );
    helper.once("exit", () => resolve("timeout"));
    helper.stdout!.once("data", (chunk) =>
      resolve(chunk.toString().includes("locked") ? "locked" : "timeout"),
    );
  });
  if (acquired === "locked") {
    return () => {
      helper.stdin!.end();
      helper.kill();
    };
  }
  helper.kill();
  if (acquired === "timeout") {
    throw new Error(`Timed out waiting for the landing lock at ${lockFile}`);
  }
  // No flock binary: fall back to an exclusive-create lock of our own.
  const own = NodePath.join(gitCommonDir, "agentqueue", "landing.lock");
  NodeFS.mkdirSync(NodePath.dirname(own), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      NodeFS.closeSync(NodeFS.openSync(own, "wx"));
      return () => {
        try {
          NodeFS.unlinkSync(own);
        } catch {
          // Already gone.
        }
      };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for the landing lock at ${own}`);
}

function currentBranchHead(repoRoot: string, baseBranch: string): string {
  const result = git(repoRoot, ["rev-parse", `refs/heads/${baseBranch}`]);
  if (result.code !== 0) throw new Error(`Base branch ${baseBranch} does not exist.`);
  return result.stdout;
}

function checkedOutAt(repoRoot: string, branch: string): string | null {
  const listing = git(repoRoot, ["worktree", "list", "--porcelain"]).stdout;
  let path: string | null = null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

/** Paths with uncommitted changes (modified, staged, deleted or untracked). */
function dirtyPaths(cwd: string): string[] {
  // Not trimmed: the first status column may be a space.
  let out = "";
  try {
    out = NodeChildProcess.execFileSync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    out = "";
  }
  const paths: string[] = [];
  const entries = out.split("\0").filter(Boolean);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    paths.push(entry.slice(3));
    // A rename lists the old path as a second entry.
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}

const stagingPath = (repoRoot: string) =>
  NodePath.join(repoRoot, ".worktrees", "agentqueue-staging");

/** Our own throwaway worktree for merging and validating. Safe to reset: it holds no one's work. */
export function prepareStagingWorktree(repoRoot: string, baseOid: string): string {
  const path = stagingPath(repoRoot);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  git(repoRoot, ["worktree", "prune"]);
  const registered = git(repoRoot, ["worktree", "list", "--porcelain"]).stdout.includes(
    `worktree ${path}\n`,
  );
  if (!registered || !NodeFS.existsSync(path)) {
    if (NodeFS.existsSync(path)) NodeFS.rmSync(path, { recursive: true, force: true });
    const added = git(repoRoot, ["worktree", "add", "--detach", path, baseOid]);
    if (added.code !== 0) throw new Error(`Could not create the staging worktree: ${added.stderr}`);
    return path;
  }
  git(path, ["merge", "--abort"]);
  git(path, ["rebase", "--abort"]);
  const reset = git(path, ["checkout", "--force", "--detach", baseOid]);
  if (reset.code !== 0) throw new Error(`Could not reset the staging worktree: ${reset.stderr}`);
  git(path, ["clean", "-fdx"]);
  return path;
}

/** The branch a plan integrates into: only AgentQueue writes it, no checkout ever has it open. */
export function integrationBranchFor(planId: string): string {
  return `agentqueue/goal/${planId.replace(/^plan_/, "").replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

/**
 * Make sure the plan's integration branch exists. A new branch starts at the target
 * branch. An existing one that holds nothing the target lacks follows the target forward,
 * so workers start from current code; one with integrated work is left exactly as it is.
 */
export function ensureIntegrationBranch(
  repoRoot: string,
  baseBranch: string,
  integrationBranch: string,
): string {
  const baseOid = git(repoRoot, ["rev-parse", `refs/heads/${baseBranch}`]);
  if (baseOid.code !== 0) throw new Error(`Base branch ${baseBranch} does not exist.`);
  const ref = `refs/heads/${integrationBranch}`;
  const existing = git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (existing.code !== 0) {
    const created = git(repoRoot, ["update-ref", ref, baseOid.stdout, ""]);
    if (created.code !== 0)
      throw new Error(`Could not create ${integrationBranch}: ${created.stderr}`);
    return baseOid.stdout;
  }
  if (git(repoRoot, ["merge-base", "--is-ancestor", existing.stdout, baseOid.stdout]).code === 0) {
    git(repoRoot, ["update-ref", ref, baseOid.stdout, existing.stdout]);
    return baseOid.stdout;
  }
  return existing.stdout;
}

/**
 * Brings the target branch's newer commits into the plan's integration branch when they
 * merge cleanly. Without this a fix made to the target branch (a guard script, a hook, a
 * contract) can never reach the workers, who start from the integration branch. A conflict
 * changes nothing and is reported; the publication step meets it later with full context.
 */
export async function syncIntegrationBranch(
  repoRoot: string,
  gitCommonDir: string,
  targetBranch: string,
  integrationBranch: string,
): Promise<{
  readonly kind: "current" | "merged" | "conflict" | "skipped";
  readonly files?: ReadonlyArray<string>;
}> {
  const target = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}`]);
  const tip = git(repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/heads/${integrationBranch}`,
  ]);
  if (target.code !== 0 || tip.code !== 0) return { kind: "skipped" };
  if (git(repoRoot, ["merge-base", "--is-ancestor", target.stdout, tip.stdout]).code === 0) {
    return { kind: "current" };
  }
  const release = await acquireLandingLock(gitCommonDir);
  try {
    const goalTip = git(repoRoot, ["rev-parse", `refs/heads/${integrationBranch}`]).stdout;
    const targetTip = git(repoRoot, ["rev-parse", `refs/heads/${targetBranch}`]).stdout;
    if (git(repoRoot, ["merge-base", "--is-ancestor", targetTip, goalTip]).code === 0)
      return { kind: "current" };
    const staging = prepareStagingWorktree(repoRoot, goalTip);
    const merge = git(staging, [
      ...IDENTITY,
      "merge",
      "--no-edit",
      "-m",
      `AgentQueue: bring ${targetBranch} into ${integrationBranch}`,
      targetTip,
    ]);
    if (merge.code !== 0) {
      const files = git(staging, ["diff", "--name-only", "--diff-filter=U"])
        .stdout.split("\n")
        .filter(Boolean);
      git(staging, ["merge", "--abort"]);
      return { kind: "conflict", files };
    }
    const result = git(staging, ["rev-parse", "HEAD"]).stdout;
    const moved = git(repoRoot, [
      "update-ref",
      "-m",
      `AgentQueue: sync ${targetBranch}`,
      `refs/heads/${integrationBranch}`,
      result,
      goalTip,
    ]);
    return moved.code === 0 ? { kind: "merged" } : { kind: "skipped" };
  } finally {
    release();
  }
}

/**
 * Settles a merge's conflicts in generated files by the contract's rule (rebuild them with the
 * repository's own generator, or take the integration branch's copy). Returns what it settled
 * and what is left for a person's judgement.
 */
export function resolveGeneratedConflicts(
  staging: string,
  contract: RepoContract,
  conflicted: ReadonlyArray<string>,
): { readonly resolved: string[]; readonly remaining: string[] } {
  const resolved: string[] = [];
  const remaining: string[] = [];
  const toRegenerate = new Set<string>();
  for (const file of conflicted) {
    const rule = contract.generated.find((candidate) => matchesAny(file, candidate.paths));
    if (!rule) {
      remaining.push(file);
      continue;
    }
    if (rule.onConflict === "regenerate" && rule.regenerate) toRegenerate.add(rule.regenerate);
    // "ours" is the integration branch the staging worktree sits on.
    const taken = git(staging, ["checkout", "--ours", "--", file]);
    if (taken.code !== 0 && git(staging, ["rm", "--quiet", "--", file]).code !== 0) {
      remaining.push(file);
      continue;
    }
    git(staging, ["add", "--", file]);
    resolved.push(file);
  }
  if (remaining.length > 0) return { resolved, remaining };
  for (const command of toRegenerate) {
    const ran = runShell(command, staging, { timeoutMs: 120_000 });
    if (ran.code !== 0) return { resolved: [], remaining: [...conflicted] };
    for (const rule of contract.generated) {
      if (rule.regenerate === command)
        for (const path of rule.paths) git(staging, ["add", "--", path]);
    }
  }
  return { resolved, remaining };
}

/**
 * Conflicts in files the contract lists as union-merged keep both sides' lines. Correctness is
 * not assumed: the caller's checks run on the merged result before anything moves.
 */
export function resolveUnionConflicts(
  staging: string,
  contract: RepoContract,
  conflicted: ReadonlyArray<string>,
): { readonly resolved: string[]; readonly remaining: string[] } {
  const resolved: string[] = [];
  const remaining: string[] = [];
  for (const file of conflicted) {
    if (!matchesAny(file, contract.unionMerge)) {
      remaining.push(file);
      continue;
    }
    // Exact bytes of each side (git() trims its output, which would eat a file's last newline).
    const stage = (n: 1 | 2 | 3) => {
      const shown = NodeChildProcess.spawnSync("git", ["show", `:${n}:${file}`], {
        cwd: staging,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return { code: shown.status ?? 1, stdout: shown.stdout ?? "" };
    };
    const [base, ours, theirs] = [stage(1), stage(2), stage(3)];
    if (ours.code !== 0 || theirs.code !== 0) {
      remaining.push(file); // deleted on one side: that is a decision, not a union
      continue;
    }
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-union-"));
    try {
      NodeFS.writeFileSync(NodePath.join(dir, "ours"), ours.stdout);
      NodeFS.writeFileSync(NodePath.join(dir, "base"), base.code === 0 ? base.stdout : "");
      NodeFS.writeFileSync(NodePath.join(dir, "theirs"), theirs.stdout);
      const merged = NodeChildProcess.spawnSync(
        "git",
        ["merge-file", "--union", "-p", "ours", "base", "theirs"],
        { cwd: dir, encoding: "utf8" },
      );
      if (merged.status === null || merged.status < 0 || merged.stdout === undefined) {
        remaining.push(file);
        continue;
      }
      NodeFS.writeFileSync(NodePath.join(staging, file), merged.stdout);
      git(staging, ["add", "--", file]);
      resolved.push(file);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  }
  return { resolved, remaining };
}

/** Everything a merge conflict can be settled by rule: generated files, then union-merged files. */
export function resolveMechanicalConflicts(
  staging: string,
  contract: RepoContract,
  conflicted: ReadonlyArray<string>,
): { readonly resolved: string[]; readonly remaining: string[] } {
  const union = resolveUnionConflicts(staging, contract, conflicted);
  const generated = resolveGeneratedConflicts(staging, contract, union.remaining);
  return {
    resolved: [...union.resolved, ...generated.resolved],
    remaining: generated.remaining,
  };
}

export interface RepairMerge {
  /**
   * `conflicted`: a merge of the integration branch is in progress in the worktree with these files
   * unresolved. `merged`: the merge is done (by rule, or cleanly) and only a failing check remains.
   * `up-to-date`: nothing to merge any more. `failed`: the merge could not be started.
   */
  readonly state: "conflicted" | "merged" | "up-to-date" | "failed";
  readonly files: ReadonlyArray<string>;
  readonly settledByRule: ReadonlyArray<string>;
  readonly detail: string;
}

/**
 * Prepares a repair so the task's own worker can finish it: the integration branch is merged into the
 * task's worktree, generated and union-merged files are settled by rule, and whatever is left is
 * left in progress as an ordinary git conflict. The worker resolves exactly that, commits, and
 * resubmits; nothing about it needs to be rediscovered by hand.
 */
export function startRepairMerge(input: {
  readonly worktreePath: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly integrationBranch: string;
  readonly baseBranch: string;
}): RepairMerge {
  const { worktreePath } = input;
  if (git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0) {
    const files = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
      .stdout.split("\n")
      .filter(Boolean);
    return {
      state: files.length > 0 ? "conflicted" : "merged",
      files,
      settledByRule: [],
      detail: "A merge was already in progress.",
    };
  }
  commitPendingChanges(worktreePath, "AgentQueue: keep edits left in the repair worktree");
  const ref = `refs/heads/${input.integrationBranch}`;
  if (git(worktreePath, ["merge-base", "--is-ancestor", ref, "HEAD"]).code === 0) {
    return {
      state: "up-to-date",
      files: [],
      settledByRule: [],
      detail: `${input.integrationBranch} is already merged.`,
    };
  }
  const merge = git(worktreePath, [
    ...IDENTITY,
    "merge",
    "--no-commit",
    "--no-ff",
    "-m",
    `Merge ${input.integrationBranch} into ${NodePath.basename(worktreePath)}`,
    ref,
  ]);
  const unmerged = () =>
    git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
      .stdout.split("\n")
      .filter(Boolean);
  if (merge.code === 0) {
    const committed = git(worktreePath, [...IDENTITY, "commit", "--no-edit"]);
    return committed.code === 0 ||
      git(worktreePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code !== 0
      ? { state: "merged", files: [], settledByRule: [], detail: "The merge was clean." }
      : { state: "failed", files: [], settledByRule: [], detail: committed.stderr.slice(0, 300) };
  }
  const files = unmerged();
  if (files.length === 0) {
    git(worktreePath, ["merge", "--abort"]);
    return { state: "failed", files: [], settledByRule: [], detail: merge.stderr.slice(0, 300) };
  }
  const contract = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: input.gitCommonDir,
    refs: [input.baseBranch, input.integrationBranch],
  }).contract;
  const settled = resolveMechanicalConflicts(worktreePath, contract, files);
  if (settled.remaining.length === 0) {
    const committed = git(worktreePath, [...IDENTITY, "commit", "--no-edit"]);
    if (committed.code === 0) {
      return {
        state: "merged",
        files: [],
        settledByRule: settled.resolved,
        detail: "Conflicts were settled by rule.",
      };
    }
  }
  return {
    state: "conflicted",
    files: unmerged(),
    settledByRule: settled.resolved,
    detail: "Conflicts remain.",
  };
}

/** Unresolved merge state or conflict markers in what a worker is about to hand in. */
export function unresolvedMerge(worktreePath: string, baseRef: string): string[] {
  const files = git(worktreePath, ["diff", "--name-only", "--diff-filter=U"])
    .stdout.split("\n")
    .filter(Boolean);
  if (files.length > 0) return files;
  const markers = git(worktreePath, ["diff", "-U0", `${baseRef}...HEAD`]);
  const seen = new Map<string, Set<string>>();
  let current = "";
  for (const line of markers.stdout.split("\n")) {
    if (line.startsWith("+++ b/")) current = line.slice(6);
    else if (current) {
      const kind = /^\+(<<<<<<< |=======$|>>>>>>> )/.exec(line)?.[1]?.[0];
      if (kind) seen.set(current, (seen.get(current) ?? new Set()).add(kind));
    }
  }
  // A real conflict has all three lines; a file that merely mentions one (a doc, a fixture) is not one.
  return [...seen.entries()].filter(([, kinds]) => kinds.size === 3).map(([file]) => file);
}

export interface SubmitInput {
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly taskId: string;
  readonly claimToken: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly verificationCommand: string;
  readonly gitCommonDir?: string;
  /** The plan's target branch, where the repository contract is read from. */
  readonly targetBranch?: string;
  /** Scope amendments the worker asked for in its final message. */
  readonly scopeRequests?: ReadonlyArray<ScopeRequest>;
}

export type SubmitOutcome =
  | {
      readonly kind: "submitted";
      readonly candidateCommit: string;
      readonly receipt: SpecResult;
      /** Changes outside the declared scope that the contract or an amendment allows. */
      readonly scope: {
        readonly generated: ReadonlyArray<string>;
        readonly supporting: ReadonlyArray<string>;
        readonly amended: ReadonlyArray<string>;
      };
    }
  | { readonly kind: "no-changes" }
  | {
      readonly kind: "verification-failed";
      readonly error: string;
      readonly receipt: SpecResult | null;
      readonly failureClass: FailureClass;
      readonly decision: FailureDecision;
    }
  | {
      readonly kind: "scope-violation";
      readonly error: string;
      readonly paths: ReadonlyArray<string>;
      readonly amendment: AmendmentOutcome | null;
      readonly decision: FailureDecision;
    }
  | {
      /**
       * A file the task needs is held by another running task. Nothing failed: the task is parked
       * with its work kept and starts again when that task no longer holds the file.
       */
      readonly kind: "scope-wait";
      readonly paths: ReadonlyArray<string>;
      readonly waitsFor: ReadonlyArray<string>;
    }
  | {
      /**
       * The checks could not run because a shared resource could not be had (the wait limit passed,
       * or the request was cancelled). Nothing is wrong with the work; it is checked again later and
       * no worker is involved.
       */
      readonly kind: "resource-wait";
      readonly message: string;
    }
  | { readonly kind: "claim-lost" };

/**
 * The worker says it is done. Commit leftovers, run the task's check, and if it passes
 * record the candidate and release the claim. After this the worker has nothing left to
 * do; integration continues without it.
 */
export async function submitCandidate(
  db: NodeSqlite.DatabaseSync,
  input: SubmitInput,
): Promise<SubmitOutcome> {
  const claim = db
    .prepare(
      "SELECT 1 FROM task_claims WHERE task_id = ? AND owner_token = ? AND released_at IS NULL",
    )
    .get(input.taskId, input.claimToken);
  if (!claim) return { kind: "claim-lost" };
  // Verification can be long; the worker is idle so nobody else renews the lease.
  renewLease(db, input.claimToken, 1800);

  // A repair is handed in as a finished merge: unresolved files, or markers committed by mistake,
  // go back to the worker before anything else is looked at.
  const unresolved = unresolvedMerge(input.worktreePath, `refs/heads/${input.baseBranch}`);
  if (unresolved.length > 0) {
    const error = `The merge is not finished: resolve the conflicts in ${unresolved.slice(0, 12).join(", ")}, \`git add\` them and commit (no <<<<<<< or >>>>>>> lines may remain).`;
    const recorded = recordFailure(db, input.taskId, {
      failureClass: "verification",
      message: error,
      headCommit: git(input.worktreePath, ["rev-parse", "HEAD"]).stdout,
      evidence: { unresolved },
    });
    return {
      kind: "verification-failed",
      error,
      receipt: null,
      failureClass: "verification",
      decision: decideAfterFailure("verification", recorded),
    };
  }
  commitPendingChanges(input.worktreePath, `${input.taskId}: commit changes left uncommitted`);
  const head = git(input.worktreePath, ["rev-parse", "HEAD"]).stdout;
  const ahead = git(input.repoRoot, [
    "rev-list",
    "--count",
    `refs/heads/${input.baseBranch}..${head}`,
  ]);
  if (ahead.code !== 0 || ahead.stdout === "0") return { kind: "no-changes" };

  // The checks come from the queue's own record of the task, never from the caller: a
  // worker or a stale prompt cannot weaken them. The input command is only a legacy fallback.
  const stored = db
    .prepare("SELECT verification_command, verification_spec FROM tasks WHERE id = ?")
    .get(input.taskId) as
    | { verification_command: string | null; verification_spec: string | null }
    | undefined;
  const spec = parseStoredSpec(
    stored?.verification_spec,
    stored?.verification_command || input.verificationCommand,
  );
  const gitCommonDir =
    input.gitCommonDir ?? git(input.repoRoot, ["rev-parse", "--git-common-dir"]).stdout;
  const gitDir = NodePath.resolve(input.repoRoot, gitCommonDir);
  const loaded = loadContract({
    repoRoot: input.repoRoot,
    gitCommonDir: gitDir,
    refs: [...new Set([input.targetBranch ?? input.baseBranch, input.baseBranch])],
  });
  const taskRow = db.prepare("SELECT scope_patterns FROM tasks WHERE id = ?").get(input.taskId) as
    | { scope_patterns: string | null }
    | undefined;
  const scope = JSON.parse(taskRow?.scope_patterns || "[]") as string[];
  const changed = changedPaths(input.worktreePath, `refs/heads/${input.baseBranch}`);
  let verdict = auditScope({
    changed,
    scope,
    contract: loaded.contract,
    amendments: storedAmendments(db, input.taskId),
  });
  let amendment: AmendmentOutcome | null = null;
  if (verdict.violations.length > 0) {
    // Settled by rule, not by a person: necessary files are granted, sensitive ones need a reason,
    // a file another running task holds is waited for.
    amendment = decideScope(db, {
      taskId: input.taskId,
      requests: input.scopeRequests ?? [],
      contract: loaded.contract,
      violations: verdict.violations,
    });
    verdict = auditScope({
      changed,
      scope,
      contract: loaded.contract,
      amendments: storedAmendments(db, input.taskId),
    });
  }
  if (verdict.violations.length > 0 && loaded.contract.scopeEnforcement === "strict") {
    const waitingPaths = new Set(amendment?.waits.map((wait) => wait.path) ?? []);
    if (
      amendment !== null &&
      amendment.denied.length === 0 &&
      verdict.violations.every((path) => waitingPaths.has(path))
    ) {
      const waitsFor = [...new Set(amendment.waits.map((wait) => wait.ownerTaskId))];
      const detail = amendment.waits
        .map((wait) => `${wait.path} (held by ${wait.ownerTaskId})`)
        .join(", ");
      const now = new Date().toISOString();
      db.prepare("UPDATE tasks SET waits_for = ?, wait_reason = ? WHERE id = ?").run(
        JSON.stringify(waitsFor),
        `Needs ${detail}`.slice(0, 500),
        input.taskId,
      );
      releaseClaim(db, {
        ownerToken: input.claimToken,
        finalStatus: "pending",
        failureReason: null,
      });
      recordEvent(db, input.taskId, "task_waiting_for_files", {
        waitsFor,
        paths: verdict.violations.slice(0, 12),
        at: now,
      });
      return { kind: "scope-wait", paths: verdict.violations, waitsFor };
    }
    const error = `These changed paths are outside the task's scope: ${verdict.violations.slice(0, 12).join(", ")}${amendment?.denied.length ? `. Not allowed: ${amendment.denied.map((d) => `${d.path} (${d.why})`).join("; ")}` : ""}.`;
    const recorded = recordFailure(db, input.taskId, {
      failureClass: "scope",
      message: error,
      headCommit: head,
      evidence: verdict,
    });
    return {
      kind: "scope-violation",
      error,
      paths: verdict.violations,
      amendment,
      decision: decideAfterFailure("scope", recorded),
    };
  } else if (verdict.violations.length > 0) {
    recordEvent(db, input.taskId, "scope_report", { violations: verdict.violations.slice(0, 20) });
  }

  const slot = ensureSlot(db, input.taskId);
  const environment = taskEnvironment({
    taskId: input.taskId,
    slot,
    gitCommonDir: gitDir,
    contract: loaded.contract,
  });
  const fail = (failureClass: FailureClass, error: string, receipt: SpecResult | null) => {
    const recorded = recordFailure(db, input.taskId, {
      failureClass,
      message: error,
      headCommit: head,
      evidence: receipt,
    });
    return {
      kind: "verification-failed" as const,
      receipt,
      error: error.slice(0, 1500),
      failureClass,
      decision: decideAfterFailure(failureClass, recorded),
    };
  };
  // The repository's own submit-time guards (for example its scope guard), with this task's
  // real allowed set, run before the task's checks.
  for (const guard of loaded.contract.guards) {
    if (guard.phase !== "submit") continue;
    const command = expandCommand(guard.run, {
      taskId: input.taskId,
      branch: input.branch,
      base: input.baseBranch,
      worktree: input.worktreePath,
      allowedPaths: verdict.allowed,
    });
    const result = runShell(command, input.worktreePath, { env: environment.variables });
    if (result.code !== 0 && !guard.optional) {
      const reason = `The repository guard "${guard.name}" failed: ${result.output.slice(-600)}`;
      recordEvent(db, input.taskId, "task_guard_failed", {
        guard: guard.name,
        output: result.output.slice(-500),
      });
      const cls = classifyReason(result.output);
      return fail(cls === "transient" ? "verification" : cls, reason, null);
    }
  }
  const checkOptions = {
    env: environment.variables,
    lockDir: NodePath.join(gitDir, "agentqueue", "locks"),
    extraRequires: resourcesNeededBy(
      loaded.contract,
      scope,
      spec.checks.map((check) => check.run),
    ),
  };
  let resourceProblem: ResourceWaitError | null = null;
  const guarded = async (toRun: typeof spec): Promise<SpecResult> => {
    try {
      return await runSpec(input.taskId, input.worktreePath, toRun, undefined, checkOptions);
    } catch (error) {
      if (!(error instanceof ResourceWaitError)) throw error;
      resourceProblem = error;
      return {
        state: "unverified",
        source: toRun.source,
        commit: "unknown",
        checks: [],
        exemptReason: null,
        rejected: [],
        verifiedAt: new Date().toISOString(),
        summary: error.message,
      };
    }
  };
  let receipt = await guarded(spec);
  // A check that fails on the integration branch the worker started from, in the same way, is not
  // this worker's to repair: judge the rest, and keep the failure as its own blocking task.
  const planRow = db.prepare("SELECT plan_id FROM tasks WHERE id = ?").get(input.taskId) as
    | { plan_id: string | null }
    | undefined;
  const baselineFailures: Array<{
    check: string;
    cwd: string;
    reason: string;
    failing: ReadonlyArray<string>;
  }> = [];
  let remaining = [...spec.checks];
  while (
    receipt.state === "failed" &&
    !resourceProblem &&
    planRow?.plan_id &&
    remaining.length > 0
  ) {
    const failedResult = receipt.checks.find((entry) => !entry.passed);
    const failedCheck = failedResult
      ? remaining.find(
          (check) => check.run === failedResult.run && (check.cwd ?? ".") === failedResult.cwd,
        )
      : undefined;
    if (!failedResult || !failedCheck) break;
    const origin = await attributeFailure(db, {
      planId: planRow.plan_id,
      taskId: input.taskId,
      repoRoot: input.repoRoot,
      integrationBranch: input.baseBranch,
      candidateWorktree: input.worktreePath,
      check: failedCheck,
      failed: failedResult,
      scope: verdict.allowed,
      changed,
      env: environment.variables,
      extraRequires: checkOptions.extraRequires,
    });
    recordEvent(db, input.taskId, "task_failure_attributed", {
      check: failedCheck.run,
      origin: origin.origin,
      reason: origin.reason.slice(0, 300),
    });
    if (origin.origin !== "baseline") {
      receipt = {
        ...receipt,
        summary: `${receipt.summary}${baselineFailures.length > 0 ? ` (Already failing before this task and set aside: ${baselineFailures.map((entry) => entry.check).join("; ")}.)` : ""}`,
      };
      break;
    }
    baselineFailures.push({
      check: failedCheck.run,
      cwd: failedCheck.cwd ?? ".",
      reason: origin.reason,
      failing: origin.failing.slice(0, 20),
    });
    remaining = remaining.filter((check) => check !== failedCheck);
    receipt =
      remaining.length === 0
        ? {
            ...receipt,
            state: "passed",
            checks: [],
            summary: "Every check already fails on the integration branch.",
          }
        : await guarded({ ...spec, checks: remaining });
    if (resourceProblem) break;
  }
  if (resourceProblem) {
    const problem: ResourceWaitError = resourceProblem;
    if (problem.outcome === "unavailable") {
      // The machine lacks the resource altogether: another worker would meet the same wall.
      return fail("prerequisite", `${problem.message} The check cannot run on this machine.`, null);
    }
    recordEvent(db, input.taskId, "task_checks_waiting_for_resource", { message: problem.message });
    return { kind: "resource-wait", message: problem.message };
  }
  if (baselineFailures.length > 0 && receipt.state === "passed") {
    receipt = {
      ...receipt,
      state: "baseline-failed",
      summary: `${receipt.checks.length} check(s) passed; ${baselineFailures.length} already failed before this task and are tracked on their own: ${baselineFailures.map((entry) => entry.check).join("; ")}.`,
    };
  }
  if (receipt.state === "failed" || receipt.state === "timed-out") {
    // The exact result stays on record: every check that ran, how it ended, and the output's tail.
    recordEvent(db, input.taskId, "task_verification_failed", { ...receipt });
    return fail("verification", receipt.summary, receipt);
  }
  if (receipt.state === "unverified") {
    recordEvent(db, input.taskId, "task_unverified", {
      summary: receipt.summary,
      rejected: receipt.rejected,
    });
  }

  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const active = db
      .prepare("SELECT id FROM task_claims WHERE owner_token = ? AND released_at IS NULL")
      .get(input.claimToken) as { id: number } | undefined;
    if (!active) {
      db.exec("ROLLBACK;");
      return { kind: "claim-lost" };
    }
    db.prepare("UPDATE task_claims SET released_at = ? WHERE id = ?").run(now, active.id);
    db.prepare(`
      UPDATE tasks SET status = 'verifying', integration_state = 'pending',
        candidate_commit = ?, candidate_branch = ?, candidate_worktree = ?, receipt_json = ?,
        integration_error = NULL, integration_updated_at = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      head,
      input.branch,
      input.worktreePath,
      JSON.stringify({
        state: receipt.state,
        source: receipt.source,
        commit: head,
        verifiedAt: receipt.verifiedAt,
        summary: receipt.summary,
        exemptReason: receipt.exemptReason,
        rejected: receipt.rejected,
        baselineFailures,
        checks: receipt.checks.map((check) => ({
          ...check,
          stdoutTail: check.stdoutTail.slice(-500),
          stderrTail: check.stderrTail.slice(-500),
        })),
      }),
      now,
      now,
      input.taskId,
    );
    recordEvent(db, input.taskId, "task_submitted", {
      candidateCommit: head,
      branch: input.branch,
    });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  if (planRow?.plan_id) {
    for (const entry of baselineFailures) {
      addFollowUpTask(db, {
        planId: planRow.plan_id,
        parentTaskId: input.taskId,
        kind: "repair",
        blocking: true,
        title: `Fix a check that already failed: ${entry.check}`.slice(0, 120),
        note: `While ${input.taskId} was checked, \`${entry.check}\` (in ${entry.cwd}) failed, and it fails the same way on the integration branch without ${input.taskId}'s changes. ${entry.reason}${entry.failing.length > 0 ? `\nFailing: ${entry.failing.join("; ")}` : ""}\nFix the cause so the check passes. Do not weaken, skip or delete the check.`,
      });
    }
  }
  return {
    kind: "submitted",
    candidateCommit: head,
    receipt,
    scope: {
      generated: verdict.generated,
      supporting: verdict.supporting,
      amended: verdict.amended,
    },
  };
}

export type IntegrationOutcome =
  | { readonly kind: "landed"; readonly commit: string; readonly reconciled: boolean }
  /** Safe to try again later; the candidate stays `pending`. */
  | { readonly kind: "deferred"; readonly reason: string; readonly files: ReadonlyArray<string> }
  /** A repair worker (or, after the budget, the overseer) must fix the candidate. */
  | {
      readonly kind: "needs-repair";
      readonly reason: string;
      readonly files: ReadonlyArray<string>;
      readonly exhausted: boolean;
    }
  | { readonly kind: "not-pending" };

export interface IntegrateInput {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  /** The target branch; the plan's integration branch starts from it. */
  readonly baseBranch: string;
  /** The branch candidates are integrated into (see integrationBranchFor). */
  readonly integrationBranch: string;
  readonly taskId: string;
  /** Automatic repair attempts before the candidate is handed to the overseer. */
  readonly maxRepairs?: number;
}

function markDeferred(db: NodeSqlite.DatabaseSync, taskId: string, reason: string): void {
  db.prepare("UPDATE tasks SET integration_error = ?, integration_updated_at = ? WHERE id = ?").run(
    reason.slice(0, 1000),
    new Date().toISOString(),
    taskId,
  );
}

/** What a failed integration looked like, minus the candidate itself: a new commit that fails the same way is the same problem. */
function integrationFingerprint(tip: string, files: ReadonlyArray<string>, reason: string): string {
  return NodeCrypto.createHash("sha1")
    .update(`${tip}|${[...files].sort().join(",")}|${failureSignature("merge-conflict", reason)}`)
    .digest("hex")
    .slice(0, 16);
}

function markNeedsRepair(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  reason: string,
  files: ReadonlyArray<string>,
  maxRepairs: number,
  tip = "",
): { exhausted: boolean } {
  const row = db
    .prepare("SELECT integration_attempts, integration_fingerprint FROM tasks WHERE id = ?")
    .get(taskId) as { integration_attempts: number; integration_fingerprint: string | null };
  const fingerprint = integrationFingerprint(tip, files, reason);
  // Another worker landing since the last attempt is a new situation, not a repeat of the old one;
  // only the same failure against the same integration tip spends the repair budget.
  const attempts = row.integration_fingerprint === fingerprint ? row.integration_attempts + 1 : 1;
  const exhausted = attempts > maxRepairs;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET integration_state = ?, integration_attempts = ?, integration_error = ?,
       integration_fingerprint = ?, integration_updated_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    exhausted ? "repair_needed" : "conflict",
    attempts,
    reason.slice(0, 1000),
    fingerprint,
    now,
    now,
    taskId,
  );
  recordEvent(db, taskId, exhausted ? "task_repair_needed" : "task_conflict", {
    reason: reason.slice(0, 500),
    files: files.slice(0, 20),
    attempts,
  });
  return { exhausted };
}

function markLanded(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  branch: string | null,
  baseBranch: string,
  commit: string,
  reconciled: boolean,
): void {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `INSERT INTO landing_queue (task_id, source_branch, target_branch, commit_hash, status, queued_at, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'landed', ?, ?, ?)`,
    ).run(taskId, branch ?? "", baseBranch, commit, now, now, now);
    db.prepare(
      `UPDATE tasks SET status = 'completed', integration_state = NULL, integration_error = NULL,
         integration_updated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(now, now, taskId);
    recordEvent(db, taskId, "task_landed", { landedCommit: commit, baseBranch, reconciled });
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/**
 * Integrate a candidate into the plan's own integration branch. Safe to call repeatedly
 * and concurrently: the landing lock serialises it, an already-integrated candidate is
 * recognised, and every failure leaves the candidate's commits untouched. No checkout of
 * the target branch is involved, so a dirty shared checkout cannot stop it.
 */
export async function integrateCandidate(
  db: NodeSqlite.DatabaseSync,
  input: IntegrateInput,
): Promise<IntegrationOutcome> {
  const row = db
    .prepare(
      `SELECT candidate_commit, candidate_branch, verification_command, verification_spec, receipt_json
       FROM tasks WHERE id = ? AND integration_state = 'pending' AND status = 'verifying'`,
    )
    .get(input.taskId) as
    | {
        candidate_commit: string | null;
        candidate_branch: string | null;
        verification_command: string | null;
        verification_spec: string | null;
        receipt_json: string | null;
      }
    | undefined;
  if (!row?.candidate_commit) return { kind: "not-pending" };
  const maxRepairs = input.maxRepairs ?? 3;
  const candidate = row.candidate_commit;

  if (git(input.repoRoot, ["cat-file", "-e", `${candidate}^{commit}`]).code !== 0) {
    markNeedsRepair(db, input.taskId, `Candidate commit ${candidate} no longer exists.`, [], 0);
    return {
      kind: "needs-repair",
      reason: "The candidate commit is missing.",
      files: [],
      exhausted: true,
    };
  }

  const release = await acquireLandingLock(input.gitCommonDir);
  try {
    // Re-read inside the lock: another caller may have finished this already.
    const stillPending = db
      .prepare("SELECT 1 FROM tasks WHERE id = ? AND integration_state = 'pending'")
      .get(input.taskId);
    if (!stillPending) return { kind: "not-pending" };

    const goalBranch = input.integrationBranch;
    ensureIntegrationBranch(input.repoRoot, input.baseBranch, goalBranch);
    const goalRef = `refs/heads/${goalBranch}`;
    const tip = currentBranchHead(input.repoRoot, goalBranch);
    // Integrated by an earlier attempt that died before recording it: just record it.
    if (git(input.repoRoot, ["merge-base", "--is-ancestor", candidate, tip]).code === 0) {
      markLanded(db, input.taskId, row.candidate_branch, goalBranch, tip, true);
      return { kind: "landed", commit: tip, reconciled: true };
    }

    // Merge and check in a private worktree; the branch only moves once the result passed.
    const staging = prepareStagingWorktree(input.repoRoot, tip);
    let result = candidate;
    if (git(input.repoRoot, ["merge-base", "--is-ancestor", tip, candidate]).code !== 0) {
      const merge = git(staging, [
        ...IDENTITY,
        "merge",
        "--no-edit",
        "-m",
        `AgentQueue: integrate ${input.taskId}`,
        candidate,
      ]);
      let mergedHead: string | null = null;
      if (merge.code !== 0) {
        const files = git(staging, ["diff", "--name-only", "--diff-filter=U"])
          .stdout.split("\n")
          .filter(Boolean);
        // Generated files (a file list, a lockfile, a schema dump) conflict on every branch and
        // are rebuilt, never merged by hand. Only the other conflicts need a person's judgement.
        const contract = loadContract({
          repoRoot: input.repoRoot,
          gitCommonDir: input.gitCommonDir,
          refs: [input.baseBranch, goalBranch],
        }).contract;
        const resolved = resolveMechanicalConflicts(staging, contract, files);
        if (resolved.remaining.length === 0 && resolved.resolved.length > 0) {
          const committed = git(staging, [...IDENTITY, "commit", "--no-edit"]);
          if (committed.code === 0) {
            mergedHead = git(staging, ["rev-parse", "HEAD"]).stdout;
            recordEvent(db, input.taskId, "task_generated_resolved", { files: resolved.resolved });
          }
        }
        if (mergedHead === null) {
          git(staging, ["merge", "--abort"]);
          const real = resolved.remaining.length > 0 ? resolved.remaining : files;
          const generatedNote =
            resolved.resolved.length > 0
              ? ` (${resolved.resolved.join(", ")} are settled by the server by rule; do not hand-merge them)`
              : "";
          const reason = `Merging ${input.taskId} into ${goalBranch} conflicts in: ${real.join(", ") || merge.stderr.slice(0, 200)}${generatedNote}`;
          const { exhausted } = markNeedsRepair(db, input.taskId, reason, real, maxRepairs, tip);
          return { kind: "needs-repair", reason, files: real, exhausted };
        }
      }
      result = mergedHead ?? git(staging, ["rev-parse", "HEAD"]).stdout;
    } else {
      git(staging, ["checkout", "--force", "--detach", candidate]);
    }

    // Files the repository rebuilds when work lands on its base branch (a file list, a schema
    // dump) are rebuilt here too, once, on the serialised result: task branches never carry them.
    const refreshRules = loadContract({
      repoRoot: input.repoRoot,
      gitCommonDir: input.gitCommonDir,
      refs: [input.baseBranch, goalBranch],
    }).contract.generated.filter((rule) => rule.refreshOnLand && rule.regenerate);
    if (refreshRules.length > 0) {
      if (git(staging, ["rev-parse", "HEAD"]).stdout !== result) {
        git(staging, ["checkout", "--force", "--detach", result]);
      }
      for (const rule of refreshRules) {
        runShell(rule.regenerate!, staging, { timeoutMs: 120_000 });
        for (const path of rule.paths) git(staging, ["add", "-A", "--", path]);
      }
      if (git(staging, ["diff", "--cached", "--quiet"]).code !== 0) {
        const refreshed = git(staging, [
          ...IDENTITY,
          "commit",
          "-m",
          `AgentQueue: refresh generated files after ${input.taskId}`,
        ]);
        if (refreshed.code === 0) result = git(staging, ["rev-parse", "HEAD"]).stdout;
      }
    }

    // Concurrent work was merged in, so the task's checks must still pass on the result.
    const adopted = row.receipt_json?.includes('"adopted":true') === true;
    if (result !== candidate || adopted) {
      const spec = parseStoredSpec(row.verification_spec, row.verification_command);
      if (spec.checks.length > 0) {
        const gitDir = input.gitCommonDir;
        const slot = ensureSlot(db, input.taskId);
        const contract = loadContract({
          repoRoot: input.repoRoot,
          gitCommonDir: gitDir,
          refs: [input.baseBranch, goalBranch],
        }).contract;
        const taskScope = JSON.parse(
          (
            db.prepare("SELECT scope_patterns FROM tasks WHERE id = ?").get(input.taskId) as {
              scope_patterns: string | null;
            }
          ).scope_patterns || "[]",
        ) as string[];
        let receipt: SpecResult;
        try {
          receipt = await runSpec(input.taskId, staging, spec, undefined, {
            env: taskEnvironment({ taskId: input.taskId, slot, gitCommonDir: gitDir, contract })
              .variables,
            lockDir: NodePath.join(gitDir, "agentqueue", "locks"),
            extraRequires: resourcesNeededBy(
              contract,
              taskScope,
              spec.checks.map((check) => check.run),
            ),
          });
        } catch (error) {
          if (!(error instanceof ResourceWaitError)) throw error;
          // A busy or unavailable resource is not a verdict on the work: wait, with no model turn.
          const reason = `Checks after merging could not run yet: ${error.message}`;
          markDeferred(db, input.taskId, reason);
          return { kind: "deferred", reason, files: [] };
        }
        if (receipt.state === "failed" || receipt.state === "timed-out") {
          recordEvent(db, input.taskId, "task_verification_failed", {
            ...receipt,
            phase: "after-merge",
          });
          const reason = `After merging with ${goalBranch}, the checks failed: ${receipt.summary.slice(-600)}`;
          const { exhausted } = markNeedsRepair(db, input.taskId, reason, [], maxRepairs, tip);
          return { kind: "needs-repair", reason, files: [], exhausted };
        }
      }
    }

    const moved = git(input.repoRoot, [
      "update-ref",
      "-m",
      `AgentQueue: integrate ${input.taskId}`,
      goalRef,
      result,
      tip,
    ]);
    if (moved.code !== 0) {
      const reason = `${goalBranch} changed while integrating; trying again.`;
      markDeferred(db, input.taskId, reason);
      return { kind: "deferred", reason, files: [] };
    }
    markLanded(db, input.taskId, row.candidate_branch, goalBranch, result, false);
    return { kind: "landed", commit: result, reconciled: false };
  } finally {
    release();
  }
}

/**
 * Adopt commits that already exist on a branch (for example a worker's preserved
 * checkpoint) as the candidate for a task nobody currently owns, so integration can
 * proceed without anyone redoing the work.
 */
export async function adoptCandidate(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly repoRoot: string;
    readonly baseBranch: string;
    readonly taskId: string;
    readonly branch: string;
    readonly verifyInWorktree?: string;
  },
): Promise<{ readonly commit: string }> {
  const task = db
    .prepare("SELECT status, verification_command FROM tasks WHERE id = ?")
    .get(input.taskId) as { status: string; verification_command: string | null } | undefined;
  if (!task) throw new Error(`Unknown task ${input.taskId}.`);
  if (!["pending", "failed", "blocked"].includes(task.status)) {
    throw new Error(
      `Task ${input.taskId} is ${task.status}; only unowned tasks can adopt a branch.`,
    );
  }
  const active = db
    .prepare("SELECT 1 FROM task_claims WHERE task_id = ? AND released_at IS NULL")
    .get(input.taskId);
  if (active) throw new Error(`Task ${input.taskId} has an active claim.`);
  const commit = git(input.repoRoot, ["rev-parse", `refs/heads/${input.branch}^{commit}`]);
  if (commit.code !== 0) throw new Error(`Branch ${input.branch} does not exist.`);
  const ahead = git(input.repoRoot, [
    "rev-list",
    "--count",
    `refs/heads/${input.baseBranch}..${commit.stdout}`,
  ]);
  if (ahead.stdout === "0")
    throw new Error(`Branch ${input.branch} has no commits beyond ${input.baseBranch}.`);

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE tasks SET status = 'verifying', integration_state = 'pending', candidate_commit = ?,
      candidate_branch = ?, candidate_worktree = NULL, integration_error = NULL,
      receipt_json = ?, integration_updated_at = ?, version = version + 1, updated_at = ?
    WHERE id = ?
  `).run(
    commit.stdout,
    input.branch,
    JSON.stringify({
      adopted: true,
      state: "unverified",
      summary: "Recovered from a preserved branch; its checks run when it is merged.",
    }),
    now,
    now,
    input.taskId,
  );
  recordEvent(db, input.taskId, "task_adopted", {
    branch: input.branch,
    candidateCommit: commit.stdout,
  });
  return { commit: commit.stdout };
}

/** Tasks waiting on integration or repair, oldest first. */
export function listCandidates(
  db: NodeSqlite.DatabaseSync,
  planId: string,
): Array<{
  readonly taskId: string;
  readonly state: "pending" | "conflict" | "repairing" | "repair_needed";
  readonly error: string | null;
  readonly attempts: number;
  readonly candidateBranch: string | null;
  readonly candidateWorktree: string | null;
  readonly updatedAt: string | null;
}> {
  return (
    db
      .prepare(
        `SELECT id, integration_state, integration_error, integration_attempts, candidate_branch,
                candidate_worktree, integration_updated_at
         FROM tasks WHERE plan_id = ? AND integration_state IS NOT NULL
         ORDER BY integration_updated_at, rowid`,
      )
      .all(planId) as Array<{
      id: string;
      integration_state: "pending" | "conflict" | "repairing" | "repair_needed";
      integration_error: string | null;
      integration_attempts: number;
      candidate_branch: string | null;
      candidate_worktree: string | null;
      integration_updated_at: string | null;
    }>
  ).map((row) => ({
    taskId: row.id,
    state: row.integration_state,
    error: row.integration_error,
    attempts: row.integration_attempts,
    candidateBranch: row.candidate_branch,
    candidateWorktree: row.candidate_worktree,
    updatedAt: row.integration_updated_at,
  }));
}
