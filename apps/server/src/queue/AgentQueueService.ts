// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import {
  openQueueDatabase,
  getReadyTasks,
  claimTask,
  renewLease,
  releaseClaim,
  getEventsSince,
  getQueueSnapshot,
  reconcileExpiredLeases,
  provisionWorktree,
  teardownWorktree,
  runVerification,
  landCandidate,
  retryTask,
  addPrerequisite,
  removeDependency,
  unblockTask,
  generateOverseerBriefing,
  type QueueSnapshot,
  type LandingExecutionResult,
  type OverseerRepairResult,
} from "../../../../packages/agent-queue-core/src/index.ts";

export interface ReservedTaskAssignment {
  readonly taskId: string;
  readonly title: string;
  readonly claimToken: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly verificationCommand?: string;
  readonly prompt?: string;
}

export function resolveGitContext(repoRoot: string) {
  const gitCommonDir = NodePath.resolve(
    repoRoot,
    NodeChildProcess.execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim(),
  );
  const baseBranch = NodeChildProcess.execFileSync("git", ["branch", "--show-current"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (!baseBranch) throw new Error("AgentQueue cannot land tasks from a detached HEAD.");
  return { gitCommonDir, baseBranch };
}

export class AgentQueueService extends Context.Service<
  AgentQueueService,
  {
    readonly getSnapshot: (gitCommonDir: string, planId?: string) => Effect.Effect<QueueSnapshot>;
    readonly getEvents: (
      gitCommonDir: string,
      cursor: number,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<any>>;
    readonly reserveNext: (
      gitCommonDir: string,
      repoRoot: string,
      workerId: string,
      baseBranch?: string,
      planId?: string,
    ) => Effect.Effect<ReservedTaskAssignment | null>;
    readonly heartbeat: (gitCommonDir: string, claimToken: string) => Effect.Effect<boolean>;
    readonly release: (
      gitCommonDir: string,
      claimToken: string,
      status: "pending" | "completed" | "failed",
      reason?: string,
    ) => Effect.Effect<boolean>;
    readonly verifyAndLand: (
      gitCommonDir: string,
      repoRoot: string,
      taskId: string,
      claimToken: string,
      worktreePath: string,
      branch: string,
      baseBranch: string,
      verificationCommand: string,
    ) => Effect.Effect<LandingExecutionResult>;
    readonly teardown: (
      repoRoot: string,
      worktreePath: string,
      branch: string,
      isSuccess: boolean,
    ) => Effect.Effect<void>;
    readonly retryTask: (
      gitCommonDir: string,
      taskId: string,
      maxRetries?: number,
    ) => Effect.Effect<OverseerRepairResult>;
    readonly addPrerequisite: (
      gitCommonDir: string,
      taskId: string,
      dependsOnTaskId: string,
    ) => Effect.Effect<OverseerRepairResult>;
    readonly removeDependency: (
      gitCommonDir: string,
      taskId: string,
      dependsOnTaskId: string,
    ) => Effect.Effect<OverseerRepairResult>;
    readonly unblockTask: (
      gitCommonDir: string,
      taskId: string,
    ) => Effect.Effect<OverseerRepairResult>;
    readonly generateBriefing: (
      gitCommonDir: string,
      repoRoot: string,
      reason: string,
    ) => Effect.Effect<string>;
  }
>()("t3/queue/AgentQueueService") {}

export const AgentQueueServiceLive = Layer.succeed(AgentQueueService, {
  getSnapshot: (gitCommonDir: string, planId?: string) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return getQueueSnapshot(db, planId);
      } finally {
        db.close();
      }
    }),

  getEvents: (gitCommonDir: string, cursor: number, limit?: number) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return getEventsSince(db, cursor, limit).events;
      } finally {
        db.close();
      }
    }),

  reserveNext: (
    gitCommonDir: string,
    repoRoot: string,
    workerId: string,
    baseBranch?: string,
    planId?: string,
  ) =>
    Effect.promise(async () => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        const resolvedBaseBranch = baseBranch ?? resolveGitContext(repoRoot).baseBranch;
        // Reconcile dead leases first
        reconcileExpiredLeases(db);

        const allTasks = db
          .prepare(
            `SELECT id, title, status, dependencies, priority, verification_command, description
             FROM tasks ${planId === undefined ? "" : "WHERE plan_id = ?"}`,
          )
          .all(...(planId === undefined ? [] : [planId])) as any[];

        const taskList = allTasks.map((t) => ({
          id: t.id,
          status: t.status,
          dependencies: t.dependencies ? JSON.parse(t.dependencies) : [],
          priority: t.priority ?? 0,
        }));

        const readyIds = getReadyTasks(taskList);
        if (readyIds.length === 0) {
          return null;
        }

        for (const taskId of readyIds) {
          const taskRecord = allTasks.find((t) => t.id === taskId);
          const { worktreePath, branch } = await provisionWorktree(
            repoRoot,
            taskId,
            resolvedBaseBranch,
            taskRecord?.title,
          );

          const claimResult = claimTask(db, {
            taskId,
            workerPid: process.pid,
            workerSessionId: workerId,
            worktreePath,
            branch,
            leaseSeconds: 300,
          });

          if (!claimResult.success) {
            await teardownWorktree(repoRoot, worktreePath, branch, { isSuccess: false });
            continue;
          }

          return {
            taskId,
            title: taskRecord?.title ?? taskId,
            claimToken: claimResult.claim.ownerToken,
            worktreePath,
            branch,
            baseBranch: resolvedBaseBranch,
            verificationCommand: taskRecord?.verification_command,
            prompt: taskRecord?.description,
          };
        }

        return null;
      } finally {
        db.close();
      }
    }),

  heartbeat: (gitCommonDir: string, claimToken: string) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return renewLease(db, claimToken, 300);
      } finally {
        db.close();
      }
    }),

  release: (
    gitCommonDir: string,
    claimToken: string,
    status: "pending" | "completed" | "failed",
    reason?: string,
  ) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return releaseClaim(db, {
          ownerToken: claimToken,
          finalStatus: status,
          failureReason: reason ?? null,
        });
      } finally {
        db.close();
      }
    }),

  verifyAndLand: (
    gitCommonDir: string,
    repoRoot: string,
    taskId: string,
    claimToken: string,
    worktreePath: string,
    branch: string,
    baseBranch: string,
    verificationCommand: string,
  ) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* Effect.promise(async () => {
        const db = openQueueDatabase({ gitCommonDir });
        try {
          const activeClaim = db
            .prepare(
              "SELECT 1 FROM task_claims WHERE task_id = ? AND owner_token = ? AND released_at IS NULL AND expires_at > ?",
            )
            .get(taskId, claimToken, now);
          if (!activeClaim) {
            return { success: false, error: "The task claim is no longer active." };
          }
          // 1. Run verification
          const receipt = await runVerification(taskId, worktreePath, verificationCommand);
          if (!receipt.passed) {
            return {
              success: false,
              error: `Verification failed with exit code ${receipt.exitCode}: ${receipt.stderrSnippet || receipt.stdoutSnippet}`,
            };
          }

          // 2. Land candidate
          return await landCandidate(db, repoRoot, gitCommonDir, {
            taskId,
            worktreePath,
            branch,
            baseBranch,
            receipt,
          });
        } finally {
          db.close();
        }
      });
    }),

  teardown: (repoRoot: string, worktreePath: string, branch: string, isSuccess: boolean) =>
    Effect.promise(async () => {
      await teardownWorktree(repoRoot, worktreePath, branch, {
        isSuccess,
        deleteBranch: isSuccess,
        preserveWorktreeOnFailure: !isSuccess,
      });
    }),

  retryTask: (gitCommonDir: string, taskId: string, maxRetries = 3) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return retryTask(db, taskId, maxRetries);
      } finally {
        db.close();
      }
    }),

  addPrerequisite: (gitCommonDir: string, taskId: string, dependsOnTaskId: string) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return addPrerequisite(db, taskId, dependsOnTaskId);
      } finally {
        db.close();
      }
    }),

  removeDependency: (gitCommonDir: string, taskId: string, dependsOnTaskId: string) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return removeDependency(db, taskId, dependsOnTaskId);
      } finally {
        db.close();
      }
    }),

  unblockTask: (gitCommonDir: string, taskId: string) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return unblockTask(db, taskId);
      } finally {
        db.close();
      }
    }),

  generateBriefing: (gitCommonDir: string, repoRoot: string, reason: string) =>
    Effect.sync(() => {
      const db = openQueueDatabase({ gitCommonDir });
      try {
        return generateOverseerBriefing(db, repoRoot, reason);
      } finally {
        db.close();
      }
    }),
});
