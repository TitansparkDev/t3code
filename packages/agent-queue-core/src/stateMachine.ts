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
