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
