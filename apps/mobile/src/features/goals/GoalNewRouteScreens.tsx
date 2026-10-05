import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { CreateGoalScreen } from "./GoalSetupRouteScreen";

/** Which project a new goal is for, opened from the Goals list. */
export function GoalProjectRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  return (
    <SettingsScreen title="New goal">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="text-sm text-foreground-muted">Which project is the goal for?</Text>
        {projects.length === 0 ? (
          <View className="pt-4">
            <Text className="text-base text-foreground-muted">Add a project first.</Text>
          </View>
        ) : (
          projects.map((project) => (
            <MaterialButton
              fullWidth
              key={`${project.environmentId}:${project.id}`}
              label={project.title}
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: {
                    screen: "SettingsGoalNew",
                    params: {
                      environmentId: project.environmentId,
                      projectId: project.id,
                      title: project.title,
                    },
                  },
                })
              }
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

type GoalNewParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly title?: string;
};

/** The setup form for a new goal, inside Settings. Starting it returns to the Goals list. */
export function GoalNewRouteScreen({ route }: StaticScreenProps<GoalNewParams>) {
  const navigation = useNavigation();
  return (
    <CreateGoalScreen
      close={() => navigation.goBack()}
      environmentId={route.params.environmentId as EnvironmentId}
      projectId={route.params.projectId as ProjectId}
      title={route.params.title}
    />
  );
}
