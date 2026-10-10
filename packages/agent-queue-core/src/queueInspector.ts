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

export interface DeadlockEvaluation {
  readonly isDeadlocked: boolean;
  readonly reason?: string | null;
  readonly blockedTaskIds: ReadonlyArray<string>;
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

  return {
    counts: {
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
export function evaluateDeadlock(db: NodeSqlite.DatabaseSync): DeadlockEvaluation {
  const snapshot = getQueueSnapshot(db);
  const activeWorkerCount =
    snapshot.counts.claimed + snapshot.counts.running + snapshot.counts.verifying;

  // If workers are currently actively working, the queue is not deadlocked
  if (activeWorkerCount > 0) {
    return { isDeadlocked: false, blockedTaskIds: [] };
  }

  // If no tasks are pending or blocked, there are no uncompleted tasks waiting
  if (snapshot.counts.pending === 0 && snapshot.counts.blocked === 0) {
    return { isDeadlocked: false, blockedTaskIds: [] };
  }

  const tasks = db.prepare("SELECT id, status, dependencies FROM tasks").all() as Array<{
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

  // 0 active workers and 0 runnable tasks while uncompleted tasks remain -> Deadlock!
  return {
    isDeadlocked: true,
    reason: `All ${permanentlyBlockedTasks.length} waiting tasks have unsatisfied or failed dependencies with 0 active workers`,
    blockedTaskIds: permanentlyBlockedTasks,
  };
}
