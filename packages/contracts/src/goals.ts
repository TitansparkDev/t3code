/** @module goals */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const GoalId = Schema.String.pipe(Schema.brand("GoalId"));
export type GoalId = typeof GoalId.Type;

/** What an agent replies, on its own line, when a goal has no work left. */
const GOAL_COMPLETE_MARKER = "GOAL COMPLETE";
/** What an agent replies at the start of a line when no plan chunk is ready. */
const GOAL_BLOCKED_MARKER = "BLOCKED TASKS";
/** What an agent replies, on its own line, when it is stuck or needs the person. */
const GOAL_NEEDS_ATTENTION_MARKER = "NEEDS ATTENTION";
export const DEFAULT_GOAL_CONCURRENCY = 3;
export const MAX_GOAL_CONCURRENCY = 100;
export const MAX_GOAL_AGENT_COUNT = 100;
/** Agents in a row that may fail to finish before the goal stops itself. */
export const DEFAULT_GOAL_STOP_AFTER_PROBLEMS = 3;
export const MAX_GOAL_STOP_AFTER_PROBLEMS = 50;
/** Escalations one worker chat may raise before the goal gives up on it for good. */
export const MAX_GOAL_ESCALATION_ROUNDS = 3;
/** Overseer runs that may leave one escalation unhandled before it goes to the person. */
export const MAX_GOAL_ESCALATION_UNHANDLED = 2;
/** Stuck escalations since the last finished chat before the goal fails. */
export const MAX_GOAL_STUCK_ESCALATIONS = 3;
export const DEFAULT_GOAL_MAX_CHATS = 50;
export const MAX_GOAL_MAX_CHATS = 10_000;

/** `draft` is a setup that was saved but not started: it runs nothing until started. */
export const GoalStatus = Schema.Literals(["draft", "running", "complete", "stopped", "failed"]);
export type GoalStatus = typeof GoalStatus.Type;

/**
 * `stopped` is a chat that ended without finishing for a reason that is not a
 * problem with the work: a usage limit it was not resumed from, or the person
 * stopped it. It does not close a lane and does not count toward stopping the goal.
 */
export const GoalChatStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "attention",
  "stopped",
]);
export type GoalChatStatus = typeof GoalChatStatus.Type;

const PositiveCount = (maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum }));

/** One provider, model and effort level, and how many of its chats may run at once. */
export const GoalAgent = Schema.Struct({
  modelSelection: ModelSelection,
  count: PositiveCount(MAX_GOAL_AGENT_COUNT),
});
export type GoalAgent = typeof GoalAgent.Type;

export const GoalChat = Schema.Struct({
  threadId: ThreadId,
  /** Index into the goal's `agents` that this chat runs on. */
  agentIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  status: GoalChatStatus,
  startedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
  /** Set while the chat waits for a provider usage limit to reset. */
  waitingForLimit: Schema.optional(Schema.Boolean),
  /** Historical Beads fields retained when reading older Goal records. */
  beadId: Schema.optional(Schema.String),
  beadTitle: Schema.optional(Schema.String),
  /** The agent found only blocked work, so it did nothing and no replacement should start yet. */
  blockedWork: Schema.optional(Schema.Boolean),
  /** The chat was already asked once to try again on its own after saying it was stuck. */
  nudged: Schema.optional(Schema.Boolean),
  /** This chat is the overseer, not a worker: it decides how a stuck goal goes on. */
  overseer: Schema.optional(Schema.Boolean),
  /** Set while this worker is held (still running, lane occupied) waiting for an overseer. */
  escalationId: Schema.optional(Schema.String),
  /** AgentQueue assignment, kept so a restart can find the claim this chat is working under. */
  taskId: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  /** The fencing token of the claim. Only the holder may release or land the task. */
  claimToken: Schema.optional(Schema.String),
  baseBranch: Schema.optional(Schema.String),
  /** The worker's thread was settled with the orchestration engine once its task was handed in. */
  settled: Schema.optional(Schema.Boolean),
  /** What the worker asked a person for. Recorded for the person; it never decides the task. */
  attentionNote: Schema.optional(Schema.String),
  /** The task's worktree was removed after its work landed. */
  worktreeRetired: Schema.optional(Schema.Boolean),
  /** Times this worker was sent back to fix a failed check. */
  landingRetries: Schema.optional(Schema.Number),
  /**
   * Stored resource jobs this worker handed to the queue (a build, an emulator run) and is waiting
   * on. While any is open the chat is parked: no turn runs and no lane is used.
   */
  resourceJobs: Schema.optional(Schema.Array(Schema.String)),
  /** Times this same conversation was brought back to continue its task (repair, retry, results). */
  resumes: Schema.optional(Schema.Number),
  /** Routine stored-job result deliveries; these do not count against repair ownership. */
  resourceResumes: Schema.optional(Schema.Number),
  /** A durable intent that makes a stored-job result safe to replay after a server restart. */
  resourceDelivery: Schema.optional(
    Schema.Struct({
      idempotencyKey: Schema.String,
      jobIds: Schema.Array(Schema.String),
      text: Schema.String,
    }),
  ),
  /** When the latest resume was sent: an end-of-turn event for a turn requested before it is stale. */
  resumedAt: Schema.optional(IsoDateTime),
  /**
   * What became of the assigned task, from the queue's records (never from the worker's
   * words): `submitted` = candidate recorded and awaiting integration, `integrated` =
   * merged and completed, `returned` = given back untouched, `attention` = needs a person,
   * `waiting` = parked on a stored resource job; the same conversation resumes when it finishes.
   */
  taskOutcome: Schema.optional(
    Schema.Literals(["submitted", "integrated", "returned", "attention", "retry", "waiting"]),
  ),
});
export type GoalChat = typeof GoalChat.Type;

/**
 * A provider the goal is not using for now, and until when. `usage-limit` waits
 * for the provider's limit to reset; `errors` backs off after chats on it
 * failed, so a broken account is not retried over and over.
 */
export const GoalProviderPause = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Only this model. Missing means every model on the account. */
  model: Schema.optional(Schema.String),
  until: IsoDateTime,
  /** `login`: the provider needs a person to sign in; held until the goal is started again. */
  reason: Schema.Literals(["usage-limit", "errors", "login"]),
  /** Failures in a row, for lengthening the back-off. */
  strikes: Schema.optional(Schema.Number),
});
export type GoalProviderPause = typeof GoalProviderPause.Type;

/** Everything a person chooses on the setup page. */
export const GoalSettings = Schema.Struct({
  /** What the goal is: its name and description in lists and chat titles. */
  name: TrimmedNonEmptyString,
  /** The instructions every agent receives. Empty or missing uses the name. */
  prompt: Schema.optional(Schema.String),
  projectId: ProjectId,
  agents: Schema.Array(GoalAgent).check(Schema.isMinLength(1)),
  /** Most chats working at the same time, across all agents. */
  concurrency: PositiveCount(MAX_GOAL_CONCURRENCY),
  /** Most chats to start in total. Null keeps going until an agent says it is complete. */
  maxChats: Schema.NullOr(PositiveCount(MAX_GOAL_MAX_CHATS)),
  runtimeMode: RuntimeMode,
  /** Resume chats that stop on a usage limit when it resets, so the work gets finished. */
  autoResume: Schema.Boolean,
  /** Add the standard coding workflow and safety rules to worker prompts. */
  standardRules: Schema.Boolean,
  /** Historical field retained when reading older Goal records; new Goals use PLAN.md. */
  useBeads: Schema.optional(Schema.Boolean),
  /** Historical Beads filter retained when reading older Goal records. */
  beadsScope: Schema.optional(Schema.String),
  /** Stop starting agents after this many in a row fail to finish. Missing means the default. */
  stopAfterProblems: Schema.optional(PositiveCount(MAX_GOAL_STOP_AFTER_PROBLEMS)),
  /**
   * When the goal gets stuck (agents keep failing, or every chunk is blocked), ask an
   * overseer agent what to do before giving up. Missing means on.
   */
  overseer: Schema.optional(Schema.Boolean),
  /**
   * The models that run the overseer, taken in turn so its usage is spread over several accounts.
   * One that is out of usage, signed out or failing is skipped. Missing or empty uses Chat Agents
   * when it is ready, otherwise the goal's own agents; those agents are also the fallback when no
   * overseer model is free.
   */
  overseerAgents: Schema.optional(Schema.Array(ModelSelection)),
  /**
   * How workers get work. `auto` (what the setup pages send) uses AgentQueue when the
   * project has a valid active plan and standard `plan-work` otherwise; `agentqueue`
   * refuses to start without a valid plan; `standard` never uses the queue. Records
   * saved before AgentQueue existed have no value and run as standard.
   */
  queueMode: Schema.optional(Schema.Literals(["auto", "standard", "agentqueue"])),
  /** The plan file to use, relative to the project's repository. Empty picks the active plan. */
  planPath: Schema.optional(Schema.String),
  /**
   * What to do when publishing the finished plan meets uncommitted edits in the checkout
   * that has the target branch open. `reconcile` (default) preserves provably abandoned edits
   * in a snapshot and keeps them on top of the result; `wait` never touches the checkout.
   * Edits with a live owner, staged changes and conflicts are never touched either way.
   */
  checkoutPolicy: Schema.optional(Schema.Literals(["reconcile", "wait"])),
  /** Historical flag; read as `queueMode: "agentqueue"` when `queueMode` is missing. */
  useAgentQueue: Schema.optional(Schema.Boolean),
  /** Historical; the bound plan id lives in `agentQueue`. */
  planId: Schema.optional(Schema.String),
  runGeneration: Schema.optional(Schema.Number),
});
export type GoalSettings = typeof GoalSettings.Type;

/**
 * What a goal running on AgentQueue is bound to. Set when the goal starts, after the plan
 * was validated and imported, and never guessed afterwards.
 */
export const GoalAgentQueueBinding = Schema.Struct({
  planId: Schema.String,
  planPath: Schema.String,
  /** The branch finished tasks are integrated into; the target branch is updated from it at the end. */
  integrationBranch: Schema.optional(Schema.String),
  /** The repository the queue and worktrees belong to. */
  repoRoot: Schema.String,
  gitCommonDir: Schema.String,
  baseBranch: Schema.String,
  importedAt: IsoDateTime,
  checksum: Schema.String,
});
export type GoalAgentQueueBinding = typeof GoalAgentQueueBinding.Type;

/** Where an AgentQueue goal stands, derived from the queue each time it is checked. */
export const GoalQueueProgress = Schema.Struct({
  total: Schema.Number,
  completed: Schema.Number,
  ready: Schema.Number,
  /** Pending and waiting on tasks that are not done. */
  waiting: Schema.Number,
  /** Workers implementing (or repairing) right now. */
  running: Schema.Number,
  /** Submitted work waiting to merge. */
  awaitingIntegration: Schema.Number,
  /** Submitted work automatic repair could not merge; needs the overseer or a person. */
  needsRepair: Schema.Number,
  failed: Schema.Number,
  phase: Schema.Literals([
    "implementing",
    "waiting-dependencies",
    "waiting-integration",
    "waiting-publication",
    "blocked",
    "complete",
    "idle",
  ]),
  note: Schema.optional(Schema.String),
  /**
   * Set while tasks are ready and agents have room, yet nothing can start: why, and since when.
   * A separate field (not a phase) so a record written with it still reads on an older server.
   */
  stall: Schema.optional(
    Schema.Struct({
      since: IsoDateTime,
      /** One line a person can act on: which tasks wait, for what, and who holds it. */
      summary: Schema.String,
      taskIds: Schema.Array(Schema.String),
    }),
  ),
  /** Exact work or wait behind the compatibility phase, from persisted queue and resource facts. */
  activity: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals([
        "implementing",
        "verifying",
        "running-resource-job",
        "waiting-resource",
        "waiting-results",
        "waiting-dependencies",
        "waiting-integration",
        "waiting-publication",
        "blocked",
        "complete",
        "idle",
        "unknown",
      ]),
      inspectionAvailable: Schema.Boolean,
      oldestWait: Schema.optional(
        Schema.Struct({
          taskId: Schema.String,
          since: IsoDateTime,
          reason: Schema.Literals([
            "dependencies",
            "blocked",
            "integration",
            "resource",
            "results",
          ]),
        }),
      ),
      activeChecks: Schema.Array(
        Schema.Struct({
          taskId: Schema.String,
          ticketId: Schema.String,
          checkId: Schema.optional(Schema.String),
          state: Schema.Literals(["waiting", "granted", "running"]),
          resources: Schema.Array(Schema.String),
          enqueuedAt: IsoDateTime,
          startedAt: Schema.optional(IsoDateTime),
          finishedAt: Schema.optional(IsoDateTime),
        }),
      ),
      activeJobs: Schema.Array(
        Schema.Struct({
          taskId: Schema.String,
          ticketId: Schema.String,
          state: Schema.Literals(["waiting", "granted", "running", "finished-unreported"]),
          resources: Schema.Array(Schema.String),
          enqueuedAt: IsoDateTime,
          startedAt: Schema.optional(IsoDateTime),
          finishedAt: Schema.optional(IsoDateTime),
        }),
      ),
      resourceWaits: Schema.Array(
        Schema.Struct({
          taskId: Schema.String,
          ticketId: Schema.String,
          checkId: Schema.optional(Schema.String),
          resources: Schema.Array(Schema.String),
          enqueuedAt: IsoDateTime,
        }),
      ),
      omittedChecks: Schema.Number,
      omittedJobs: Schema.Number,
      omittedResourceWaits: Schema.Number,
      completedParentTasks: Schema.Number,
      completedRepairTasks: Schema.Number,
      remainingDependencyTaskIds: Schema.Array(Schema.String),
      omittedDependencyCount: Schema.Number,
    }),
  ),
  checkedAt: IsoDateTime,
});
export type GoalQueueProgress = typeof GoalQueueProgress.Type;

/** Historical Beads queue snapshot retained when reading older Goal records. */
export const GoalQueue = Schema.Struct({
  ready: Schema.Number,
  /** Claimed and being worked on. */
  working: Schema.Number,
  /** Unfinished and waiting on other chunks. */
  blocked: Schema.Number,
  done: Schema.Number,
  checkedAt: IsoDateTime,
});
export type GoalQueue = typeof GoalQueue.Type;

export const GoalEscalationKind = Schema.Literals([
  "attention",
  "repeated-failure",
  "blocked",
  "stuck",
  "manual",
]);
export type GoalEscalationKind = typeof GoalEscalationKind.Type;
export const GoalEscalationStatus = Schema.Literals([
  "open",
  "reviewing",
  "resolved",
  "needs-person",
  "cancelled",
]);
export type GoalEscalationStatus = typeof GoalEscalationStatus.Type;
export const GoalEscalationAction = Schema.Literals([
  "replied",
  "retry",
  "unblock",
  "give-up",
  "needs-person",
  "cancelled",
]);
export type GoalEscalationAction = typeof GoalEscalationAction.Type;

/**
 * A problem the goal's overseer must answer: about one worker chat (threadId), or about the
 * whole goal when it has none. Durable, so a restart resumes it; a held worker keeps its lane
 * until the escalation is resolved.
 */
export const GoalEscalation = Schema.Struct({
  id: Schema.String,
  kind: GoalEscalationKind,
  status: GoalEscalationStatus,
  reason: Schema.String.check(Schema.isMaxLength(4000)),
  threadId: Schema.optional(ThreadId),
  taskId: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.optional(IsoDateTime),
  overseerThreadId: Schema.optional(ThreadId),
  resolution: Schema.optional(
    Schema.Struct({
      action: GoalEscalationAction,
      note: Schema.String,
      by: Schema.Literals(["overseer", "person", "server"]),
    }),
  ),
  /** Overseer runs that have taken this escalation. */
  rounds: Schema.Number,
});
export type GoalEscalation = typeof GoalEscalation.Type;

export const Goal = Schema.Struct({
  ...GoalSettings.fields,
  id: GoalId,
  status: GoalStatus,
  detail: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set when the goal is started again; chats and failures before it no longer count. */
  restartedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  chats: Schema.Array(GoalChat),
  queue: Schema.optional(GoalQueue),
  /** Present when workers are assigned tasks from the repository's AgentQueue. */
  agentQueue: Schema.optional(GoalAgentQueueBinding),
  queueProgress: Schema.optional(GoalQueueProgress),
  /** Why a goal that asked for `auto` runs without AgentQueue. */
  queueReason: Schema.optional(Schema.String),
  /** Last AgentQueue event this goal has seen, so a restart does not replay or miss wakeups. */
  queueEventCursor: Schema.optional(Schema.Number),
  /** AgentQueue operations that failed in a row; the goal stops at three. */
  queueErrors: Schema.optional(Schema.Number),
  /** A chat found only blocked work: start nothing new until another chat finishes. */
  holdStarts: Schema.optional(Schema.Boolean),
  /** Providers set aside for now. A paused provider gets no new chats until `until`. */
  pauses: Schema.optional(Schema.Array(GoalProviderPause)),
  /**
   * Set while the goal is running but cannot start anything because every
   * provider it uses is paused or unavailable: when the first one comes back.
   */
  waitingUntil: Schema.optional(IsoDateTime),
  /** Set while ready work waits for the machine (memory, load) rather than for a provider. */
  hostBusy: Schema.optional(Schema.Boolean),
  /** The overseer's latest note, passed to every worker started after it. */
  guidance: Schema.optional(Schema.String),
  /** Chats before this position were looked at by the overseer or a restart: they no longer count. */
  reviewedChats: Schema.optional(Schema.Number),
  /** Overseers asked for since the goal was last started by hand. Historical; no longer written. */
  overseerRuns: Schema.optional(Schema.Number),
  /** Problems the overseer is asked about, oldest first. */
  escalations: Schema.optional(Schema.Array(GoalEscalation)),
});
export type Goal = typeof Goal.Type;

export const GoalList = Schema.Struct({ goals: Schema.Array(Goal) });
export type GoalList = typeof GoalList.Type;

/** What an overseer may do with an escalation that is not a reply to its worker. */
export const GoalEscalationResolveAction = Schema.Literals([
  "retry",
  "unblock",
  "give-up",
  "needs-person",
]);
export type GoalEscalationResolveAction = typeof GoalEscalationResolveAction.Type;

/** Everything an overseer needs to decide one escalation, read through the MCP tools. */
export const GoalEscalationPacket = Schema.Struct({
  goalId: GoalId,
  goalName: Schema.String,
  goalInstructions: Schema.String,
  projectId: ProjectId,
  guidance: Schema.optional(Schema.String),
  escalation: GoalEscalation,
  worker: Schema.optional(
    Schema.Struct({
      threadId: ThreadId,
      taskId: Schema.optional(Schema.String),
      branch: Schema.optional(Schema.String),
      worktreePath: Schema.optional(Schema.String),
      baseBranch: Schema.optional(Schema.String),
      landingRetries: Schema.optional(Schema.Number),
      attentionNote: Schema.optional(Schema.String),
    }),
  ),
  /** The worker's last assistant messages, oldest first, each trimmed to its end. */
  recentReplies: Schema.Array(Schema.String),
  /** The AgentQueue briefing for the worker's task, for queue goals. */
  queueBriefing: Schema.optional(Schema.String),
  /** Earlier escalations for the same worker chat, with what was done about them. */
  previous: Schema.Array(GoalEscalation),
});
export type GoalEscalationPacket = typeof GoalEscalationPacket.Type;

const GOAL_ESCALATION_MESSAGES = {
  "not-found": "The escalation was not found.",
  closed: "The escalation is already resolved.",
  "no-thread": "The escalation is not about a worker chat.",
  "not-held": "The worker is still working; wait until it stops.",
  "invalid-chat": "The worker chat is not part of this goal.",
  "not-sent": "The message could not be sent to the worker.",
  "queue-action-failed":
    "The queue could not apply the recovery action; the escalation remains open.",
} as const;

export class GoalEscalationError extends Schema.TaggedError<GoalEscalationError>()(
  "GoalEscalationError",
  {
    reason: Schema.Literals([
      "not-found",
      "closed",
      "no-thread",
      "not-held",
      "invalid-chat",
      "not-sent",
      "queue-action-failed",
    ]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.detail
      ? `${GOAL_ESCALATION_MESSAGES[this.reason]} ${this.detail}`
      : GOAL_ESCALATION_MESSAGES[this.reason];
  }
}

/** The first line of a goal's name, for lists and chat titles. */
export function goalTitle(goal: Pick<Goal, "name">): string {
  const firstLine = goal.name.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

const GOAL_COMPLETE_LINE = new RegExp(`^\\s*${GOAL_COMPLETE_MARKER}\\s*$`, "mu");
/**
 * A marker must start its own line and may be followed by a reason separator.
 * Narration or a mention inside prose does not count.
 */
const MARKER_LINE_START = "^[ \\t]*(?:(?:#{1,6}|[-*+>]|\\*\\*|__)[ \\t]*)*";
const MARKER_LINE_TAIL = "(?:\\*\\*)?(?:[ \\t]*$|(?::|[ \\t]+[-–\\u2014])(?=[ \\t]*\\S))";
const GOAL_NEEDS_ATTENTION_LINE = new RegExp(
  `${MARKER_LINE_START}${GOAL_NEEDS_ATTENTION_MARKER}${MARKER_LINE_TAIL}`,
  "mu",
);

/** Whether an agent's reply says the goal has no work left. */
export function replyReportsGoalComplete(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_COMPLETE_LINE.test(reply);
}

/** Whether an agent's reply says it is blocked or needs the person to do something. */
export function replyNeedsAttention(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_NEEDS_ATTENTION_LINE.test(reply);
}

const GOAL_ATTENTION_NOTE = new RegExp(
  `${MARKER_LINE_START}${GOAL_NEEDS_ATTENTION_MARKER}${MARKER_LINE_TAIL}([^]*)$`,
  "mu",
);

/**
 * What a worker asked a person for: the marker line and what follows it, with or without a
 * colon. Used to keep the request visible; AgentQueue tasks are decided by commits and checks.
 */
export function replyAttentionNote(reply: string | undefined): string | undefined {
  const match = reply === undefined ? null : GOAL_ATTENTION_NOTE.exec(reply);
  if (!match || reply === undefined) return undefined;
  const after = match[1]!.trim();
  if (after) return after.slice(0, 1200);
  // A bare marker: the explanation is what the worker wrote just before it.
  const before = reply
    .slice(0, match.index)
    .replace(/\*\*Needs attention:?\*\*:?/giu, "")
    .trim();
  return (before ? before.slice(-1200) : "The worker asked for a person.").trim();
}

const GOAL_BLOCKED_LINE = new RegExp(
  `${MARKER_LINE_START}${GOAL_BLOCKED_MARKER}${MARKER_LINE_TAIL}`,
  "mu",
);

/** Whether an agent's reply says the remaining work is all waiting on unfinished tasks. */
export function replyReportsBlockedWork(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_BLOCKED_LINE.test(reply);
}

/** What a chat that ended with this status and flag counts as, for deciding to stop. */
function isProblemChat(chat: Pick<GoalChat, "status" | "blockedWork">): boolean {
  return chat.status === "failed" || chat.status === "attention" || chat.blockedWork === true;
}

/** Count consecutive unsuccessful finished chats, skipping stopped chats. */
export function problemStreak(chats: ReadonlyArray<GoalChat>): number {
  const finished = chats
    .filter(
      (chat) =>
        chat.status !== "running" && chat.status !== "stopped" && chat.completedAt !== undefined,
    )
    .sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""));
  const firstGood = finished.findIndex((chat) => !isProblemChat(chat));
  return firstGood === -1 ? finished.length : firstGood;
}

/**
 * What a worker is told the first time it says it is blocked or needs attention:
 * try again on its own, with wider authority, before the person or an overseer is asked.
 */
export const GOAL_NUDGE_PROMPT = [
  "You said you are stuck or blocked. Before giving up: are you able to figure this out on your own and complete the chunk?",
  "You may fix a broken build or test, resolve your own merge conflict, install what is missing, or make a small reversible decision and say what you chose. Keep your work inside your selected plan chunk unless a needed fix is clearly related and safe.",
  "Preserve partial work. Never take over, overwrite, clean, or merge another worker's branch or worktree while its process or session is alive. Resume abandoned work only after confirming that the exact prior worker is no longer running.",
  "Stay safe: do not delete data you did not create, force-push over other people's work, disable security or safety checks, or spend money.",
  `If it truly needs a person (a login, a secret, a decision that cannot be undone), reply ${GOAL_NEEDS_ATTENTION_MARKER} again on a line by itself and say exactly what is needed. If no plan chunk is ready, reply ${GOAL_BLOCKED_MARKER} and briefly explain what blocks it. Otherwise finish the work and end as usual.`,
].join("\n");

/** A worker chat's plain title: "Goal worker #3". */
export function goalWorkerTitle(number: number): string {
  return `Goal worker #${number}`;
}

export const GOAL_OVERSEER_TITLE = "Goal overseer";

/** The instructions every agent in the goal receives, before the rules added to them. */
export function goalInstructions(goal: Pick<Goal, "name" | "prompt">): string {
  return goal.prompt?.trim() || goal.name;
}

/**
 * The prompt every goal chat receives. Chats run unattended, so they are told
 * to work alone and which line to end on when the work cannot go on. The
 * working rules are optional because not every goal is code in a shared
 * repository. Coding workers select work from the active plan with plan-work.
 */
export function goalPrompt(
  goal: Pick<Goal, "name" | "prompt" | "concurrency" | "standardRules"> &
    Partial<Pick<Goal, "guidance">>,
): string {
  return [
    goalInstructions(goal),
    "",
    "--- Goal rules (added automatically) ---",
    `You are one of up to ${goal.concurrency} agents working on this goal at the same time, each in its own chat. Nobody is available to answer questions: use your best judgment, choose the safest reasonable option, and say what you chose.`,
    ...(goal.standardRules
      ? [
          "Use plan-work for repository work tracked by an active PLAN.md (or the plan named by AGENTS.md): select exactly one eligible chunk with `plan-work select --plan PLAN.md`, keep its OWNER_TOKEN, and work only in the stable branch and worktree it reports. If no chunk is eligible, do not choose one manually; report BLOCKED TASKS with the reason. If there is no active plan, follow the Goal and repository's normal non-Beads workflow; do not invent task ownership records.",
          "Preserve useful partial work and checkpoints. Before resuming an existing branch, confirm the exact previous worker process and session are no longer alive. Never overwrite or clean another worker's worktree.",
          "Run the chunk's stated checks. Land it with `plan-work land --owner-token TOKEN`; this serializes the merge and records completion only after the code lands. Do not mark a chunk complete or merge it by hand.",
        ]
      : []),
    ...(goal.guidance?.trim()
      ? ["--- Note from the goal's overseer ---", goal.guidance.trim()]
      : []),
    "Finish one piece of work, then stop. A fresh chat takes the next piece.",
    "Do not spend time exploring: if you cannot quickly find unfinished work you can start, do not build, test, or read the whole repository to look harder. End right away with the matching line below.",
    "End your last message with exactly one of these on a line by itself, when it applies:",
    `${GOAL_COMPLETE_MARKER}: there is no unfinished work left at all.`,
    `${GOAL_BLOCKED_MARKER}: unfinished work remains, but no plan chunk is currently eligible; briefly state why.`,
    `${GOAL_NEEDS_ATTENTION_MARKER}: you hit a problem you cannot fix (for example it cannot be merged even after one rebase), or something only a person can do (a login, a decision, a missing secret). Explain it; that chat is kept open for the person to read.`,
  ].join("\n");
}

/**
 * Why a setup is not ready to start, or undefined when it is. Shared by the
 * setup pages so web and mobile accept the same input as the server.
 */
export function goalSettingsProblem(
  settings: Pick<GoalSettings, "name" | "agents" | "concurrency" | "maxChats">,
): string | undefined {
  if (settings.name.trim().length === 0) return "Write what the goal is.";
  if (settings.agents.length === 0) return "Choose at least one model.";
  if (settings.maxChats !== null && settings.maxChats < settings.concurrency) {
    return "The most chats to run must be at least as many as run at once, or choose until complete.";
  }
  return undefined;
}

/** What a queue-bound goal asks for, read from the settings (old records say nothing). */
export function requestedQueueMode(
  goal: Pick<GoalSettings, "queueMode" | "useAgentQueue">,
): "auto" | "standard" | "agentqueue" {
  return goal.queueMode ?? (goal.useAgentQueue ? "agentqueue" : "standard");
}

/** The task a queue worker was given, as the worker's first message describes it. */
export interface QueueTaskAssignment {
  readonly taskId: string;
  readonly title: string;
  readonly description: string | null;
  readonly verificationCommand: string | null;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly planPath: string;
  readonly retryCount: number;
  readonly lastFailure: string | null;
  /** Set when the work is already done and only has to be repaired so it can merge. */
  readonly repair: string | null;
  /** The commits already on the branch (oldest first, `sha subject`): kept work, never redone. */
  readonly existingCommits?: ReadonlyArray<string>;
  /** Files the merge conflicted in (repairs). */
  readonly conflictFiles?: ReadonlyArray<string>;
  /** Paths the task may change (scope, generated, supporting, amended). Empty = unrestricted. */
  readonly allowedPaths?: ReadonlyArray<string>;
  /** The repository's own commands to run, filled in for this task. */
  readonly guards?: ReadonlyArray<{
    readonly name: string;
    readonly phase: string;
    readonly command: string;
  }>;
  /** Generated files the server rebuilds when they conflict. */
  readonly generatedPaths?: ReadonlyArray<string>;
  /** This task's isolated resources, as lines for the prompt. */
  readonly environmentNotes?: ReadonlyArray<string>;
  /** Facts about this environment (missing optional tools, corrections already made). */
  readonly notes?: ReadonlyArray<string>;
  /** What the server already did to a repair's worktree (see the queue's RepairContext). */
  readonly repairMerge?: {
    readonly state: "conflicted" | "merged" | "none";
    readonly settledByRule: ReadonlyArray<string>;
    readonly integrationBranch: string;
  };
  /** Shared resources the task's checks use; their commands go through `agentq run`. */
  readonly resources?: ReadonlyArray<string>;
  /** How long a command waits for a busy resource before it is stored as a job. Default 30. */
  readonly deferAfterSeconds?: number;
  /** Bounded queue evidence provided only when a replacement takes over an existing task. */
  readonly replacementHandoff?: {
    readonly integrationBranch: string;
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
    readonly outstandingJobs: ReadonlyArray<string>;
    readonly moreOutstandingJobs: number;
  };
}

/** Why a conversation that already worked on a task is being continued on it. */
export type QueueResumeReason =
  | { readonly kind: "conflict" }
  | { readonly kind: "retry"; readonly failure: string | null }
  | { readonly kind: "scope-wait-cleared"; readonly note: string | null }
  | { readonly kind: "follow-up" }
  | { readonly kind: "resource-results"; readonly results: ReadonlyArray<string> };

/** The part of a worker prompt that carries the repository's execution contract for this task. */
function contractLines(task: QueueTaskAssignment): string[] {
  const lines: string[] = [];
  const start = (task.guards ?? []).filter((guard) => guard.phase === "start");
  const submit = (task.guards ?? []).filter((guard) => guard.phase === "submit");
  if (start.length > 0) {
    lines.push(
      "--- The repository's own guards (already passing for your branch; run them again if instructions ask) ---",
      ...start.map((guard) => `- ${guard.name}: \`${guard.command}\``),
    );
  }
  if (submit.length > 0) {
    lines.push(
      `--- Before you finish, run \`agentq task finalize ${task.taskId}\` in your worktree. It runs the repository's own finalizer (${submit.map((guard) => guard.name).join(", ")}) with your task's real allowed paths, and approves extra files your task needs the same way the server will, so a guard you run later never contradicts the server. Do not run the finalizer's raw command yourself. Exit code 3 means not finished: read its output, fix what it names (add the SCOPE-REQUEST line it asks for or revert out-of-scope edits), and run finalize again. ---`,
    );
  }
  if ((task.allowedPaths?.length ?? 0) > 0) {
    lines.push(
      `Your task's own paths: ${task.allowedPaths!.join(", ")}. Other files the task really needs (a model, a migration, a generated schema, a test) are fine to change: the server approves them by itself. It refuses protected files, pauses your task if another running task holds a file you need (and resumes you when it is free), and wants a reason for sensitive ones (credentials, CI, live data): write \`SCOPE-REQUEST: <path> -- <why the task needs it>\` and pass it to finalize as \`--request "SCOPE-REQUEST: <path> -- <why>"\` before you finish, not only in your final message. Do not edit a file just to satisfy a guard.`,
    );
  }
  if ((task.generatedPaths?.length ?? 0) > 0) {
    lines.push(
      `Generated files (${task.generatedPaths!.join(", ")}) are rebuilt by the server when they conflict; do not hand-merge them.`,
    );
  }
  lines.push(...(task.environmentNotes ?? []));
  for (const note of task.notes ?? []) lines.push(`Note: ${note}`);
  return lines;
}

/** How a worker runs anything that contends for a shared machine resource. */
function resourceLines(task: QueueTaskAssignment): string[] {
  const defer = task.deferAfterSeconds ?? 30;
  return [
    `Heavy or shared tools (Gradle, an emulator, Docker, a database, a GPU, compilers, test runs) go through the machine's fair queue: prefix the command with \`agentq run --owner ${task.taskId} --defer-after ${defer} --timeout <seconds> --\`, for example \`agentq run --owner ${task.taskId} --defer-after ${defer} --timeout 1800 -- ./gradlew test\`. The timeout is the task's declared check timeout when the task details give one, otherwise 1800; it kills a hung command so it cannot hold the shared slot forever. It waits its turn, holds the resource only while the command runs, and costs you nothing while it waits. Never start those tools without it${(task.resources?.length ?? 0) > 0 ? ` (this task's checks use ${task.resources!.join(", ")})` : ""}. Never wait on such a command in the foreground or as an untracked background job.`,
    `If \`agentq run\` answers QUEUED (exit 75) the command was stored and the server will run it and send the result into this same conversation: commit what you have and end your turn with the line \`WAITING FOR <the id it printed>\`. A busy resource, a queue or a wait is never a reason to stop, report a problem or write ${GOAL_NEEDS_ATTENTION_MARKER}.`,
  ];
}

/**
 * The prompt a worker receives when its task was already reserved for it. It never
 * mentions plan-work, claiming or choosing work: the server owns assignment, landing
 * and completion. The goal's own instructions are background and cannot change the task.
 */
export function queueWorkerPrompt(
  goal: Pick<Goal, "name" | "prompt" | "concurrency"> & Partial<Pick<Goal, "guidance">>,
  task: QueueTaskAssignment,
): string {
  if (task.repair !== null) return queueRepairPrompt(goal, task);
  return [
    `You are an unattended coding agent. You own task **${task.taskId}**, "${task.title}", until the server confirms it is verified and integrated: this conversation is resumed with exact details if anything needs fixing after you finish (a failing check, a conflict with another task), so you do not need to guess about those cases now.`,
    "",
    "--- Your assignment (fixed by the server) ---",
    `Plan: ${task.planPath}`,
    `Worktree (work only here): ${task.worktreePath}`,
    `Branch: ${task.branch}  (started from the plan's integration branch ${task.baseBranch}, which already holds every finished predecessor task)`,
    ...(task.retryCount > 0
      ? [
          `This task was attempted ${task.retryCount} time(s) before${task.lastFailure ? `; the last attempt ended with: ${task.lastFailure}` : ""}. Earlier commits on the branch are kept: inspect them with \`git log\` and continue from them.`,
        ]
      : []),
    ...((task.existingCommits?.length ?? 0) > 0
      ? [
          "Work already committed on this branch (kept; do not redo it, finish what is missing or fix what failed):",
          ...task.existingCommits!.map((commit) => `  ${commit}`),
        ]
      : []),
    ...replacementHandoffLines(task),
    task.description ? `\nTask details from the plan:\n${task.description}` : "",
    "",
    ...contractLines(task),
    "",
    "--- Rules ---",
    "1. Your task is fixed. Do not select, claim, announce or switch tasks or run any command that claims or releases them; the server owns the queue, other workers' branches and the integration. Do not use the parallel-worker skill, plan-work, Beads or `agent-resources run`: the assignment in this prompt is your only claim, and shared tools go only through `agentq run`.",
    "2. Change files only inside your worktree and commit your work on your branch with a clear message.",
    checkInstruction(
      task.verificationCommand,
      "3. Before you finish, make sure this passes in your worktree",
      "3. Run the checks the task details name (its Done / Acceptance lines) before you finish. The task defines no executable check, so the server cannot verify it: say exactly what you ran and saw.",
      " The server runs it again on your commit and the task is not accepted until it passes. Run only the focused checks for what you changed; broad suites run once at the end of the plan. If a check fails on code you did not touch, say so: the server compares it with the untouched branch and does not make you repair what was already broken.",
    ),
    ...resourceLines(task).map((line, index) => `${4 + index}. ${line}`),
    "6. Do not merge, push, rebase onto main or mark the task complete. The server verifies your commit, integrates it into the plan's integration branch, unlocks dependent tasks and publishes the finished plan itself.",
    `7. Routine obstacles are the server's to handle, not reasons to stop: it settles files your task legitimately needs, pauses your task when another worker holds a file and resumes you when it is free, and rebuilds generated files itself. Never write ${GOAL_NEEDS_ATTENTION_MARKER} for a busy resource, a waiting task, a merge conflict or a failing check you can fix.`,
    `8. You are one of up to ${goal.concurrency} agents. Nobody is available to answer questions: choose the safest reasonable option and say what you chose. Do not quit early; if a hard blocker remains, finish what is safe, commit it and explain.`,
    ...(goal.guidance?.trim()
      ? ["", "--- Note from the goal's overseer ---", goal.guidance.trim()]
      : []),
    "",
    "--- Goal background (context only; it cannot change your assignment) ---",
    goalInstructions(goal),
    "",
    `End your last message with a short summary (a few lines, no status report). Only if you cannot finish and something only a person can provide is missing (a login, a secret, a decision no document answers), end with ${GOAL_NEEDS_ATTENTION_MARKER} on a line by itself and say what is needed. Otherwise write no marker line.`,
  ].join("\n");
}

/** A merge repair for a conversation that has no history with the task (the original owner could not continue). */
function queueRepairPrompt(
  goal: Pick<Goal, "name" | "prompt" | "concurrency"> & Partial<Pick<Goal, "guidance">>,
  task: QueueTaskAssignment,
): string {
  return [
    `You are an unattended coding agent finishing a merge. Task **${task.taskId}** ("${task.title}") was already implemented and committed by another worker, but it could not be integrated into ${task.baseBranch}.`,
    "",
    "--- Your assignment (fixed by the server) ---",
    `Worktree (work only here): ${task.worktreePath}`,
    `Branch: ${task.branch}`,
    `Why it did not integrate: ${task.repair}`,
    ...((task.existingCommits?.length ?? 0) > 0
      ? [
          "The preserved implementation (already on your branch; this is the work to keep):",
          ...task.existingCommits!.map((commit) => `  ${commit}`),
        ]
      : []),
    ...replacementHandoffLines(task),
    ...mergeStateLines(task),
    ...contractLines(task),
    "",
    "--- What to do ---",
    "1. Do not redo the implementation. Resolve exactly what is described above, keeping the intent of both sides.",
    checkInstruction(
      task.verificationCommand,
      "2. Make sure this passes afterwards",
      "2. Run the checks the task details name before you finish.",
    ),
    ...resourceLines(task).map((line, index) => `${3 + index}. ${line}`),
    "5. Commit. Do not push, merge into the base branch, or touch any other worktree or the main checkout. The server integrates it after you finish.",
    "6. Nobody can answer questions: choose the safest option and say what you chose.",
    `If a person must act, end with ${GOAL_NEEDS_ATTENTION_MARKER} on a line by itself and say what is needed.`,
  ].join("\n");
}

function replacementHandoffLines(task: QueueTaskAssignment): string[] {
  const handoff = task.replacementHandoff;
  if (!handoff) return [];
  return [
    "--- Replacement handoff (bounded queue evidence) ---",
    `Current integration revision: ${handoff.integrationBranch} at ${handoff.integrationHead ?? "unavailable"}. Reconcile your kept branch with this revision before changing code.`,
    `Latest recorded failure: ${handoff.latestFailure ?? task.lastFailure ?? "none recorded"}`,
    `Earlier recorded failure: ${handoff.earlierFailure ?? "none recorded"}`,
    "Prior approaches are not recorded; do not infer rejected approaches from unavailable conversation history.",
    ...(handoff.siblingRepairs.length > 0
      ? [
          "Related repair tasks:",
          ...handoff.siblingRepairs.map(
            (repair) =>
              `- ${repair.taskId} (${repair.title}): ${repair.status}; landed commit ${repair.landedCommit ?? "not recorded"}; failure ${repair.failure ?? "none recorded"}`,
          ),
        ]
      : ["Related repair tasks: none recorded."]),
    `Outstanding stored command jobs: ${handoff.outstandingJobs.join(", ") || "none"}${handoff.moreOutstandingJobs > 0 ? `; ${handoff.moreOutstandingJobs} more omitted` : ""}.`,
    "Use the current integration revision and the preserved commits above as the source of truth. Do not repeat work already kept or landed.",
    "",
  ];
}

/** What the server did to a repair's worktree and what is left to do. */
function mergeStateLines(task: QueueTaskAssignment): string[] {
  const merge = task.repairMerge;
  if (!merge || merge.state === "none") return [];
  const settled =
    merge.settledByRule.length > 0
      ? `The server already settled ${merge.settledByRule.join(", ")} by rule; do not touch those.`
      : "";
  if (merge.state === "conflicted") {
    return [
      `The server started the merge of ${merge.integrationBranch} into your branch in your worktree and left it in progress. Files with conflicts: ${(task.conflictFiles ?? []).join(", ") || "see \`git status\`"}. ${settled}Edit each file to keep both intents (no <<<<<<< ======= >>>>>>> lines may remain), \`git add\` it, then \`git commit\` to finish the merge.`,
    ];
  }
  return [
    `The server already merged ${merge.integrationBranch} into your branch (${settled || "no textual conflicts"}); what remains is the failure described above.`,
  ];
}

/**
 * The message that brings back the conversation that already owns a task: only what is new, because
 * everything else is already in its context.
 */
export function queueResumePrompt(task: QueueTaskAssignment, reason: QueueResumeReason): string {
  const where = `Worktree: ${task.worktreePath}  Branch: ${task.branch}`;
  switch (reason.kind) {
    case "conflict":
      return [
        `Task ${task.taskId} is not integrated yet: ${task.repair ?? "it could not be merged"}.`,
        where,
        ...mergeStateLines(task),
        checkInstruction(
          task.verificationCommand,
          "When the merge is done make sure this passes",
          "When the merge is done run the task's checks.",
        ),
        "Then commit (the merge commit finishes the merge) and end your turn with a one-line summary. Do not redo your implementation or touch other branches.",
      ].join("\n");
    case "retry":
      return [
        `Task ${task.taskId} was not accepted${reason.failure ? `: ${reason.failure}` : "."}`,
        where,
        "Fix it from your existing commits, run the check yourself, commit, and end your turn with a one-line summary.",
      ].join("\n");
    case "scope-wait-cleared":
      return [
        `The files you needed for ${task.taskId} are free now${reason.note ? ` (${reason.note})` : ""}; the other worker's changes are merged into your branch.`,
        where,
        ...mergeStateLines(task),
        "Finish the task on top of them, run its checks, commit, and end your turn with a one-line summary.",
      ].join("\n");
    case "follow-up":
      return [
        `A follow-up for your task ${task.taskId} was created: ${task.title}.`,
        where,
        task.description ?? "",
        "Fix the cause, run the check, commit, and end your turn with a one-line summary.",
      ].join("\n");
    case "resource-results":
      return [
        `The stored command${reason.results.length > 1 ? "s" : ""} you queued for ${task.taskId} finished:`,
        ...reason.results,
        where,
        "If a tool call fails because its input format is rejected, switch to an available read tool with a working format instead of repeating the same failing call.",
        "Continue from these results: fix what they show, re-run only what is needed (through \`agentq run\`), commit, and end your turn with a one-line summary.",
      ].join("\n");
  }
}

/** Whether a project and plan can back a goal, as the setup pages show it before starting. */
export const GoalPlanReadiness = Schema.Literals([
  "ready",
  "no-plan",
  "invalid",
  "complete",
  "legacy-active",
  "ambiguous",
  "repo-unusable",
]);
export type GoalPlanReadiness = typeof GoalPlanReadiness.Type;

export const GoalPlanCandidate = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  taskCount: Schema.Number,
  unfinishedCount: Schema.Number,
});

export const GoalPlanPreview = Schema.Struct({
  readiness: GoalPlanReadiness,
  /** The mode the goal would run in if started now. */
  effectiveMode: Schema.Literals(["agentqueue", "standard"]),
  /** Set when the requested mode cannot be honoured; the goal would not start. */
  blocked: Schema.Boolean,
  /** One plain sentence explaining the mode and any problem. */
  summary: Schema.String,
  repoRoot: Schema.String,
  baseBranch: Schema.NullOr(Schema.String),
  planPath: Schema.NullOr(Schema.String),
  planId: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  errors: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  counts: Schema.Struct({
    total: Schema.Number,
    completed: Schema.Number,
    ready: Schema.Number,
    waiting: Schema.Number,
    active: Schema.Number,
    failed: Schema.Number,
    withoutVerification: Schema.Number,
  }),
  legacyOwnedTaskIds: Schema.Array(Schema.String),
  candidates: Schema.Array(GoalPlanCandidate),
});
export type GoalPlanPreview = typeof GoalPlanPreview.Type;

/** The prompt line for a task's check: a command to pass, an explicit exemption, or none defined. */
function checkInstruction(
  verification: string | null,
  prefix: string,
  none: string,
  suffix = "",
): string {
  if (!verification) return none;
  if (verification.startsWith("exempt:")) {
    return `${prefix.slice(0, 2)} This task is exempt from executable checks (${verification.slice(7).trim()}). Record the evidence the task asks for in your final message.`;
  }
  return `${prefix}: \`${verification}\`.${suffix}`;
}
