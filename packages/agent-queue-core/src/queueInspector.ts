// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";

export interface QueueStatusCounts {
  readonly pending: number;
  readonly claimed: number;
  readonly running: number;
  readonly verifying: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly total: number;
  /** Submitted work waiting to be merged or repaired (a subset of `verifying`). */
  readonly awaitingIntegration?: number;
  /** Submitted work whose automatic repair ran out; needs the overseer or a person. */
  readonly repairNeeded?: number;
}

export interface QueueActiveLease {
  readonly taskId: string;
  readonly workerPid: number;
  readonly worktreePath: string;
  readonly branch: string;
  readonly leasedAt: string;
  readonly expiresAt: string;
}

export type QueueSnapshot = QueueSnapshotReport;
export interface QueueSnapshotReport {
  readonly counts: QueueStatusCounts;
  readonly activeLeases: ReadonlyArray<QueueActiveLease>;
  readonly sampledAt: string;
}

const ENVIRONMENT_CLASSES: ReadonlySet<string> = new Set([
  "external",
  "configuration",
  "prerequisite",
]);

export interface DeadlockEvaluation {
  readonly isDeadlocked: boolean;
  readonly reason?: string | null;
  readonly blockedTaskIds: ReadonlyArray<string>;
  /**
   * Every task that is actually stuck (not just waiting on another) waits on the environment:
   * a capability, credential, live host, missing tool or repository guard. Another worker or an
   * overseer cannot fix that; the tasks come back by themselves once the environment changes.
   */
  readonly awaitingEnvironment?: boolean;
  readonly environmentTaskIds?: ReadonlyArray<string>;
}

/**
 * Produces a point-in-time snapshot report of the queue state.
 */
export function getQueueSnapshot(
  db: NodeSqlite.DatabaseSync,
  planId?: string,
): QueueSnapshotReport {
  const now = new Date().toISOString();

  const countRows = db
    .prepare(
      `SELECT status, count(*) as cnt FROM tasks ${planId === undefined ? "" : "WHERE plan_id = ?"} GROUP BY status`,
    )
    .all(...(planId === undefined ? [] : [planId])) as Array<{
    status: string;
    cnt: number;
  }>;

  const counts: Record<string, number> = {
    pending: 0,
    claimed: 0,
    running: 0,
    verifying: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
  };

  let total = 0;
  for (const row of countRows) {
    counts[row.status] = row.cnt;
    total += row.cnt;
  }

  const leaseRows = db
    .prepare(`
      SELECT task_claims.task_id, task_claims.worker_pid,
        task_claims.worktree_path, task_claims.branch, task_claims.leased_at, task_claims.expires_at
      FROM task_claims
      JOIN tasks ON tasks.id = task_claims.task_id
      WHERE task_claims.released_at IS NULL AND task_claims.expires_at > ?
      ${planId === undefined ? "" : "AND tasks.plan_id = ?"}
    `)
    .all(...(planId === undefined ? [now] : [now, planId])) as Array<{
    task_id: string;
    worker_pid: number;
    worktree_path: string;
    branch: string;
    leased_at: string;
    expires_at: string;
  }>;

  const activeLeases: QueueActiveLease[] = leaseRows.map((r) => ({
    taskId: r.task_id,
    workerPid: r.worker_pid,
    worktreePath: r.worktree_path,
    branch: r.branch,
    leasedAt: r.leased_at,
    expiresAt: r.expires_at,
  }));

  const integrationRows = db
    .prepare(
      `SELECT integration_state AS state, count(*) AS cnt FROM tasks
       WHERE integration_state IS NOT NULL ${planId === undefined ? "" : "AND plan_id = ?"} GROUP BY integration_state`,
    )
    .all(...(planId === undefined ? [] : [planId])) as Array<{ state: string; cnt: number }>;
  const repairNeeded = integrationRows.find((row) => row.state === "repair_needed")?.cnt ?? 0;
  const awaitingIntegration = integrationRows.reduce((sum, row) => sum + row.cnt, 0) - repairNeeded;

  return {
    counts: {
      awaitingIntegration,
      repairNeeded,
      pending: counts.pending ?? 0,
      claimed: counts.claimed ?? 0,
      running: counts.running ?? 0,
      verifying: counts.verifying ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      blocked: counts.blocked ?? 0,
      total,
    },
    activeLeases,
    sampledAt: now,
  };
}

/**
 * Evaluates queue graph for deadlock or permanent stalls.
 * A deadlock occurs when tasks remain uncompleted, 0 workers are actively running,
 * and no pending task is eligible to run due to failed/missing/blocked dependencies.
 */
export function evaluateDeadlock(db: NodeSqlite.DatabaseSync, planId?: string): DeadlockEvaluation {
  const snapshot = getQueueSnapshot(db, planId);
  // Candidates waiting to merge are progressing; ones past automatic repair are not.
  const activeWorkerCount =
    snapshot.counts.claimed +
    snapshot.counts.running +
    snapshot.counts.verifying -
    (snapshot.counts.repairNeeded ?? 0);

  // If workers are currently actively working, the queue is not deadlocked
  if (activeWorkerCount > 0) {
    return { isDeadlocked: false, blockedTaskIds: [] };
  }

  // If no tasks are pending or blocked, there are no uncompleted tasks waiting
  if (
    snapshot.counts.pending === 0 &&
    snapshot.counts.blocked === 0 &&
    (snapshot.counts.repairNeeded ?? 0) === 0
  ) {
    return { isDeadlocked: false, blockedTaskIds: [] };
  }

  const tasks = db
    .prepare(
      `SELECT id, status, dependencies FROM tasks ${planId === undefined ? "" : "WHERE plan_id = ?"}`,
    )
    .all(...(planId === undefined ? [] : [planId])) as Array<{
    id: string;
    status: string;
    dependencies: string;
  }>;

  const completedSet = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));

  const pendingOrBlocked = tasks.filter((t) => t.status === "pending" || t.status === "blocked");

  const runnablePendingTasks: string[] = [];
  const permanentlyBlockedTasks: string[] = [];

  for (const t of pendingOrBlocked) {
    const deps: string[] = JSON.parse(t.dependencies || "[]");
    const unmet = deps.filter((d) => !completedSet.has(d));

    if (unmet.length === 0 && t.status === "pending") {
      runnablePendingTasks.push(t.id);
    } else {
      permanentlyBlockedTasks.push(t.id);
    }
  }

  // If at least one pending task is ready to run, workers can pick it up (idle, not deadlocked)
  if (runnablePendingTasks.length > 0) {
    return { isDeadlocked: false, blockedTaskIds: permanentlyBlockedTasks };
  }

  // Which tasks are the actual stuck points: blocked with every dependency done.
  const roots = tasks.filter((t) => {
    if (t.status !== "blocked") return false;
    const deps: string[] = JSON.parse(t.dependencies || "[]");
    return deps.every((d) => completedSet.has(d));
  });
  const classes = new Map(
    (
      db
        .prepare(
          `SELECT id, failure_class FROM tasks ${planId === undefined ? "" : "WHERE plan_id = ?"}`,
        )
        .all(...(planId === undefined ? [] : [planId])) as Array<{
        id: string;
        failure_class: string | null;
      }>
    ).map((row) => [row.id, row.failure_class]),
  );
  const environmentRoots = roots
    .filter((t) => ENVIRONMENT_CLASSES.has(classes.get(t.id) ?? ""))
    .map((t) => t.id);
  const awaitingEnvironment = roots.length > 0 && environmentRoots.length === roots.length;

  // 0 active workers and 0 runnable tasks while uncompleted tasks remain -> Deadlock!
  return {
    awaitingEnvironment,
    environmentTaskIds: environmentRoots,
    isDeadlocked: true,
    reason: `All ${permanentlyBlockedTasks.length} waiting tasks have unsatisfied or failed dependencies with 0 active workers`,
    blockedTaskIds: permanentlyBlockedTasks,
  };
}
