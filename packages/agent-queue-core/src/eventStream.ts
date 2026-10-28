// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";

export interface StoredQueueEvent {
  readonly id: number;
  readonly taskId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface EventBatch {
  readonly events: ReadonlyArray<StoredQueueEvent>;
  readonly lastEventId: number;
}

export interface AuditEntrySummary {
  readonly total: number;
  readonly completed: number;
  readonly audited: number;
  readonly passed: number;
  readonly failed: number;
  readonly otherAuditStates: number;
  /** Completed entries without a persisted audit result; historical absence stays unknown. */
  readonly unknown: number;
}

export interface PlanAuditSummary {
  readonly originalTasks: AuditEntrySummary;
  readonly repairEntries: AuditEntrySummary & { readonly created: number };
  readonly unclassifiedEntries: AuditEntrySummary;
}

/**
 * Appends a durable event to the task_events outbox.
 */
export function recordEvent(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): number {
  const now = new Date().toISOString();
  const res = db
    .prepare(`
      INSERT INTO task_events (task_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
    .run(taskId, eventType, JSON.stringify(payload), now);

  return Number(res.lastInsertRowid);
}

/**
 * Reads events sequentially from the event outbox starting after sinceEventId.
 */
export function getEventsSince(
  db: NodeSqlite.DatabaseSync,
  sinceEventId = 0,
  limit = 100,
): EventBatch {
  const rows = db
    .prepare(`
      SELECT id, task_id, event_type, payload_json, created_at
      FROM task_events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `)
    .all(sinceEventId, limit) as Array<{
    id: number;
    task_id: string;
    event_type: string;
    payload_json: string;
    created_at: string;
  }>;

  const events: StoredQueueEvent[] = rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    eventType: r.event_type,
    payload: JSON.parse(r.payload_json || "{}"),
    createdAt: r.created_at,
  }));

  const lastEventId = events.length > 0 ? events[events.length - 1]!.id : sinceEventId;

  return { events, lastEventId };
}

/** Summarize durable audit outcomes while keeping repair entries separate from their parent tasks. */
export function summarizePlanAudit(db: NodeSqlite.DatabaseSync, planId: string): PlanAuditSummary {
  const tasks = db.prepare("SELECT id, status FROM tasks WHERE plan_id = ?").all(planId) as Array<{
    id: string;
    status: string;
  }>;
  const events = db
    .prepare(
      `SELECT e.task_id, e.event_type, e.payload_json FROM task_events e
       JOIN tasks t ON t.id = e.task_id WHERE t.plan_id = ?
       AND e.event_type IN ('task_imported','task_synced','task_followup_created','task_audited')
       ORDER BY e.id`,
    )
    .all(planId) as Array<{ task_id: string; event_type: string; payload_json: string }>;
  const repairs = new Set<string>();
  const originals = new Set<string>();
  const audits = new Map<string, string>();
  for (const event of events) {
    if (event.event_type === "task_imported" || event.event_type === "task_synced") {
      originals.add(event.task_id);
      continue;
    }
    let payload: { kind?: unknown; state?: unknown };
    try {
      payload = JSON.parse(event.payload_json) as typeof payload;
    } catch {
      if (event.event_type === "task_audited") audits.set(event.task_id, "unknown");
      continue;
    }
    if (event.event_type === "task_followup_created" && payload.kind === "repair") {
      repairs.add(event.task_id);
    } else if (event.event_type === "task_audited") {
      audits.set(event.task_id, typeof payload.state === "string" ? payload.state : "unknown");
    }
  }
  const summarize = (entries: ReadonlyArray<{ id: string; status: string }>): AuditEntrySummary => {
    const completed = entries.filter((task) => task.status === "completed");
    const states = completed.map((task) => audits.get(task.id));
    const audited = states.filter((state) => state !== undefined);
    const passed = audited.filter((state) => state === "passed").length;
    const failed = audited.filter((state) => state === "failed" || state === "timed-out").length;
    return {
      total: entries.length,
      completed: completed.length,
      audited: audited.length,
      passed,
      failed,
      otherAuditStates: audited.length - passed - failed,
      unknown: completed.length - audited.length,
    };
  };
  const repairTasks = tasks.filter((task) => repairs.has(task.id));
  const originalTasks = tasks.filter((task) => originals.has(task.id) && !repairs.has(task.id));
  return {
    originalTasks: summarize(originalTasks),
    repairEntries: { ...summarize(repairTasks), created: repairTasks.length },
    unclassifiedEntries: summarize(
      tasks.filter((task) => !originals.has(task.id) && !repairs.has(task.id)),
    ),
  };
}

/**
 * Polls for new events or resolves when timeout expires.
 */
export async function pollEventsSince(
  db: NodeSqlite.DatabaseSync,
  sinceEventId: number,
  timeoutMs = 2000,
  pollIntervalMs = 50,
): Promise<EventBatch> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const batch = getEventsSince(db, sinceEventId);
    if (batch.events.length > 0) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { events: [], lastEventId: sinceEventId };
}
