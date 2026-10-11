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
  /** How workers get work: `auto` uses AgentQueue when the project has a valid active plan. */
  readonly queueMode: "auto" | "standard" | "agentqueue";
  /** The plan file (relative to the repository). Empty picks the repository's active plan. */
  readonly planPath: string;
  /** What publishing does about abandoned uncommitted edits in the target branch's checkout. */
  readonly checkoutPolicy: "reconcile" | "wait";
}

/** What a new goal's name and instructions start as, so the plan-completion workflow is one tap away. */
export const DEFAULT_GOAL_NAME = "Complete the plan";
export const DEFAULT_GOAL_PROMPT = `Finish the active plan for this repository. Do your assigned work completely and to high production quality, following the plan, the original spec, repository instructions, acceptance criteria, scope boundaries, and the assigned validation level. Do not redesign the plan or expand into unrelated work.

Do not quit easily. If a task needs extra steps that are not listed in the plan, do them. You have full authority to do whatever you need to complete your work, as long as it does not harm other agents or anything else.

Work in your own dedicated worktree, commit checkpoints as you go, and run the task's verification before you finish.`;

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
    queueMode: "auto",
    planPath: "",
    checkoutPolicy: "reconcile",
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
    // Goals saved before AgentQueue existed keep running the way they always did.
    queueMode: goal.queueMode ?? (goal.useAgentQueue ? "agentqueue" : "standard"),
    planPath: goal.planPath ?? "",
    checkoutPolicy: goal.checkoutPolicy ?? "reconcile",
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
    queueMode: form.queueMode,
    checkoutPolicy: form.checkoutPolicy,
    ...(form.planPath.trim() ? { planPath: form.planPath.trim() } : {}),
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
    queueMode: form.queueMode,
    checkoutPolicy: form.checkoutPolicy,
    ...(form.planPath.trim() ? { planPath: form.planPath.trim() } : {}),
  };
}
