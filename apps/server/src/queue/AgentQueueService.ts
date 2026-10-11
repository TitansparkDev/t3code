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
import {
  adoptCandidate,
  evaluateDeadlock,
  ensureIntegrationBranch,
  integrationBranchFor,
  publishPlan,
  DEFAULT_PUBLISH_POLICY,
  type PublishOutcome,
  integrateCandidate,
  isProcessAlive,
  listCandidates,
  submitCandidate,
  verifyPlanCompletion,
  generateOverseerBriefing,
  getEventsSince,
  getQueueSnapshot,
  importPlanFile,
  openQueueDatabase,
  previewPlan,
  releaseClaim,
  releaseClaimForRetry,
  renewLease,
  reserveNextTask,
  resolveRepoGit,
  addFollowUpTask,
  retryTask,
  teardownWorktree,
  unblockTask,
  type CompletionReport,
  type IntegrationOutcome,
  type SubmitOutcome,
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
  /** The target branch the finished plan is published to. */
  readonly baseBranch: string;
  /** Where tasks are integrated; workers start from it. Defaults from the plan id. */
  readonly integrationBranch?: string | undefined;
  readonly checksum: string;
}

/** The branch a plan's tasks integrate into. */
const goalBranchOf = (binding: Pick<QueueBinding, "planId" | "integrationBranch">) =>
  binding.integrationBranch ?? integrationBranchFor(binding.planId);

export interface PublicationStatus {
  readonly state: "none" | "pending" | "blocked" | "published";
  readonly note: string | null;
}

export interface QueueStatus {
  readonly snapshot: QueueSnapshot;
  /** Pending tasks whose dependencies are all done. */
  readonly ready: number;
  readonly deadlocked: boolean;
  readonly deadlockReason: string | null;
  readonly candidates: ReadonlyArray<CandidateInfo>;
  readonly publication: PublicationStatus;
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

export type CandidateInfo = ReturnType<typeof listCandidates>[number];

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
    /**
     * The worker finished: commit leftovers, run the task's check, and record the work as
     * a candidate (the claim is released). Integration continues without the worker.
     */
    readonly submit: (
      binding: QueueBinding,
      input: {
        readonly taskId: string;
        readonly claimToken: string;
        readonly worktreePath: string;
        readonly branch: string;
        readonly verificationCommand: string;
      },
    ) => Effect.Effect<SubmitOutcome, AgentQueueError>;
    /** Merge a submitted candidate through the staging worktree. Safe to repeat. */
    readonly integrate: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<IntegrationOutcome, AgentQueueError>;
    /** Candidates waiting to merge or be repaired. */
    readonly candidates: (
      binding: QueueBinding,
    ) => Effect.Effect<ReadonlyArray<CandidateInfo>, AgentQueueError>;
    /** Register commits already on a branch as the candidate of a task nobody owns. */
    readonly adopt: (
      binding: QueueBinding,
      taskId: string,
      branch: string,
    ) => Effect.Effect<{ readonly commit: string }, AgentQueueError>;
    /** Remove a landed worktree, or keep a failed one (with a salvage branch if it has work). */
    readonly teardown: (
      binding: QueueBinding,
      worktreePath: string,
      branch: string,
      landed: boolean,
    ) => Effect.Effect<{ readonly preserved: boolean }, AgentQueueError>;
    readonly events: (
      binding: QueueBinding,
      cursor: number,
    ) => Effect.Effect<
      { readonly events: ReadonlyArray<StoredQueueEvent>; readonly last: number },
      AgentQueueError
    >;
    /**
     * Update the target branch from the plan's integration branch, safely. Pending when a
     * checkout has uncommitted edits of a live owner; the verified result is kept either way.
     */
    readonly publish: (
      binding: QueueBinding,
      options: { readonly reconcileAbandoned: boolean },
    ) => Effect.Effect<PublishOutcome, AgentQueueError>;
    readonly publication: (
      binding: QueueBinding,
    ) => Effect.Effect<PublicationStatus, AgentQueueError>;
    /** Whether the whole plan is finished, judged from the queue and Git alone. */
    readonly completion: (
      binding: QueueBinding,
      options: { readonly runFinalCheck: boolean },
    ) => Effect.Effect<CompletionReport, AgentQueueError>;
    /** Keep a worker's commits and record what is left (a blocker or a repair) as its own task. */
    readonly addFollowUp: (
      binding: QueueBinding,
      input: {
        readonly parentTaskId: string;
        readonly kind: "repair" | "decision";
        readonly blocking: boolean;
        readonly title: string;
        readonly note: string;
      },
    ) => Effect.Effect<{ readonly taskId: string; readonly created: boolean }, AgentQueueError>;
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

const make = AgentQueueService.of({
  preview: (repoRoot, planPath) => run("preview", () => previewPlan(repoRoot, planPath)),

  bind: (repoRoot, planPath) =>
    run("bind", () => {
      const imported = importPlanFile(repoRoot, planPath ?? previewPlan(repoRoot).planPath ?? "");
      const repoGit = resolveRepoGit(repoRoot);
      if (!repoGit?.baseBranch) {
        throw new Error("AgentQueue cannot land tasks from a detached HEAD.");
      }
      const integrationBranch = integrationBranchFor(imported.planId);
      const baseCommit = ensureIntegrationBranch(repoRoot, repoGit.baseBranch, integrationBranch);
      withDb({ gitCommonDir: repoGit.gitCommonDir }, (db) =>
        db
          .prepare(
            `UPDATE plans SET integration_branch = ?, base_branch = ?,
               base_commit = COALESCE(base_commit, ?), updated_at = ? WHERE id = ?`,
          )
          .run(
            integrationBranch,
            repoGit.baseBranch!,
            baseCommit,
            new Date().toISOString(),
            imported.planId,
          ),
      );
      return {
        planId: imported.planId,
        planPath: imported.planPath,
        repoRoot,
        gitCommonDir: repoGit.gitCommonDir,
        baseBranch: repoGit.baseBranch,
        integrationBranch,
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
             WHERE plan_id = ? AND (status IN ('failed', 'blocked') OR integration_state = 'repair_needed')`,
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
          candidates: listCandidates(db, binding.planId),
          publication: (() => {
            const row = db
              .prepare("SELECT publication_state, publication_note FROM plans WHERE id = ?")
              .get(binding.planId) as
              | { publication_state: string | null; publication_note: string | null }
              | undefined;
            return {
              state: (row?.publication_state ?? "none") as PublicationStatus["state"],
              note: row?.publication_note ?? null,
            };
          })(),
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
          baseBranch: goalBranchOf(binding),
          planId: binding.planId,
          workerSessionId,
          // This server owns every claim it makes and renews them while the chat runs.
          // A claim whose renewals stopped is abandoned even though the server is alive.
          isOwnerAlive: (pid, sessionId) =>
            sessionId?.startsWith("goal-") ? false : isProcessAlive(pid),
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

  submit: (binding, input) =>
    runAsync("submit", () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      return submitCandidate(db, {
        repoRoot: binding.repoRoot,
        baseBranch: goalBranchOf(binding),
        ...input,
      }).finally(() => db.close());
    }),

  integrate: (binding, taskId) =>
    runAsync("integrate", () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      return integrateCandidate(db, {
        repoRoot: binding.repoRoot,
        gitCommonDir: binding.gitCommonDir,
        baseBranch: binding.baseBranch,
        integrationBranch: goalBranchOf(binding),
        taskId,
      }).finally(() => db.close());
    }),

  candidates: (binding) =>
    run("candidates", () => withDb(binding, (db) => listCandidates(db, binding.planId))),

  adopt: (binding, taskId, branch) =>
    runAsync("adopt", () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      return adoptCandidate(db, {
        repoRoot: binding.repoRoot,
        baseBranch: goalBranchOf(binding),
        taskId,
        branch,
      }).finally(() => db.close());
    }),

  teardown: (binding, worktreePath, branch, landed) =>
    runAsync("teardown", async () => {
      return await teardownWorktree(binding.repoRoot, worktreePath, branch, {
        isSuccess: landed,
        deleteBranch: landed,
        keepIfDirty: landed,
        preserveWorktreeOnFailure: !landed,
        emptyBaseRef: goalBranchOf(binding),
      });
    }),

  events: (binding, cursor) =>
    run("events", () =>
      withDb(binding, (db) => {
        // A negative cursor means "from now": start after the newest event.
        if (cursor < 0) {
          const newest = db.prepare("SELECT max(id) AS id FROM task_events").get() as {
            id: number | null;
          };
          return { events: [], last: newest.id ?? 0 };
        }
        const batch = getEventsSince(db, cursor, 200);
        return { events: batch.events, last: batch.lastEventId };
      }),
    ),

  publish: (binding, options) =>
    runAsync("publish", () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      return publishPlan(db, {
        repoRoot: binding.repoRoot,
        gitCommonDir: binding.gitCommonDir,
        baseBranch: binding.baseBranch,
        integrationBranch: goalBranchOf(binding),
        planId: binding.planId,
        policy: { ...DEFAULT_PUBLISH_POLICY, reconcileAbandoned: options.reconcileAbandoned },
      }).finally(() => db.close());
    }),

  publication: (binding) =>
    run("publication", () =>
      withDb(binding, (db) => {
        const row = db
          .prepare("SELECT publication_state, publication_note FROM plans WHERE id = ?")
          .get(binding.planId) as
          | { publication_state: string | null; publication_note: string | null }
          | undefined;
        return {
          state: (row?.publication_state ?? "none") as PublicationStatus["state"],
          note: row?.publication_note ?? null,
        };
      }),
    ),

  completion: (binding, options) =>
    runAsync("completion", () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      return verifyPlanCompletion(db, {
        repoRoot: binding.repoRoot,
        gitCommonDir: binding.gitCommonDir,
        baseBranch: binding.baseBranch,
        integrationBranch: goalBranchOf(binding),
        planId: binding.planId,
        runFinalCheck: options.runFinalCheck,
      }).finally(() => db.close());
    }),

  addFollowUp: (binding, input) =>
    run("addFollowUp", () =>
      withDb(binding, (db) => addFollowUpTask(db, { planId: binding.planId, ...input })),
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
