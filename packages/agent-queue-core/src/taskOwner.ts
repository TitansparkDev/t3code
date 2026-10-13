// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Who is accountable for a task. The owner is one conversation (a reference the caller
 * understands, for T3 Code a thread id) from the first line of code to the verified integration:
 * it outlives the claim (held only while the worker is active), the candidate (waiting to merge)
 * and every repair. Another conversation takes over only when the owner cannot continue, and that
 * is recorded, so a task is never silently handed from worker to worker.
 *
 * @module taskOwner
 */
import type * as NodeSqlite from "node:sqlite";
import { recordEvent } from "./eventStream.ts";

export interface TaskOwner {
  readonly ownerRef: string | null;
  /** Times a worker turn has been started on this task under any owner. */
  readonly turns: number;
}

export function ownerOf(db: NodeSqlite.DatabaseSync, taskId: string): TaskOwner {
  const row = db.prepare("SELECT owner_ref, owner_turns FROM tasks WHERE id = ?").get(taskId) as
    | { owner_ref: string | null; owner_turns: number }
    | undefined;
  return { ownerRef: row?.owner_ref ?? null, turns: row?.owner_turns ?? 0 };
}

/** Records the conversation working on a task now. A different one than before is an event. */
export function bindOwner(db: NodeSqlite.DatabaseSync, taskId: string, ownerRef: string): void {
  const before = ownerOf(db, taskId);
  db.prepare("UPDATE tasks SET owner_ref = ?, owner_turns = owner_turns + 1 WHERE id = ?").run(
    ownerRef,
    taskId,
  );
  if (before.ownerRef !== null && before.ownerRef !== ownerRef) {
    recordEvent(db, taskId, "task_owner_changed", { from: before.ownerRef, to: ownerRef });
  }
}

/** The task whose owner should take a follow-up task: the follow-up's parent, when it is one. */
export function inheritedOwner(db: NodeSqlite.DatabaseSync, taskId: string): string | null {
  const match = /^(.*)-FU\d+$/.exec(taskId);
  if (!match) return null;
  return ownerOf(db, match[1]!).ownerRef;
}
