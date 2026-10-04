/**
 * Scheduled tasks settings — prompts an environment sends on its own clock.
 *
 * The editor is deliberately one form per task rather than a wizard: a task is
 * four decisions (what to say, where to say it, who to say it to, when), and
 * splitting four fields across steps would hide the shape of the thing being
 * built.
 *
 * Times are the *server's* wall clock, and the panel says so: a phone in
 * another timezone must not read a different hour than the machine that will
 * actually run the prompt.
 *
 * @module ScheduledTasksSettings
 */
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  nextScheduledRunAt,
  scheduledTimesOfDay,
  type ScheduledTask,
  type ScheduledTaskDraft,
  type ScheduledTaskRun,
  type ScheduledTaskTarget,
} from "@t3tools/contracts/scheduledTasks";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ExternalLinkIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useScheduledTasks } from "../../state/scheduledTasks";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface DraftState {
  readonly id?: ScheduledTask["id"];
  name: string;
  prompt: string;
  projectId: string;
  timeOfDay: string;
  /** Total sends per day, including the first. */
  sendsPerDay: number;
  /** Hours between sends when there is more than one. */
  everyHours: number;
  daysOfWeek: ReadonlyArray<number>;
  enabled: boolean;
  targets: ReadonlyArray<ScheduledTaskTarget>;
}

const emptyDraft = (): DraftState => ({
  name: "",
  prompt: "",
  projectId: "",
  timeOfDay: "05:00",
  sendsPerDay: 1,
  everyHours: 5,
  daysOfWeek: [],
  enabled: true,
  targets: [],
});

const draftFromTask = (task: ScheduledTask): DraftState => ({
  id: task.id,
  name: task.name,
  prompt: task.prompt,
  projectId: task.projectId ?? "",
  timeOfDay: task.schedule.timeOfDay,
  sendsPerDay: task.schedule.repeat?.count ?? 1,
  everyHours: (task.schedule.repeat?.everyMinutes ?? 300) / 60,
  daysOfWeek: task.schedule.daysOfWeek,
  enabled: task.enabled,
  targets: task.targets,
});

function draftSchedule(draft: DraftState): ScheduledTaskDraft["schedule"] {
  const sends = Math.round(draft.sendsPerDay);
  return {
    timeOfDay: draft.timeOfDay,
    daysOfWeek: draft.daysOfWeek,
    ...(sends > 1
      ? { repeat: { everyMinutes: Math.round(draft.everyHours * 60), count: sends } }
      : {}),
  };
}

/** Repeats are a same-day idea: they must not reach the next day's first send. */
function draftRepeatIsValid(draft: DraftState): boolean {
  const sends = Math.round(draft.sendsPerDay);
  if (sends < 1 || sends > 24) return false;
  if (sends === 1) return true;
  const everyMinutes = Math.round(draft.everyHours * 60);
  return everyMinutes >= 15 && (sends - 1) * everyMinutes < 24 * 60;
}

function describeSchedule(task: ScheduledTask): string {
  const days =
    task.schedule.daysOfWeek.length === 0
      ? "every day"
      : task.schedule.daysOfWeek
          .slice()
          .sort((left, right) => left - right)
          .map((day) => DAY_LABELS[day])
          .join(", ");
  return `${scheduledTimesOfDay(task.schedule).join(", ")} · ${days}`;
}

function formatRunDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "duration unavailable";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatRunStatus(run: ScheduledTaskRun): string {
  switch (run.status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
  }
}

export function ScheduledTasksSettingsPanel() {
  const { environments } = useEnvironments();
  const projects = useProjects();
  const scheduled = useScheduledTasks();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Scheduled tasks">
        <p className="px-1 text-xs text-muted-foreground">
          A scheduled task sends the same prompt to one or more provider accounts at a fixed time,
          using the clock of the environment that runs it. Each run is an ordinary thread that
          settles itself when the turn finishes, so it stays out of your chat list unless the agent
          needs you.
        </p>
        {environments.map((environment) => (
          <EnvironmentScheduledTasks
            environmentId={environment.environmentId}
            key={environment.environmentId}
            projects={projects
              .filter((project) => project.environmentId === environment.environmentId)
              .map((project) => ({ id: project.id, title: project.title }))}
            providerInstances={deriveProviderInstanceEntries(
              environment.serverConfig?.providers ?? [],
            )}
            scheduled={scheduled}
            title={environment.label}
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentScheduledTasks({
  environmentId,
  projects,
  providerInstances,
  scheduled,
  title,
}: {
  environmentId: EnvironmentId;
  projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  providerInstances: ReturnType<typeof deriveProviderInstanceEntries>;
  scheduled: ReturnType<typeof useScheduledTasks>;
  title: string;
}) {
  const tasks = useMemo(
    () =>
      scheduled.environments.find((entry) => entry.environmentId === environmentId)?.tasks ?? [],
    [environmentId, scheduled.environments],
  );
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [busy, setBusy] = useState(false);

  const startNew = useCallback(() => {
    setDraft(emptyDraft());
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload = {
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        ...(draft.projectId ? { projectId: draft.projectId } : {}),
        targets: draft.targets,
        schedule: draftSchedule(draft),
        enabled: draft.enabled,
      } as ScheduledTaskDraft;
      await scheduled.save(environmentId, payload);
      setDraft(null);
      toastManager.add({
        type: "success",
        title: draft.id ? "Scheduled task saved" : "Scheduled task created",
        description: "It remains listed here and will run on the environment’s local clock.",
      });
    } catch (error: unknown) {
      toastManager.add({
        type: "error",
        title: "Could not save scheduled task",
        description: error instanceof Error ? error.message : "The task was not saved.",
      });
    } finally {
      setBusy(false);
    }
  }, [draft, environmentId, scheduled]);

  const canSave =
    draft !== null &&
    draft.name.trim().length > 0 &&
    draft.prompt.trim().length > 0 &&
    draft.targets.length > 0 &&
    draftRepeatIsValid(draft);

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">{title}</h4>
        <Button onClick={startNew} size="sm" type="button" variant="outline">
          <PlusIcon className="size-3.5" /> New task
        </Button>
      </div>

      {tasks.length === 0 && draft === null ? (
        <p className="text-xs text-muted-foreground">
          {scheduled.environments.find((entry) => entry.environmentId === environmentId)?.isPending
            ? "Loading saved tasks…"
            : "No scheduled tasks on this environment."}
        </p>
      ) : null}

      <ul className="space-y-2">
        {tasks.map((task) => (
          <li className="space-y-3 rounded-md border border-border/50 p-3" key={task.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {task.name}
                  {task.enabled ? null : (
                    <span className="ml-2 text-2xs text-muted-foreground">(disabled)</span>
                  )}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {describeSchedule(task)} · {task.targets.length} account
                  {task.targets.length === 1 ? "" : "s"}
                </p>
                <p className="truncate text-2xs text-muted-foreground/80">
                  Next {new Date(nextScheduledRunAt(task.schedule, Date.now())).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  aria-label={`Run ${task.name} now`}
                  onClick={() => {
                    void scheduled
                      .runNow(environmentId, task.id)
                      .then(() =>
                        toastManager.add({
                          type: "success",
                          title: "Task started",
                          description: `${task.name} is running. Its chats will appear in run history below.`,
                        }),
                      )
                      .catch((error: unknown) =>
                        toastManager.add({
                          type: "error",
                          title: "Could not start task",
                          description:
                            error instanceof Error ? error.message : "Run failed to start.",
                        }),
                      );
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <PlayIcon className="size-3.5" />
                </Button>
                <Button
                  onClick={() => setDraft(draftFromTask(task))}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Edit
                </Button>
                <Button
                  aria-label={`Delete ${task.name}`}
                  onClick={() => void scheduled.remove(environmentId, task.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
            <TaskRunHistory
              environmentId={environmentId}
              providerInstances={providerInstances}
              runs={task.runHistory ?? []}
            />
          </li>
        ))}
      </ul>

      {draft ? (
        <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Name</span>
            <Input
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="Open the morning window"
              value={draft.name}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Prompt</span>
            <Textarea
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              placeholder="Say hello and summarize the repository."
              rows={3}
              value={draft.prompt}
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Project</span>
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
              value={draft.projectId}
            >
              <option value="">No project (runs stay out of your thread list)</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              Accounts and models (this environment&apos;s configured providers)
            </span>
            <TargetPicker
              instances={providerInstances}
              onChange={(targets) => setDraft({ ...draft, targets })}
              targets={draft.targets}
            />
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">
                Time (environment&apos;s local clock)
              </span>
              <Input
                className="w-32"
                onChange={(event) => setDraft({ ...draft, timeOfDay: event.target.value })}
                type="time"
                value={draft.timeOfDay}
              />
            </label>

            <label className="space-y-1">
              <span className="block text-xs text-muted-foreground">Sends per day</span>
              <Input
                className="w-24"
                inputMode="numeric"
                max={24}
                min={1}
                onChange={(event) =>
                  setDraft({ ...draft, sendsPerDay: Number(event.target.value) || 1 })
                }
                type="number"
                value={draft.sendsPerDay}
              />
            </label>

            {draft.sendsPerDay > 1 ? (
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">Every (hours)</span>
                <Input
                  className="w-24"
                  inputMode="decimal"
                  max={24}
                  min={0.25}
                  onChange={(event) =>
                    setDraft({ ...draft, everyHours: Number(event.target.value) || 0 })
                  }
                  step={0.25}
                  type="number"
                  value={draft.everyHours}
                />
              </label>
            ) : null}

            <div className="space-y-1">
              <span className="block text-xs text-muted-foreground">
                Days (none selected = every day)
              </span>
              <div className="flex gap-1">
                {DAY_LABELS.map((label, day) => {
                  const selected = draft.daysOfWeek.includes(day);
                  return (
                    <Button
                      aria-pressed={selected}
                      key={label}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          daysOfWeek: selected
                            ? draft.daysOfWeek.filter((entry) => entry !== day)
                            : [...draft.daysOfWeek, day],
                        })
                      }
                      size="sm"
                      type="button"
                      variant={selected ? "default" : "outline"}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
            </div>

            <label className="flex items-center gap-2">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              <span className="text-xs text-muted-foreground">Enabled</span>
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            {draftRepeatIsValid(draft)
              ? `Sends at ${scheduledTimesOfDay(draftSchedule(draft)).join(", ")} on the environment's clock.`
              : "Repeats must fit in one day: sends per day × hours apart has to stay under 24 hours."}
          </p>

          <div className="flex justify-end gap-2">
            <Button onClick={() => setDraft(null)} size="sm" type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={!canSave || busy} onClick={() => void save()} size="sm" type="button">
              {draft.id ? "Save task" : "Create task"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TaskRunHistory({
  environmentId,
  providerInstances,
  runs,
}: {
  environmentId: EnvironmentId;
  providerInstances: ReturnType<typeof deriveProviderInstanceEntries>;
  runs: ReadonlyArray<ScheduledTaskRun>;
}) {
  const providerNames = useMemo(
    () => new Map(providerInstances.map((instance) => [instance.instanceId, instance.displayName])),
    [providerInstances],
  );

  if (runs.length === 0) {
    return (
      <div className="rounded-md bg-muted/30 px-2.5 py-2 text-2xs text-muted-foreground">
        No runs yet. When this task runs, each provider chat and its measured usage will stay here.
      </div>
    );
  }

  return (
    <div className="rounded-md bg-muted/30 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-xs font-medium">Run history</p>
        <span className="text-2xs text-muted-foreground">{runs.length} saved</span>
      </div>
      <ul className="space-y-1">
        {runs.map((run) => (
          <li key={run.id}>
            <details className="group rounded-md border border-border/40 bg-background/35">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                <span className="font-medium">{formatRunStatus(run)}</span>
                <span className="text-muted-foreground">
                  {new Date(run.startedAt).toLocaleString()} · {run.trigger}
                </span>
                <span className="ml-auto text-muted-foreground">
                  {run.targets.length} provider{run.targets.length === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="space-y-2 border-t border-border/40 px-2 py-2">
                {run.detail ? <p className="text-2xs text-muted-foreground">{run.detail}</p> : null}
                <ul className="space-y-1.5">
                  {run.targets.map((target) => {
                    const name = providerNames.get(target.instanceId) ?? String(target.instanceId);
                    return (
                      <li
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs"
                        key={`${run.id}-${target.instanceId}`}
                      >
                        <span className="font-medium">{name}</span>
                        <span className="text-muted-foreground">{target.model}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                          {target.status}
                        </span>
                        {target.durationMs !== undefined ? (
                          <span className="text-muted-foreground">
                            agent time {formatRunDuration(target.durationMs)}
                          </span>
                        ) : null}
                        {target.status === "completed" &&
                        target.quota5h &&
                        target.windowStatus &&
                        target.windowStatus !== "unverified" ? (
                          <span className="text-muted-foreground">
                            {target.windowStatus === "opened"
                              ? "5h window opened"
                              : "5h window active"}
                            : {Math.round(target.quota5h.usedPercent)}% used ·{" "}
                            {Math.round(target.quota5h.remainingPercent)}% left
                          </span>
                        ) : target.status === "completed" ? (
                          <span className="text-muted-foreground">5h window unverified</span>
                        ) : null}
                        {target.detail ? (
                          <span className="text-muted-foreground">{target.detail}</span>
                        ) : null}
                        {target.threadId ? (
                          <Button
                            render={
                              <Link
                                params={{ environmentId, threadId: target.threadId }}
                                to="/$environmentId/$threadId"
                              />
                            }
                            size="xs"
                            variant="outline"
                          >
                            <ExternalLinkIcon className="size-3" /> Open chat
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One row per configured provider instance: tick the accounts to send to, and
 * pick each one's model. Models are per account because running the same
 * prompt on two accounts usually means two different subscriptions.
 */
function TargetPicker({
  instances,
  onChange,
  targets,
}: {
  instances: ReturnType<typeof deriveProviderInstanceEntries>;
  onChange: (targets: ReadonlyArray<ScheduledTaskTarget>) => void;
  targets: ReadonlyArray<ScheduledTaskTarget>;
}) {
  const selected = new Map(targets.map((target) => [target.instanceId, target]));

  const toggle = (instanceId: ProviderInstanceId, models: ReadonlyArray<{ slug: string }>) => {
    if (selected.has(instanceId)) {
      onChange(targets.filter((target) => target.instanceId !== instanceId));
      return;
    }
    const model = models[0]?.slug;
    if (!model) return;
    onChange([...targets, { instanceId, model }]);
  };

  return (
    <ul className="space-y-1">
      {instances
        .filter((instance) => instance.enabled)
        .map((instance) => {
          const models = instance.models ?? [];
          const target = selected.get(instance.instanceId);
          return (
            <li className="space-y-1.5" key={instance.instanceId}>
              <div className="flex items-center gap-2">
                <input
                  checked={target !== undefined}
                  disabled={models.length === 0}
                  onChange={() => toggle(instance.instanceId, models)}
                  type="checkbox"
                />
                <span className="w-32 shrink-0 truncate text-xs">{instance.displayName}</span>
                <select
                  className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                  disabled={target === undefined}
                  onChange={(event) =>
                    onChange(
                      targets.map((candidate) =>
                        candidate.instanceId === instance.instanceId
                          ? { ...candidate, model: event.target.value, options: undefined }
                          : candidate,
                      ),
                    )
                  }
                  value={target?.model ?? ""}
                >
                  {models.length === 0 ? <option value="">No models reported</option> : null}
                  {models.map((candidate) => (
                    <option key={candidate.slug} value={candidate.slug}>
                      {candidate.name || candidate.slug}
                    </option>
                  ))}
                </select>
              </div>
              {target ? (
                <ProviderOptionsPicker
                  instance={instance}
                  onChange={(nextTarget) =>
                    onChange(
                      targets.map((candidate) =>
                        candidate.instanceId === instance.instanceId ? nextTarget : candidate,
                      ),
                    )
                  }
                  target={target}
                />
              ) : null}
            </li>
          );
        })}
    </ul>
  );
}

/** Effort and reasoning choices for one provider model. Shared with the goal setup page. */
export function ProviderOptionsPicker<
  T extends { model: string; options?: ReadonlyArray<ProviderOptionSelection> | undefined },
>({
  instance,
  onChange,
  target,
}: {
  instance: ReturnType<typeof deriveProviderInstanceEntries>[number];
  onChange: (target: T) => void;
  target: T;
}) {
  const capabilities = getProviderModelCapabilities(
    instance.models,
    target.model,
    instance.driverKind,
  );
  const descriptors = getProviderOptionDescriptors({
    caps: capabilities,
    selections: target.options,
  }).filter(
    (descriptor) =>
      descriptor.id.toLowerCase().includes("effort") ||
      descriptor.id.toLowerCase().includes("reason"),
  );
  if (descriptors.length === 0) return null;

  return (
    <div className="ml-6 flex flex-wrap items-center gap-2 text-2xs">
      {descriptors.map((descriptor) => {
        if (descriptor.type !== "select") return null;
        const currentValue = getProviderOptionCurrentValue(descriptor);
        return (
          <label className="flex items-center gap-1.5" key={descriptor.id}>
            <span className="text-muted-foreground">{descriptor.label}</span>
            <select
              className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
              onChange={(event) => {
                const options = [
                  ...(target.options ?? []).filter((option) => option.id !== descriptor.id),
                  { id: descriptor.id, value: event.target.value },
                ];
                onChange({ ...target, options });
              }}
              value={typeof currentValue === "string" ? currentValue : ""}
            >
              {descriptor.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
