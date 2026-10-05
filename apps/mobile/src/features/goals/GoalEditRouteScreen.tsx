import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { goalToSetup } from "@t3tools/client-runtime/goal-setup";
import type { EnvironmentId } from "@t3tools/contracts";
import { goalTitle, type GoalId } from "@t3tools/contracts/goals";
import { AsyncResult } from "effect/unstable/reactivity";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { GoalForm } from "./GoalSetupRouteScreen";

type GoalEditParams = {
  readonly environmentId: string;
  readonly goalId: string;
};

/** Every setting of a goal that was already started. Agents started from now on use the changes. */
export function GoalEditRouteScreen({ route }: StaticScreenProps<GoalEditParams>) {
  const navigation = useNavigation();
  const environmentId = route.params.environmentId as EnvironmentId;
  const goalId = route.params.goalId as GoalId;
  const goals = useEnvironmentQuery(serverEnvironment.goals({ environmentId, input: {} }));
  const updateGoal = useAtomCommand(serverEnvironment.updateGoal, { reportFailure: false });
  const goal = goals.data?.goals.find((entry) => entry.id === goalId);

  if (!goal) {
    return (
      <SettingsScreen title="Edit goal">
        <View className="items-center px-6 pt-10">
          <Text className="text-center text-base text-foreground-muted">
            {goals.data ? "This goal no longer exists." : "Loading the goal…"}
          </Text>
        </View>
      </SettingsScreen>
    );
  }

  return (
    <GoalForm
      busyLabel="Saving…"
      environmentId={environmentId}
      initial={goalToSetup(goal)}
      onSubmit={async (settings) => {
        const result = await updateGoal({ environmentId, input: { id: goalId, goal: settings } });
        if (AsyncResult.isFailure(result)) {
          Alert.alert("Could not save the goal", "Check the connection and try again.");
          return false;
        }
        navigation.goBack();
        return true;
      }}
      submitLabel="Save changes"
      subtitle={goalTitle(goal)}
      title="Edit goal"
    />
  );
}
