// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
  const indexPath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agentqueue-index-"));
  const indexFile = NodePath.join(indexPath, "index");
  const gitEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    NodeChildProcess.execFileSync("git", ["read-tree", "HEAD"], { cwd: worktreePath, env: gitEnv });
    NodeChildProcess.execFileSync("git", ["add", "-A"], { cwd: worktreePath, env: gitEnv, stdio: "ignore" });
    const tree = NodeChildProcess.execFileSync("git", ["write-tree"], {
      cwd: worktreePath, env: gitEnv, encoding: "utf8",
    }).trim();
    const headTree = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: worktreePath, encoding: "utf8",
    }).trim();
    if (tree === headTree) return { saved: false };
    const commit = NodeChildProcess.execFileSync("git", [
      "commit-tree", tree, "-p", "HEAD", "-m", `AgentQueue recovery snapshot for ${taskId}`,
    ], { cwd: worktreePath, encoding: "utf8" }).trim();
    NodeChildProcess.execFileSync("git", ["branch", branch, commit], { cwd: worktreePath });
    return { saved: true, branch };
  } catch {
    // Non-fatal if git commit fails
  } finally {
    NodeFS.rmSync(indexPath, { recursive: true, force: true });
  }

  return { saved: false };
}

/**
 * Scans for expired leases, verifies worker liveness, preserves partial work,
 * and recovers or quarantines tasks.
 */
export function reconcileExpiredLeases(
  db: NodeSqlite.DatabaseSync,
  options: { readonly isOwnerAlive?: (pid: number, sessionId: string | null) => boolean } = {},
): LeaseRecoveryResult[] {
  const isAlive = options.isOwnerAlive ?? ((pid: number) => isProcessAlive(pid));
  const now = new Date().toISOString();
  const results: LeaseRecoveryResult[] = [];

  const expiredClaims = db
    .prepare(`
      SELECT c.*, t.retry_count, t.max_retries, t.version as task_version
      FROM task_claims c
      JOIN tasks t ON c.task_id = t.id
      WHERE c.released_at IS NULL AND c.expires_at <= ?
        AND t.status IN ('claimed', 'running', 'verifying')
    `)
    .all(now) as Array<{
    id: number;
    task_id: string;
    owner_token: string;
    worker_pid: number;
    worker_session_id: string | null;
    worktree_path: string;
    branch: string;
    retry_count: number;
    max_retries: number;
    task_version: number;
  }>;

  // A claim whose task already finished (landed, failed or blocked) only needs closing.
  db.prepare(`
    UPDATE task_claims SET released_at = ?
    WHERE released_at IS NULL AND expires_at <= ?
      AND task_id IN (SELECT id FROM tasks WHERE status IN ('completed', 'failed', 'blocked', 'pending'))
  `).run(now, now);

  for (const claim of expiredClaims) {
    // 1. Liveness check: If the PID is still alive, do not break the lease
    if (isAlive(claim.worker_pid, claim.worker_session_id)) {
      results.push({
        taskId: claim.task_id,
        ownerToken: claim.owner_token,
        action: "retained_alive",
        reason: `Worker PID ${claim.worker_pid} is still executing`,
      });
      continue;
    }

    const preservation = preserveWorktreeChanges(claim.worktree_path, claim.task_id);
    // Recheck under the write lock before updating the claim: another process may have renewed
    // this lease after the expired-claim snapshot was read.
    db.exec("BEGIN IMMEDIATE;");
    let committed = false;
    try {
      const current = db
        .prepare(`SELECT c.id FROM task_claims c JOIN tasks t ON t.id = c.task_id
        WHERE c.id = ? AND c.released_at IS NULL AND c.expires_at <= ? AND t.version = ?
        AND t.status IN ('claimed', 'running', 'verifying')`)
        .get(claim.id, now, claim.task_version);
      if (!current || isAlive(claim.worker_pid, claim.worker_session_id)) {
        db.exec("ROLLBACK;");
        if (preservation.branch) {
          NodeChildProcess.execFileSync("git", ["branch", "-D", preservation.branch], { cwd: claim.worktree_path });
        }
        continue;
      }
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
