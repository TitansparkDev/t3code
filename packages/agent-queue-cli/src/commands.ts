// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  openQueueDatabase,
  parsePlanMarkdown,
  computePlanChecksum,
  validatePlanDag,
  getReadyTasks,
  claimTask,
  renewLease,
  releaseClaim,
  transitionTask,
  recordEvent,
  getEventsSince,
  getQueueSnapshot,
  evaluateDeadlock,
  reconcileExpiredLeases,
  initRepo,
  doctorRepo,
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
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const absPath = NodePath.isAbsolute(planFilePath)
      ? planFilePath
      : NodePath.resolve(options.cwd ?? process.cwd(), planFilePath);

    if (!NodeFS.existsSync(absPath)) {
      throw new Error(`Plan file not found: ${absPath}`);
    }

    const content = NodeFS.readFileSync(absPath, "utf8");
    const checksum = computePlanChecksum(content);
    const parsed = parsePlanMarkdown(content);

    // Validate DAG invariants
    validatePlanDag(parsed.tasks);

    const relPath = NodePath.relative(git.rootDir, absPath);
    const planId = `plan_${NodePath.basename(absPath, NodePath.extname(absPath))}`;
    const now = new Date().toISOString();

    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_path = excluded.file_path,
          checksum = excluded.checksum,
          title = excluded.title,
          updated_at = excluded.updated_at
      `).run(planId, relPath, checksum, parsed.title, now, now);

      for (const t of parsed.tasks) {
        db.prepare(`
          INSERT INTO tasks (
            id, plan_id, title, description, status, priority,
            scope_patterns, dependencies, verification_command, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            plan_id = excluded.plan_id,
            title = excluded.title,
            description = excluded.description,
            priority = excluded.priority,
            scope_patterns = excluded.scope_patterns,
            dependencies = excluded.dependencies,
            verification_command = excluded.verification_command,
            updated_at = excluded.updated_at
        `).run(
          t.id,
          planId,
          t.title,
          t.description ?? null,
          t.priority ?? 100,
          JSON.stringify(t.scopePatterns ?? []),
          JSON.stringify(t.dependencies ?? []),
          t.verificationCommand ?? null,
          now,
          now,
        );
      }

      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }

    return {
      success: true,
      planId,
      title: parsed.title,
      taskCount: parsed.tasks.length,
      checksum,
    };
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
        .prepare("SELECT id, status, dependencies, priority FROM tasks")
        .all() as Array<{ id: string; status: string; dependencies: string; priority: number }>;

      const parsed = allTasks.map((t) => ({
        id: t.id,
        status: t.status,
        dependencies: JSON.parse(t.dependencies || "[]") as string[],
        priority: t.priority,
      }));

      const ready = getReadyTasks(parsed);
      if (ready.length === 0) {
        return { success: false, reason: "NO_READY_TASKS" };
      }
      targetId = ready[0]!;
    }

    const branch = getCurrentBranch(cwd);
    const result = claimTask(db, {
      taskId: targetId,
      workerPid: process.pid,
      worktreePath: cwd,
      branch,
      leaseSeconds: args.leaseSeconds ?? 120,
    });

    return result;
  } finally {
    db.close();
  }
}

/**
 * Renews an active task claim heartbeat.
 */
export function heartbeatCommand(
  ownerToken: string,
  extensionSeconds = 120,
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    const success = renewLease(db, ownerToken, extensionSeconds);
    return { success, ownerToken };
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
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
    // Reconcile any expired leases first
    reconcileExpiredLeases(db);

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

/* ========================================================================= */
/* Human Intervention Commands (AQ-017)                                       */
/* ========================================================================= */

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
  options: CommandOptions = {},
): Record<string, unknown> {
  const git = resolveGitContext(options.cwd);
  const db = openQueueDatabase({ gitCommonDir: git.gitCommonDir });
  try {
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
