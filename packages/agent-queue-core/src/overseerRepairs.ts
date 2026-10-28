// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import { validatePlanDag, type PlanTaskDefinition } from "./planGraph.ts";
import type { VerificationCheck, VerificationSpec } from "./verificationSpec.ts";
import { recordEvent } from "./eventStream.ts";
import { failureSignature, unchangedHeldFailure, type FailureClass } from "./failures.ts";
import { reconcileExpiredLeases } from "./leaseRecovery.ts";
import { getQueueSnapshot, evaluateDeadlock } from "./queueInspector.ts";

export interface OverseerRepairResult {
  readonly success: boolean;
  readonly message: string;
  readonly taskId?: string;
  readonly updatedDependencies?: ReadonlyArray<string>;
}

export class RetryBudgetExceededError extends Error {
  public readonly taskId: string;
  public readonly attempts: number;

  constructor(taskId: string, attempts: number) {
    super(`Task ${taskId} has exceeded its retry budget of ${attempts} attempts`);
    this.name = "RetryBudgetExceededError";
    this.taskId = taskId;
    this.attempts = attempts;
  }
}

export interface RepairEvidence {
  readonly failedCheckId?: string | null;
  readonly producerDependencyIds?: ReadonlyArray<string>;
  /** Exact declared input identity; absent when inputs are not safely covered. */
  readonly inputFingerprint?: string | null;
  readonly diagnostics?: {
    readonly failureKind?: string;
    readonly failureReason?: string;
    readonly diagnosticExcerpt?: string;
    readonly diagnosticLogPath?: string | null;
  };
}

function boundedRepairEvidence(evidence: RepairEvidence) {
  const diagnostics = evidence.diagnostics;
  return {
    ...(evidence.failedCheckId ? { failedCheckId: evidence.failedCheckId.slice(0, 128) } : {}),
    producerDependencyIds: [
      ...new Set((evidence.producerDependencyIds ?? []).map((id) => id.slice(0, 128))),
    ].slice(0, 50),
    ...(evidence.inputFingerprint !== undefined
      ? { inputFingerprint: evidence.inputFingerprint?.slice(0, 128) ?? null }
      : {}),
    ...(diagnostics
      ? {
          diagnostics: {
            ...(diagnostics.failureKind
              ? { failureKind: diagnostics.failureKind.slice(0, 64) }
              : {}),
            ...(diagnostics.failureReason
              ? { failureReason: diagnostics.failureReason.slice(0, 1000) }
              : {}),
            ...(diagnostics.diagnosticExcerpt
              ? { diagnosticExcerpt: diagnostics.diagnosticExcerpt.slice(0, 2000) }
              : {}),
            ...(diagnostics.diagnosticLogPath !== undefined
              ? { diagnosticLogPath: diagnostics.diagnosticLogPath?.slice(0, 500) ?? null }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Retries a failed or blocked task if within failure budget.
 */
export function retryTask(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  maxRetries = 3,
  options: { readonly force?: boolean } = {},
): OverseerRepairResult {
  if (!options.force) {
    const unchanged = unchangedHeldFailure(db, taskId);
    if (unchanged) {
      throw new Error(
        `Task ${taskId} is held: the same failure (${unchanged.signature}) repeated on commit ` +
          `${unchanged.headCommit ?? "(none)"} with no change. Fix the cause first (a repair task, ` +
          `a base-branch fix or a changed check) or retry with --force.`,
      );
    }
  }
  db.exec("BEGIN IMMEDIATE;");
  try {
    const task = db
      .prepare("SELECT id, status, retry_count FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; status: string; retry_count: number } | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    // Submitted work the automatic repair gave up on: give it a fresh set of repair attempts.
    const stuck = db.prepare("SELECT integration_state FROM tasks WHERE id = ?").get(taskId) as {
      integration_state: string | null;
    };
    if (stuck.integration_state === "repair_needed") {
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE tasks SET integration_state = 'conflict', integration_attempts = 0, updated_at = ?, integration_updated_at = ? WHERE id = ?",
      ).run(now, now, taskId);
      db.exec("COMMIT;");
      return { success: true, message: `Task ${taskId} will be repaired again.`, taskId };
    }

    if (task.retry_count >= maxRetries) {
      throw new RetryBudgetExceededError(taskId, task.retry_count);
    }

    const newRetryCount = task.retry_count + 1;
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE tasks
      SET status = 'pending',
          retry_count = ?,
          updated_at = ?
      WHERE id = ?
    `).run(newRetryCount, now, taskId);

    // Cancel any orphaned active leases
    db.prepare(`
      UPDATE task_claims
      SET released_at = ?
      WHERE task_id = ? AND released_at IS NULL
    `).run(now, taskId);

    recordEvent(db, taskId, "task_retried", { previousStatus: task.status, newRetryCount });

    db.exec("COMMIT;");
    return {
      success: true,
      message: `Task ${taskId} reset to pending (attempt ${newRetryCount} of ${maxRetries})`,
      taskId,
    };
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Adds a prerequisite dependency to a task, enforcing acyclicity via Kahn's algorithm.
 */
export function addPrerequisite(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  dependsOnTaskId: string,
): OverseerRepairResult {
  if (taskId === dependsOnTaskId) {
    throw new Error(`Task ${taskId} cannot depend on itself`);
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    const allTasks = db.prepare("SELECT id, dependencies FROM tasks").all() as Array<{
      id: string;
      dependencies: string | null;
    }>;

    const taskMap = new Map<string, string[]>();
    for (const row of allTasks) {
      taskMap.set(row.id, row.dependencies ? JSON.parse(row.dependencies) : []);
    }

    if (!taskMap.has(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }
    if (!taskMap.has(dependsOnTaskId)) {
      throw new Error(`Prerequisite task ${dependsOnTaskId} not found`);
    }

    const currentDeps = taskMap.get(taskId)!;
    if (currentDeps.includes(dependsOnTaskId)) {
      db.exec("COMMIT;");
      return {
        success: true,
        message: `Task ${taskId} already depends on ${dependsOnTaskId}`,
        taskId,
        updatedDependencies: currentDeps,
      };
    }

    currentDeps.push(dependsOnTaskId);

    // Validate entire DAG with new edge
    const planTasks: PlanTaskDefinition[] = Array.from(taskMap.entries()).map(([id, deps]) => ({
      id,
      title: id,
      description: "",
      dependencies: deps,
    }));

    // Throws DependencyCycleError or MissingDependencyError if invalid
    validatePlanDag(planTasks);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET dependencies = ?,
          updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(currentDeps), now, taskId);

    recordEvent(db, taskId, "dependency_added", { addedPrerequisite: dependsOnTaskId });

    db.exec("COMMIT;");
    return {
      success: true,
      message: `Added prerequisite ${dependsOnTaskId} to task ${taskId}`,
      taskId,
      updatedDependencies: currentDeps,
    };
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Removes a prerequisite dependency from a task.
 */
export function removeDependency(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  dependsOnTaskId: string,
): OverseerRepairResult {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const task = db.prepare("SELECT id, dependencies FROM tasks WHERE id = ?").get(taskId) as
      | { id: string; dependencies: string | null }
      | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const currentDeps: string[] = task.dependencies ? JSON.parse(task.dependencies) : [];
    const newDeps = currentDeps.filter((dep) => dep !== dependsOnTaskId);

    if (newDeps.length === currentDeps.length) {
      db.exec("COMMIT;");
      return {
        success: true,
        message: `Task ${taskId} did not depend on ${dependsOnTaskId}`,
        taskId,
        updatedDependencies: currentDeps,
      };
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET dependencies = ?,
          updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(newDeps), now, taskId);

    recordEvent(db, taskId, "dependency_removed", { removedPrerequisite: dependsOnTaskId });

    db.exec("COMMIT;");
    return {
      success: true,
      message: `Removed prerequisite ${dependsOnTaskId} from task ${taskId}`,
      taskId,
      updatedDependencies: newDeps,
    };
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Unblocks a blocked task, setting it back to 'pending'.
 */
export function unblockTask(db: NodeSqlite.DatabaseSync, taskId: string): OverseerRepairResult {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const task = db
      .prepare("SELECT id, status, failure_class FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; status: string; failure_class: string | null } | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    // An external blocker (a capability, a credential, a live host) is not cured by saying so:
    // the task is released by itself when the environment can provide it. Releasing it by hand
    // would only send a worker at a wall, or let work look done that was never possible.
    if (task.status === "blocked" && task.failure_class === "external") {
      db.exec("ROLLBACK;");
      return {
        success: false,
        message: `Task ${taskId} waits on something outside the queue (${task.failure_class}); it is released automatically once the environment provides it.`,
        taskId,
      };
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = 'pending',
          failure_class = NULL,
          unblock_fingerprint = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(now, taskId);

    recordEvent(db, taskId, "task_unblocked", { previousStatus: task.status });

    db.exec("COMMIT;");
    return {
      success: true,
      message: `Task ${taskId} unblocked and returned to pending`,
      taskId,
    };
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

/**
 * Builds a structured, compact Overseer briefing that avoids dumping the entire chat history.
 */
export function generateOverseerBriefing(
  db: NodeSqlite.DatabaseSync,
  repoRoot: string,
  reason: string,
  planId?: string,
): string {
  // 1. Reconcile any dead workers
  reconcileExpiredLeases(db);

  // 2. Queue snapshot & deadlock report
  const snapshot = getQueueSnapshot(db, planId);
  const deadlock = evaluateDeadlock(db, planId);

  // 3. Problem tasks
  const problemTasks = db
    .prepare(`
      SELECT id, title, status, retry_count, dependencies, failure_reason, failure_class
      FROM tasks
      WHERE status IN ('failed', 'blocked') ${planId === undefined ? "" : "AND plan_id = ?"}
    `)
    .all(...(planId === undefined ? [] : [planId])) as Array<{
    id: string;
    title: string;
    status: string;
    retry_count: number;
    dependencies: string | null;
    failure_reason: string | null;
    failure_class: string | null;
  }>;

  const lines: string[] = [
    "### AgentQueue Overseer Briefing",
    `Stall Reason: ${reason}`,
    "",
    `**Queue Status**: Total: ${snapshot.counts.total}, Pending: ${snapshot.counts.pending}, Running/Claimed: ${snapshot.counts.claimed + snapshot.counts.running}, Completed: ${snapshot.counts.completed}, Blocked: ${snapshot.counts.blocked}, Failed: ${snapshot.counts.failed}`,
    `**Deadlock Detected**: ${deadlock.isDeadlocked ? `YES (${deadlock.reason})` : "NO"}`,
  ];

  if (problemTasks.length > 0) {
    lines.push("", "**Problem Tasks Requiring Repair**:");
    for (const t of problemTasks) {
      const deps = t.dependencies ? JSON.parse(t.dependencies) : [];
      lines.push(
        `- \`${t.id}\` ("${t.title}"): status=${t.status}, retries=${t.retry_count}, dependencies=[${deps.join(", ")}], reason=${t.failure_reason ?? "unknown"}${
          t.failure_class
            ? `, class=${t.failure_class} (${
                t.failure_class === "external" ||
                t.failure_class === "configuration" ||
                t.failure_class === "prerequisite"
                  ? "held by the server until the environment changes; retrying or unblocking it by hand cannot help"
                  : "needs a change to the work itself"
              })`
            : ""
        }`,
      );
    }
  }

  lines.push(
    "",
    "**Permitted Repair Operations**:",
    "- `retry <taskId>`: Retry failed task within budget",
    "- `add-prerequisite <taskId> <dependsOnTaskId>`: Add prerequisite (cycle checked)",
    "- `remove-dependency <taskId> <dependsOnTaskId>`: Remove unnecessary dependency",
    "- `unblock <taskId>`: Unblock task when prerequisite condition is resolved",
    "",
    "Respond with CONTINUE and repair actions, or STOP if unrecoverable.",
  );

  return lines.join("\n");
}

export interface FollowUpInput {
  readonly planId: string;
  readonly parentTaskId: string;
  /** "repair" can be worked by an agent now; "decision" waits for a person or the overseer. */
  readonly kind: "repair" | "decision";
  /**
   * Whether the original objective needs this done. A blocking follow-up is added as a
   * dependency of every task that waited on the parent that has not started yet, so nothing
   * builds on the unfinished requirement. Only work the parent's own acceptance already
   * covered may be nonblocking.
   */
  readonly blocking: boolean;
  readonly title: string;
  readonly note: string;
  /** What kind of wall the leftover work is (see failures.ts); defaults to a plain decision. */
  readonly failureClass?: FailureClass;
  /** The environment it was seen in: the follow-up is revalidated when this changes. */
  readonly fingerprint?: string | null;
  /** Judge the follow-up by these checks alone instead of the parent's whole verification. */
  readonly checks?: ReadonlyArray<VerificationCheck>;
  /** The declared failed check and evidence needed to retry only when its inputs change. */
  readonly repairEvidence?: RepairEvidence;
  /**
   * Plan-wide identity of the problem. While an unfinished follow-up with the same key exists,
   * no second one is made; the tasks that waited on the parent wait on it instead.
   */
  readonly dedupeKey?: string;
}

/**
 * Records leftover work next to a task whose commits are kept: a requirement the worker could
 * not finish, or a repair that a later audit calls for. The follow-up copies the parent's
 * checks, so it is judged the same way. The plan cannot complete while it stays open.
 * Repeating the same note for the same parent returns the task that already exists.
 */
export function addFollowUpTask(
  db: NodeSqlite.DatabaseSync,
  input: FollowUpInput,
): { readonly taskId: string; readonly created: boolean } {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const parent = db
      .prepare(
        "SELECT scope_patterns, verification_command, verification_spec FROM tasks WHERE id = ? AND plan_id = ?",
      )
      .get(input.parentTaskId, input.planId) as
      | {
          scope_patterns: string;
          verification_command: string | null;
          verification_spec: string | null;
        }
      | undefined;
    if (!parent) throw new Error(`Task ${input.parentTaskId} not found`);
    const inputFingerprint = input.repairEvidence?.inputFingerprint;
    const dedupeKey =
      input.dedupeKey ??
      (input.kind === "repair" && inputFingerprint && inputFingerprint.length <= 128
        ? `repair-input:${inputFingerprint}`
        : input.kind === "decision" &&
            (input.failureClass === "configuration" || input.failureClass === "prerequisite") &&
            input.fingerprint &&
            input.fingerprint.length <= 128
          ? `held:${input.failureClass}:${input.fingerprint}:${failureSignature(input.failureClass, input.note)}`
          : undefined);
    const dedupeMarker = dedupeKey ? `\n[${dedupeKey}]` : "";
    const note = `${input.note.trim().slice(0, 4000 - dedupeMarker.length)}${dedupeMarker}`;
    const siblings = db
      .prepare("SELECT id, description FROM tasks WHERE plan_id = ? AND id LIKE ? ESCAPE '\\'")
      .all(input.planId, `${input.parentTaskId.replace(/[\\%_]/g, "\\$&")}-FU%`) as Array<{
      id: string;
      description: string | null;
    }>;
    const existing = siblings.find((row) => row.description === note);
    if (existing) {
      db.exec("COMMIT;");
      return { taskId: existing.id, created: false };
    }
    const now = new Date().toISOString();
    const rewire = (followUpId: string): string[] => {
      const rewired: string[] = [];
      if (!input.blocking) return rewired;
      const waiting = db
        .prepare(
          "SELECT id, dependencies FROM tasks WHERE plan_id = ? AND status IN ('pending', 'blocked')",
        )
        .all(input.planId) as Array<{ id: string; dependencies: string }>;
      for (const task of waiting) {
        if (task.id === followUpId) continue;
        const dependencies = JSON.parse(task.dependencies || "[]") as string[];
        if (!dependencies.includes(input.parentTaskId) || dependencies.includes(followUpId)) {
          continue;
        }
        db.prepare("UPDATE tasks SET dependencies = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify([...dependencies, followUpId]),
          now,
          task.id,
        );
        rewired.push(task.id);
      }
      return rewired;
    };
    if (dedupeKey) {
      const open = db
        .prepare(
          "SELECT id FROM tasks WHERE plan_id = ? AND status != 'completed' AND description LIKE ? ESCAPE '\\' ORDER BY created_at LIMIT 1",
        )
        .get(input.planId, `%\n[${dedupeKey.replace(/[\\%_]/g, "\\$&")}]`) as
        | { id: string }
        | undefined;
      if (open) {
        rewire(open.id);
        db.exec("COMMIT;");
        return { taskId: open.id, created: false };
      }
    }
    const taskId = `${input.parentTaskId}-FU${siblings.length + 1}`;
    db.prepare(
      `INSERT INTO tasks (id, plan_id, title, description, status, priority, scope_patterns,
         dependencies, verification_command, verification_spec, failure_reason, failure_class,
         unblock_fingerprint, created_at, updated_at, owner_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT owner_ref FROM tasks WHERE id = ?))`,
    ).run(
      taskId,
      input.planId,
      input.title.slice(0, 200),
      note,
      input.kind === "decision" ? "blocked" : "pending",
      input.blocking ? 200 : 50,
      parent.scope_patterns,
      JSON.stringify([]),
      input.checks ? null : parent.verification_command,
      input.checks
        ? JSON.stringify({
            source: "declared",
            checks: input.checks,
            exemptReason: null,
            rejected: [],
          } satisfies VerificationSpec)
        : parent.verification_spec,
      input.kind === "decision" ? note.slice(0, 500) : null,
      input.kind === "decision" ? (input.failureClass ?? null) : null,
      input.kind === "decision" ? (input.fingerprint ?? null) : null,
      now,
      now,
      input.parentTaskId,
    );
    const rewired = rewire(taskId);
    recordEvent(db, taskId, "task_followup_created", {
      parentTaskId: input.parentTaskId,
      kind: input.kind,
      blocking: input.blocking,
      nowWaitingOnIt: rewired,
      ...(input.failureClass ? { failureClass: input.failureClass } : {}),
      ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint.slice(0, 128) } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
      ...(input.repairEvidence
        ? { repairEvidence: boundedRepairEvidence(input.repairEvidence) }
        : {}),
    });
    db.exec("COMMIT;");
    return { taskId, created: true };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
