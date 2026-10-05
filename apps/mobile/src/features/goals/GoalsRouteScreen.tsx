import { useNavigation } from "@react-navigation/native";
import {
  describeGoalPauses,
  describeGoalProgress,
  describeGoalQueue,
} from "@t3tools/client-runtime/goal-progress";
import type { EnvironmentId } from "@t3tools/contracts";
import { goalTitle, type Goal } from "@t3tools/contracts/goals";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";
import { Alert, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";

const REFRESH_MS = 5_000;

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

const STATUS_LABEL: Record<Goal["status"], string> = {
  draft: "Draft",
  running: "Running",
  complete: "Complete",
  stopped: "Stopped",
  failed: "Stopped early",
};

function GoalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly goal: Goal;
  readonly nameOf: (instanceId: string) => string;
  readonly onChanged: () => void;
}) {
  const navigation = useNavigation();
  const stopGoal = useAtomCommand(serverEnvironment.stopGoal);
  const restartGoal = useAtomCommand(serverEnvironment.restartGoal);
  const deleteGoal = useAtomCommand(serverEnvironment.deleteGoal);
  const { goal, environmentId } = props;
  const running = goal.status === "running";
  const queue = describeGoalQueue(goal);
  const needAttention = goal.chats.filter(
    (chat) => chat.status === "attention" || chat.status === "failed",
  ).length;

  const run = async (action: typeof stopGoal) => {
    const result = await action({ environmentId, input: { id: goal.id } });
    if (AsyncResult.isFailure(result)) {
      Alert.alert("Could not update the goal", "Check the connection and try again.");
    }
    props.onChanged();
  };
  const pauses =
    running || goal.status === "stopped"
      ? describeGoalPauses(goal, Date.now(), props.nameOf, formatTime)
      : [];

  return (
    <View className="gap-3 rounded-[24px] bg-card p-4">
      <View className="gap-1">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
          {goalTitle(goal)}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {STATUS_LABEL[goal.status]}
          {goal.status === "draft" ? " · not started" : ` · ${describeGoalProgress(goal)}`}
        </Text>
        {queue ? <Text className="text-sm text-foreground-muted">{queue}</Text> : null}
        {goal.detail ? <Text className="text-sm text-foreground-muted">{goal.detail}</Text> : null}
        {goal.waitingUntil ? (
          <Text className="text-sm text-foreground-muted">
            Next check for a provider that is back: {formatTime(goal.waitingUntil)}
          </Text>
        ) : null}
        {pauses.map((line) => (
          <Text className="text-sm text-foreground-muted" key={line}>
            {line}
          </Text>
        ))}
        {needAttention > 0 ? (
          <Text className="text-sm text-danger-foreground">
            {needAttention} agent{needAttention === 1 ? "" : "s"} failed or need you. Open them from
            the thread list.
          </Text>
        ) : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {running ? (
          <MaterialButton label="Stop" onPress={() => void run(stopGoal)} />
        ) : (
          <MaterialButton
            label={goal.status === "draft" ? "Start" : "Start again"}
            onPress={() => void run(restartGoal)}
          />
        )}
        <MaterialButton
          label="Edit"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsGoalEdit", params: { environmentId, goalId: goal.id } },
            })
          }
        />
        <MaterialButton
          label="Delete"
          onPress={() =>
            Alert.alert("Delete this goal?", "Its chats stay as normal threads and keep running.", [
              { style: "cancel", text: "Cancel" },
              { style: "destructive", text: "Delete", onPress: () => void run(deleteGoal) },
            ])
          }
          tone="text"
        />
      </View>
    </View>
  );
}

function EnvironmentGoals(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { environmentId } = props;
  const config = useServerConfigs().get(environmentId);
  const nameOf = (instanceId: string) =>
    config?.providers.find((provider) => provider.instanceId === instanceId)?.displayName ??
    instanceId;
  const goals = useEnvironmentQuery(serverEnvironment.goals({ environmentId, input: {} }));
  const refresh = goals.refresh;
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  if (!goals.data || goals.data.goals.length === 0) return null;
  return (
    <View className="gap-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      {goals.data.goals.map((goal) => (
        <GoalCard
          environmentId={environmentId}
          goal={goal}
          key={goal.id}
          nameOf={nameOf}
          onChanged={refresh}
        />
      ))}
    </View>
  );
}

/** Goals on every connected machine: counts only, with stop, restart, edit and delete. */
export function GoalsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { environments } = useEnvironments();
  return (
    <SettingsScreen title="Goals">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">
          Start a goal here or from New thread with the Goal switch on. It keeps agents working
          until nothing is left. A goal you set up but did not start is kept as a draft.
        </Text>
        <MaterialButton
          label="New goal"
          onPress={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsGoalProject" },
            })
          }
          tone="primary"
        />
        {environments.map((environment) => (
          <EnvironmentGoals
            environmentId={environment.environmentId}
            key={environment.environmentId}
            label={environment.label}
          />
        ))}
      </ScrollView>
    </SettingsScreen>
  );
}
