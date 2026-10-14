// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Whose failure is it? A check that fails on a worker's commit may fail only because of that
 * commit, or may already fail on the integration branch the worker started from. Sending the worker
 * to repair code it never touched wastes its context and rewards nothing; calling the check passed
 * would hide a real failure. This runs the failing check once on the untouched integration tip
 * (remembered per check and tip) and compares what fails:
 *
 *  - passes there: the commit introduced the failure and its owner must fix it;
 *  - fails there the same way: a baseline failure, which the task is not made to repair but which
 *    stays on the plan as its own blocking task and keeps the check from counting as passed;
 *  - fails there differently, or cannot be run: treated as introduced (the safe default).
 *
 * @module baseline
 */
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { matchesAny } from "./contract.ts";
import { ResourceWaitError } from "./resourceRunner.ts";
import { isBroadCheck, type PlanFinding } from "./planLint.ts";
import type { PlanTaskDefinition } from "./planGraph.ts";
import { runSpec, type CheckResult, type VerificationCheck } from "./verificationSpec.ts";

export type FailureOrigin = "introduced" | "baseline" | "unknown";

export interface OriginVerdict {
  readonly origin: FailureOrigin;
  readonly reason: string;
  /** What fails, as far as the output names it. */
  readonly failing: ReadonlyArray<string>;
  readonly baselineCommit: string | null;
}

export const checkKey = (
  check: Pick<VerificationCheck, "run" | "cwd" | "expectExitCode">,
): string =>
  NodeCrypto.createHash("sha1")
    .update(`${check.run}\n${check.cwd ?? "."}\n${check.expectExitCode}`)
    .digest("hex")
    .slice(0, 20);

/** The names of failing tests or errors in a check's output, where it names them. */
export function failingNames(output: string): string[] {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const text = line.trim();
    const match =
      /^(?:FAILED|FAIL|ERROR)\s+(\S.{0,200})$/.exec(text) ??
      /^[✗×✕✖]\s+(.{1,200})$/.exec(text) ??
      /^not ok \d+ - (.{1,200})$/.exec(text) ??
      /^(.{1,200}?)\s+FAILED(?:\s|$)/.exec(text) ??
      /^error(?:\[\w+\])?:\s+(.{1,200})$/i.exec(text);
    if (match?.[1]) {
      names.add(
        match[1]
          .replace(/\s+\(?\d+(\.\d+)?\s*m?s\)?$/i, "")
          .replace(/\b0x[0-9a-f]+\b/gi, "<addr>")
          .replace(/\d+/g, "#"),
      );
    }
  }
  return [...names].slice(0, 200);
}

const normalise = (text: string) =>
  text
    .replace(/(?:\/[\w.@+-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\d+(\.\d+)?\s*(ms|s|seconds?)\b/gi, "<t>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-400);

const stemOf = (file: string) =>
  NodePath.basename(file)
    .replace(/\.[^.]+$/, "")
    .toLowerCase();

/**
 * Could this failing item be the task's own business? Yes when it names a file the task owns or
 * changed, or carries the stem of a changed file (`test_billing_total` for `billing.py`). A failure
 * the task is responsible for is never set aside as "already broken", however long it has been red:
 * a bug the task was given to fix still failing is the task failing.
 */
export function relatedToTask(
  name: string,
  scope: ReadonlyArray<string>,
  changed: ReadonlyArray<string>,
): boolean {
  const lower = name.toLowerCase();
  const paths = name.match(/[\w@.+-]+(?:\/[\w@.+-]+)+/g) ?? [];
  if (
    paths.some(
      (path) =>
        matchesAny(path, scope) ||
        changed.some((file) => file === path || file.endsWith(`/${path}`) || path.endsWith(file)),
    )
  ) {
    return true;
  }
  return changed.some((file) => {
    const stem = stemOf(file);
    return stem.length >= 3 && lower.includes(stem);
  });
}

/** Does the candidate fail only in ways the baseline already fails? */
export function sameFailure(
  candidate: CheckResult,
  base: { exitCode: number; stdout: string; stderr: string },
): boolean {
  const mine = failingNames(`${candidate.stdoutTail}\n${candidate.stderrTail}`);
  const theirs = failingNames(`${base.stdout}\n${base.stderr}`);
  if (mine.length > 0 && theirs.length > 0) {
    const known = new Set(theirs);
    return mine.every((name) => known.has(name));
  }
  return (
    candidate.exitCode === base.exitCode &&
    normalise(`${candidate.stderrTail}${candidate.stdoutTail}`) ===
      normalise(`${base.stderr}${base.stdout}`)
  );
}

export const DEPENDENCY_DIRS = [
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  ".gradle",
  ".pnpm-store",
  ".yarn",
];

function git(cwd: string, args: ReadonlyArray<string>) {
  const result = NodeChildProcess.spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Runs `check` on the untouched integration tip. The tip is checked out in a private worktree whose
 * installed dependencies are the candidate worktree's own (linked, never copied), so the check meets
 * the same toolchain; it is removed afterwards.
 */
async function runAtBaseline(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly planId: string;
    readonly taskId: string;
    readonly repoRoot: string;
    readonly tip: string;
    readonly candidateWorktree: string;
    readonly check: VerificationCheck;
    readonly env?: Record<string, string>;
    readonly extraRequires?: ReadonlyArray<string>;
  },
): Promise<{
  state: "passed" | "failed" | "unknown";
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const path = NodePath.join(
    input.repoRoot,
    ".worktrees",
    `agentqueue-baseline-${input.tip.slice(0, 9)}`,
  );
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  git(input.repoRoot, ["worktree", "prune"]);
  if (NodeFS.existsSync(path)) git(input.repoRoot, ["worktree", "remove", "--force", path]);
  const added = git(input.repoRoot, ["worktree", "add", "--detach", path, input.tip]);
  if (added.code !== 0) return { state: "unknown", stdout: "", stderr: added.stderr, exitCode: 1 };
  try {
    for (const name of DEPENDENCY_DIRS) {
      const source = NodePath.join(input.candidateWorktree, name);
      const target = NodePath.join(path, name);
      if (NodeFS.existsSync(source) && !NodeFS.existsSync(target)) {
        try {
          NodeFS.symlinkSync(source, target, "dir");
        } catch {
          // The check will say what is missing.
        }
      }
    }
    let result: Awaited<ReturnType<typeof runSpec>>;
    try {
      result = await runSpec(
        input.taskId,
        path,
        { source: "declared", checks: [input.check], exemptReason: null, rejected: [] },
        undefined,
        {
          ...(input.env ? { env: input.env } : {}),
          ...(input.extraRequires ? { extraRequires: input.extraRequires } : {}),
        },
      );
    } catch (error) {
      // A busy or missing shared resource says nothing about the check: unknown, not "failed".
      if (error instanceof ResourceWaitError) {
        return { state: "unknown", stdout: "", stderr: error.message, exitCode: 1 };
      }
      throw error;
    }
    const ran = result.checks[0];
    if (!ran) return { state: "unknown", stdout: "", stderr: result.summary, exitCode: 1 };
    return {
      state: ran.passed ? "passed" : ran.outcome === "timed-out" ? "unknown" : "failed",
      stdout: ran.stdoutTail,
      stderr: ran.stderrTail,
      exitCode: ran.exitCode,
    };
  } finally {
    git(input.repoRoot, ["worktree", "remove", "--force", path]);
  }
}

/**
 * What a check does on the untouched `commit`: remembered per check and commit, so a plan-time probe
 * and every later attribution share one answer instead of running the same suite again.
 */
export async function baselineResult(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly planId: string | null;
    readonly taskId: string;
    readonly repoRoot: string;
    readonly commit: string;
    readonly check: VerificationCheck;
    /** A worktree whose installed dependencies (node_modules, .venv) the baseline checkout may link. */
    readonly dependencySource: string;
    readonly env?: Record<string, string>;
    readonly extraRequires?: ReadonlyArray<string>;
  },
): Promise<{
  state: "passed" | "failed" | "unknown";
  stdout: string;
  stderr: string;
  exitCode: number;
  failing: string[];
  cached: boolean;
}> {
  const key = checkKey(input.check);
  const cached = db
    .prepare(
      "SELECT state, summary, failing_json FROM check_baselines WHERE check_key = ? AND ref_commit = ?",
    )
    .get(key, input.commit) as
    | { state: string; summary: string | null; failing_json: string }
    | undefined;
  if (cached) {
    const names = JSON.parse(cached.failing_json) as string[];
    return {
      state: cached.state as "passed" | "failed" | "unknown",
      stdout: names.map((name) => `FAILED ${name}`).join("\n"),
      stderr: cached.summary ?? "",
      exitCode: input.check.expectExitCode === 0 ? 1 : 0,
      failing: names,
      cached: true,
    };
  }
  const ran = await runAtBaseline(db, {
    planId: input.planId ?? "",
    taskId: input.taskId,
    repoRoot: input.repoRoot,
    tip: input.commit,
    candidateWorktree: input.dependencySource,
    check: input.check,
    ...(input.env ? { env: input.env } : {}),
    ...(input.extraRequires ? { extraRequires: input.extraRequires } : {}),
  });
  const failing = ran.state === "failed" ? failingNames(`${ran.stdout}\n${ran.stderr}`) : [];
  db.prepare(
    `INSERT OR REPLACE INTO check_baselines (plan_id, check_key, ref_commit, state, signature, failing_json, summary, run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.planId,
    key,
    input.commit,
    ran.state,
    null,
    JSON.stringify(failing),
    `${ran.stderr}${ran.stdout}`.slice(-600),
    new Date().toISOString(),
  );
  return { ...ran, failing, cached: false };
}

/** Decide whether a failed check is the commit's doing or was already there. */
export async function attributeFailure(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly planId: string;
    readonly taskId: string;
    readonly repoRoot: string;
    readonly integrationBranch: string;
    readonly candidateWorktree: string;
    readonly check: VerificationCheck;
    readonly failed: CheckResult;
    /** What the task owns and what its commits changed: failures there are the task's own. */
    readonly scope: ReadonlyArray<string>;
    readonly changed: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
    readonly extraRequires?: ReadonlyArray<string>;
  },
): Promise<OriginVerdict> {
  // A check that names no failing item (a file test, a bare exit code) cannot be told apart from
  // "the task has not done its work yet", which is exactly what it is for: never set aside.
  const mine = failingNames(`${input.failed.stdoutTail}\n${input.failed.stderrTail}`);
  const own = mine.filter((name) => relatedToTask(name, input.scope, input.changed));
  const targetsTask = (input.check.run.match(/[\w@.+-]+(?:\/[\w@.+-]+)+/g) ?? []).some((token) =>
    matchesAny(token, input.scope),
  );
  if (mine.length === 0 || own.length > 0 || targetsTask) {
    return {
      origin: "introduced",
      reason:
        mine.length === 0
          ? "The check names no failing item, so it is judged on this commit."
          : own.length > 0
            ? `Failing item(s) belong to this task's files: ${own.slice(0, 3).join("; ")}.`
            : "The check targets this task's own files.",
      failing: mine,
      baselineCommit: null,
    };
  }
  const tip = git(input.repoRoot, ["rev-parse", `refs/heads/${input.integrationBranch}`]).stdout;
  if (!tip)
    return {
      origin: "unknown",
      reason: "The integration branch has no tip to compare against.",
      failing: [],
      baselineCommit: null,
    };
  const baseline = await baselineResult(db, {
    planId: input.planId,
    taskId: input.taskId,
    repoRoot: input.repoRoot,
    commit: tip,
    check: input.check,
    dependencySource: input.candidateWorktree,
    ...(input.env ? { env: input.env } : {}),
    ...(input.extraRequires ? { extraRequires: input.extraRequires } : {}),
  });
  if (baseline.state === "passed") {
    return {
      origin: "introduced",
      reason: `\`${input.check.run}\` passes on ${input.integrationBranch} (${tip.slice(0, 9)}); the commit broke it.`,
      failing: failingNames(`${input.failed.stdoutTail}\n${input.failed.stderrTail}`),
      baselineCommit: tip,
    };
  }
  if (baseline.state === "failed" && sameFailure(input.failed, baseline)) {
    return {
      origin: "baseline",
      reason: `\`${input.check.run}\` already fails the same way on ${input.integrationBranch} (${tip.slice(0, 9)}), before this task.`,
      failing: failingNames(`${baseline.stdout}\n${baseline.stderr}`),
      baselineCommit: tip,
    };
  }
  return {
    origin: "unknown",
    reason:
      baseline.state === "failed"
        ? "It fails on the integration branch too, but not in the same way."
        : "The check could not be run on the integration branch.",
    failing: [],
    baselineCommit: tip,
  };
}

/**
 * Runs the plan's checks once on the untouched branch the workers will start from and records
 * the answers (so later attribution reuses them). A check that already fails there, on items the
 * task has no business with, would block its task through no fault of the worker: the plan must
 * scope the check to the task's own tests, or give the failure its own task first.
 */
export async function probePlanBaseline(
  db: NodeSqlite.DatabaseSync,
  input: {
    readonly repoRoot: string;
    readonly ref: string;
    readonly planId: string | null;
    readonly tasks: ReadonlyArray<PlanTaskDefinition>;
    /** `broad`: only whole-suite checks (the expensive and the risky ones); `all`: every check. */
    readonly only: "broad" | "all";
    readonly env?: Record<string, string>;
  },
): Promise<PlanFinding[]> {
  const commit = git(input.repoRoot, ["rev-parse", `${input.ref}^{commit}`]).stdout;
  if (!commit)
    return [
      {
        level: "warning",
        code: "baseline-unknown",
        taskId: null,
        message: `${input.ref} has no commit to probe.`,
      },
    ];
  const findings: PlanFinding[] = [];
  const seen = new Map<string, Awaited<ReturnType<typeof baselineResult>>>();
  for (const task of input.tasks) {
    for (const check of task.verification?.checks ?? []) {
      if (input.only === "broad" && !isBroadCheck(check.run)) continue;
      const key = checkKey(check);
      let result = seen.get(key);
      if (!result) {
        result = await baselineResult(db, {
          planId: input.planId,
          taskId: task.id,
          repoRoot: input.repoRoot,
          commit,
          check,
          dependencySource: input.repoRoot,
          ...(input.env ? { env: input.env } : {}),
        });
        seen.set(key, result);
      }
      if (result.state === "passed") continue;
      if (result.state === "unknown") {
        findings.push({
          level: "warning",
          code: "baseline-unknown",
          taskId: task.id,
          message: `${task.id}'s check \`${check.run}\` could not be run on ${input.ref} (${result.stderr.slice(-160).trim() || "timed out"}), so nobody knows whether it passes before the task.`,
        });
        continue;
      }
      const scope = task.scopePatterns ?? [];
      const own = result.failing.filter((name) => relatedToTask(name, scope, []));
      if (result.failing.length > 0 && own.length === result.failing.length) continue; // the task is meant to fix these
      findings.push({
        level: "error",
        code: "baseline-failing",
        taskId: task.id,
        message: `${task.id}'s check \`${check.run}\` already FAILS on ${input.ref} (${commit.slice(0, 9)})${result.failing.length > 0 ? `: ${result.failing.length} failing item(s), e.g. ${result.failing.slice(0, 3).join("; ")}` : ""}. The worker cannot make it pass without repairing code that is not its task.`,
        fix: "Point the check at the task's own test files, or add a task that fixes the failing items first and make this one depend on it; never leave a whole-suite check on an ordinary task while the baseline is red.",
      });
    }
  }
  return findings;
}
