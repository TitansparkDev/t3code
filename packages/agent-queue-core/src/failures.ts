// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/** Failure classification and recovery policy. */
import type * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import { recordEvent } from "./eventStream.ts";

export type FailureClass =
  | "transient"
  | "configuration"
  | "prerequisite"
  | "external"
  | "verification"
  | "scope"
  | "merge-conflict"
  | "resource"
  | "owner";

/** Classes that cannot be cured by sending another worker. */
export const DETERMINISTIC_CLASSES: ReadonlySet<FailureClass> = new Set([
  "configuration",
  "prerequisite",
  "external",
  "owner",
]);

const RULES: ReadonlyArray<readonly [RegExp, FailureClass]> = [
  [
    /usage limit|rate.?limit|overloaded|temporar|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|worker (process )?\d* ?(died|was stopped)|never started|turn failed|lease/i,
    "transient",
  ],
  [
    /checkout guard|refus(es|ed|ing) to work outside|branch .{0,80}(not (permitted|allowed|accepted)|rejected|does not match)|only permits? `?agent|guard (rejects|rejected)|pre-?flight (check )?(failed|rejected)/i,
    "configuration",
  ],
  [
    /command not found|not installed|executable .{0,40}(missing|not found)|ENOENT.{0,80}\b(spawn|exec)|no such (command|tool)|missing (tool|prerequisite|dependency)|SDK location not found|JAVA_HOME is not set|Unable to locate a Java Runtime/i,
    "prerequisite",
  ],
  [
    /production access|live (apply|host|database|service)|recovery key|credential|secret|login required|authenticat|permission denied|not authori[sz]ed|a person (with|must)/i,
    "external",
  ],
  [/out.of.scope|outside .{0,40}scope|scope (guard|violation|audit)/i, "scope"],
  [
    /address already in use|EADDRINUSE|already exists.{0,40}(database|container|volume)|database .{0,40}already|resource busy|is locked by|port .{0,20}in use/i,
    "resource",
  ],
  [/merge conflict|conflicts? in:|CONFLICT \(/i, "merge-conflict"],
];

/** Best-effort class of a free-text reason. Typed callers should pass the class themselves. */
export function classifyReason(reason: string): FailureClass {
  for (const [pattern, failureClass] of RULES) {
    if (pattern.test(reason)) return failureClass;
  }
  return "transient";
}

/** A stable identity for "the same failure": volatile parts (paths, ids, numbers) are removed. */
export function failureSignature(failureClass: FailureClass, message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(/(?:\/[\w.@+-]+){2,}/g, "<path>")
    .replace(/\b[0-9a-f]{7,40}\b/g, "<hex>")
    .replace(/\b(?:agent(?:queue)?|salvage|recovery)\/[\w./-]+/g, "<branch>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return NodeCrypto.createHash("sha1")
    .update(`${failureClass}:${normalized}`)
    .digest("hex")
    .slice(0, 16);
}

export interface RecordedFailure {
  readonly signature: string;
  /** Consecutive most recent failures of this task with this signature, this one included. */
  readonly repeats: number;
  /** Consecutive repeats that also left the task's head commit unchanged. */
  readonly repeatsWithoutChange: number;
}

export function recordFailure(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  input: {
    readonly failureClass: FailureClass;
    readonly message: string;
    readonly headCommit?: string | null;
    readonly evidence?: unknown;
  },
): RecordedFailure {
  const signature = failureSignature(input.failureClass, input.message);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_failures (task_id, class, signature, message, head_commit, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    input.failureClass,
    signature,
    input.message.slice(0, 2000),
    input.headCommit ?? null,
    JSON.stringify(input.evidence ?? {}),
    now,
  );
  const recent = db
    .prepare(
      "SELECT signature, head_commit FROM task_failures WHERE task_id = ? ORDER BY id DESC LIMIT 20",
    )
    .all(taskId) as Array<{ signature: string; head_commit: string | null }>;
  let repeats = 0;
  let repeatsWithoutChange = 0;
  const head = input.headCommit ?? null;
  for (const row of recent) {
    if (row.signature !== signature) break;
    repeats++;
    if ((row.head_commit ?? null) === head) repeatsWithoutChange++;
  }
  recordEvent(db, taskId, "task_failure_recorded", {
    class: input.failureClass,
    signature,
    repeats,
    message: input.message.slice(0, 300),
  });
  return { signature, repeats, repeatsWithoutChange };
}

/**
 * A held task whose last two recorded failures are the same failure on the same commit.
 * Retrying it as it stands only repeats the work (SA8 re-ran a 4 minute red gate on
 * `c933f7e8f` four times), so a manual retry must come with a change or an explicit force.
 */
export function unchangedHeldFailure(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
): { readonly signature: string; readonly headCommit: string | null } | null {
  const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
    | { status: string }
    | undefined;
  if (task?.status !== "blocked") return null;
  const rows = db
    .prepare(
      "SELECT signature, head_commit FROM task_failures WHERE task_id = ? ORDER BY id DESC LIMIT 2",
    )
    .all(taskId) as Array<{ signature: string; head_commit: string | null }>;
  const [a, b] = rows;
  if (!a || !b || a.signature !== b.signature) return null;
  if ((a.head_commit ?? null) !== (b.head_commit ?? null)) return null;
  return { signature: a.signature, headCommit: a.head_commit ?? null };
}

export type FailureDecision =
  | { readonly action: "retry" }
  /** Do not send another worker; keep the evidence and wait for `unblock_fingerprint` to change. */
  | { readonly action: "hold"; readonly why: string };

/**
 * The only place that decides whether a failure may cost another worker turn. Typed so a
 * test can state each rule: deterministic classes never retry; worker-fixable classes
 * (verification, scope) retry while the worker is making a different attempt, and are held
 * when the same failure comes back on an unchanged commit.
 */
export function decideAfterFailure(
  failureClass: FailureClass,
  recorded: RecordedFailure,
): FailureDecision {
  if (DETERMINISTIC_CLASSES.has(failureClass)) {
    return {
      action: "hold",
      why: `${failureClass} failure: another worker would meet the same problem`,
    };
  }
  if (failureClass === "verification" || failureClass === "scope") {
    if (recorded.repeatsWithoutChange >= 2) {
      return {
        action: "hold",
        why: `the same ${failureClass} failure repeated without any change`,
      };
    }
    if (recorded.repeats >= 3) {
      return {
        action: "hold",
        why: `the same ${failureClass} failure repeated ${recorded.repeats} times`,
      };
    }
  }
  if (failureClass === "transient" && recorded.repeatsWithoutChange >= 3) {
    return { action: "hold", why: "the same failure keeps recurring without any new work" };
  }
  if (failureClass === "resource" && recorded.repeats >= 4) {
    return { action: "hold", why: "the shared resource stayed unavailable" };
  }
  return { action: "retry" };
}

/**
 * Parks a task that must not be retried as it is. The claim must already be released.
 * `fingerprint` names the environment the failure happened in; the task is released again
 * by {@link reviveHeldTasks} once that environment differs.
 */
export function holdTask(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  input: {
    readonly failureClass: FailureClass;
    readonly message: string;
    readonly signature: string;
    readonly fingerprint: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE tasks SET status = 'blocked', failure_reason = ?, failure_class = ?, failure_signature = ?,
       unblock_fingerprint = ?, version = version + 1, updated_at = ? WHERE id = ? AND status != 'completed'`,
  ).run(
    input.message.slice(0, 1500),
    input.failureClass,
    input.signature,
    input.fingerprint,
    now,
    taskId,
  );
  recordEvent(db, taskId, "task_held", {
    class: input.failureClass,
    signature: input.signature,
    awaitsChange: input.fingerprint !== null,
    message: input.message.slice(0, 300),
  });
}

/**
 * Releases held tasks whose blocking environment changed. No retry is spent: the task never
 * got a fair attempt. Returns the released task ids.
 */
export function reviveHeldTasks(
  db: NodeSqlite.DatabaseSync,
  planId: string,
  currentFingerprint: (failureClass: FailureClass) => string | null,
): string[] {
  const held = db
    .prepare(
      `SELECT id, failure_class, unblock_fingerprint FROM tasks
       WHERE plan_id = ? AND status = 'blocked' AND unblock_fingerprint IS NOT NULL`,
    )
    .all(planId) as Array<{
    id: string;
    failure_class: FailureClass;
    unblock_fingerprint: string;
  }>;
  const revived: string[] = [];
  const now = new Date().toISOString();
  for (const task of held) {
    const current = currentFingerprint(task.failure_class);
    if (current === null || current === task.unblock_fingerprint) continue;
    // A note that a person was needed for a wall the environment has since lifted (a guard, a
    // missing tool) is closed, not worked: the parent's commits stand and its checks are audited.
    const isDecision = db
      .prepare(
        "SELECT 1 FROM task_events WHERE task_id = ? AND event_type = 'task_followup_created' AND payload_json LIKE '%\"kind\":\"decision\"%'",
      )
      .get(task.id);
    const closes =
      isDecision !== undefined &&
      (task.failure_class === "configuration" || task.failure_class === "prerequisite");
    db.prepare(
      `UPDATE tasks SET status = ?, failure_reason = NULL, failure_class = NULL,
         unblock_fingerprint = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = 'blocked'`,
    ).run(closes ? "completed" : "pending", now, task.id);
    recordEvent(db, task.id, closes ? "task_followup_resolved" : "task_revalidated", {
      previousClass: task.failure_class,
    });
    revived.push(task.id);
  }
  const stuckCandidates = db
    .prepare(
      `SELECT id, failure_class, unblock_fingerprint FROM tasks
       WHERE plan_id = ? AND integration_state = 'repair_needed' AND unblock_fingerprint IS NOT NULL`,
    )
    .all(planId) as Array<{ id: string; failure_class: FailureClass; unblock_fingerprint: string }>;
  for (const task of stuckCandidates) {
    const current = currentFingerprint(task.failure_class);
    if (current === null || current === task.unblock_fingerprint) continue;
    db.prepare(
      `UPDATE tasks SET integration_state = 'conflict', integration_attempts = 0, integration_error = NULL,
         failure_class = NULL, unblock_fingerprint = NULL, integration_updated_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, task.id);
    recordEvent(db, task.id, "task_revalidated", {
      previousClass: task.failure_class,
      repair: true,
    });
    revived.push(task.id);
  }
  return revived;
}
