// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import type * as NodeSqlite from "node:sqlite";
import { claimTask, releaseClaim } from "./claimService.ts";
import { recordEvent } from "./eventStream.ts";
import { reconcileExpiredLeases } from "./leaseRecovery.ts";
import { getReadyTasks } from "./planGraph.ts";
import { planWorktree, provisionWorktree } from "./worktreeManager.ts";

export interface ReservedTask {
  readonly taskId: string;
  readonly title: string;
  readonly description: string | null;
  readonly verificationCommand: string | null;
  readonly claimToken: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly retryCount: number;
  readonly lastFailure: string | null;
  /** Set when the worker must repair a submitted candidate instead of implementing the task. */
  readonly repair: { readonly reason: string; readonly candidateCommit: string | null } | null;
}

export type ReserveOutcome =
  | { readonly kind: "reserved"; readonly task: ReservedTask }
  | {
      /** Nothing can start now. `ready` counts tasks that were ready but lost a claim race or scope. */
      readonly kind: "none";
      readonly skipped: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>;
    };

export class WorktreeProvisionError extends Error {
  readonly taskId: string;
  constructor(taskId: string, cause: unknown) {
    super(
      `Could not prepare the worktree for ${taskId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "WorktreeProvisionError";
    this.taskId = taskId;
  }
}

/**
 * Reserves the next ready task of a plan for one worker. The claim (a compare-and-swap in
 * one transaction) is taken BEFORE the worktree is created, so two reservers can never
 * both build a worktree for the same task, and a task that is not ready never gets a
 * worker. If the worktree cannot be made, the claim is given back and the error is raised.
 */
export async function reserveNextTask(
  db: NodeSqlite.DatabaseSync,
  options: {
    readonly repoRoot: string;
    readonly baseBranch: string;
    readonly planId: string;
    readonly workerSessionId: string;
    readonly workerPid?: number;
    readonly leaseSeconds?: number;
    readonly isOwnerAlive?: (pid: number, sessionId: string | null) => boolean;
  },
): Promise<ReserveOutcome> {
  reconcileExpiredLeases(
    db,
    options.isOwnerAlive ? { isOwnerAlive: options.isOwnerAlive } : undefined,
  );

  const rows = db
    .prepare(
      `SELECT id, title, description, status, dependencies, priority, verification_command,
              retry_count, failure_reason
       FROM tasks WHERE plan_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(options.planId) as Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    dependencies: string | null;
    priority: number | null;
    verification_command: string | null;
    retry_count: number;
    failure_reason: string | null;
  }>;

  const readyIds = getReadyTasks(
    rows.map((row) => ({
      id: row.id,
      status: row.status,
      dependencies: row.dependencies ? (JSON.parse(row.dependencies) as string[]) : [],
      priority: row.priority ?? 100,
    })),
  );

  const skipped: Array<{ taskId: string; reason: string }> = [];

  // Submitted work that failed to merge is repaired before any new task starts.
  const repairs = db
    .prepare(
      `SELECT id, title, description, verification_command, retry_count, integration_error, candidate_commit
       FROM tasks WHERE plan_id = ? AND status = 'verifying' AND integration_state = 'conflict'
       ORDER BY integration_updated_at, rowid`,
    )
    .all(options.planId) as Array<{
    id: string;
    title: string;
    description: string | null;
    verification_command: string | null;
    retry_count: number;
    integration_error: string | null;
    candidate_commit: string | null;
  }>;
  for (const repair of repairs) {
    const planned = planWorktree(options.repoRoot, repair.id, repair.title);
    const claim = claimTask(db, {
      taskId: repair.id,
      workerPid: options.workerPid ?? process.pid,
      workerSessionId: options.workerSessionId,
      worktreePath: planned.worktreePath,
      branch: planned.branch,
      leaseSeconds: options.leaseSeconds ?? 300,
      repair: true,
    });
    if (!claim.success) {
      skipped.push({ taskId: repair.id, reason: claim.reason });
      continue;
    }
    try {
      const provisioned = await provisionWorktree(
        options.repoRoot,
        repair.id,
        options.baseBranch,
        repair.title,
      );
      db.prepare("UPDATE task_claims SET worktree_path = ?, branch = ? WHERE owner_token = ?").run(
        provisioned.worktreePath,
        provisioned.branch,
        claim.claim.ownerToken,
      );
      return {
        kind: "reserved",
        task: {
          taskId: repair.id,
          title: repair.title,
          description: repair.description,
          verificationCommand: repair.verification_command,
          claimToken: claim.claim.ownerToken,
          worktreePath: provisioned.worktreePath,
          branch: provisioned.branch,
          baseBranch: options.baseBranch,
          retryCount: repair.retry_count,
          lastFailure: repair.integration_error,
          repair: {
            reason: repair.integration_error ?? "The candidate could not be merged.",
            candidateCommit: repair.candidate_commit,
          },
        },
      };
    } catch (error) {
      releaseClaim(db, {
        ownerToken: claim.claim.ownerToken,
        finalStatus: "pending",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      throw new WorktreeProvisionError(repair.id, error);
    }
  }

  for (const taskId of readyIds) {
    const row = rows.find((candidate) => candidate.id === taskId)!;
    const planned = planWorktree(options.repoRoot, taskId, row.title);
    const claim = claimTask(db, {
      taskId,
      workerPid: options.workerPid ?? process.pid,
      workerSessionId: options.workerSessionId,
      worktreePath: planned.worktreePath,
      branch: planned.branch,
      leaseSeconds: options.leaseSeconds ?? 300,
    });
    if (!claim.success) {
      skipped.push({ taskId, reason: claim.reason });
      continue;
    }
    try {
      const provisioned = await provisionWorktree(
        options.repoRoot,
        taskId,
        options.baseBranch,
        row.title,
      );
      if (
        provisioned.worktreePath !== planned.worktreePath ||
        provisioned.branch !== planned.branch
      ) {
        db.prepare(
          "UPDATE task_claims SET worktree_path = ?, branch = ? WHERE owner_token = ?",
        ).run(provisioned.worktreePath, provisioned.branch, claim.claim.ownerToken);
      }
      return {
        kind: "reserved",
        task: {
          taskId,
          title: row.title,
          description: row.description,
          verificationCommand: row.verification_command,
          claimToken: claim.claim.ownerToken,
          worktreePath: provisioned.worktreePath,
          branch: provisioned.branch,
          baseBranch: options.baseBranch,
          retryCount: row.retry_count,
          lastFailure: row.failure_reason,
          repair: null,
        },
      };
    } catch (error) {
      releaseClaim(db, {
        ownerToken: claim.claim.ownerToken,
        finalStatus: "pending",
        failureReason: error instanceof Error ? error.message : String(error),
      });
      recordEvent(db, taskId, "task_provision_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new WorktreeProvisionError(taskId, error);
    }
  }
  return { kind: "none", skipped };
}
