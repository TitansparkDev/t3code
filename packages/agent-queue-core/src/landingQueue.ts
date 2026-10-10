// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { recordEvent } from "./eventStream.ts";
import { rebaseOntoBase } from "./worktreeManager.ts";
import type { VerificationExecutionResult } from "./verifier.ts";

export interface LandingCandidate {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly receipt: VerificationExecutionResult;
}

export interface LandingExecutionResult {
  readonly success: boolean;
  readonly landedCommit?: string;
  readonly requiresReplanning?: boolean;
  readonly conflictFiles?: ReadonlyArray<string>;
  readonly error?: string;
}

export function checkIsAncestor(ancestorRef: string, descendantRef: string, cwd: string): boolean {
  try {
    NodeChildProcess.execFileSync(
      "git",
      ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
      {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

export function updateBaseBranch(repoRoot: string, baseBranch: string, targetCommit: string): void {
  let currentHeadBranch = "";
  try {
    currentHeadBranch = NodeChildProcess.execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
  } catch {}

  if (currentHeadBranch === baseBranch) {
    // Current worktree has baseBranch checked out: fast-forward merge
    NodeChildProcess.execFileSync("git", ["merge", "--ff-only", targetCommit], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    // baseBranch is not checked out in repoRoot: safe to update ref directly
    NodeChildProcess.execFileSync("git", ["branch", "-f", baseBranch, targetCommit], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

/**
 * Acquire dual-landing lock:
 * 1. Plan-work legacy lock at <gitCommonDir>/plan-work-landing.lock
 * Returns a lock release handle.
 */
export async function acquireLegacyLandingLock(
  gitCommonDir: string,
  timeoutMs = 15_000,
  pollIntervalMs = 100,
): Promise<() => void> {
  const lockFilePath = NodePath.join(gitCommonDir, "plan-work-landing.lock");
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const fd = NodeFS.openSync(lockFilePath, "wx");
      NodeFS.writeSync(fd, `agentqueue-pid-${process.pid}-${Date.now()}\n`);
      NodeFS.closeSync(fd);

      return () => {
        try {
          if (NodeFS.existsSync(lockFilePath)) {
            NodeFS.unlinkSync(lockFilePath);
          }
        } catch {}
      };
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Lock is held by another process/worker
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Timeout acquiring legacy landing lock at ${lockFilePath}`);
}

/**
 * Serializes landing of a verified task into baseBranch.
 * Enforces verified commit hash matching, automatic rebase if base moved,
 * and dual-locking with plan-work.
 */
export async function landCandidate(
  db: NodeSqlite.DatabaseSync,
  repoRoot: string,
  gitCommonDir: string,
  candidate: LandingCandidate,
): Promise<LandingExecutionResult> {
  const { taskId, worktreePath, branch, baseBranch, receipt } = candidate;

  // 1. Strict verification check: Receipt must have passed
  if (!receipt.passed) {
    return {
      success: false,
      error: `Cannot land task ${taskId}: verification failed with exit code ${receipt.exitCode}`,
    };
  }

  // 2. Commit hash authenticity check: HEAD in worktree must match receipt
  const currentHead = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
  }).trim();

  if (currentHead !== receipt.commitHash) {
    return {
      success: false,
      error: `Commit mismatch: current HEAD (${currentHead}) does not match verified receipt (${receipt.commitHash})`,
    };
  }

  const baseHead = NodeChildProcess.execFileSync("git", ["rev-parse", baseBranch], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (currentHead === baseHead) {
    return {
      success: false,
      error: `Cannot land task ${taskId}: the worker branch contains no commit beyond ${baseBranch}`,
    };
  }

  // 3. Acquire dual locks: plan-work lockfile + database landing queue slot
  const releaseLockfile = await acquireLegacyLandingLock(gitCommonDir);

  try {
    const now = new Date().toISOString();

    // Register into landing_queue table inside SQLite transaction
    db.prepare(`
      INSERT INTO landing_queue (
        task_id, source_branch, target_branch, commit_hash, status, queued_at, started_at
      ) VALUES (?, ?, ?, ?, 'merging', ?, ?)
    `).run(taskId, branch, baseBranch, receipt.commitHash, now, now);

    // 4. Check if base branch has moved ahead
    const currentBaseHead = NodeChildProcess.execFileSync("git", ["rev-parse", baseBranch], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    const isAncestor = checkIsAncestor(currentBaseHead, "HEAD", worktreePath);

    if (!isAncestor) {
      // Base branch has new commits -> Attempt non-interactive rebase
      const rebaseRes = await rebaseOntoBase(worktreePath, baseBranch);
      if (!rebaseRes.success) {
        // Conflict occurred: mark task for replanning
        db.prepare(`
          UPDATE landing_queue
          SET status = 'failed', error_message = ?, completed_at = ?
          WHERE task_id = ?
        `).run("Rebase merge conflict", now, taskId);

        db.prepare(`
          UPDATE tasks SET status = 'blocked', failure_reason = ?, updated_at = ? WHERE id = ?
        `).run(
          `Merge conflict rebasing onto ${baseBranch}: ${(rebaseRes.conflictFiles ?? []).join(", ")}`,
          now,
          taskId,
        );

        recordEvent(db, taskId, "landing_conflict", {
          conflictFiles: rebaseRes.conflictFiles ?? [],
          baseBranch,
        });

        return {
          success: false,
          requiresReplanning: true,
          conflictFiles: rebaseRes.conflictFiles ?? [],
          error: "Merge conflict occurred during rebase",
        };
      }
    }

    // 5. Land the commits: Fast-forward baseBranch ref
    const finalCommit = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();

    // Update base branch cleanly
    updateBaseBranch(repoRoot, baseBranch, finalCommit);

    // 6. Update database landing_queue and task status
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
        UPDATE landing_queue
        SET status = 'landed', commit_hash = ?, completed_at = ?
        WHERE task_id = ?
      `).run(finalCommit, now, taskId);

      db.prepare(`
        UPDATE tasks
        SET status = 'completed', updated_at = ?
        WHERE id = ?
      `).run(now, taskId);

      recordEvent(db, taskId, "task_landed", {
        landedCommit: finalCommit,
        baseBranch,
      });

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }

    return {
      success: true,
      landedCommit: finalCommit,
    };
  } finally {
    releaseLockfile();
  }
}
