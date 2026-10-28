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

export interface QueueProgressWait {
  readonly taskId: string;
  readonly since: string;
  readonly reason: "dependencies" | "blocked" | "integration";
}

export interface QueueProgressFacts {
  readonly completedParentTasks: number;
  readonly completedRepairTasks: number;
  /** A deterministic, dependency-first view of the unfinished task graph, capped at 20 ids. */
  readonly remainingDependencyTaskIds: ReadonlyArray<string>;
  readonly omittedDependencyCount: number;
  readonly oldestWait: QueueProgressWait | null;
}

const MAX_REMAINING_DEPENDENCIES = 20;

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

/** Persisted plan facts for explaining an unfinished queue without reading worker conversations. */
export function getQueueProgressFacts(
  db: NodeSqlite.DatabaseSync,
  planId: string,
): QueueProgressFacts {
  const tasks = db
    .prepare(
      "SELECT id, status, dependencies, updated_at, integration_state, integration_updated_at FROM tasks WHERE plan_id = ? ORDER BY id",
    )
    .all(planId) as Array<{
    id: string;
    status: string;
    dependencies: string | null;
    updated_at: string;
    integration_state: string | null;
    integration_updated_at: string | null;
  }>;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set(
    tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );
  const repairTasks = new Set(
    (
      db
        .prepare(
          `SELECT e.task_id, e.payload_json FROM task_events e
           JOIN tasks t ON t.id = e.task_id
           WHERE t.plan_id = ? AND e.event_type = 'task_followup_created' ORDER BY e.id`,
        )
        .all(planId) as Array<{ task_id: string; payload_json: string }>
    ).flatMap((event) => {
      try {
        const payload = JSON.parse(event.payload_json) as { kind?: unknown };
        return payload.kind === "repair" ? [event.task_id] : [];
      } catch {
        return [];
      }
    }),
  );
  const dependenciesOf = (task: (typeof tasks)[number] | undefined): ReadonlyArray<string> => {
    if (!task?.dependencies) return [];
    try {
      const parsed: unknown = JSON.parse(task.dependencies);
      return Array.isArray(parsed)
        ? [
            ...new Set(
              parsed.filter((dependency): dependency is string => typeof dependency === "string"),
            ),
          ].toSorted()
        : [];
    } catch {
      return [];
    }
  };

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const remaining: string[] = [];
  for (const task of tasks) {
    if (completed.has(task.id) || visited.has(task.id)) continue;
    const stack = [{ taskId: task.id, dependencies: dependenciesOf(task), nextDependency: 0 }];
    visiting.add(task.id);
    while (stack.length > 0) {
      const current = stack[stack.length - 1]!;
      if (current.nextDependency < current.dependencies.length) {
        const dependency = current.dependencies[current.nextDependency++]!;
        if (completed.has(dependency) || visited.has(dependency) || visiting.has(dependency))
          continue;
        visiting.add(dependency);
        stack.push({
          taskId: dependency,
          dependencies: dependenciesOf(taskById.get(dependency)),
          nextDependency: 0,
        });
        continue;
      }
      stack.pop();
      visiting.delete(current.taskId);
      visited.add(current.taskId);
      remaining.push(current.taskId);
    }
  }

  const waitFacts = tasks.flatMap((task) => {
    const blocked =
      task.status === "failed" ||
      task.status === "blocked" ||
      task.integration_state === "repair_needed";
    const waitingOnDependencies =
      task.status === "pending" &&
      dependenciesOf(task).some((dependency) => !completed.has(dependency));
    const waitingOnIntegration =
      task.integration_state === "pending" || task.integration_state === "conflict";
    const since = waitingOnIntegration
      ? (task.integration_updated_at ?? task.updated_at)
      : task.updated_at;
    if (
      (!blocked && !waitingOnDependencies && !waitingOnIntegration) ||
      !Number.isFinite(Date.parse(since))
    ) {
      return [];
    }
    return [
      {
        taskId: task.id,
        since,
        reason: blocked
          ? ("blocked" as const)
          : waitingOnDependencies
            ? ("dependencies" as const)
            : ("integration" as const),
      },
    ];
  });
  waitFacts.sort(
    (left, right) =>
      Date.parse(left.since) - Date.parse(right.since) || left.taskId.localeCompare(right.taskId),
  );
  const kept = remaining.slice(0, MAX_REMAINING_DEPENDENCIES);

  return {
    completedParentTasks: tasks.filter(
      (task) => task.status === "completed" && !repairTasks.has(task.id),
    ).length,
    completedRepairTasks: tasks.filter(
      (task) => task.status === "completed" && repairTasks.has(task.id),
    ).length,
    remainingDependencyTaskIds: kept,
    omittedDependencyCount: remaining.length - kept.length,
    oldestWait: waitFacts[0] ?? null,
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
