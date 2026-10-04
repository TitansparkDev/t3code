import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { GoalSetupPage } from "../components/goals/GoalSetupPage";

function NewGoalRoute() {
  const { environmentId, projectId } = Route.useSearch();
  // Keyed so choosing another project starts a fresh form with that environment's models.
  return (
    <GoalSetupPage
      environmentId={environmentId}
      key={`${environmentId}:${projectId}`}
      projectId={projectId}
    />
  );
}

export const Route = createFileRoute("/new-goal")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { environmentId?: EnvironmentId; projectId?: ProjectId } => ({
    ...(typeof search.environmentId === "string"
      ? { environmentId: search.environmentId as EnvironmentId }
      : {}),
    ...(typeof search.projectId === "string" ? { projectId: search.projectId as ProjectId } : {}),
  }),
  component: NewGoalRoute,
});
