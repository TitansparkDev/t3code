// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/**
 * The server's only door to AgentQueue. Goals never touch the queue database or git
 * directly: they ask this service to bind a plan, reserve a task, land it, and read
 * state. Every operation either succeeds or fails with an `AgentQueueError` that says
 * what went wrong; nothing is swallowed, so the caller decides what a failure means.
 *
 * @module queue/AgentQueueService
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import {
  commitPendingChanges,
  evaluateDeadlock,
  generateOverseerBriefing,
  getEventsSince,
  getQueueSnapshot,
  importPlanFile,
  landCandidate,
  openQueueDatabase,
  previewPlan,
  releaseClaim,
  releaseClaimForRetry,
  renewLease,
  reserveNextTask,
  resolveRepoGit,
  retryTask,
  runVerification,
  teardownWorktree,
  unblockTask,
  type LandingExecutionResult,
  type OverseerRepairResult,
  type PlanPreview,
  type QueueSnapshot,
  type ReservedTask,
  type StoredQueueEvent,
} from "../../../../packages/agent-queue-core/src/index.ts";

export class AgentQueueError extends Data.TaggedError("AgentQueueError")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** What a goal remembers about the plan it runs. Enough to reopen the queue after a restart. */
export interface QueueBinding {
  readonly planId: string;
  readonly planPath: string;
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly baseBranch: string;
  readonly checksum: string;
}

export interface QueueStatus {
  readonly snapshot: QueueSnapshot;
  /** Pending tasks whose dependencies are all done. */
  readonly ready: number;
  readonly deadlocked: boolean;
  readonly deadlockReason: string | null;
  /** Failed or blocked tasks, with why. */
  readonly problems: ReadonlyArray<{
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
    readonly reason: string | null;
    readonly retryCount: number;
    readonly maxRetries: number;
  }>;
}

export interface ActiveClaim {
  readonly taskId: string;
  readonly claimToken: string;
  readonly workerSessionId: string | null;
  readonly worktreePath: string;
  readonly branch: string;
}

export interface TaskInfo {
  readonly taskId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly verificationCommand: string | null;
  readonly retryCount: number;
  readonly maxRetries: number;
}

export interface LandOutcome extends LandingExecutionResult {
  /** The verification command's tail output when it failed. */
  readonly verificationFailed?: boolean;
}

const fail = (operation: string, cause: unknown) =>
  new AgentQueueError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const run = <A>(operation: string, body: () => A) =>
  Effect.try({ try: body, catch: (cause) => fail(operation, cause) });

const runAsync = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => fail(operation, cause) });

/** Opens the repository's queue, runs `body`, and always closes it. */
function withDb<A>(binding: Pick<QueueBinding, "gitCommonDir">, body: (db: Db) => A): A {
  const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
  try {
    return body(db);
  } finally {
    db.close();
  }
}
type Db = ReturnType<typeof openQueueDatabase>;

export class AgentQueueService extends Context.Service<
  AgentQueueService,
  {
    /** Look at a repository and plan without changing anything. */
    readonly preview: (
      repoRoot: string,
      planPath?: string,
    ) => Effect.Effect<PlanPreview, AgentQueueError>;
    /** Validate and import the plan, returning what the goal must remember. */
    readonly bind: (
      repoRoot: string,
      planPath?: string,
    ) => Effect.Effect<QueueBinding, AgentQueueError>;
    readonly status: (binding: QueueBinding) => Effect.Effect<QueueStatus, AgentQueueError>;
    /** Claim the next ready task and prepare its worktree. Null when nothing is ready. */
    readonly reserveNext: (
      binding: QueueBinding,
      workerSessionId: string,
    ) => Effect.Effect<ReservedTask | null, AgentQueueError>;
    readonly heartbeat: (
      binding: QueueBinding,
      claimToken: string,
    ) => Effect.Effect<boolean, AgentQueueError>;
    readonly activeClaims: (
      binding: QueueBinding,
    ) => Effect.Effect<ReadonlyArray<ActiveClaim>, AgentQueueError>;
    readonly taskInfo: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<TaskInfo | null, AgentQueueError>;
    /** Give a claim back. `pending` re-queues it without penalty, `retry` re-queues it and spends one retry, `failed` ends it, `blocked` parks it. */
    readonly release: (
      binding: QueueBinding,
      claimToken: string,
      status: "pending" | "completed" | "failed" | "blocked" | "retry",
      reason?: string,
    ) => Effect.Effect<boolean, AgentQueueError>;
    /** Commit leftovers, run the task's check, rebase if needed, and land it on the base branch. */
    readonly verifyAndLand: (
      binding: QueueBinding,
      input: {
        readonly taskId: string;
        readonly claimToken: string;
        readonly worktreePath: string;
        readonly branch: string;
        readonly verificationCommand: string;
      },
    ) => Effect.Effect<LandOutcome, AgentQueueError>;
    /** Remove a landed worktree, or keep a failed one (with a salvage branch if it has work). */
    readonly teardown: (
      binding: QueueBinding,
      worktreePath: string,
      branch: string,
      landed: boolean,
    ) => Effect.Effect<void, AgentQueueError>;
    readonly events: (
      binding: QueueBinding,
      cursor: number,
    ) => Effect.Effect<
      { readonly events: ReadonlyArray<StoredQueueEvent>; readonly last: number },
      AgentQueueError
    >;
    /** Every finished task of the plan is on the base branch. Lists what is not. */
    readonly verifyCompletion: (
      binding: QueueBinding,
    ) => Effect.Effect<
      { readonly complete: boolean; readonly unverified: ReadonlyArray<string> },
      AgentQueueError
    >;
    readonly retryTask: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<OverseerRepairResult, AgentQueueError>;
    readonly unblockTask: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<OverseerRepairResult, AgentQueueError>;
    /** The structured overseer briefing: queue counts, deadlock, problem tasks, allowed repairs. */
    readonly briefing: (
      binding: QueueBinding,
      reason: string,
    ) => Effect.Effect<string, AgentQueueError>;
  }
>()("t3/queue/AgentQueueService") {}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const make = AgentQueueService.of({
  preview: (repoRoot, planPath) => run("preview", () => previewPlan(repoRoot, planPath)),

  bind: (repoRoot, planPath) =>
    run("bind", () => {
      const imported = importPlanFile(repoRoot, planPath ?? previewPlan(repoRoot).planPath ?? "");
      const repoGit = resolveRepoGit(repoRoot);
      if (!repoGit?.baseBranch) {
        throw new Error("AgentQueue cannot land tasks from a detached HEAD.");
      }
      return {
        planId: imported.planId,
        planPath: imported.planPath,
        repoRoot,
        gitCommonDir: repoGit.gitCommonDir,
        baseBranch: repoGit.baseBranch,
        checksum: imported.checksum,
      } satisfies QueueBinding;
    }),

  status: (binding) =>
    run("status", () =>
      withDb(binding, (db) => {
        const snapshot = getQueueSnapshot(db, binding.planId);
        const rows = db
          .prepare(
            "SELECT id, title, status, dependencies, priority FROM tasks WHERE plan_id = ? ORDER BY created_at, rowid",
          )
          .all(binding.planId) as Array<{
          id: string;
          title: string;
          status: string;
          dependencies: string | null;
          priority: number | null;
        }>;
        const done = new Set(rows.filter((row) => row.status === "completed").map((row) => row.id));
        const ready = rows.filter(
          (row) =>
            row.status === "pending" &&
            (JSON.parse(row.dependencies || "[]") as string[]).every((dep) => done.has(dep)),
        ).length;
        const deadlock = evaluateDeadlock(db, binding.planId);
        const problems = db
          .prepare(
            `SELECT id, title, status, failure_reason, retry_count, max_retries FROM tasks
             WHERE plan_id = ? AND status IN ('failed', 'blocked')`,
          )
          .all(binding.planId) as Array<{
          id: string;
          title: string;
          status: string;
          failure_reason: string | null;
          retry_count: number;
          max_retries: number;
        }>;
        return {
          snapshot,
          ready,
          deadlocked: deadlock.isDeadlocked,
          deadlockReason: deadlock.reason ?? null,
          problems: problems.map((row) => ({
            taskId: row.id,
            title: row.title,
            status: row.status,
            reason: row.failure_reason,
            retryCount: row.retry_count,
            maxRetries: row.max_retries,
          })),
        } satisfies QueueStatus;
      }),
    ),

  reserveNext: (binding, workerSessionId) =>
    runAsync("reserveNext", async () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      try {
        const outcome = await reserveNextTask(db, {
          repoRoot: binding.repoRoot,
          baseBranch: binding.baseBranch,
          planId: binding.planId,
          workerSessionId,
          // This server owns every claim it makes and renews them while the chat runs.
          // A claim whose renewals stopped is abandoned even though the server is alive.
          isOwnerAlive: () => false,
        });
        return outcome.kind === "reserved" ? outcome.task : null;
      } finally {
        db.close();
      }
    }),

  heartbeat: (binding, claimToken) =>
    run("heartbeat", () => withDb(binding, (db) => renewLease(db, claimToken, 300))),

  activeClaims: (binding) =>
    run("activeClaims", () =>
      withDb(binding, (db) =>
        (
          db
            .prepare(
              `SELECT c.task_id, c.owner_token, c.worker_session_id, c.worktree_path, c.branch
               FROM task_claims c JOIN tasks t ON t.id = c.task_id
               WHERE c.released_at IS NULL AND t.plan_id = ?`,
            )
            .all(binding.planId) as Array<{
            task_id: string;
            owner_token: string;
            worker_session_id: string | null;
            worktree_path: string;
            branch: string;
          }>
        ).map((row) => ({
          taskId: row.task_id,
          claimToken: row.owner_token,
          workerSessionId: row.worker_session_id,
          worktreePath: row.worktree_path,
          branch: row.branch,
        })),
      ),
    ),

  taskInfo: (binding, taskId) =>
    run("taskInfo", () =>
      withDb(binding, (db) => {
        const row = db
          .prepare(
            "SELECT id, title, description, status, verification_command, retry_count, max_retries FROM tasks WHERE id = ? AND plan_id = ?",
          )
          .get(taskId, binding.planId) as
          | {
              id: string;
              title: string;
              description: string | null;
              status: string;
              verification_command: string | null;
              retry_count: number;
              max_retries: number;
            }
          | undefined;
        return row
          ? {
              taskId: row.id,
              title: row.title,
              description: row.description,
              status: row.status,
              verificationCommand: row.verification_command,
              retryCount: row.retry_count,
              maxRetries: row.max_retries,
            }
          : null;
      }),
    ),

  release: (binding, claimToken, status, reason) =>
    run("release", () =>
      withDb(binding, (db) => {
        if (status === "retry") {
          return releaseClaimForRetry(db, claimToken, reason ?? "Attempt did not land").released;
        }
        if (status === "blocked") {
          const claim = db
            .prepare(
              "SELECT task_id FROM task_claims WHERE owner_token = ? AND released_at IS NULL",
            )
            .get(claimToken) as { task_id: string } | undefined;
          if (!claim) return false;
          // Release as failed first (closes the claim), then park the task for a person or overseer.
          const closed = releaseClaim(db, {
            ownerToken: claimToken,
            finalStatus: "failed",
            failureReason: reason ?? null,
          });
          db.prepare(
            "UPDATE tasks SET status = 'blocked', failure_reason = ?, updated_at = ? WHERE id = ?",
          ).run(reason ?? "Blocked", new Date().toISOString(), claim.task_id);
          return closed;
        }
        return releaseClaim(db, {
          ownerToken: claimToken,
          finalStatus: status,
          failureReason: reason ?? null,
        });
      }),
    ),

  verifyAndLand: (binding, input) =>
    runAsync("verifyAndLand", async () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      try {
        const claim = db
          .prepare(
            "SELECT 1 FROM task_claims WHERE task_id = ? AND owner_token = ? AND released_at IS NULL",
          )
          .get(input.taskId, input.claimToken);
        if (!claim) {
          return { success: false, error: "The task claim is no longer held by this worker." };
        }
        // Verification can outlast the lease; keep it alive while we work.
        renewLease(db, input.claimToken, 900);
        commitPendingChanges(
          input.worktreePath,
          `${input.taskId}: commit changes the worker left uncommitted`,
        );
        const receipt = await runVerification(
          input.taskId,
          input.worktreePath,
          input.verificationCommand,
        );
        if (!receipt.passed) {
          return {
            success: false,
            verificationFailed: true,
            error:
              `Verification failed (exit ${receipt.exitCode}): ${receipt.stderrSnippet || receipt.stdoutSnippet}`.slice(
                0,
                1500,
              ),
          };
        }
        return await landCandidate(db, binding.repoRoot, binding.gitCommonDir, {
          taskId: input.taskId,
          worktreePath: input.worktreePath,
          branch: input.branch,
          baseBranch: binding.baseBranch,
          receipt,
        });
      } finally {
        db.close();
      }
    }),

  teardown: (binding, worktreePath, branch, landed) =>
    runAsync("teardown", async () => {
      await teardownWorktree(binding.repoRoot, worktreePath, branch, {
        isSuccess: landed,
        deleteBranch: landed,
        preserveWorktreeOnFailure: !landed,
        emptyBaseRef: binding.baseBranch,
      });
    }),

  events: (binding, cursor) =>
    run("events", () =>
      withDb(binding, (db) => {
        const batch = getEventsSince(db, cursor, 200);
        return { events: batch.events, last: batch.lastEventId };
      }),
    ),

  verifyCompletion: (binding) =>
    run("verifyCompletion", () =>
      withDb(binding, (db) => {
        const completed = db
          .prepare("SELECT id FROM tasks WHERE plan_id = ? AND status = 'completed'")
          .all(binding.planId) as Array<{ id: string }>;
        const total = (
          db.prepare("SELECT count(*) AS n FROM tasks WHERE plan_id = ?").get(binding.planId) as {
            n: number;
          }
        ).n;
        const unverified: string[] = [];
        for (const { id } of completed) {
          const imported = db
            .prepare(
              "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type IN ('task_imported', 'task_synced') ORDER BY id LIMIT 1",
            )
            .get(id) as { payload_json: string } | undefined;
          // Ticked in the plan file before the queue ever ran it: done outside this queue.
          if (imported && /"checked":true|plan-checkbox/.test(imported.payload_json)) continue;
          const landed = db
            .prepare(
              "SELECT commit_hash FROM landing_queue WHERE task_id = ? AND status = 'landed' ORDER BY id DESC LIMIT 1",
            )
            .get(id) as { commit_hash: string | null } | undefined;
          if (!landed?.commit_hash) {
            unverified.push(id);
            continue;
          }
          try {
            git(binding.repoRoot, [
              "merge-base",
              "--is-ancestor",
              landed.commit_hash,
              binding.baseBranch,
            ]);
          } catch {
            unverified.push(id);
          }
        }
        return {
          complete: total > 0 && completed.length === total && unverified.length === 0,
          unverified,
        };
      }),
    ),

  retryTask: (binding, taskId) =>
    run("retryTask", () => withDb(binding, (db) => retryTask(db, taskId, 3))),

  unblockTask: (binding, taskId) =>
    run("unblockTask", () => withDb(binding, (db) => unblockTask(db, taskId))),

  briefing: (binding, reason) =>
    run("briefing", () =>
      withDb(binding, (db) =>
        generateOverseerBriefing(db, binding.repoRoot, reason, binding.planId),
      ),
    ),
});

export const AgentQueueServiceLive = Layer.succeed(AgentQueueService, make);
