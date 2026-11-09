// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  openQueueDatabase,
  getReadyTasks,
  claimTask,
  renewLease,
  releaseClaim,
  transitionTask,
  recordEvent,
  getEventsSince,
  getQueueSnapshot,
  evaluateDeadlock,
  finalizeTask,
  parseScopeRequests,
  reconcileExpiredLeases,
  waiveTask,
  unwaiveTask,
  pendingWaits,
  initRepo,
  doctorRepo,
  unchangedHeldFailure,
  importPlanFile,
  lintPlanFile,
  lintPlanFileWithBaseline,
  previewPlan,
} from "../../agent-queue-core/src/index.ts";
import { resolveGitContext } from "./gitContext.ts";

export interface CommandOptions {
  readonly json?: boolean;
  readonly cwd?: string;
  readonly [key: string]: unknown;
}

export function getCurrentBranch(cwd: string): string {
  try {
    return NodeChildProcess.execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Imports a markdown plan file into the durable queue.
 */
export function importPlanCommand(
  planFilePath: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const absPath = NodePath.isAbsolute(planFilePath)
    ? planFilePath
    : NodePath.resolve(options.cwd ?? process.cwd(), planFilePath);
  if (!NodeFS.existsSync(absPath)) {
    throw new Error(`Plan file not found: ${absPath}`);
  }
  const imported = importPlanFile(git.rootDir, NodePath.relative(git.rootDir, absPath));
  return {
    success: true,
    planId: imported.planId,
    title: imported.title,
    taskCount: imported.total,
    added: imported.added,
    orphaned: imported.orphaned,
    checksum: imported.checksum,
  };
}

/** Checks a plan without importing it: readiness, task counts, legacy owners and problems. */
export function validatePlanCommand(
  planFilePath: string | undefined,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const rel = planFilePath
    ? NodePath.relative(
        git.rootDir,
        NodePath.isAbsolute(planFilePath)
          ? planFilePath
          : NodePath.resolve(options.cwd ?? process.cwd(), planFilePath),
      )
    : undefined;
  return { success: true, ...previewPlan(git.rootDir, rel) };
}

/**
 * Checks a plan against the repository and this machine: work an agent cannot finish, live
 * changes outside the release task, decisions left open, scopes that leave out what a task needs,
 * checks that cannot run here. Exit status is the caller's: `ok` is false when any error remains.
 */
export function lintPlanCommand(
  planFilePath: string | undefined,
  options: CommandOptions & { readonly ref?: string } = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const rel = planFilePath
    ? NodePath.relative(
        git.rootDir,
        NodePath.isAbsolute(planFilePath)
          ? planFilePath
          : NodePath.resolve(options.cwd ?? process.cwd(), planFilePath),
      )
    : undefined;
  const result = lintPlanFile(git.rootDir, rel, options.ref ? { ref: options.ref } : {});
  const errors = result.findings.filter((finding) => finding.level === "error");
  return {
    success: true,
    ok: errors.length === 0,
    planPath: result.planPath,
    errors: errors.length,
    warnings: result.findings.length - errors.length,
    findings: result.findings,
    report: result.report,
  };
}

/** `lintPlanCommand` plus the baseline probe; asynchronous because it runs the plan's checks. */
export async function lintPlanWithBaselineCommand(
  planFilePath: string | undefined,
  options: CommandOptions & { readonly ref?: string; readonly baseline: "broad" | "all" },
): Promise<Record<string, unknown>> {
  const git = resolveGitContext(options.cwd);
  const rel = planFilePath
    ? NodePath.relative(
        git.rootDir,
        NodePath.isAbsolute(planFilePath)
          ? planFilePath
          : NodePath.resolve(options.cwd ?? process.cwd(), planFilePath),
      )
    : undefined;
  const result = await lintPlanFileWithBaseline(git.rootDir, rel, {
    baseline: options.baseline,
    ...(options.ref ? { ref: options.ref } : {}),
  });
  const errors = result.findings.filter((finding) => finding.level === "error");
  return {
    success: true,
    ok: errors.length === 0,
    planPath: result.planPath,
    errors: errors.length,
    warnings: result.findings.length - errors.length,
    findings: result.findings,
    report: result.report,
  };
}

/** What a worker runs before it finishes (see finalize.ts): the server's scope decision and the repository's finalizer. */
export function finalizeTaskCommand(
  taskId: string,
  requestText: string | undefined,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const report = finalizeTask(db, {
      taskId,
      worktree: git.rootDir,
      repoRoot: git.rootDir,
      gitCommonDir: git.gitCommonDir,
      requests: requestText ? parseScopeRequests(requestText) : [],
    });
    return { success: true, ...report };
  } finally {
    db.close();
  }
}

/**
 * Lists tasks filtered by status or planId.
 */
export function listTasksCommand(
  filters: { status?: string; planId?: string } = {},
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir, readonly: true });
  try {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: Array<string | number> = [];

    if (filters.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.planId) {
      sql += " AND plan_id = ?";
      params.push(filters.planId);
    }

    sql += " ORDER BY priority DESC, created_at ASC";
    const rows = db.prepare(sql).all(...params) as Array<{
      id: string;
      plan_id: string | null;
      title: string;
      status: string;
      priority: number;
      dependencies: string;
      scope_patterns: string;
      verification_command: string | null;
      failure_reason: string | null;
      updated_at: string;
    }>;

    const tasks = rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      dependencies: JSON.parse(r.dependencies || "[]"),
      scopePatterns: JSON.parse(r.scope_patterns || "[]"),
      verificationCommand: r.verification_command,
      failureReason: r.failure_reason,
      updatedAt: r.updated_at,
    }));

    return {
      count: tasks.length,
      tasks,
    };
  } finally {
    db.close();
  }
}

/**
 * Claims a ready task or a specific task ID.
 */
export function claimTaskCommand(
  args: { taskId?: string; leaseSeconds?: number } = {},
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const cwd = options.cwd ?? process.cwd();
    let targetId = args.taskId;

    if (!targetId) {
      // Find eligible ready task
      const allTasks = db
        .prepare("SELECT id, status, dependencies, priority, failure_class FROM tasks")
        .all() as Array<{
        id: string;
        status: string;
        dependencies: string;
        priority: number;
        failure_class: string | null;
      }>;
      const ownerTaskIds = new Set(
        allTasks.filter((task) => task.failure_class === "owner").map((task) => task.id),
      );

      const parsed = allTasks.map((t) => ({
        id: t.id,
        status: t.status,
        dependencies: JSON.parse(t.dependencies || "[]") as string[],
        priority: t.priority,
      }));

      const ready = getReadyTasks(parsed).find(
        (id) => !ownerTaskIds.has(id) && pendingWaits(db, id).length === 0,
      );
      if (!ready) {
        return { success: false, reason: "NO_READY_TASKS" };
      }
      targetId = ready;
    }

    const branch = getCurrentBranch(cwd);
    const result = claimTask(db, {
      taskId: targetId,
      workerPid: process.pid,
      worktreePath: cwd,
      branch,
      leaseSeconds: args.leaseSeconds ?? 900,
    });

    return result;
  } finally {
    db.close();
  }
}

/** Waives a task after an operator records why it is no longer needed. */
export function waiveTaskCommand(
  taskId: string,
  reason: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    return { taskId, ...waiveTask(db, { taskId, reason }) };
  } finally {
    db.close();
  }
}

/** Reopens a previously waived task when its work is needed again. */
export function unwaiveTaskCommand(
  taskId: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    return { taskId, ...unwaiveTask(db, taskId) };
  } finally {
    db.close();
  }
}

/** Recovers expired worker claims on explicit operator request. */
export function reconcileTasksCommand(options: CommandOptions = {}): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    return { results: reconcileExpiredLeases(db) };
  } finally {
    db.close();
  }
}

/**
 * Renews an active task claim heartbeat. Without an explicit extension the lease is renewed for
 * as long as it was first taken, so `task claim --lease 1800` is not cut to two minutes by the
 * first heartbeat.
 */
export function heartbeatCommand(
  ownerToken: string,
  extensionSeconds: number | undefined,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const claim = db
      .prepare(
        "SELECT heartbeat_at, expires_at FROM task_claims WHERE owner_token = ? AND released_at IS NULL",
      )
      .get(ownerToken) as { heartbeat_at: string; expires_at: string } | undefined;
    if (!claim) return { success: false, ownerToken, reason: "LEASE_NOT_HELD" };
    // Every renewal sets heartbeat_at and expires_at together, so their gap is the lease length.
    const taken = Math.round(
      (Date.parse(claim.expires_at) - Date.parse(claim.heartbeat_at)) / 1000,
    );
    const seconds = extensionSeconds ?? Math.max(taken, 120);
    const success = renewLease(db, ownerToken, seconds);
    const renewed = db
      .prepare("SELECT expires_at FROM task_claims WHERE owner_token = ?")
      .get(ownerToken) as { expires_at: string };
    return {
      success,
      ownerToken,
      leaseSeconds: seconds,
      expiresAt: renewed.expires_at,
      ...(success ? {} : { reason: "LEASE_NOT_HELD" }),
    };
  } finally {
    db.close();
  }
}

/**
 * Releases a task claim with final status.
 */
export function releaseCommand(
  ownerToken: string,
  finalStatus: "completed" | "failed" | "pending",
  failureReason?: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const success = releaseClaim(db, {
      ownerToken,
      finalStatus,
      failureReason: failureReason ?? null,
    });
    return { success, ownerToken, finalStatus };
  } finally {
    db.close();
  }
}

/**
 * Returns point-in-time status and diagnostics of the queue.
 */
export function statusCommand(options: CommandOptions = {}): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir, readonly: true });
  try {
    const snapshot = getQueueSnapshot(db);
    const deadlock = evaluateDeadlock(db);

    return {
      snapshot,
      deadlock,
    };
  } finally {
    db.close();
  }
}

/**
 * Reads events from the durable outbox stream.
 */
export function eventsCommand(
  sinceEventId = 0,
  limit = 100,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir, readonly: true });
  try {
    return getEventsSince(db, sinceEventId, limit) as unknown as Record<string, unknown>;
  } finally {
    db.close();
  }
}

/**
 * Aborts an active task, resetting it or releasing active claims.
 */
export function abortTaskCommand(
  taskId: string,
  reason = "Aborted by operator",
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE;");
    try {
      const task = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as
        | { status: string }
        | undefined;
      // Landed work is not a failure, and a mistyped id must not look aborted.
      if (!task || task.status === "completed") {
        throw new Error(
          task ? `Task ${taskId} is completed; it cannot be aborted.` : `Task ${taskId} not found`,
        );
      }
      // Mark active claims released
      db.prepare(
        "UPDATE task_claims SET released_at = ? WHERE task_id = ? AND released_at IS NULL",
      ).run(now, taskId);

      // Transition task to failed with reason
      db.prepare(`
        UPDATE tasks
        SET status = 'failed', failure_reason = ?, updated_at = ?
        WHERE id = ?
      `).run(reason, now, taskId);

      recordEvent(db, taskId, "task_aborted", { reason });

      db.exec("COMMIT;");
      return { success: true, taskId, reason, status: "failed" };
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * Retries a failed or blocked task, resetting status to 'pending' and clearing errors.
 */
export function retryTaskCommand(
  taskId: string,
  options: CommandOptions & { readonly force?: boolean } = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const task = db.prepare("SELECT status, failure_class FROM tasks WHERE id = ?").get(taskId) as
      | { status: string; failure_class: string | null }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.failure_class === "owner") {
      throw new Error(
        `Task ${taskId} is an owner task; close it with agentq task waive ${taskId} --reason "...".`,
      );
    }
    // Resetting a claimed task would start a second worker on it; resetting a completed one
    // would redo landed work. Neither is a retry, even with --force.
    if (!["failed", "blocked", "pending"].includes(task.status)) {
      throw new Error(
        `Task ${taskId} is ${task.status}; only a failed, blocked or held task can be retried.`,
      );
    }
    if (!options.force) {
      const unchanged = unchangedHeldFailure(db, taskId);
      if (unchanged) {
        throw new Error(
          `Task ${taskId} is held: the same failure (${unchanged.signature}) repeated on commit ` +
            `${unchanged.headCommit ?? "(none)"} with no change. Fix the cause first or pass --force.`,
        );
      }
    }
    const now = new Date().toISOString();
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
        UPDATE tasks
        SET status = 'pending', failure_reason = NULL, retry_count = 0, updated_at = ?
        WHERE id = ?
      `).run(now, taskId);

      recordEvent(db, taskId, "task_retried", { taskId });

      db.exec("COMMIT;");
      return { success: true, taskId, status: "pending" };
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * Blocks a task from scheduling with an explanatory reason.
 */
export function blockTaskCommand(
  taskId: string,
  reason: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const result = transitionTask(db, {
      taskId,
      nextStatus: "blocked",
      failureReason: reason,
      note: `Operator block: ${reason}`,
    });
    return { success: true, taskId, status: "blocked", reason, version: result.version };
  } finally {
    db.close();
  }
}

/**
 * Unblocks a blocked task, returning it to 'pending'.
 */
export function unblockTaskCommand(
  taskId: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const task = db.prepare("SELECT failure_class FROM tasks WHERE id = ?").get(taskId) as
      | { failure_class: string | null }
      | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.failure_class === "owner") {
      throw new Error(
        `Task ${taskId} is an owner task; close it with agentq task waive ${taskId} --reason "...".`,
      );
    }
    const result = transitionTask(db, {
      taskId,
      expectedStatus: "blocked",
      nextStatus: "pending",
      note: "Operator unblock",
    });
    return { success: true, taskId, status: "pending", version: result.version };
  } finally {
    db.close();
  }
}

/**
 * Records an operator guidance note to the task history without modifying status.
 */
export function noteTaskCommand(
  taskId: string,
  noteText: string,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const eventId = recordEvent(db, taskId, "operator_note", { note: noteText });
    return { success: true, taskId, noteText, eventId };
  } finally {
    db.close();
  }
}

/**
 * Initializes AgentQueue in the repository.
 */
export function repoInitCommand(options: CommandOptions = {}): Record<string, unknown> {
  const cwd = options.cwd ?? process.cwd();
  const res = initRepo(cwd);
  return {
    success: true,
    gitCommonDir: res.gitCommonDir,
    dbPath: res.dbPath,
  };
}

/**
 * Runs diagnostics on repository AgentQueue configuration.
 */
export function repoDoctorCommand(options: CommandOptions = {}): Record<string, unknown> {
  const cwd = options.cwd ?? process.cwd();
  const res = doctorRepo(cwd);
  return {
    success: res.healthy,
    ...res,
  };
}
