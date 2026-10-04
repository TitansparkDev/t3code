import type { EnvironmentId } from "@t3tools/contracts";
import type { GoalId } from "@t3tools/contracts/goals";
import { createFileRoute } from "@tanstack/react-router";

import { GoalSetupPage } from "../components/goals/GoalSetupPage";
import { useGoals } from "../state/goals";

function EditGoalRoute() {
  const { environmentId, goalId } = Route.useSearch();
  const { environments } = useGoals();
  const goal = environments
    .find((candidate) => candidate.environmentId === environmentId)
    ?.goals.find((candidate) => candidate.id === goalId);
  if (!goal || !environmentId) {
    return <p className="p-6 text-sm text-muted-foreground">This goal is not available.</p>;
  }
  // Keyed so the form starts from the goal it was opened for, and is not reset by list refreshes.
  return (
    <GoalSetupPage
      environmentId={environmentId}
      goal={goal}
      key={goal.id}
      projectId={goal.projectId}
    />
  );
}

export const Route = createFileRoute("/edit-goal")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { environmentId?: EnvironmentId; goalId?: GoalId } => ({
    ...(typeof search.environmentId === "string"
      ? { environmentId: search.environmentId as EnvironmentId }
      : {}),
    ...(typeof search.goalId === "string" ? { goalId: search.goalId as GoalId } : {}),
  }),
  component: EditGoalRoute,
});
