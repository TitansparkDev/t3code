import type { EnvironmentId } from "@t3tools/contracts";
import { type Goal, goalTitle } from "@t3tools/contracts/goals";
import { Link } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ExternalLinkIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useEnvironments } from "../../state/environments";
import { useGoals } from "../../state/goals";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { describeGoalProgress } from "./goalProgress";

const STATUS_LABEL: Record<Goal["status"], string> = {
  running: "Running",
  complete: "Complete",
  stopped: "Stopped",
  failed: "Stopped early",
};

function GoalStatusIcon({ status }: { status: Goal["status"] }) {
  if (status === "complete") {
    return <CheckCircle2Icon aria-label="Goal complete" className="size-5 text-success" />;
  }
  if (status === "failed") {
    return <CircleAlertIcon aria-label="Stopped early" className="size-5 text-warning" />;
  }
  if (status === "stopped") {
    return <SquareIcon aria-label="Stopped" className="size-5 text-muted-foreground" />;
  }
  return <PlayIcon aria-label="Running" className="size-5 text-info" />;
}

function GoalCard({
  environmentId,
  goal,
  onAction,
}: {
  environmentId: EnvironmentId;
  goal: Goal;
  onAction: (action: "stop" | "restart" | "remove", goal: Goal) => void;
}) {
  return (
    <li className="space-y-3 rounded-lg border border-border/60 p-4">
      <div className="flex items-start gap-3">
        <GoalStatusIcon status={goal.status} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{goalTitle(goal)}</p>
          {goal.name.includes("\n") ? (
            <p className="line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">
              {goal.name.slice(goal.name.indexOf("\n") + 1).trim()}
            </p>
          ) : null}
          <p className="pt-1 text-2xs text-muted-foreground/80">
            {STATUS_LABEL[goal.status]} · {describeGoalProgress(goal)}
          </p>
          {goal.detail ? <p className="text-2xs text-muted-foreground/80">{goal.detail}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {goal.status === "running" ? (
            <Button
              onClick={() => onAction("stop", goal)}
              size="sm"
              type="button"
              variant="outline"
            >
              <SquareIcon className="size-3.5" /> Stop
            </Button>
          ) : (
            <Button
              onClick={() => onAction("restart", goal)}
              size="sm"
              type="button"
              variant="outline"
            >
              <PlayIcon className="size-3.5" /> Start again
            </Button>
          )}
          <Button
            aria-label={`Delete ${goalTitle(goal)}`}
            onClick={() => onAction("remove", goal)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <ul className="space-y-1">
        {goal.chats.toReversed().map((chat, index) => (
          <li
            className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
            key={chat.threadId}
          >
            <span>
              Agent {goal.chats.length - index} ·{" "}
              {chat.waitingForLimit ? "waiting for a usage limit, will resume" : chat.status}
            </span>
            <Button
              render={
                <Link
                  params={{ environmentId, threadId: chat.threadId }}
                  to="/$environmentId/$threadId"
                />
              }
              size="xs"
              variant="outline"
            >
              <ExternalLinkIcon className="size-3" /> Open chat
            </Button>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function GoalsPage() {
  const { environments: presentations } = useEnvironments();
  const { environments, stop, restart, remove } = useGoals();
  const labelFor = (environmentId: EnvironmentId) =>
    presentations.find((candidate) => candidate.environmentId === environmentId)?.label ??
    "Environment";
  const total = environments.reduce((count, environment) => count + environment.goals.length, 0);

  const onAction =
    (environmentId: EnvironmentId) => (action: "stop" | "restart" | "remove", goal: Goal) => {
      const run = action === "stop" ? stop : action === "restart" ? restart : remove;
      void run(environmentId, goal.id).catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not update the goal",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="relative bg-background">
        <h1 className="text-sm font-medium">Goals</h1>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer className="min-h-full gap-4">
          <p className="text-xs text-muted-foreground">
            Start a goal by sending <code>!goal</code> followed by what should get done, in any
            chat. Add more lines for instructions, and <code>x4</code> after <code>!goal</code> to
            run four chats at once. A goal keeps starting chats until an agent says nothing is left.
          </p>
          {total === 0 ? (
            <p className="text-sm text-muted-foreground">No goals yet.</p>
          ) : (
            environments.map((environment) =>
              environment.goals.length === 0 ? null : (
                <section className="space-y-2" key={environment.environmentId}>
                  {environments.length > 1 ? (
                    <h2 className="text-xs font-medium text-muted-foreground">
                      {labelFor(environment.environmentId)}
                    </h2>
                  ) : null}
                  <ul className="space-y-3">
                    {environment.goals.map((goal) => (
                      <GoalCard
                        environmentId={environment.environmentId}
                        goal={goal}
                        key={goal.id}
                        onAction={onAction(environment.environmentId)}
                      />
                    ))}
                  </ul>
                </section>
              ),
            )
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
