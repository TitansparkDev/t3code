// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off effectFnOpportunity:off
/** @module queue/AgentQueueService */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeChildProcess from "node:child_process";
import {
  adoptCandidate,
  admitWorker,
  bindOwner,
  createJobRunner,
  describeJob,
  openBroker,
  ownerOf,
  type JobRunner,
  type Ticket,
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
  getQueueProgressFacts,
  getQueueSnapshot,
  importPlanFile,
  openQueueDatabase,
  previewPlan,
  releaseClaim,
  releaseClaimForRetry,
  holdClaim,
  renewLease,
  reserveNextTask,
  resolveRepoGit,
  addFollowUpTask,
  retryTask,
  teardownWorktree,
  unblockTask,
  auditUnverifiedTasks,
  classifyReason,
  environmentFingerprint,
  loadContract,
  probeBranchPrefix,
  type AuditReport,
  type FailureClass,
  parseScopeRequests,
  type ScopeRequest,
  type CompletionReport,
  type IntegrationOutcome,
  type SubmitOutcome,
  type OverseerRepairResult,
  type PlanPreview,
  type QueueSnapshot,
  type QueueProgressFacts,
  type ReservedTask,
  type StoredQueueEvent,
  type TicketState,
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
  /** Everything stuck waits on the environment (a capability, tool, guard or credential); no one needs to be asked. */
  readonly awaitingEnvironment: boolean;
  readonly environmentTaskIds: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<CandidateInfo>;
  readonly publication: PublicationStatus;
  readonly progressFacts: QueueProgressFacts;
  readonly resourceProgress: QueueResourceProgress;
  /** Failed or blocked tasks, with why. */
  readonly problems: ReadonlyArray<{
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
    readonly reason: string | null;
    readonly retryCount: number;
    readonly maxRetries: number;
    /** Why it stopped, when classified (configuration, prerequisite, external...). */
    readonly failureClass: string | null;
  }>;
}

export interface QueueResourceProgressTicket {
  readonly taskId: string;
  readonly ticketId: string;
  readonly state: "waiting" | "granted" | "running" | "finished-unreported";
  readonly checkId: string | null;
  readonly resources: ReadonlyArray<string>;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export interface QueueResourceProgressCheck extends QueueResourceProgressTicket {
  readonly state: "waiting" | "granted" | "running";
}

export interface QueueResourceProgress {
  readonly inspectionAvailable: boolean;
  readonly activeChecks: ReadonlyArray<QueueResourceProgressCheck>;
  readonly activeJobs: ReadonlyArray<QueueResourceProgressTicket>;
  readonly resourceWaits: ReadonlyArray<QueueResourceProgressTicket>;
  readonly omittedChecks: number;
  readonly omittedJobs: number;
  readonly omittedResourceWaits: number;
}

const MAX_PROGRESS_TICKETS = 5;
const isActiveTicketState = (state: TicketState): state is "waiting" | "granted" | "running" =>
  state === "waiting" || state === "granted" || state === "running";

function inspectQueueResources(
  binding: QueueBinding,
  tasks: ReadonlyArray<{ readonly taskId: string }>,
): QueueResourceProgress {
  try {
    const broker = openBroker();
    try {
      const activeChecks: QueueResourceProgressCheck[] = [];
      const activeJobs: QueueResourceProgressTicket[] = [];
      const resourceWaits: QueueResourceProgressTicket[] = [];
      for (const task of tasks) {
        const tickets = broker.forOwner(task.taskId, binding.gitCommonDir);
        const accounting = broker.accountingFor(binding.gitCommonDir, task.taskId);
        const attempts = new Map(
          accounting.attempts.map((attempt) => [attempt.attemptId, attempt]),
        );
        for (const ticket of tickets) {
          const unreportedFinishedJob =
            ticket.kind === "job" &&
            !isActiveTicketState(ticket.state) &&
            ticket.reportedAt === null;
          const state = unreportedFinishedJob
            ? "finished-unreported"
            : isActiveTicketState(ticket.state)
              ? ticket.state
              : undefined;
          if (state === undefined) continue;
          const attempt = attempts.get(ticket.id);
          const progress: QueueResourceProgressTicket = {
            taskId: task.taskId,
            ticketId: ticket.id,
            state,
            checkId: ticket.checkId,
            resources: ticket.resources.map((resource) => resource.name),
            enqueuedAt: ticket.enqueuedAt,
            startedAt: attempt?.startedAt ?? ticket.startedAt,
            finishedAt: attempt?.finishedAt ?? ticket.finishedAt,
          };
          if (ticket.state === "waiting") resourceWaits.push({ ...progress, state: "waiting" });
          if (ticket.kind === "run" && isActiveTicketState(ticket.state)) {
            activeChecks.push({ ...progress, state: ticket.state });
          }
          if (
            ticket.kind === "job" &&
            (isActiveTicketState(ticket.state) || unreportedFinishedJob)
          ) {
            activeJobs.push(progress);
          }
        }
      }
      const order = (left: QueueResourceProgressTicket, right: QueueResourceProgressTicket) =>
        left.enqueuedAt - right.enqueuedAt ||
        left.taskId.localeCompare(right.taskId) ||
        left.ticketId.localeCompare(right.ticketId);
      const bounded = <T extends QueueResourceProgressTicket>(items: ReadonlyArray<T>): T[] =>
        [...items].sort(order).slice(0, MAX_PROGRESS_TICKETS);
      return {
        inspectionAvailable: true,
        activeChecks: bounded(activeChecks),
        activeJobs: bounded(activeJobs),
        resourceWaits: bounded(resourceWaits),
        omittedChecks: Math.max(0, activeChecks.length - MAX_PROGRESS_TICKETS),
        omittedJobs: Math.max(0, activeJobs.length - MAX_PROGRESS_TICKETS),
        omittedResourceWaits: Math.max(0, resourceWaits.length - MAX_PROGRESS_TICKETS),
      };
    } finally {
      broker.close();
    }
  } catch {
    return {
      inspectionAvailable: false,
      activeChecks: [],
      activeJobs: [],
      resourceWaits: [],
      omittedChecks: 0,
      omittedJobs: 0,
      omittedResourceWaits: 0,
    };
  }
}

export type CandidateInfo = ReturnType<typeof listCandidates>[number];

/** What one attempt to reserve a task found. */
export interface ReserveNextResult {
  readonly task: ReservedTask | null;
  /** Ready tasks that could not be claimed, with the queue's reason for each. */
  readonly skipped: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>;
  /** Tasks parked this pass because their assignment could not run. */
  readonly held: ReadonlyArray<{ readonly taskId: string; readonly reason: string }>;
}

export interface ActiveClaim {
  readonly workerAlive: boolean;
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

export interface ReplacementQueueContext {
  readonly integrationHead: string | null;
  readonly latestFailure: string | null;
  readonly earlierFailure: string | null;
  readonly siblingRepairs: ReadonlyArray<{
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
    readonly landedCommit: string | null;
    readonly failure: string | null;
  }>;
}

const fail = (operation: string, cause: unknown) =>
  new AgentQueueError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const run = <A>(operation: string, body: () => A) =>
  Effect.try({ try: body, catch: (cause) => fail(operation, cause) });

const runAsync = <A>(operation: string, body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => fail(operation, cause) }).pipe(
    Effect.uninterruptible,
  );

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
    /**
     * Claim the next ready task and prepare its worktree. `task` is null when nothing can start;
     * `skipped` then says why each ready task could not (for example `SCOPE_CONFLICT (held by X)`),
     * and `held` lists tasks parked this pass because their assignment is not executable.
     */
    readonly reserveNext: (
      binding: QueueBinding,
      workerSessionId: string,
      excludeTaskIds?: ReadonlySet<string>,
    ) => Effect.Effect<ReserveNextResult, AgentQueueError>;
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
    /** Bounded persisted facts for handing an existing task to a replacement worker. */
    readonly replacementContext: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<ReplacementQueueContext, AgentQueueError>;
    /** Give a claim back. `pending` re-queues it without penalty, `retry` re-queues it and spends one retry, `failed` ends it, `blocked` parks it. */
    readonly release: (
      binding: QueueBinding,
      claimToken: string,
      status: "pending" | "completed" | "failed" | "blocked" | "retry" | "hold",
      reason?: string,
      options?: {
        readonly failureClass?: FailureClass;
        readonly headCommit?: string | null;
        readonly record?: boolean;
      },
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
        readonly scopeRequests?: ReadonlyArray<ScopeRequest>;
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
    /** Run the stored checks of merged tasks that were never checked, against the plan's tip. */
    readonly audit: (binding: QueueBinding) => Effect.Effect<AuditReport, AgentQueueError>;
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
    /** Whether the machine has room for one more worker right now (memory and load), and why not. */
    readonly admit: (
      running: number,
    ) => Effect.Effect<{ readonly ok: boolean; readonly reason: string | null }>;
    /** Record the conversation accountable for a task, and who that was before. */
    readonly bindOwner: (
      binding: QueueBinding,
      taskId: string,
      ownerRef: string,
    ) => Effect.Effect<void, AgentQueueError>;
    readonly ownerOf: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<
      { readonly ownerRef: string | null; readonly turns: number },
      AgentQueueError
    >;
    /**
     * Stored resource jobs a task's worker handed to the queue: the ones still waiting or running,
     * and the finished ones whose result its owner has not been told.
     */
    readonly resourceJobs: (
      binding: QueueBinding,
      taskId: string,
    ) => Effect.Effect<
      {
        readonly open: ReadonlyArray<string>;
        readonly finished: ReadonlyArray<{ readonly id: string; readonly summary: string }>;
      },
      AgentQueueError
    >;
    readonly reportJob: (jobId: string) => Effect.Effect<void, AgentQueueError>;
    /** Start whatever stored jobs can run now (this server is their runner). Returns how many started. */
    readonly runJobs: (binding: QueueBinding) => Effect.Effect<number, AgentQueueError>;
  }
>()("t3/queue/AgentQueueService") {}

/** The environment a deterministic failure happened in (see contract.ts). */
function fingerprintOf(binding: QueueBinding, failureClass?: FailureClass): string | null {
  try {
    const refs = [...new Set([binding.baseBranch, goalBranchOf(binding)])];
    const loaded = loadContract({
      repoRoot: binding.repoRoot,
      gitCommonDir: binding.gitCommonDir,
      refs,
    });
    return environmentFingerprint({
      repoRoot: binding.repoRoot,
      loaded,
      refs,
      ...(failureClass === "external" ? { only: "capabilities" as const } : {}),
    });
  } catch {
    return null;
  }
}

/** One runner per repository: it executes that repository's stored resource jobs, here, in this server. */
const jobRunners = new Map<string, JobRunner>();

const make = AgentQueueService.of({
  admit: (running) =>
    Effect.sync(() => {
      const verdict = admitWorker({ running });
      return { ok: verdict.ok, reason: verdict.reason };
    }),

  bindOwner: (binding, taskId, ownerRef) =>
    run("bindOwner", () => withDb(binding, (db) => bindOwner(db, taskId, ownerRef))),

  ownerOf: (binding, taskId) => run("ownerOf", () => withDb(binding, (db) => ownerOf(db, taskId))),

  resourceJobs: (binding, taskId) =>
    run("resourceJobs", () => {
      const broker = openBroker();
      try {
        broker.pump();
        const tickets = broker
          .forOwner(taskId, binding.gitCommonDir)
          .filter((ticket) => ticket.kind === "job");
        const finished = tickets.filter(
          (ticket) =>
            ticket.reportedAt === null &&
            (ticket.state === "done" || ticket.state === "cancelled" || ticket.state === "expired"),
        );
        return {
          open: tickets
            .filter(
              (ticket) =>
                ticket.state === "waiting" ||
                ticket.state === "granted" ||
                ticket.state === "running",
            )
            .map((ticket) => ticket.id),
          finished: finished.map((ticket: Ticket) => ({
            id: ticket.id,
            summary: describeJob(ticket),
          })),
        };
      } finally {
        broker.close();
      }
    }),

  reportJob: (jobId) =>
    run("reportJob", () => {
      const broker = openBroker();
      try {
        broker.markReported(jobId);
      } finally {
        broker.close();
      }
    }),

  runJobs: (binding) =>
    runAsync("runJobs", async () => {
      let runner = jobRunners.get(binding.gitCommonDir);
      if (!runner) {
        runner = createJobRunner({ repo: binding.gitCommonDir });
        jobRunners.set(binding.gitCommonDir, runner);
      }
      return (await runner.tick()).length;
    }),

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
      // Before any worker exists, find out which branch names the repository's own guards
      // accept, by really trying them. A repository that rejects every name cannot host a
      // goal, and saying so now costs nothing.
      const loaded = loadContract({
        repoRoot,
        gitCommonDir: repoGit.gitCommonDir,
        refs: [repoGit.baseBranch, integrationBranch],
      });
      const probe = probeBranchPrefix({
        repoRoot,
        gitCommonDir: repoGit.gitCommonDir,
        baseRef: repoGit.baseBranch,
        loaded,
      });
      if (probe.prefix === null) throw new Error(probe.detail);
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
        const progressFacts = getQueueProgressFacts(db, binding.planId);
        const resourceInspection = inspectQueueResources(
          binding,
          rows
            .filter(
              (row) =>
                row.status === "claimed" || row.status === "running" || row.status === "verifying",
            )
            .map((row) => ({ taskId: row.id })),
        );
        const problems = db
          .prepare(
            `SELECT id, title, status, failure_reason, failure_class, retry_count, max_retries FROM tasks
             WHERE plan_id = ? AND (status IN ('failed', 'blocked') OR integration_state = 'repair_needed')`,
          )
          .all(binding.planId) as Array<{
          id: string;
          title: string;
          status: string;
          failure_reason: string | null;
          failure_class: string | null;
          retry_count: number;
          max_retries: number;
        }>;
        return {
          snapshot,
          ready,
          deadlocked: deadlock.isDeadlocked,
          deadlockReason: deadlock.reason ?? null,
          awaitingEnvironment: deadlock.awaitingEnvironment === true,
          environmentTaskIds: deadlock.environmentTaskIds ?? [],
          candidates: listCandidates(db, binding.planId),
          progressFacts,
          resourceProgress: resourceInspection,
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
            failureClass: row.failure_class,
          })),
        } satisfies QueueStatus;
      }),
    ),

  reserveNext: (binding, workerSessionId, excludeTaskIds) =>
    runAsync("reserveNext", async () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      try {
        const outcome = await reserveNextTask(db, {
          repoRoot: binding.repoRoot,
          baseBranch: goalBranchOf(binding),
          targetBranch: binding.baseBranch,
          gitCommonDir: binding.gitCommonDir,
          planId: binding.planId,
          workerSessionId,
          ...(excludeTaskIds && excludeTaskIds.size > 0 ? { excludeTaskIds } : {}),
          // An expired heartbeat is not evidence that a live server's worker stopped.
          // GoalService reconciles quiet threads explicitly; process death permits core recovery.
          isOwnerAlive: (pid) => isProcessAlive(pid),
        });
        return outcome.kind === "reserved"
          ? { task: outcome.task, skipped: [], held: [] }
          : { task: null, skipped: outcome.skipped, held: outcome.held };
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
              `SELECT c.task_id, c.owner_token, c.worker_session_id, c.worker_pid, c.worktree_path, c.branch
               FROM task_claims c JOIN tasks t ON t.id = c.task_id
               WHERE c.released_at IS NULL AND t.plan_id = ?`,
            )
            .all(binding.planId) as Array<{
            task_id: string;
            owner_token: string;
            worker_session_id: string | null;
            worker_pid: number | null;
            worktree_path: string;
            branch: string;
          }>
        ).map((row) => ({
          taskId: row.task_id,
          claimToken: row.owner_token,
          workerSessionId: row.worker_session_id,
          workerAlive: row.worker_pid === null || isProcessAlive(row.worker_pid),
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

  replacementContext: (binding, taskId) =>
    run("replacementContext", () =>
      withDb(binding, (db) => {
        const headResult = NodeChildProcess.spawnSync(
          "git",
          ["rev-parse", "--verify", "--quiet", `refs/heads/${goalBranchOf(binding)}^{commit}`],
          { cwd: binding.repoRoot, encoding: "utf8" },
        );
        const integrationHead =
          headResult.status === 0 && /^[\da-f]{40,64}$/iu.test(headResult.stdout.trim())
            ? headResult.stdout.trim()
            : null;
        const failures = db
          .prepare("SELECT message FROM task_failures WHERE task_id = ? ORDER BY id DESC LIMIT 2")
          .all(taskId) as Array<{ message: string }>;
        const current = db
          .prepare("SELECT failure_reason FROM tasks WHERE id = ? AND plan_id = ?")
          .get(taskId, binding.planId) as { failure_reason: string | null } | undefined;
        const root = taskId.replace(/(?:-FU\d+)+$/u, "");
        const rows = db
          .prepare(
            "SELECT id, title, status, failure_reason, created_at FROM tasks WHERE plan_id = ?",
          )
          .all(binding.planId) as Array<{
          id: string;
          title: string;
          status: string;
          failure_reason: string | null;
          created_at: string;
        }>;
        const siblingRepairs = rows
          .filter((row) => row.id !== taskId && row.id.startsWith(`${root}-FU`))
          .sort((left, right) => left.created_at.localeCompare(right.created_at))
          .slice(-8)
          .map((row) => {
            const landing = db
              .prepare(
                "SELECT commit_hash FROM landing_queue WHERE task_id = ? AND status = 'landed' ORDER BY id DESC LIMIT 1",
              )
              .get(row.id) as { commit_hash: string | null } | undefined;
            const event = db
              .prepare(
                "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task_landed' ORDER BY id DESC LIMIT 1",
              )
              .get(row.id) as { payload_json: string } | undefined;
            let eventCommit: string | null = null;
            if (event) {
              try {
                const payload = JSON.parse(event.payload_json) as { landedCommit?: unknown };
                if (typeof payload.landedCommit === "string") eventCommit = payload.landedCommit;
              } catch {
                // Malformed historical event data is unknown, not a handoff fact.
              }
            }
            return {
              taskId: row.id.slice(0, 120),
              title: row.title.slice(0, 160),
              status: row.status.slice(0, 40),
              landedCommit: (landing?.commit_hash ?? eventCommit)?.slice(0, 64) ?? null,
              failure: row.failure_reason?.slice(0, 500) ?? null,
            };
          });
        return {
          integrationHead,
          latestFailure: (failures[0]?.message ?? current?.failure_reason)?.slice(0, 500) ?? null,
          earlierFailure: failures[1]?.message.slice(0, 500) ?? null,
          siblingRepairs,
        } satisfies ReplacementQueueContext;
      }),
    ),

  release: (binding, claimToken, status, reason, options) =>
    run("release", () =>
      withDb(binding, (db) => {
        if (status === "hold") {
          const failureClass = options?.failureClass ?? classifyReason(reason ?? "");
          const waitsForEnvironment =
            failureClass === "configuration" ||
            failureClass === "prerequisite" ||
            failureClass === "external";
          return holdClaim(db, claimToken, {
            failureClass,
            reason: reason ?? "Held",
            fingerprint: waitsForEnvironment ? fingerprintOf(binding, failureClass) : null,
          });
        }
        if (status === "retry") {
          const why = reason ?? "Attempt did not land";
          const failureClass = options?.failureClass ?? classifyReason(why);
          return releaseClaimForRetry(db, claimToken, why, {
            failureClass,
            // A deterministic failure waits for the environment to change; remember which one.
            fingerprint:
              failureClass === "transient" ||
              failureClass === "verification" ||
              failureClass === "scope"
                ? null
                : fingerprintOf(binding, failureClass),
            headCommit: options?.headCommit ?? null,
            ...(options?.record === false ? { record: false } : {}),
          }).released;
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
        gitCommonDir: binding.gitCommonDir,
        targetBranch: binding.baseBranch,
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
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      try {
        // Keep claim grants serialized with the file operation, including external queue actors.
        db.exec("BEGIN IMMEDIATE");
        const owned = db
          .prepare(
            "SELECT 1 FROM task_claims WHERE released_at IS NULL AND worktree_path = ? LIMIT 1",
          )
          .get(worktreePath);
        if (owned) return { preserved: true };
        return await teardownWorktree(binding.repoRoot, worktreePath, branch, {
          isSuccess: landed,
          deleteBranch: landed,
          keepIfDirty: landed,
          preserveWorktreeOnFailure: !landed,
          emptyBaseRef: goalBranchOf(binding),
        });
      } finally {
        if (db.isTransaction) db.exec("ROLLBACK");
        db.close();
      }
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
      withDb(binding, (db) => {
        // What the note says decides what it waits for: a wall the environment can lift
        // (a guard, a tool) is revalidated when it changes; production access stays external.
        const failureClass = classifyReason(input.note);
        const deterministic =
          failureClass === "configuration" ||
          failureClass === "prerequisite" ||
          failureClass === "external";
        return addFollowUpTask(db, {
          planId: binding.planId,
          ...input,
          ...(deterministic
            ? { failureClass, fingerprint: fingerprintOf(binding, failureClass) }
            : {}),
        });
      }),
    ),

  audit: (binding) =>
    runAsync("audit", () => {
      const db = openQueueDatabase({ gitCommonDir: binding.gitCommonDir });
      return auditUnverifiedTasks(db, {
        repoRoot: binding.repoRoot,
        gitCommonDir: binding.gitCommonDir,
        baseBranch: binding.baseBranch,
        integrationBranch: goalBranchOf(binding),
        planId: binding.planId,
      }).finally(() => db.close());
    }),

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

export { parseScopeRequests };
