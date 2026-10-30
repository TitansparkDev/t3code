// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { conflictingTasks } from "./scopeManager.ts";
import {
  classifyReason,
  decideAfterFailure,
  failureSignature,
  holdTask,
  recordFailure,
  type FailureClass,
} from "./failures.ts";

export interface ClaimRequest {
  readonly taskId: string;
  readonly workerPid: number;
  readonly workerSessionId?: string | null;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leaseSeconds?: number;
  /** Claim a submitted candidate that needs a merge repair, not an unstarted task. */
  readonly repair?: boolean;
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
          integration_state: string | null;
          failure_class: string | null;
        }
      | undefined;

    if (!task) {
      db.exec("ROLLBACK;");
      return { success: false, reason: "TASK_NOT_FOUND" };
    }

    if (task.failure_class === "owner") {
      db.exec("ROLLBACK;");
      return { success: false, reason: "OWNER_TASK" };
    }

    const repairing = req.repair === true;
    if (
      repairing
        ? !(task.status === "verifying" && task.integration_state === "conflict")
        : task.status !== "pending"
    ) {
      db.exec("ROLLBACK;");
      return {
        success: false,
        reason: `${repairing ? "TASK_NOT_REPAIRABLE" : "TASK_NOT_PENDING"} (status=${task.status}${task.integration_state ? `, integration=${task.integration_state}` : ""})`,
      };
    }

    // Check dependencies
    const deps: string[] = JSON.parse(task.dependencies || "[]");
    if (deps.length > 0 && !repairing) {
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
          WHERE c.released_at IS NULL
        `)
        .all() as Array<{ id: string; scope_patterns: string }>;

      const activeDescriptors = activeTasks.map((at) => ({
        taskId: at.id,
        patterns: JSON.parse(at.scope_patterns || "[]") as string[],
      }));

      const holders = conflictingTasks(
        { taskId: task.id, patterns: candidateScopes },
        activeDescriptors,
      );
      if (holders.length > 0) {
        db.exec("ROLLBACK;");
        // Who holds the files is the whole diagnosis: say it, so nobody has to guess.
        return { success: false, reason: `SCOPE_CONFLICT (held by ${holders.join(", ")})` };
      }
    }

    // CAS Update task
    // One active owner per worktree and per branch, whoever asks and whatever the task: the
    // database also enforces this, but a clear refusal beats a constraint error.
    const owned = db
      .prepare(
        "SELECT task_id FROM task_claims WHERE released_at IS NULL AND task_id != ? AND (worktree_path = ? OR branch = ?)",
      )
      .get(task.id, req.worktreePath, req.branch) as { task_id: string } | undefined;
    if (owned) {
      db.exec("ROLLBACK;");
      return { success: false, reason: `WORKTREE_OWNED (by ${owned.task_id})` };
    }

    const nextVersion = task.version + 1;
    const updateResult = db
      .prepare(`
        UPDATE tasks
        SET status = 'claimed', version = ?, updated_at = ?,
            integration_state = CASE WHEN ? = 1 THEN 'repairing' ELSE integration_state END
        WHERE id = ? AND version = ?
      `)
      .run(nextVersion, now, repairing ? 1 : 0, task.id, task.version);

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
    const task = db
      .prepare("SELECT version, integration_state FROM tasks WHERE id = ?")
      .get(claim.task_id) as { version: number; integration_state: string | null };
    const nextVersion = (task?.version ?? 0) + 1;

    if (task?.integration_state === "repairing" && options.finalStatus === "pending") {
      // A repair worker that stopped hands the candidate back to be repaired again.
      db.prepare(
        "UPDATE tasks SET status = 'verifying', integration_state = 'conflict', version = ?, updated_at = ? WHERE id = ?",
      ).run(nextVersion, now, claim.task_id);
    } else {
      db.prepare(`
        UPDATE tasks
        SET status = ?, version = ?, failure_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(options.finalStatus, nextVersion, options.failureReason ?? null, now, claim.task_id);
    }

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

/**
 * Ends a claim whose work did not land. The task goes back to `pending` for another
 * attempt until its retry budget is spent, then becomes `failed` for the overseer.
 * Commits on the task's branch are untouched, so the next attempt resumes from them.
 */
export function releaseClaimForRetry(
  db: NodeSqlite.DatabaseSync,
  ownerToken: string,
  reason: string,
  options: {
    /** Defaults to a reading of `reason`. */
    readonly failureClass?: FailureClass;
    /** The environment the failure happened in; a held task waits for it to change. */
    readonly fingerprint?: string | null;
    readonly headCommit?: string | null;
    /** False when the caller already recorded this failure (a submission's own verdict). */
    readonly record?: boolean;
  } = {},
): { readonly released: boolean; readonly exhausted: boolean; readonly held?: boolean } {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const claim = db
      .prepare("SELECT id, task_id FROM task_claims WHERE owner_token = ? AND released_at IS NULL")
      .get(ownerToken) as { id: number; task_id: string } | undefined;
    if (!claim) {
      db.exec("ROLLBACK;");
      return { released: false, exhausted: false };
    }
    const task = db
      .prepare(
        "SELECT version, retry_count, max_retries, integration_state, integration_attempts FROM tasks WHERE id = ?",
      )
      .get(claim.task_id) as {
      version: number;
      retry_count: number;
      max_retries: number;
      integration_state: string | null;
      integration_attempts: number;
    };
    db.prepare("UPDATE task_claims SET released_at = ? WHERE id = ?").run(now, claim.id);
    if (task.integration_state === "repairing") {
      // A failed repair attempt: try again, or ask the overseer once the budget is spent.
      const attempts = task.integration_attempts + 1;
      const exhausted = attempts > task.max_retries;
      db.prepare(
        "UPDATE tasks SET status = 'verifying', integration_state = ?, integration_attempts = ?, integration_error = ?, version = ?, updated_at = ? WHERE id = ?",
      ).run(
        exhausted ? "repair_needed" : "conflict",
        attempts,
        reason,
        task.version + 1,
        now,
        claim.task_id,
      );
      db.prepare(
        "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(
        claim.task_id,
        exhausted ? "task_repair_needed" : "task_repair_failed",
        JSON.stringify({ ownerToken, reason: reason.slice(0, 500), attempts }),
        now,
      );
      db.exec("COMMIT;");
      return { released: true, exhausted };
    }
    // The failure is classified and remembered. A deterministic one, or one that keeps coming
    // back unchanged, must not cost another worker: the task is held with its evidence.
    const failureClass = options.failureClass ?? classifyReason(reason);
    const recorded =
      options.record === false
        ? null
        : recordFailure(db, claim.task_id, {
            failureClass,
            message: reason,
            headCommit: options.headCommit ?? null,
          });
    const decision = recorded
      ? decideAfterFailure(failureClass, recorded)
      : ({ action: "retry" } as const);
    if (recorded && decision.action === "hold") {
      db.prepare(
        "UPDATE tasks SET status = 'pending', version = ?, updated_at = ? WHERE id = ?",
      ).run(task.version + 1, now, claim.task_id);
      holdTask(db, claim.task_id, {
        failureClass,
        message: `${reason} (${decision.why})`,
        signature: recorded.signature,
        fingerprint: options.fingerprint ?? null,
      });
      db.exec("COMMIT;");
      return { released: true, exhausted: false, held: true };
    }
    const retryCount = task.retry_count + 1;
    const exhausted = retryCount > task.max_retries;
    db.prepare(
      "UPDATE tasks SET status = ?, retry_count = ?, version = ?, failure_reason = ?, updated_at = ? WHERE id = ?",
    ).run(
      exhausted ? "failed" : "pending",
      retryCount,
      task.version + 1,
      reason,
      now,
      claim.task_id,
    );
    db.prepare(
      "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      claim.task_id,
      exhausted ? "task_failed" : "task_requeued",
      JSON.stringify({ ownerToken, reason: reason.slice(0, 500), retryCount }),
      now,
    );
    db.exec("COMMIT;");
    return { released: true, exhausted };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

/**
 * Ends a claim and parks the task: its failure repeats, or cannot be cured by another worker.
 * The task's branch and commits are untouched. With a fingerprint it comes back by itself
 * when the environment changes; without one it waits for the overseer or a person.
 */
export function holdClaim(
  db: NodeSqlite.DatabaseSync,
  ownerToken: string,
  input: {
    readonly failureClass: FailureClass;
    readonly reason: string;
    readonly fingerprint: string | null;
  },
): boolean {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE;");
  try {
    const claim = db
      .prepare("SELECT id, task_id FROM task_claims WHERE owner_token = ? AND released_at IS NULL")
      .get(ownerToken) as { id: number; task_id: string } | undefined;
    if (!claim) {
      db.exec("ROLLBACK;");
      return false;
    }
    db.prepare("UPDATE task_claims SET released_at = ? WHERE id = ?").run(now, claim.id);
    holdTask(db, claim.task_id, {
      failureClass: input.failureClass,
      message: input.reason,
      signature: failureSignature(input.failureClass, input.reason),
      fingerprint: input.fingerprint,
    });
    db.exec("COMMIT;");
    return true;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
