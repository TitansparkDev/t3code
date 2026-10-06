/**
 * The goal setup form shared by the web and mobile setup pages: the values a
 * person edits, their defaults, and the conversion into what the server takes.
 *
 * @module goalSetup
 */
import {
  type ModelSelection,
  type ProjectId,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  DEFAULT_GOAL_CONCURRENCY,
  DEFAULT_GOAL_MAX_CHATS,
  DEFAULT_GOAL_STOP_AFTER_PROBLEMS,
  MAX_GOAL_STOP_AFTER_PROBLEMS,
  type Goal,
  MAX_GOAL_AGENT_COUNT,
  MAX_GOAL_CONCURRENCY,
  MAX_GOAL_MAX_CHATS,
  type GoalSettings,
  goalSettingsProblem,
} from "@t3tools/contracts/goals";

export interface GoalSetupAgent {
  readonly instanceId: ModelSelection["instanceId"];
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
  /** How many chats on this model may run at once. */
  readonly count: number;
}

export interface GoalSetupForm {
  /** The goal's name and description. */
  readonly name: string;
  /** What each agent is told. Empty uses the name. */
  readonly prompt: string;
  readonly projectId: ProjectId | null;
  readonly agents: ReadonlyArray<GoalSetupAgent>;
  readonly concurrency: number;
  /** Null means keep going until an agent says the goal is complete. */
  readonly maxChats: number | null;
  readonly runtimeMode: RuntimeMode;
  readonly autoResume: boolean;
  readonly standardRules: boolean;
  readonly useBeads: boolean;
  /** A Beads epic or plan id, or empty for the whole queue. */
  readonly beadsScope: string;
  readonly stopAfterProblems: number;
  /** Ask an overseer agent what to do when the goal gets stuck, before giving up. */
  readonly overseer: boolean;
}

/** What a new goal's name and instructions start as, so the plan-completion workflow is one tap away. */
export const DEFAULT_GOAL_NAME = "Complete the plan";
export const DEFAULT_GOAL_PROMPT = `Find the active fix-up plan for this repository and immediately claim one ready chunk through the configured parallel-plan/Beads workflow. Do not manually choose blocked work, duplicate another worker's claim, or modify another chunk's worktree. Execute it as a parallel worker. ONLY If no ready work is available stop and report that no claimable chunk is currently available.

Do not quit easily. I want you to complete this task. If it has extra things you must do that aren't explicitly listed in the plan, do those things to complete the task successfully. You have full authority to do whatever you need to do to complete the chunk.

Complete the claimed chunk fully and to high end production quality, following the sealed plan, original spec, repository instructions, acceptance criteria, scope boundaries, and assigned validation level. Do not unnecessarily redesign the plan or expand into unrelated work.

Use the configured dedicated worktree and preserve resumable checkpoints/handoff state during substantial work. When the chunk is genuinely complete and its required verification passes, safely land/merge it according to the configured workflow, close the Bead, and prune your tree.`;

/** What a draft is called until it has a name. The setup form shows it as empty. */
export const UNTITLED_GOAL_NAME = "Untitled goal";

export function defaultGoalSetup(input: {
  readonly projectId: ProjectId | null;
  readonly agent: Omit<GoalSetupAgent, "count"> | null;
  readonly runtimeMode: RuntimeMode;
}): GoalSetupForm {
  return {
    name: DEFAULT_GOAL_NAME,
    prompt: DEFAULT_GOAL_PROMPT,
    projectId: input.projectId,
    agents: input.agent ? [{ ...input.agent, count: DEFAULT_GOAL_CONCURRENCY }] : [],
    concurrency: DEFAULT_GOAL_CONCURRENCY,
    maxChats: DEFAULT_GOAL_MAX_CHATS,
    runtimeMode: input.runtimeMode,
    autoResume: true,
    standardRules: true,
    useBeads: true,
    beadsScope: "",
    stopAfterProblems: DEFAULT_GOAL_STOP_AFTER_PROBLEMS,
    overseer: true,
  };
}

/** The form for editing a goal that already exists. */
export function goalToSetup(goal: Goal): GoalSetupForm {
  return {
    name: goal.status === "draft" && goal.name === UNTITLED_GOAL_NAME ? "" : goal.name,
    prompt: goal.prompt ?? "",
    projectId: goal.projectId,
    agents: goal.agents.map((agent) => ({
      instanceId: agent.modelSelection.instanceId,
      model: agent.modelSelection.model,
      options: agent.modelSelection.options,
      count: agent.count,
    })),
    concurrency: goal.concurrency,
    maxChats: goal.maxChats,
    runtimeMode: goal.runtimeMode,
    autoResume: goal.autoResume,
    standardRules: goal.standardRules,
    useBeads: goal.useBeads ?? false,
    beadsScope: goal.beadsScope ?? "",
    stopAfterProblems: goal.stopAfterProblems ?? DEFAULT_GOAL_STOP_AFTER_PROBLEMS,
    overseer: goal.overseer !== false,
  };
}

const whole = (value: number) => Math.round(value);

/** Why the form cannot be started yet, or undefined when it can. */
export function goalSetupProblem(form: GoalSetupForm): string | undefined {
  if (form.projectId === null) return "Choose a project.";
  const concurrency = whole(form.concurrency);
  if (!(concurrency >= 1 && concurrency <= MAX_GOAL_CONCURRENCY)) {
    return `Run between 1 and ${MAX_GOAL_CONCURRENCY} agents at once.`;
  }
  if (
    form.agents.some(
      (agent) => !(whole(agent.count) >= 1 && whole(agent.count) <= MAX_GOAL_AGENT_COUNT),
    )
  ) {
    return `Each model can run between 1 and ${MAX_GOAL_AGENT_COUNT} agents at once.`;
  }
  if (
    form.maxChats !== null &&
    !(whole(form.maxChats) >= 1 && whole(form.maxChats) <= MAX_GOAL_MAX_CHATS)
  ) {
    return `Most agents to run must be between 1 and ${MAX_GOAL_MAX_CHATS}, or until complete.`;
  }
  const stopAfter = whole(form.stopAfterProblems);
  if (!(stopAfter >= 1 && stopAfter <= MAX_GOAL_STOP_AFTER_PROBLEMS)) {
    return `Stop after between 1 and ${MAX_GOAL_STOP_AFTER_PROBLEMS} agents in a row that cannot finish.`;
  }
  return goalSettingsProblem({
    name: form.name,
    agents: form.agents.map(() => ({}) as never),
    concurrency,
    maxChats: form.maxChats === null ? null : whole(form.maxChats),
  });
}

/** The server's input for a form that has no problem. */
export function goalSetupToSettings(form: GoalSetupForm): GoalSettings | undefined {
  if (form.projectId === null || goalSetupProblem(form) !== undefined) return undefined;
  return {
    name: form.name.trim(),
    prompt: form.prompt.trim(),
    projectId: form.projectId,
    agents: form.agents.map((agent) => ({
      modelSelection: {
        instanceId: agent.instanceId,
        model: agent.model,
        ...(agent.options && agent.options.length > 0 ? { options: agent.options } : {}),
      },
      count: whole(agent.count),
    })),
    concurrency: whole(form.concurrency),
    maxChats: form.maxChats === null ? null : whole(form.maxChats),
    runtimeMode: form.runtimeMode,
    autoResume: form.autoResume,
    standardRules: form.standardRules,
    useBeads: form.useBeads,
    beadsScope: form.beadsScope.trim(),
    stopAfterProblems: whole(form.stopAfterProblems),
    overseer: form.overseer,
  };
}

const clamp = (value: number, maximum: number) =>
  Math.min(Math.max(Math.round(Number.isFinite(value) ? value : 1), 1), maximum);

/**
 * What to save for a draft: whatever has been typed so far, with numbers pulled
 * into range so the server accepts it. Undefined until there is a project and a model.
 */
export function goalSetupToDraftSettings(form: GoalSetupForm): GoalSettings | undefined {
  if (form.projectId === null || form.agents.length === 0) return undefined;
  return {
    name: form.name.trim() || UNTITLED_GOAL_NAME,
    prompt: form.prompt.trim(),
    projectId: form.projectId,
    agents: form.agents.map((agent) => ({
      modelSelection: {
        instanceId: agent.instanceId,
        model: agent.model,
        ...(agent.options && agent.options.length > 0 ? { options: agent.options } : {}),
      },
      count: clamp(agent.count, MAX_GOAL_AGENT_COUNT),
    })),
    concurrency: clamp(form.concurrency, MAX_GOAL_CONCURRENCY),
    maxChats: form.maxChats === null ? null : clamp(form.maxChats, MAX_GOAL_MAX_CHATS),
    runtimeMode: form.runtimeMode,
    autoResume: form.autoResume,
    standardRules: form.standardRules,
    useBeads: form.useBeads,
    beadsScope: form.beadsScope.trim(),
    stopAfterProblems: clamp(form.stopAfterProblems, MAX_GOAL_STOP_AFTER_PROBLEMS),
    overseer: form.overseer,
  };
}
