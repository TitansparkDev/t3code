import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";
import {
  defaultGoalSetup,
  goalSetupProblem,
  goalToSetup,
  goalSetupToDraftSettings,
  goalSetupToSettings,
  type GoalSetupAgent,
  type GoalSetupForm,
} from "@t3tools/client-runtime/goal-setup";
import {
  type Goal,
  type GoalId,
  MAX_GOAL_AGENT_COUNT,
  MAX_GOAL_CONCURRENCY,
  MAX_GOAL_STOP_AFTER_PROBLEMS,
} from "@t3tools/contracts/goals";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useGoals } from "../../state/goals";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { ProviderOptionsPicker } from "../settings/ScheduledTasksSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

type ProviderInstances = ReturnType<typeof deriveProviderInstanceEntries>;

function firstAgent(instances: ProviderInstances): Omit<GoalSetupAgent, "count"> | null {
  const instance = instances.find((candidate) => candidate.enabled && candidate.models.length > 0);
  const model = instance?.models.find((candidate) => candidate.isDefault) ?? instance?.models[0];
  return instance && model ? { instanceId: instance.instanceId, model: model.slug } : null;
}

/**
 * Where a goal is set up after choosing a project with the Goal switch on, and
 * where every setting of an existing goal is edited. The project fixes the
 * environment, so models come from that environment's provider accounts.
 */
const DRAFT_SAVE_DELAY_MS = 1_000;

/** Pick where the goal runs when the page was opened without a project. */
function ProjectPicker() {
  const navigate = useNavigate();
  const projects = useProjects();
  const { environments } = useEnvironments();
  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Add a project first, then set up a goal.</p>
    );
  }
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium text-muted-foreground">Which project is the goal for?</h2>
      <ul className="space-y-1">
        {projects.map((candidate) => (
          <li key={`${candidate.environmentId}:${candidate.id}`}>
            <Button
              onClick={() =>
                void navigate({
                  to: "/new-goal",
                  search: { environmentId: candidate.environmentId, projectId: candidate.id },
                })
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {candidate.title}
              {environments.length > 1
                ? ` · ${environments.find((entry) => entry.environmentId === candidate.environmentId)?.label ?? ""}`
                : ""}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function GoalSetupPage({
  environmentId,
  projectId,
  goal,
}: {
  environmentId: EnvironmentId | undefined;
  projectId: ProjectId | undefined;
  /** Set when editing a goal that already exists. */
  goal?: Goal;
}) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const { create, update, restart } = useGoals();
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
  );
  const instances = useMemo(
    () =>
      deriveProviderInstanceEntries(
        environments.find((candidate) => candidate.environmentId === environmentId)?.serverConfig
          ?.providers ?? [],
      ),
    [environments, environmentId],
  );
  const [form, setForm] = useState<GoalSetupForm>(() =>
    goal
      ? goalToSetup(goal)
      : defaultGoalSetup({
          projectId: projectId ?? null,
          agent: firstAgent(instances),
          runtimeMode: "full-access",
        }),
  );
  // Provider accounts may load after the page opens; give the form a first model then.
  const agents =
    form.agents.length === 0 && !goal && firstAgent(instances)
      ? [{ ...firstAgent(instances)!, count: form.concurrency }]
      : form.agents;
  const current: GoalSetupForm = { ...form, agents };
  const problem = goalSetupProblem(current);
  const [starting, setStarting] = useState(false);
  const dirty = useRef(false);
  const patch = (change: Partial<GoalSetupForm>) => {
    dirty.current = true;
    setForm({ ...current, ...change });
  };
  const setAgent = (index: number, change: Partial<GoalSetupAgent>) =>
    patch({
      agents: agents.map((agent, position) =>
        position === index ? { ...agent, ...change } : agent,
      ),
    });

  // A new goal, or one saved as a draft, is kept as a draft while it is being filled in,
  // so leaving the page half-way loses nothing.
  const keepsDraft = !goal || goal.status === "draft";
  const draftId = useRef<GoalId | null>(goal?.status === "draft" ? goal.id : null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(current);
  useEffect(() => {
    latest.current = current;
  });
  const finished = useRef(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);

  const saveDraft = useCallback(() => {
    if (!keepsDraft || !environmentId || !dirty.current || finished.current) return;
    const settings = goalSetupToDraftSettings(latest.current);
    if (!settings) return;
    dirty.current = false;
    saveQueue.current = saveQueue.current
      .then(async () => {
        if (draftId.current) await update(environmentId, draftId.current, settings, true);
        else draftId.current = (await create(environmentId, settings, true))?.id ?? null;
        setDraftSavedAt(new Date().toLocaleTimeString());
      })
      .catch(() => {
        // Try again with the next change.
        dirty.current = true;
      });
  }, [keepsDraft, environmentId, create, update]);

  useEffect(() => {
    if (!dirty.current) return;
    const timer = window.setTimeout(saveDraft, DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [form, saveDraft]);
  // Leaving the page saves what is waiting for the timer.
  const saveOnLeave = useRef(saveDraft);
  useEffect(() => {
    saveOnLeave.current = saveDraft;
  });
  useEffect(() => () => saveOnLeave.current(), []);

  const start = async (andStart: boolean) => {
    const settings = goalSetupToSettings(current);
    if (!settings || !environmentId) return;
    setStarting(true);
    finished.current = true;
    try {
      await saveQueue.current;
      if (goal || draftId.current) {
        const id = (goal?.id ?? draftId.current)!;
        await update(environmentId, id, settings);
        if (andStart && goal?.status !== "running") await restart(environmentId, id);
      } else {
        await create(environmentId, settings);
      }
      void navigate({ to: "/goals" });
    } catch (error: unknown) {
      finished.current = false;
      toastManager.add({
        type: "error",
        title: andStart ? "Could not start the goal" : "Could not save the goal",
        description: error instanceof Error ? error.message : "Try again.",
      });
      setStarting(false);
    }
  };

  const untilComplete = current.maxChats === null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <h1 className="text-sm font-medium">
          {goal && goal.status !== "draft" ? "Edit goal" : goal ? "Draft goal" : "New goal"}
          {project ? ` in ${project.title}` : ""}
        </h1>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer className="min-h-full gap-5">
          {!project ? (
            <ProjectPicker />
          ) : (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">
                  Goal name — what you are trying to get done
                </span>
                <Input
                  autoFocus={!goal}
                  onChange={(event) => patch({ name: event.target.value })}
                  placeholder="Finish everything in PLAN.md"
                  value={current.name}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">
                  Instructions for each agent — leave empty to send the goal name
                </span>
                <Textarea
                  onChange={(event) => patch({ prompt: event.target.value })}
                  placeholder="Work through PLAN.md: take one unfinished chunk, build it, test it, and merge it."
                  rows={4}
                  value={current.prompt}
                />
              </label>
              {goal ? (
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">Project</span>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    onChange={(event) => patch({ projectId: event.target.value as ProjectId })}
                    value={current.projectId ?? ""}
                  >
                    {projects
                      .filter((candidate) => candidate.environmentId === environmentId)
                      .map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              <div className="flex flex-wrap items-end gap-4">
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">Agents at once</span>
                  <Input
                    className="w-24"
                    inputMode="numeric"
                    max={MAX_GOAL_CONCURRENCY}
                    min={1}
                    onChange={(event) => patch({ concurrency: Number(event.target.value) || 1 })}
                    type="number"
                    value={current.concurrency}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">Most agents in total</span>
                  <Input
                    className="w-28"
                    disabled={untilComplete}
                    inputMode="numeric"
                    min={1}
                    onChange={(event) => patch({ maxChats: Number(event.target.value) || 1 })}
                    type="number"
                    value={current.maxChats ?? ""}
                  />
                </label>
                <label className="flex items-center gap-2 pb-2">
                  <Switch
                    checked={untilComplete}
                    onCheckedChange={(checked) =>
                      patch({ maxChats: checked ? null : Math.max(50, current.concurrency) })
                    }
                  />
                  <span className="text-xs text-muted-foreground">Until complete (no limit)</span>
                </label>
              </div>
              {untilComplete ? (
                <p className="text-2xs text-muted-foreground">
                  The goal keeps starting agents until one replies GOAL COMPLETE or you stop it.
                  Each agent uses your plan&apos;s usage.
                </p>
              ) : null}

              <section className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground">
                  Models, effort, and how many of each run at once
                </h2>
                <ul className="space-y-2">
                  {agents.map((agent, index) => {
                    const instance = instances.find(
                      (candidate) => candidate.instanceId === agent.instanceId,
                    );
                    return (
                      <li
                        className="space-y-2 rounded-md border border-border/60 p-3"
                        key={`${agent.instanceId}:${index}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label="Provider"
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                            onChange={(event) => {
                              const next = instances.find(
                                (candidate) => candidate.instanceId === event.target.value,
                              );
                              const model =
                                next?.models.find((candidate) => candidate.isDefault) ??
                                next?.models[0];
                              if (next && model) {
                                setAgent(index, {
                                  instanceId: next.instanceId,
                                  model: model.slug,
                                  options: undefined,
                                });
                              }
                            }}
                            value={agent.instanceId}
                          >
                            {instances
                              .filter((candidate) => candidate.enabled)
                              .map((candidate) => (
                                <option key={candidate.instanceId} value={candidate.instanceId}>
                                  {candidate.displayName}
                                </option>
                              ))}
                          </select>
                          <select
                            aria-label="Model"
                            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs"
                            onChange={(event) =>
                              setAgent(index, { model: event.target.value, options: undefined })
                            }
                            value={agent.model}
                          >
                            {(instance?.models ?? []).map((model) => (
                              <option key={model.slug} value={model.slug}>
                                {model.name || model.slug}
                              </option>
                            ))}
                          </select>
                          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            At once
                            <Input
                              className="w-16"
                              inputMode="numeric"
                              max={MAX_GOAL_AGENT_COUNT}
                              min={1}
                              onChange={(event) =>
                                setAgent(index, { count: Number(event.target.value) || 1 })
                              }
                              type="number"
                              value={agent.count}
                            />
                          </label>
                          {agents.length > 1 ? (
                            <Button
                              aria-label="Remove this model"
                              onClick={() =>
                                patch({
                                  agents: agents.filter((_, position) => position !== index),
                                })
                              }
                              size="sm"
                              type="button"
                              variant="ghost"
                            >
                              <XIcon className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                        {instance ? (
                          <ProviderOptionsPicker
                            instance={instance}
                            onChange={(next) => setAgent(index, { options: next.options })}
                            target={agent}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <Button
                  disabled={firstAgent(instances) === null}
                  onClick={() => {
                    const next = firstAgent(instances);
                    if (next) patch({ agents: [...agents, { ...next, count: 1 }] });
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <PlusIcon className="size-3.5" /> Add a model
                </Button>
              </section>

              <section className="space-y-3">
                <h2 className="text-xs font-medium text-muted-foreground">Other settings</h2>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={current.autoResume}
                    onCheckedChange={(autoResume) => patch({ autoResume })}
                  />
                  <span className="text-xs">
                    Restart agents cut off by a usage limit, when it resets
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={current.overseer}
                    onCheckedChange={(overseer) => patch({ overseer })}
                  />
                  <span className="text-xs">
                    When the goal gets stuck, ask an overseer agent what to do before stopping
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <Input
                    className="w-16"
                    inputMode="numeric"
                    max={MAX_GOAL_STOP_AFTER_PROBLEMS}
                    min={1}
                    onChange={(event) =>
                      patch({ stopAfterProblems: Number(event.target.value) || 1 })
                    }
                    type="number"
                    value={current.stopAfterProblems}
                  />
                  <span className="text-xs">
                    Stop the goal after this many agents in a row cannot finish
                  </span>
                </label>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={current.standardRules}
                    onCheckedChange={(standardRules) => patch({ standardRules })}
                  />
                  <span className="text-xs">
                    Working rules: claim a chunk, own worktree, merge, push, clean up
                  </span>
                </label>
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">Permissions</span>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs"
                    onChange={(event) => patch({ runtimeMode: event.target.value as RuntimeMode })}
                    value={current.runtimeMode}
                  >
                    {runtimeModeOptions.map((mode) => (
                      <option key={mode} value={mode}>
                        {runtimeModeConfig[mode].label} — {runtimeModeConfig[mode].description}
                      </option>
                    ))}
                  </select>
                </label>
                {current.runtimeMode !== "full-access" ? (
                  <p className="text-2xs text-muted-foreground">
                    Agents work unattended. Any approval they ask for waits for you.
                  </p>
                ) : null}
              </section>

              {goal && goal.status !== "draft" ? (
                <p className="text-2xs text-muted-foreground">
                  Changes apply to agents started from now on. Agents already working keep what they
                  were given.
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-3">
                {problem ? (
                  <p className="text-2xs text-muted-foreground">{problem}</p>
                ) : keepsDraft && draftSavedAt ? (
                  <p className="text-2xs text-muted-foreground">Draft saved {draftSavedAt}</p>
                ) : null}
                {goal && goal.status !== "draft" ? (
                  <>
                    <Button
                      disabled={problem !== undefined || starting}
                      onClick={() => void start(false)}
                      type="button"
                      variant={goal.status === "running" ? "default" : "outline"}
                    >
                      {starting ? "Saving…" : "Save changes"}
                    </Button>
                    {goal.status !== "running" ? (
                      <Button
                        disabled={problem !== undefined || starting}
                        onClick={() => void start(true)}
                        type="button"
                      >
                        Save and start
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <Button
                    disabled={problem !== undefined || starting}
                    onClick={() => void start(true)}
                    type="button"
                  >
                    {starting ? "Starting…" : "Start goal"}
                  </Button>
                )}
              </div>
            </>
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
