import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  defaultGoalSetup,
  goalSetupProblem,
  goalSetupToDraftSettings,
  goalSetupToSettings,
  type GoalSetupAgent,
  type GoalSetupForm,
} from "@t3tools/client-runtime/goal-setup";
import type { EnvironmentId, ProjectId, RuntimeMode } from "@t3tools/contracts";
import type { GoalId } from "@t3tools/contracts/goals";
import {
  MAX_GOAL_AGENT_COUNT,
  MAX_GOAL_CONCURRENCY,
  type GoalSettings,
} from "@t3tools/contracts/goals";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { ThemedSwitch } from "../../components/ThemedSwitch";
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

/** One model row: the model, its effort choices, and how many run at once. */
function AgentCard(props: {
  readonly agent: GoalSetupAgent;
  readonly options: ReadonlyArray<ModelOption>;
  readonly canRemove: boolean;
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
            <MaterialListRow
              key={option.key}
              onPress={() => {
                props.onChange(agentFromOption(option, props.agent.count));
                setPicking(false);
              }}
              subtitle={option.providerLabel}
              title={option.label}
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
        <Field label={`Run at once (up to ${MAX_GOAL_AGENT_COUNT})`}>
          <NumberInput
            accessibilityLabel="Agents of this model at once"
            onChange={(count) => props.onChange({ ...props.agent, count })}
            value={props.agent.count}
          />
        </Field>
        {props.canRemove ? (
          <MaterialButton label="Remove" onPress={props.onRemove} tone="text" />
        ) : null}
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
    () => buildModelOptions(config, null).filter((option) => !option.isUnavailable),
    [config],
  );
  const defaultOption = modelOptions.find((option) => option.isDefault) ?? modelOptions[0];
  const [form, setForm] = useState<GoalSetupForm>(props.initial);
  const [starting, setStarting] = useState(false);
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
      <ScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        sidebar={false}
        hideBottomBorder
        onBack={() => navigation.goBack()}
      />
      <MaterialScreenContent>
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
            <MaterialButton
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
              label="Restart agents cut off by a usage limit, when it resets"
              onChange={(autoResume) => patch({ autoResume })}
              value={current.autoResume}
            />
            <SwitchRow
              label="Take work from Beads: start an agent only when a chunk is ready"
              onChange={(useBeads) => patch({ useBeads })}
              value={current.useBeads}
            />
            {current.useBeads ? (
              <Field label="Only this Beads epic or plan (optional)">
                <TextInput
                  autoCapitalize="none"
                  className="h-12 min-h-12 rounded-[24px] px-4 py-0 text-base leading-snug"
                  onChangeText={(beadsScope) => patch({ beadsScope })}
                  value={current.beadsScope}
                />
              </Field>
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
          <MaterialButton
            disabled={problem !== undefined}
            fullWidth
            label={starting ? props.busyLabel : props.submitLabel}
            loading={starting}
            onPress={() => void finish(props.onSubmit)}
            tone="primary"
          />
          {props.secondary ? (
            <MaterialButton
              disabled={problem !== undefined || starting}
              fullWidth
              label={props.secondary.label}
              onPress={() => void finish(props.secondary!.onSubmit)}
            />
          ) : null}
        </ScrollView>
      </MaterialScreenContent>
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
    const options = buildModelOptions(config, null).filter((option) => !option.isUnavailable);
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
          Alert.alert("Could not start the goal", "Check the connection and try again.");
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
      close={() => (navigation.getParent() ?? navigation).goBack()}
      environmentId={route.params.environmentId as EnvironmentId}
      projectId={route.params.projectId as ProjectId}
      title={route.params.title}
    />
  );
}
