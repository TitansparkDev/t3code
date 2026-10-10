// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { hasScopeConflict } from "./scopeManager.ts";

export interface ClaimRequest {
  readonly taskId: string;
  readonly workerPid: number;
  readonly workerSessionId?: string | null;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leaseSeconds?: number;
}

export interface TaskClaim {
  readonly id: number;
  readonly taskId: string;
  readonly ownerToken: string;
  readonly workerPid: number;
  readonly workerSessionId: string | null;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leasedAt: string;
  readonly heartbeatAt: string;
  readonly expiresAt: string;
  readonly releasedAt: string | null;
}

export type ClaimResult =
  | { readonly success: true; readonly claim: TaskClaim; readonly version: number }
  | { readonly success: false; readonly reason: string };

/**
 * Attempts to claim a task using Compare-And-Swap (CAS) in an IMMEDIATE transaction.
 * Fails gracefully if another worker won the race or dependencies/scopes conflict.
 */
export function claimTask(db: NodeSqlite.DatabaseSync, req: ClaimRequest): ClaimResult {
  const leaseSeconds = req.leaseSeconds ?? 120;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const ownerToken = `claim_${NodeCrypto.randomUUID()}`;

  db.exec("BEGIN IMMEDIATE;");
  try {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.taskId) as
      | {
          id: string;
          status: string;
          version: number;
          dependencies: string;
          scope_patterns: string;
        }
      | undefined;

    if (!task) {
      db.exec("ROLLBACK;");
      return { success: false, reason: "TASK_NOT_FOUND" };
    }

    if (task.status !== "pending") {
      db.exec("ROLLBACK;");
      return { success: false, reason: `TASK_NOT_PENDING (status=${task.status})` };
    }

    // Check dependencies
    const deps: string[] = JSON.parse(task.dependencies || "[]");
    if (deps.length > 0) {
      const placeholders = deps.map(() => "?").join(",");
      const incomplete = db
        .prepare(
          `SELECT count(*) as cnt FROM tasks WHERE id IN (${placeholders}) AND status != 'completed'`,
        )
        .get(...deps) as { cnt: number };

      if (incomplete.cnt > 0) {
        db.exec("ROLLBACK;");
        return { success: false, reason: "UNMET_DEPENDENCIES" };
      }
    }

    // Check scope conflicts against other active claims
    const candidateScopes: string[] = JSON.parse(task.scope_patterns || "[]");
    if (candidateScopes.length > 0) {
      const activeTasks = db
        .prepare(`
          SELECT t.id, t.scope_patterns
          FROM tasks t
          JOIN task_claims c ON t.id = c.task_id
          WHERE c.released_at IS NULL AND c.expires_at > ?
        `)
        .all(now) as Array<{ id: string; scope_patterns: string }>;

      const activeDescriptors = activeTasks.map((at) => ({
        taskId: at.id,
        patterns: JSON.parse(at.scope_patterns || "[]") as string[],
      }));

      if (hasScopeConflict({ taskId: task.id, patterns: candidateScopes }, activeDescriptors)) {
        db.exec("ROLLBACK;");
        return { success: false, reason: "SCOPE_CONFLICT" };
      }
    }

    // CAS Update task
    const nextVersion = task.version + 1;
    const updateResult = db
      .prepare(`
        UPDATE tasks
        SET status = 'claimed', version = ?, updated_at = ?
        WHERE id = ? AND version = ?
      `)
      .run(nextVersion, now, task.id, task.version);

    if (updateResult.changes !== 1) {
      db.exec("ROLLBACK;");
      return { success: false, reason: "CAS_VERSION_MISMATCH" };
    }

    // Insert claim record
    const insertClaim = db
      .prepare(`
        INSERT INTO task_claims (
          task_id, owner_token, worker_pid, worker_session_id,
          worktree_path, branch, leased_at, heartbeat_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        ownerToken,
        req.workerPid,
        req.workerSessionId ?? null,
        req.worktreePath ?? null,
        req.branch ?? null,
        now,
        now,
        expiresAt,
      );

    const claimId = Number(insertClaim.lastInsertRowid);

    // Emit event into durable outbox
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES (?, 'task_claimed', ?, ?)
    `).run(task.id, JSON.stringify({ ownerToken, workerPid: req.workerPid }), now);

    db.exec("COMMIT;");

    const claim: TaskClaim = {
      id: claimId,
      taskId: task.id,
      ownerToken,
      workerPid: req.workerPid,
      workerSessionId: req.workerSessionId ?? null,
      worktreePath: req.worktreePath,
      branch: req.branch,
      leasedAt: now,
      heartbeatAt: now,
      expiresAt,
      releasedAt: null,
    };

    return { success: true, claim, version: nextVersion };
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Renews an active lease.
 */
export function renewLease(
  db: NodeSqlite.DatabaseSync,
  ownerToken: string,
  extensionSeconds = 120,
): boolean {
  const now = new Date().toISOString();
  const nextExpiresAt = new Date(Date.now() + extensionSeconds * 1000).toISOString();

  const result = db
    .prepare(`
      UPDATE task_claims
      SET heartbeat_at = ?, expires_at = ?
      WHERE owner_token = ? AND released_at IS NULL
    `)
    .run(now, nextExpiresAt, ownerToken);

  return result.changes === 1;
}

/**
 * Releases a claim, recording final task status and emitting an event.
 */
export function releaseClaim(
  db: NodeSqlite.DatabaseSync,
  options: {
    ownerToken: string;
    finalStatus: "completed" | "failed" | "pending";
    failureReason?: string | null;
  },
): boolean {
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE;");
  try {
    const claim = db
      .prepare("SELECT * FROM task_claims WHERE owner_token = ? AND released_at IS NULL")
      .get(options.ownerToken) as { id: number; task_id: string } | undefined;

    if (!claim) {
      db.exec("ROLLBACK;");
      return false;
    }

    // Mark claim released
    db.prepare("UPDATE task_claims SET released_at = ? WHERE id = ?").run(now, claim.id);

    // Update task
    const task = db.prepare("SELECT version FROM tasks WHERE id = ?").get(claim.task_id) as {
      version: number;
    };
    const nextVersion = (task?.version ?? 0) + 1;

    db.prepare(`
      UPDATE tasks
      SET status = ?, version = ?, failure_reason = ?, updated_at = ?
      WHERE id = ?
    `).run(options.finalStatus, nextVersion, options.failureReason ?? null, now, claim.task_id);

    // Emit event
    const eventType =
      options.finalStatus === "completed"
        ? "task_landed"
        : options.finalStatus === "failed"
          ? "task_failed"
          : "task_released";

    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(claim.task_id, eventType, JSON.stringify({ ownerToken: options.ownerToken }), now);

    db.exec("COMMIT;");
    return true;
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}
