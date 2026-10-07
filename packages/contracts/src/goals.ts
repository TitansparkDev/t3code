/**
 * Goals — work an environment keeps doing on its own until nothing is left.
 *
 * A person sets one up from the new-chat flow with the Goal switch on: what
 * the goal is, how many agents run at once, which providers, models and effort
 * levels to use and how many of each, and when to stop. The server keeps that
 * many chats working, starts the next chat as each one finishes, and stops
 * when an agent replies GOAL COMPLETE, the cap is reached, or the person
 * stops it. Every chat is an ordinary thread.
 *
 * Fork-local, in its own file so it does not conflict with upstream edits.
 *
 * @module goals
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const GoalId = Schema.String.pipe(Schema.brand("GoalId"));
export type GoalId = typeof GoalId.Type;

/** What an agent replies, on its own line, when a goal has no work left. */
export const GOAL_COMPLETE_MARKER = "GOAL COMPLETE";
/** What an agent replies at the start of a line when no plan chunk is ready. */
export const GOAL_BLOCKED_MARKER = "BLOCKED TASKS";
/** What an agent replies, on its own line, when it is stuck or needs the person. */
export const GOAL_NEEDS_ATTENTION_MARKER = "NEEDS ATTENTION";
export const DEFAULT_GOAL_CONCURRENCY = 3;
export const MAX_GOAL_CONCURRENCY = 100;
export const MAX_GOAL_AGENT_COUNT = 100;
/** Agents in a row that may fail to finish before the goal stops itself. */
export const DEFAULT_GOAL_STOP_AFTER_PROBLEMS = 3;
export const MAX_GOAL_STOP_AFTER_PROBLEMS = 50;
/** Times per start an overseer may be asked to get a stuck goal moving before the goal gives up. */
export const MAX_GOAL_OVERSEER_RUNS = 2;
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
  reason: Schema.Literals(["usage-limit", "errors"]),
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
});
export type GoalSettings = typeof GoalSettings.Type;

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
  /** A chat found only blocked work: start nothing new until another chat finishes. */
  holdStarts: Schema.optional(Schema.Boolean),
  /** Providers set aside for now. A paused provider gets no new chats until `until`. */
  pauses: Schema.optional(Schema.Array(GoalProviderPause)),
  /**
   * Set while the goal is running but cannot start anything because every
   * provider it uses is paused or unavailable: when the first one comes back.
   */
  waitingUntil: Schema.optional(IsoDateTime),
  /** The overseer's latest note, passed to every worker started after it. */
  guidance: Schema.optional(Schema.String),
  /** Chats before this position were looked at by the overseer or a restart: they no longer count. */
  reviewedChats: Schema.optional(Schema.Number),
  /** Overseers asked for since the goal was last started by hand. */
  overseerRuns: Schema.optional(Schema.Number),
});
export type Goal = typeof Goal.Type;

export const GoalList = Schema.Struct({ goals: Schema.Array(Goal) });
export type GoalList = typeof GoalList.Type;

/** The first line of a goal's name, for lists and chat titles. */
export function goalTitle(goal: Pick<Goal, "name">): string {
  const firstLine = goal.name.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

const GOAL_COMPLETE_LINE = new RegExp(`^\\s*${GOAL_COMPLETE_MARKER}\\s*$`, "mu");
const GOAL_NEEDS_ATTENTION_LINE = new RegExp(`^\\s*${GOAL_NEEDS_ATTENTION_MARKER}\\s*$`, "mu");

/** Whether an agent's reply says the goal has no work left. */
export function replyReportsGoalComplete(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_COMPLETE_LINE.test(reply);
}

/** Whether an agent's reply says it is blocked or needs the person to do something. */
export function replyNeedsAttention(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_NEEDS_ATTENTION_LINE.test(reply);
}

const GOAL_BLOCKED_LINE = new RegExp(
  `^[ \\t]*${GOAL_BLOCKED_MARKER}(?:[ \\t]*[-–—:][^\\r\\n]*)?[ \\t]*$`,
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

/**
 * How many of the most recently finished chats in a row did not finish their
 * work (failed, need the person, or found only blocked work). Chats that were
 * stopped by a usage limit or by the person are skipped: they are not evidence
 * either way. A goal that keeps
 * hitting this is not going to get anywhere, so it stops instead of spending usage.
 */
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

export interface OverseerDecision {
  /** `undefined` when the reply did not say: treated as giving up. */
  readonly verdict: "continue" | "stop" | undefined;
  /** Chunks the overseer wants given back to the queue. */
  readonly release: ReadonlyArray<string>;
  /** The prompt for every worker that starts next. */
  readonly guidance: string | undefined;
  /** The prompt for each stuck chat the briefing numbered, by that number. */
  readonly chats: ReadonlyMap<number, string>;
}

const OVERSEER_DIRECTIVE = /^\s*(OVERSEER|RELEASE|GUIDANCE|CHAT\s+\d+)\s*:[ \t]*(.*)$/iu;
const MAX_OVERSEER_TEXT = 6000;

/**
 * Reads an overseer's reply, a list of sections that each start on a line of their
 * own: `OVERSEER: CONTINUE|STOP`, `RELEASE: id, id`, `GUIDANCE:` (the prompt for new
 * workers) and `CHAT n:` (the prompt that continues stuck chat n). A section runs
 * until the next one starts, so prompts may span several lines.
 */
export function parseOverseerReply(reply: string | undefined): OverseerDecision {
  const sections: Array<{ key: string; lines: Array<string> }> = [];
  for (const line of (reply ?? "").split("\n")) {
    const match = OVERSEER_DIRECTIVE.exec(line);
    if (match)
      sections.push({ key: match[1]!.toUpperCase().replace(/\s+/gu, " "), lines: [match[2]!] });
    else sections.at(-1)?.lines.push(line);
  }
  const text = (section: { lines: ReadonlyArray<string> }) =>
    section.lines.join("\n").trim().slice(0, MAX_OVERSEER_TEXT);
  const first = (key: string) => sections.find((section) => section.key === key);
  const verdictWord = /^(CONTINUE|STOP)\b/iu.exec(text(first("OVERSEER") ?? { lines: [] }))?.[1];
  const chats = new Map<number, string>();
  for (const section of sections) {
    const number = /^CHAT (\d+)$/u.exec(section.key)?.[1];
    if (number !== undefined && text(section)) chats.set(Number(number), text(section));
  }
  const guidanceSection = first("GUIDANCE");
  return {
    verdict:
      verdictWord?.toUpperCase() === "CONTINUE"
        ? "continue"
        : verdictWord?.toUpperCase() === "STOP"
          ? "stop"
          : undefined,
    release: (first("RELEASE") ? text(first("RELEASE")!) : "")
      .split(/[\s,]+/u)
      .filter((id) => /^[A-Za-z0-9._-]+$/u.test(id)),
    guidance: guidanceSection ? text(guidanceSection) || undefined : undefined,
    chats,
  };
}

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
          "Read the active PLAN.md (or the plan named by AGENTS.md) and select exactly one eligible chunk with `plan-work select --plan PLAN.md`. Keep its OWNER_TOKEN and work only in the stable branch and worktree it reports. If no chunk is eligible, do not choose one manually; report BLOCKED TASKS with the reason.",
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
    `${GOAL_COMPLETE_MARKER} — there is no unfinished work left at all.`,
    `${GOAL_BLOCKED_MARKER} — unfinished work remains, but no plan chunk is currently eligible; briefly state why.`,
    `${GOAL_NEEDS_ATTENTION_MARKER} — you hit a problem you cannot fix (for example it cannot be merged even after one rebase), or something only a person can do (a login, a decision, a missing secret). Explain it; that chat is kept open for the person to read.`,
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
