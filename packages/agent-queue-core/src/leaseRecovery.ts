// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

export interface LeaseRecoveryResult {
  readonly taskId: string;
  readonly ownerToken: string;
  readonly action: "recovered" | "quarantined" | "retained_alive";
  readonly reason: string;
  readonly recoveryBranch?: string | null;
}

/**
 * Checks whether a process is alive on the local machine.
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

/**
 * Preserves uncommitted worktree changes to a recovery branch if git is available.
 */
export function preserveWorktreeChanges(
  worktreePath: string,
  taskId: string,
): { saved: boolean; branch?: string } {
  if (!NodeFS.existsSync(worktreePath)) {
    return { saved: false };
  }

  const branch = `recovery/${taskId}-${Date.now()}`;
  try {
    // Check if git status has dirty changes
    const status = NodeChildProcess.execSync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf8",
    }).trim();

    if (status.length > 0) {
      NodeChildProcess.execSync("git add -A", { cwd: worktreePath, stdio: "ignore" });
      NodeChildProcess.execFileSync(
        "git",
        ["commit", "-m", `AgentQueue recovery stash for ${taskId}`],
        { cwd: worktreePath, stdio: "ignore" },
      );
      NodeChildProcess.execFileSync("git", ["branch", branch], {
        cwd: worktreePath,
        stdio: "ignore",
      });
      return { saved: true, branch };
    }
  } catch {
    // Non-fatal if git commit fails
  }

  return { saved: false };
}

/**
 * Scans for expired leases, verifies worker liveness, preserves partial work,
 * and recovers or quarantines tasks.
 */
export function reconcileExpiredLeases(db: NodeSqlite.DatabaseSync): LeaseRecoveryResult[] {
  const now = new Date().toISOString();
  const results: LeaseRecoveryResult[] = [];

  const expiredClaims = db
    .prepare(`
      SELECT c.*, t.retry_count, t.max_retries, t.version as task_version
      FROM task_claims c
      JOIN tasks t ON c.task_id = t.id
      WHERE c.released_at IS NULL AND c.expires_at <= ?
    `)
    .all(now) as Array<{
    id: number;
    task_id: string;
    owner_token: string;
    worker_pid: number;
    worktree_path: string;
    branch: string;
    retry_count: number;
    max_retries: number;
    task_version: number;
  }>;

  for (const claim of expiredClaims) {
    // 1. Liveness check: If the PID is still alive, do not break the lease
    if (isProcessAlive(claim.worker_pid)) {
      results.push({
        taskId: claim.task_id,
        ownerToken: claim.owner_token,
        action: "retained_alive",
        reason: `Worker PID ${claim.worker_pid} is still executing`,
      });
      continue;
    }

    // 2. Worker is dead: Preserve any uncommitted files in worktree
    const preservation = preserveWorktreeChanges(claim.worktree_path, claim.task_id);

    // 3. CAS state recovery
    db.exec("BEGIN IMMEDIATE;");
    let committed = false;
    try {
      // Mark claim released
      db.prepare("UPDATE task_claims SET released_at = ? WHERE id = ?").run(now, claim.id);

      const nextVersion = claim.task_version + 1;
      const willRetry = claim.retry_count < claim.max_retries;

      if (willRetry) {
        const nextRetryCount = claim.retry_count + 1;
        db.prepare(`
          UPDATE tasks
          SET status = 'pending', retry_count = ?, version = ?, failure_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextRetryCount,
          nextVersion,
          `Worker process ${claim.worker_pid} died; recovered lease`,
          now,
          claim.task_id,
        );

        db.prepare(`
          INSERT INTO task_events (task_id, event_type, payload_json, created_at)
          VALUES (?, 'task_recovered', ?, ?)
        `).run(
          claim.task_id,
          JSON.stringify({
            deadPid: claim.worker_pid,
            retryCount: nextRetryCount,
            recoveryBranch: preservation.branch ?? null,
          }),
          now,
        );

        results.push({
          taskId: claim.task_id,
          ownerToken: claim.owner_token,
          action: "recovered",
          reason: `Worker PID ${claim.worker_pid} terminated unexpectedly; re-queued (retry ${nextRetryCount}/${claim.max_retries})`,
          recoveryBranch: preservation.branch ?? null,
        });
      } else {
        // Retry budget exhausted -> quarantine as failed
        db.prepare(`
          UPDATE tasks
          SET status = 'failed', version = ?, failure_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(
          nextVersion,
          `Worker process ${claim.worker_pid} died; max retries (${claim.max_retries}) exhausted`,
          now,
          claim.task_id,
        );

        db.prepare(`
          INSERT INTO task_events (task_id, event_type, payload_json, created_at)
          VALUES (?, 'task_failed', ?, ?)
        `).run(
          claim.task_id,
          JSON.stringify({
            deadPid: claim.worker_pid,
            quarantined: true,
            recoveryBranch: preservation.branch ?? null,
          }),
          now,
        );

        results.push({
          taskId: claim.task_id,
          ownerToken: claim.owner_token,
          action: "quarantined",
          reason: `Worker PID ${claim.worker_pid} died; retry budget exhausted (${claim.max_retries})`,
          recoveryBranch: preservation.branch ?? null,
        });
      }

      db.exec("COMMIT;");
      committed = true;
    } finally {
      if (!committed) {
        try {
          db.exec("ROLLBACK;");
        } catch {}
      }
    }
  }

  return results;
}
