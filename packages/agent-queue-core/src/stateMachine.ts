// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";

export type QueueTaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "blocked";

export class InvalidStateTransitionError extends Error {
  public readonly taskId: string;
  public readonly fromStatus: string;
  public readonly toStatus: string;
  constructor(taskId: string, fromStatus: string, toStatus: string) {
    super(`Invalid task state transition for ${taskId}: '${fromStatus}' -> '${toStatus}'`);
    this.name = "InvalidStateTransitionError";
    this.taskId = taskId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

const ALLOWED_TRANSITIONS: Readonly<Record<QueueTaskStatus, ReadonlyArray<QueueTaskStatus>>> = {
  pending: ["claimed", "blocked"],
  claimed: ["running", "pending", "failed"],
  running: ["verifying", "failed", "pending"],
  verifying: ["completed", "failed"],
  failed: ["pending", "blocked"],
  blocked: ["pending", "failed"],
  completed: [], // Terminal
};

export function isAllowedTransition(from: QueueTaskStatus, to: QueueTaskStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

export interface TransitionOptions {
  readonly taskId: string;
  readonly expectedStatus?: QueueTaskStatus;
  readonly nextStatus: QueueTaskStatus;
  readonly note?: string | null;
  readonly failureReason?: string | null;
}

export function transitionTask(
  db: NodeSqlite.DatabaseSync,
  opts: TransitionOptions,
): { success: boolean; version: number } {
  db.exec("BEGIN IMMEDIATE;");
  let committed = false;
  try {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(opts.taskId) as
      | {
          id: string;
          status: QueueTaskStatus;
          version: number;
        }
      | undefined;

    if (!task) {
      throw new Error(`Task ${opts.taskId} not found`);
    }

    if (opts.expectedStatus && task.status !== opts.expectedStatus) {
      throw new InvalidStateTransitionError(opts.taskId, task.status, opts.nextStatus);
    }

    if (!isAllowedTransition(task.status, opts.nextStatus)) {
      throw new InvalidStateTransitionError(opts.taskId, task.status, opts.nextStatus);
    }

    const nextVersion = task.version + 1;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE tasks
      SET status = ?, version = ?, failure_reason = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(opts.nextStatus, nextVersion, opts.failureReason ?? null, now, task.id, task.version);

    // Record transition event with note
    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES (?, 'status_transition', ?, ?)
    `).run(
      task.id,
      JSON.stringify({
        from: task.status,
        to: opts.nextStatus,
        note: opts.note ?? null,
        failureReason: opts.failureReason ?? null,
      }),
      now,
    );

    db.exec("COMMIT;");
    committed = true;
    return { success: true, version: nextVersion };
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Transaction may already be aborted
      }
    }
  }
}

export const MIN_WAIVER_REASON_LENGTH = 10;

const WAIVABLE_STATUSES: ReadonlyArray<QueueTaskStatus> = ["pending", "failed", "blocked"];
const DEPENDENT_STARTED_STATUSES: ReadonlyArray<QueueTaskStatus> = [
  "claimed",
  "running",
  "verifying",
  "completed",
];

export interface WaiveTaskOptions {
  readonly taskId: string;
  readonly reason: string;
}

/**
 * Drops a task the plan no longer needs: it becomes 'completed' with a recorded reason, so
 * its dependants are satisfied. Waived tasks are settled, never failed.
 */
export function waiveTask(
  db: NodeSqlite.DatabaseSync,
  opts: WaiveTaskOptions,
): { success: boolean; version: number } {
  const reason = opts.reason.trim();
  if (reason.length < MIN_WAIVER_REASON_LENGTH) {
    throw new Error(
      `Waiver reason for ${opts.taskId} must be at least ${MIN_WAIVER_REASON_LENGTH} characters: "${reason}"`,
    );
  }

  db.exec("BEGIN IMMEDIATE;");
  let committed = false;
  try {
    const task = db
      .prepare("SELECT id, status, version FROM tasks WHERE id = ?")
      .get(opts.taskId) as { id: string; status: QueueTaskStatus; version: number } | undefined;
    if (!task) {
      throw new Error(`Task ${opts.taskId} not found`);
    }
    if (!WAIVABLE_STATUSES.includes(task.status)) {
      throw new Error(
        `Task ${opts.taskId} cannot be waived from '${task.status}' (reason: "${reason}"); only pending, failed or blocked tasks can be waived`,
      );
    }

    const nextVersion = task.version + 1;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = 'completed', version = ?, failure_reason = NULL, waived_reason = ?, waived_at = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(nextVersion, reason, now, now, task.id, task.version);

    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES (?, 'task_waived', ?, ?)
    `).run(task.id, JSON.stringify({ from: task.status, reason }), now);

    db.exec("COMMIT;");
    committed = true;
    return { success: true, version: nextVersion };
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Transaction may already be aborted
      }
    }
  }
}

/** Returns a waived task to 'pending', unless a task that depends on it has already started. */
export function unwaiveTask(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
): { success: boolean; version: number } {
  db.exec("BEGIN IMMEDIATE;");
  let committed = false;
  try {
    const task = db
      .prepare("SELECT id, version, waived_reason FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; version: number; waived_reason: string | null } | undefined;
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (task.waived_reason === null) {
      throw new Error(`Task ${taskId} is not waived`);
    }

    const startedDependents = (
      db
        .prepare(
          `SELECT id, status FROM tasks
           WHERE EXISTS (SELECT 1 FROM json_each(tasks.dependencies) WHERE value = ?)
           ORDER BY id`,
        )
        .all(taskId) as Array<{ id: string; status: QueueTaskStatus }>
    ).filter((dependent) => DEPENDENT_STARTED_STATUSES.includes(dependent.status));
    if (startedDependents.length > 0) {
      throw new Error(
        `Task ${taskId} cannot be unwaived: dependents already started: ${startedDependents.map((dependent) => dependent.id).join(", ")}`,
      );
    }

    const nextVersion = task.version + 1;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = 'pending', version = ?, waived_reason = NULL, waived_at = NULL, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(nextVersion, now, task.id, task.version);

    db.prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES (?, 'task_unwaived', '{}', ?)
    `).run(task.id, now);

    db.exec("COMMIT;");
    committed = true;
    return { success: true, version: nextVersion };
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Transaction may already be aborted
      }
    }
  }
}
