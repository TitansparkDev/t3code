// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import { validatePlanDag, type PlanTaskDefinition } from "./planGraph.ts";
import { recordEvent } from "./eventStream.ts";
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

/**
 * Retries a failed or blocked task if within failure budget.
 */
export function retryTask(
  db: NodeSqlite.DatabaseSync,
  taskId: string,
  maxRetries = 3,
): OverseerRepairResult {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const task = db
      .prepare("SELECT id, status, retry_count FROM tasks WHERE id = ?")
      .get(taskId) as { id: string; status: string; retry_count: number } | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
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
    const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(taskId) as
      | { id: string; status: string }
      | undefined;

    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE tasks
      SET status = 'pending',
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
): string {
  // 1. Reconcile any dead workers
  reconcileExpiredLeases(db);

  // 2. Queue snapshot & deadlock report
  const snapshot = getQueueSnapshot(db);
  const deadlock = evaluateDeadlock(db);

  // 3. Problem tasks
  const problemTasks = db
    .prepare(`
      SELECT id, title, status, retry_count, dependencies
      FROM tasks
      WHERE status IN ('failed', 'blocked')
    `)
    .all() as Array<{
    id: string;
    title: string;
    status: string;
    retry_count: number;
    dependencies: string | null;
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
        `- \`${t.id}\` ("${t.title}"): status=${t.status}, retries=${t.retry_count}, dependencies=[${deps.join(", ")}]`,
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
