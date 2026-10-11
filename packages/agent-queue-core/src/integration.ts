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
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { recordEvent } from "./eventStream.ts";
import { renewLease } from "./claimService.ts";
import { runVerification, type VerificationExecutionResult } from "./verifier.ts";
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

export interface SubmitInput {
  readonly repoRoot: string;
  readonly baseBranch: string;
  readonly taskId: string;
  readonly claimToken: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly verificationCommand: string;
}

export type SubmitOutcome =
  | {
      readonly kind: "submitted";
      readonly candidateCommit: string;
      readonly receipt: VerificationExecutionResult;
    }
  | { readonly kind: "no-changes" }
  | {
      readonly kind: "verification-failed";
      readonly error: string;
      readonly receipt: VerificationExecutionResult;
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

  commitPendingChanges(input.worktreePath, `${input.taskId}: commit changes left uncommitted`);
  const head = git(input.worktreePath, ["rev-parse", "HEAD"]).stdout;
  const ahead = git(input.repoRoot, [
    "rev-list",
    "--count",
    `refs/heads/${input.baseBranch}..${head}`,
  ]);
  if (ahead.code !== 0 || ahead.stdout === "0") return { kind: "no-changes" };

  const receipt = await runVerification(
    input.taskId,
    input.worktreePath,
    input.verificationCommand,
  );
  if (!receipt.passed) {
    return {
      kind: "verification-failed",
      receipt,
      error:
        `Verification failed (exit ${receipt.exitCode}): ${receipt.stderrSnippet || receipt.stdoutSnippet}`.slice(
          0,
          1500,
        ),
    };
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
        command: receipt.verificationCommand,
        exitCode: receipt.exitCode,
        commit: receipt.commitHash,
        verifiedAt: receipt.verifiedAt,
        durationMs: receipt.durationMs,
        stdoutTail: receipt.stdoutSnippet.slice(-500),
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
  return { kind: "submitted", candidateCommit: head, receipt };
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

function markNeedsRepair(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  reason: string,
  files: ReadonlyArray<string>,
  maxRepairs: number,
): { exhausted: boolean } {
  const row = db.prepare("SELECT integration_attempts FROM tasks WHERE id = ?").get(taskId) as {
    integration_attempts: number;
  };
  const attempts = row.integration_attempts + 1;
  const exhausted = attempts > maxRepairs;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET integration_state = ?, integration_attempts = ?, integration_error = ?,
       integration_updated_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    exhausted ? "repair_needed" : "conflict",
    attempts,
    reason.slice(0, 1000),
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
      `SELECT candidate_commit, candidate_branch, verification_command
       FROM tasks WHERE id = ? AND integration_state = 'pending' AND status = 'verifying'`,
    )
    .get(input.taskId) as
    | {
        candidate_commit: string | null;
        candidate_branch: string | null;
        verification_command: string | null;
      }
    | undefined;
  if (!row?.candidate_commit) return { kind: "not-pending" };
  const maxRepairs = input.maxRepairs ?? 2;
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
      if (merge.code !== 0) {
        const files = git(staging, ["diff", "--name-only", "--diff-filter=U"])
          .stdout.split("\n")
          .filter(Boolean);
        git(staging, ["merge", "--abort"]);
        const reason = `Merging ${input.taskId} into ${goalBranch} conflicts in: ${files.join(", ") || merge.stderr.slice(0, 200)}`;
        const { exhausted } = markNeedsRepair(db, input.taskId, reason, files, maxRepairs);
        return { kind: "needs-repair", reason, files, exhausted };
      }
      result = git(staging, ["rev-parse", "HEAD"]).stdout;
    } else {
      git(staging, ["checkout", "--force", "--detach", candidate]);
    }

    // Concurrent work was merged in, so the task's check must still pass on the result.
    if (result !== candidate && row.verification_command?.trim()) {
      const receipt = await runVerification(input.taskId, staging, row.verification_command);
      if (!receipt.passed) {
        const reason = `After merging with ${goalBranch}, the check failed (exit ${receipt.exitCode}): ${(receipt.stderrSnippet || receipt.stdoutSnippet).slice(-600)}`;
        const { exhausted } = markNeedsRepair(db, input.taskId, reason, [], maxRepairs);
        return { kind: "needs-repair", reason, files: [], exhausted };
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
      note: "Recovered from a preserved branch; verified again when merged.",
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
