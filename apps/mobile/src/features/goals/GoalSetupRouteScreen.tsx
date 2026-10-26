import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  defaultGoalSetup,
  goalSetupProblem,
  goalSetupToDraftSettings,
  goalSetupToSettings,
  type GoalSetupAgent,
  type GoalSetupForm,
} from "@t3tools/client-runtime/goal-setup";
import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";
import type { GoalId, GoalPlanPreview } from "@t3tools/contracts/goals";
import {
  MAX_GOAL_AGENT_COUNT,
  MAX_GOAL_CONCURRENCY,
  type GoalSettings,
} from "@t3tools/contracts/goals";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListRow } from "../../components/ui/ListRow";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import { useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const DRAFT_SAVE_DELAY_MS = 1_500;

type GoalSetupParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title?: string;
};

const RUNTIME_MODES: ReadonlyArray<{ readonly mode: RuntimeMode; readonly label: string }> = [
  { mode: "full-access", label: "Full access" },
  { mode: "auto", label: "Auto" },
  { mode: "auto-accept-edits", label: "Auto-accept edits" },
  { mode: "approval-required", label: "Supervised" },
];

function agentFromOption(option: ModelOption, count: number): GoalSetupAgent {
  return {
    instanceId: option.selection.instanceId,
    model: option.selection.model,
    options: option.selection.options,
    count,
  };
}

function Field(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <View className="gap-1.5">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      {props.children}
    </View>
  );
}

function NumberInput(props: {
  readonly value: number | null;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
}) {
  return (
    <TextInput
      accessibilityLabel={props.accessibilityLabel}
      className={cn(
        "h-12 min-h-12 w-28 rounded-[24px] px-4 py-0 text-base leading-snug",
        props.disabled && "opacity-45",
      )}
      editable={!props.disabled}
      inputMode="numeric"
      keyboardType="number-pad"
      onChangeText={(text) => props.onChange(Number(text.replace(/[^0-9]/g, "")) || 1)}
      value={props.value === null ? "" : String(props.value)}
    />
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <View className="flex-row items-center justify-between gap-4">
      <Text className="min-w-0 flex-1 text-base text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onChange}
        value={props.value}
      />
    </View>
  );
}

const QUEUE_MODES: ReadonlyArray<{
  readonly mode: GoalSetupForm["queueMode"];
  readonly label: string;
}> = [
  { mode: "auto", label: "Auto" },
  { mode: "agentqueue", label: "AgentQueue" },
  { mode: "standard", label: "Standard" },
];

/**
 * What the goal would run on, checked by the server before it starts: repository, plan,
 * mode, task counts and any problem. Reports whether the choice is blocked.
 */
function PlanPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly queueMode: GoalSetupForm["queueMode"];
  readonly planPath: string;
  readonly onChange: (change: Partial<GoalSetupForm>) => void;
  readonly onBlockedChange: (blocked: boolean) => void;
}) {
  const previewPlan = useAtomCommand(serverEnvironment.previewGoalPlan, { reportFailure: false });
  const [preview, setPreview] = useState<GoalPlanPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const { environmentId, projectId, queueMode, planPath, onBlockedChange } = props;
  const previewRef = useRef(previewPlan);
  useEffect(() => {
    previewRef.current = previewPlan;
  });
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void previewRef
        .current({
          environmentId,
          input: {
            projectId,
            queueMode,
            ...(planPath.trim() ? { planPath: planPath.trim() } : {}),
          },
        })
        .then((result) => {
          if (cancelled) return;
          if (AsyncResult.isFailure(result)) {
            setFailed(true);
            onBlockedChange(queueMode === "agentqueue");
            return;
          }
          setFailed(false);
          setPreview(result.value);
          onBlockedChange(result.value.blocked);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentId, projectId, queueMode, planPath, onBlockedChange]);

  const counts = preview?.counts;
  return (
    <View className="gap-2 rounded-[24px] bg-card p-4">
      <Text className="text-sm text-foreground-muted">How agents get their work</Text>
      <View className="flex-row flex-wrap gap-2">
        {QUEUE_MODES.map((option) => (
          <Button
            key={option.mode}
            label={option.label}
            onPress={() => props.onChange({ queueMode: option.mode })}
            tone={queueMode === option.mode ? "primary" : "secondary"}
          />
        ))}
      </View>
      {preview && preview.candidates.length > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          {preview.candidates.map((candidate) => (
            <Button
              key={candidate.path}
              label={`${candidate.path} (${candidate.unfinishedCount}/${candidate.taskCount})`}
              onPress={() => props.onChange({ planPath: candidate.path })}
              tone={(planPath || preview.planPath) === candidate.path ? "primary" : "secondary"}
            />
          ))}
        </View>
      ) : null}
      {failed ? (
        <Text className="text-sm text-danger-foreground">Could not check the plan.</Text>
      ) : preview ? (
        <View className="gap-1">
          <Text
            className={cn(
              "text-sm",
              preview.blocked ? "text-danger-foreground" : "text-foreground",
            )}
          >
            {preview.summary}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {preview.effectiveMode === "agentqueue" ? "AgentQueue" : "Standard"}
            {preview.planPath ? ` · ${preview.planPath}` : ""}
            {preview.baseBranch ? ` → ${preview.baseBranch}` : ""}
          </Text>
          {counts && counts.total > 0 ? (
            <Text className="text-sm text-foreground-muted">
              {counts.total} tasks · {counts.completed} done · {counts.ready} ready now ·{" "}
              {counts.waiting} waiting
            </Text>
          ) : null}
          {preview.errors.map((message) => (
            <Text className="text-sm text-danger-foreground" key={message}>
              {message}
            </Text>
          ))}
          {preview.warnings.map((message) => (
            <Text className="text-sm text-foreground-muted" key={message}>
              {message}
            </Text>
          ))}
        </View>
      ) : (
        <Text className="text-sm text-foreground-muted">Checking the project's plan…</Text>
      )}
    </View>
  );
}

/** One model row: the model, its effort choices, and how many run at once. */
function AgentCard(props: {
  readonly agent: GoalSetupAgent;
  readonly options: ReadonlyArray<ModelOption>;
  readonly canRemove: boolean;
  /** Overseer models have no count: they run one chat at a time. */
  readonly counted?: boolean;
  readonly onChange: (agent: GoalSetupAgent) => void;
  readonly onRemove: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const current = props.options.find(
    (option) =>
      option.selection.instanceId === props.agent.instanceId &&
      option.selection.model === props.agent.model,
  );
  const efforts = current?.capabilities
    ? getProviderOptionDescriptors({
        caps: current.capabilities,
        selections: props.agent.options,
      }).filter(
        (descriptor) =>
          descriptor.type === "select" &&
          (descriptor.id.toLowerCase().includes("effort") ||
            descriptor.id.toLowerCase().includes("reason")),
      )
    : [];

  return (
    <View className="gap-3 rounded-[24px] bg-card p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Change model"
        className="gap-0.5 active:opacity-70"
        onPress={() => setPicking((open) => !open)}
      >
        <Text className="text-base font-t3-medium text-foreground">
          {current?.label ?? props.agent.model}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {current?.providerLabel ?? props.agent.instanceId} · tap to change
        </Text>
      </Pressable>
      {picking ? (
        <View className="overflow-hidden rounded-[20px]">
          {props.options.map((option) => (
            <ListRow
              key={option.key}
              onPress={() => {
                props.onChange(agentFromOption(option, props.agent.count));
                setPicking(false);
              }}
              description={option.providerLabel}
              label={option.label}
            />
          ))}
        </View>
      ) : null}
      {efforts.map((descriptor) => {
        if (descriptor.type !== "select") return null;
        const currentValue = getProviderOptionCurrentValue(descriptor);
        return (
          <View className="gap-1.5" key={descriptor.id}>
            <Text className="text-sm text-foreground-muted">{descriptor.label}</Text>
            <View className="flex-row flex-wrap gap-2">
              {descriptor.options.map((choice) => {
                const selected = choice.id === currentValue;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    className={cn(
                      "rounded-full px-4 py-2 active:opacity-70",
                      selected ? "bg-primary" : "bg-subtle-strong",
                    )}
                    key={choice.id}
                    onPress={() =>
                      props.onChange({
                        ...props.agent,
                        options: [
                          ...(props.agent.options ?? []).filter(
                            (option) => option.id !== descriptor.id,
                          ),
                          { id: descriptor.id, value: choice.id },
                        ],
                      })
                    }
                  >
                    <Text
                      className={cn(
                        "text-sm",
                        selected ? "text-primary-foreground" : "text-foreground",
                      )}
                    >
                      {choice.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })}
      <View className="flex-row items-center justify-between gap-3">
        {props.counted === false ? (
          <View />
        ) : (
          <Field label={`Run at once (up to ${MAX_GOAL_AGENT_COUNT})`}>
            <NumberInput
              accessibilityLabel="Agents of this model at once"
              onChange={(count) => props.onChange({ ...props.agent, count })}
              value={props.agent.count}
            />
          </Field>
        )}
        {props.canRemove ? <Button label="Remove" onPress={props.onRemove} tone="text" /> : null}
      </View>
    </View>
  );
}

/**
 * The goal form, for starting a goal and for editing one that is running or
 * finished. The environment fixes where the models come from.
 */
export function GoalForm(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly subtitle?: string;
  readonly initial: GoalSetupForm;
  readonly submitLabel: string;
  readonly busyLabel: string;
  /** Resolves true when the change was accepted and the screen can close. */
  readonly onSubmit: (settings: GoalSettings) => Promise<boolean>;
  /** A second way to finish, for example saving a stopped goal and starting it. */
  readonly secondary?: {
    readonly label: string;
    readonly onSubmit: (settings: GoalSettings) => Promise<boolean>;
  };
  /**
   * Keeps what has been typed as a draft. Called a moment after each change and
   * when the screen closes; absent for goals that were already started.
   */
  readonly onDraft?: (settings: GoalSettings) => Promise<void>;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const config = useServerConfigs().get(props.environmentId);
  const modelOptions = useMemo(
    () =>
      buildModelOptions(config, null, undefined, null).filter((option) => !option.isUnavailable),
    [config],
  );
  const defaultOption = modelOptions.find((option) => option.isDefault) ?? modelOptions[0];
  const [form, setForm] = useState<GoalSetupForm>(props.initial);
  const [starting, setStarting] = useState(false);
  const [planBlocked, setPlanBlocked] = useState(false);
  const agents =
    form.agents.length === 0 && defaultOption
      ? [agentFromOption(defaultOption, form.concurrency)]
      : form.agents;
  const current: GoalSetupForm = { ...form, agents };
  const problem = goalSetupProblem(current);
  const dirty = useRef(false);
  const finished = useRef(false);
  const latest = useRef(current);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const onDraftRef = useRef(props.onDraft);
  const [draftSaved, setDraftSaved] = useState(false);
  const patch = (change: Partial<GoalSetupForm>) => {
    dirty.current = true;
    setForm({ ...current, ...change });
  };
  const untilComplete = current.maxChats === null;

  const saveDraft = () => {
    const onDraft = onDraftRef.current;
    if (!onDraft || !dirty.current || finished.current) return;
    const settings = goalSetupToDraftSettings(latest.current);
    if (!settings) return;
    dirty.current = false;
    saveQueue.current = saveQueue.current
      .then(() => onDraft(settings))
      .then(() => setDraftSaved(true))
      .catch(() => {
        dirty.current = true;
      });
  };
  const saveDraftRef = useRef(saveDraft);
  useEffect(() => {
    latest.current = current;
    onDraftRef.current = props.onDraft;
    saveDraftRef.current = saveDraft;
  });
  useEffect(() => {
    if (!dirty.current) return;
    const timer = setTimeout(() => saveDraftRef.current(), DRAFT_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [form]);
  // Leaving the screen saves what is still waiting for the timer.
  useEffect(() => () => saveDraftRef.current(), []);

  async function finish(submit: (settings: GoalSettings) => Promise<boolean>): Promise<void> {
    const settings = goalSetupToSettings(current);
    if (!settings || starting) return;
    setStarting(true);
    finished.current = true;
    await saveQueue.current;
    if (!(await submit(settings))) {
      finished.current = false;
      setStarting(false);
    }
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={props.title} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions options={{ title: props.title }} />
      )}
      <>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          className="flex-1"
          contentContainerStyle={{
            gap: 20,
            paddingBottom: Math.max(insets.bottom, 18) + 18,
            paddingHorizontal: 20,
            paddingTop: 12,
          }}
        >
          <Field label="Goal name: what you are trying to get done">
            <TextInput
              className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
              onChangeText={(name) => patch({ name })}
              placeholder="Finish everything in PLAN.md"
              value={current.name}
            />
          </Field>
          <Field label="Instructions for each agent (empty sends the goal name)">
            <TextInput
              className="min-h-28 rounded-[24px] px-4 py-3 text-base leading-snug"
              multiline
              onChangeText={(prompt) => patch({ prompt })}
              placeholder="Work through PLAN.md: take one unfinished chunk, build it, test it, and merge it."
              textAlignVertical="top"
              value={current.prompt}
            />
          </Field>

          {current.projectId ? (
            <PlanPanel
              environmentId={props.environmentId}
              onBlockedChange={setPlanBlocked}
              onChange={patch}
              planPath={current.planPath}
              projectId={current.projectId}
              queueMode={current.queueMode}
            />
          ) : null}

          <View className="flex-row flex-wrap gap-4">
            <Field label={`Agents at once (up to ${MAX_GOAL_CONCURRENCY})`}>
              <NumberInput
                accessibilityLabel="Agents at once"
                onChange={(concurrency) => patch({ concurrency })}
                value={current.concurrency}
              />
            </Field>
            <Field label="Most agents in total">
              <NumberInput
                accessibilityLabel="Most agents in total"
                disabled={untilComplete}
                onChange={(maxChats) => patch({ maxChats })}
                value={current.maxChats}
              />
            </Field>
          </View>
          <SwitchRow
            label="Until complete (no limit)"
            onChange={(checked) =>
              patch({ maxChats: checked ? null : Math.max(50, current.concurrency) })
            }
            value={untilComplete}
          />
          {untilComplete ? (
            <Text className="text-sm text-foreground-muted">
              The goal keeps starting agents until one replies GOAL COMPLETE or you stop it. Each
              agent uses your plan&apos;s usage.
            </Text>
          ) : null}

          <View className="gap-3">
            <Text className="text-sm text-foreground-muted">
              Models, effort, and how many of each run at once
            </Text>
            {agents.map((agent, index) => (
              <AgentCard
                agent={agent}
                canRemove={agents.length > 1}
                key={`${agent.instanceId}:${index}`}
                onChange={(next) =>
                  patch({ agents: agents.map((entry, at) => (at === index ? next : entry)) })
                }
                onRemove={() => patch({ agents: agents.filter((_, at) => at !== index) })}
                options={modelOptions}
              />
            ))}
            <Button
              disabled={modelOptions.length === 0}
              label="Add a model"
              onPress={() => {
                if (defaultOption) {
                  patch({ agents: [...agents, agentFromOption(defaultOption, 1)] });
                }
              }}
            />
          </View>

          <View className="gap-4">
            <Text className="text-sm text-foreground-muted">Other settings</Text>
            <SwitchRow
              label="When publishing, keep abandoned uncommitted edits safe (snapshot first)"
              onChange={(checked) => patch({ checkoutPolicy: checked ? "reconcile" : "wait" })}
              value={current.checkoutPolicy === "reconcile"}
            />
            <SwitchRow
              label="Restart agents cut off by a usage limit, when it resets"
              onChange={(autoResume) => patch({ autoResume })}
              value={current.autoResume}
            />
            <SwitchRow
              label="When the goal gets stuck, ask an overseer agent what to do before stopping"
              onChange={(overseer) => patch({ overseer })}
              value={current.overseer}
            />
            {current.overseer ? (
              <View className="gap-3">
                <Text className="text-sm text-foreground-muted">
                  Overseer models take turns, skipping any that are out of usage or failing. With
                  none, Chat Agents runs it, or the goal&apos;s own models.
                </Text>
                {current.overseerAgents.map((agent, index) => (
                  <AgentCard
                    agent={{ ...agent, count: 1 }}
                    canRemove
                    counted={false}
                    key={`${agent.instanceId}:${index}`}
                    onChange={({ count: _count, ...next }) =>
                      patch({
                        overseerAgents: current.overseerAgents.map((entry, at) =>
                          at === index ? next : entry,
                        ),
                      })
                    }
                    onRemove={() =>
                      patch({
                        overseerAgents: current.overseerAgents.filter((_, at) => at !== index),
                      })
                    }
                    options={modelOptions}
                  />
                ))}
                <Button
                  disabled={modelOptions.length === 0}
                  label="Add an overseer model"
                  onPress={() => {
                    if (defaultOption) {
                      const { count: _count, ...next } = agentFromOption(defaultOption, 1);
                      patch({ overseerAgents: [...current.overseerAgents, next] });
                    }
                  }}
                />
              </View>
            ) : null}
            <Field label="Stop the goal after this many agents in a row cannot finish">
              <NumberInput
                accessibilityLabel="Stop after agents that cannot finish"
                onChange={(stopAfterProblems) => patch({ stopAfterProblems })}
                value={current.stopAfterProblems}
              />
            </Field>
            <SwitchRow
              label="Working rules: claim a chunk, own worktree, merge, push, clean up"
              onChange={(standardRules) => patch({ standardRules })}
              value={current.standardRules}
            />
            <View className="gap-1.5">
              <Text className="text-sm text-foreground-muted">Permissions</Text>
              <View className="flex-row flex-wrap gap-2">
                {RUNTIME_MODES.map(({ mode, label }) => {
                  const selected = current.runtimeMode === mode;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      className={cn(
                        "rounded-full px-4 py-2 active:opacity-70",
                        selected ? "bg-primary" : "bg-subtle-strong",
                      )}
                      key={mode}
                      onPress={() => patch({ runtimeMode: mode })}
                    >
                      <Text
                        className={cn(
                          "text-sm",
                          selected ? "text-primary-foreground" : "text-foreground",
                        )}
                      >
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {current.runtimeMode !== "full-access" ? (
                <Text className="text-sm text-foreground-muted">
                  Agents work unattended. Any approval they ask for waits for you.
                </Text>
              ) : null}
            </View>
          </View>

          {problem ? (
            <Text className="text-sm text-foreground-muted">{problem}</Text>
          ) : draftSaved ? (
            <Text className="text-sm text-foreground-muted">Draft saved.</Text>
          ) : null}
          <Button
            disabled={problem !== undefined || planBlocked}
            fullWidth
            label={starting ? props.busyLabel : props.submitLabel}
            loading={starting}
            onPress={() => void finish(props.onSubmit)}
            tone="primary"
          />
          {props.secondary ? (
            <Button
              disabled={problem !== undefined || starting || planBlocked}
              fullWidth
              label={props.secondary.label}
              onPress={() => void finish(props.secondary!.onSubmit)}
            />
          ) : null}
        </ScrollView>
      </>
    </View>
  );
}

/**
 * A new goal in one project. What is typed is kept as a draft, so closing the
 * screen half-way loses nothing; starting turns the draft into a running goal.
 */
export function CreateGoalScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title?: string | undefined;
  /** Closes the screen after the goal was started. */
  readonly close: () => void;
}) {
  const { environmentId, projectId } = props;
  const config = useServerConfigs().get(environmentId);
  const defaultOption = useMemo(() => {
    const options = buildModelOptions(config, null, undefined, null).filter(
      (option) => !option.isUnavailable,
    );
    return options.find((option) => option.isDefault) ?? options[0];
  }, [config]);
  const createGoal = useAtomCommand(serverEnvironment.createGoal, { reportFailure: false });
  const updateGoal = useAtomCommand(serverEnvironment.updateGoal, { reportFailure: false });
  const restartGoal = useAtomCommand(serverEnvironment.restartGoal, { reportFailure: false });
  const draftId = useRef<GoalId | null>(null);

  return (
    <GoalForm
      busyLabel="Starting…"
      environmentId={environmentId}
      initial={defaultGoalSetup({
        projectId,
        agent: defaultOption ? agentFromOption(defaultOption, 1) : null,
        runtimeMode: "full-access",
      })}
      onDraft={async (settings) => {
        if (draftId.current) {
          const result = await updateGoal({
            environmentId,
            input: { id: draftId.current, goal: settings, draft: true },
          });
          if (AsyncResult.isFailure(result)) throw new Error("Could not save the draft.");
          return;
        }
        const result = await createGoal({ environmentId, input: { goal: settings, draft: true } });
        if (AsyncResult.isFailure(result)) throw new Error("Could not save the draft.");
        draftId.current = result.value.goals[0]?.id ?? null;
      }}
      onSubmit={async (settings) => {
        const id = draftId.current;
        const result = id
          ? await updateGoal({ environmentId, input: { id, goal: settings } })
          : await createGoal({ environmentId, input: { goal: settings } });
        if (AsyncResult.isFailure(result)) {
          // The server explains a refusal (for example an unusable plan); show it.
          const reason = Cause.squash(result.cause);
          Alert.alert(
            "Could not start the goal",
            reason instanceof Error && reason.message
              ? reason.message
              : "Check the connection and try again.",
          );
          return false;
        }
        if (id) {
          const started = await restartGoal({ environmentId, input: { id } });
          if (AsyncResult.isFailure(started)) {
            Alert.alert("Could not start the goal", "It was saved as a draft. Try again.");
            return false;
          }
        }
        props.close();
        return true;
      }}
      submitLabel="Start goal"
      subtitle={props.title}
      title="New goal"
    />
  );
}

/**
 * Goal setup, opened from the new-task project picker with Goal switched on.
 */
export function GoalSetupRouteScreen({ route }: StaticScreenProps<GoalSetupParams>) {
  const navigation = useNavigation();
  return (
    <CreateGoalScreen
      close={() => {
        // Starting a goal finishes the new-task flow, so the project picker closes with it.
        const state = navigation.getState();
        const fromPicker = state?.routes[state.index - 1]?.name === "NewTaskProject";
        navigation.dispatch(StackActions.pop(fromPicker ? 2 : 1));
      }}
      environmentId={route.params.environmentId as EnvironmentId}
      projectId={route.params.projectId as ProjectId}
      title={route.params.title}
    />
  );
}
