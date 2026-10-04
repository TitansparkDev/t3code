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
  readonly name: string;
  readonly projectId: ProjectId | null;
  readonly agents: ReadonlyArray<GoalSetupAgent>;
  readonly concurrency: number;
  /** Null means keep going until an agent says the goal is complete. */
  readonly maxChats: number | null;
  readonly runtimeMode: RuntimeMode;
  readonly autoResume: boolean;
  readonly standardRules: boolean;
}

export function defaultGoalSetup(input: {
  readonly projectId: ProjectId | null;
  readonly agent: Omit<GoalSetupAgent, "count"> | null;
  readonly runtimeMode: RuntimeMode;
}): GoalSetupForm {
  return {
    name: "",
    projectId: input.projectId,
    agents: input.agent ? [{ ...input.agent, count: DEFAULT_GOAL_CONCURRENCY }] : [],
    concurrency: DEFAULT_GOAL_CONCURRENCY,
    maxChats: DEFAULT_GOAL_MAX_CHATS,
    runtimeMode: input.runtimeMode,
    autoResume: true,
    standardRules: true,
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
  };
}
