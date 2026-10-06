import type { EnvironmentId } from "@t3tools/contracts";
import { type Goal, goalTitle } from "@t3tools/contracts/goals";
import { Link } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";

import { isElectron } from "../../env";
import { useEnvironments } from "../../state/environments";
import { useGoals } from "../../state/goals";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  describeGoalPauses,
  describeGoalProgress,
  describeGoalQueue,
} from "@t3tools/client-runtime/goal-progress";

const STATUS_LABEL: Record<Goal["status"], string> = {
  draft: "Draft",
  running: "Running",
  complete: "Complete",
  stopped: "Stopped",
  failed: "Stopped early",
};

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

function GoalStatusIcon({ status }: { status: Goal["status"] }) {
  if (status === "draft") {
    return <PencilIcon aria-label="Draft" className="size-5 text-muted-foreground" />;
  }
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
  nameOf,
  onAction,
}: {
  environmentId: EnvironmentId;
  goal: Goal;
  nameOf: (instanceId: string) => string;
  onAction: (action: "stop" | "restart" | "addAgents" | "remove", goal: Goal) => void;
}) {
  // Working and finished agents are only counted; the ones that need a look are listed.
  const attentionChats = goal.chats.filter(
    (chat) => chat.status === "attention" || chat.status === "failed",
  );
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
          {goal.prompt?.trim() ? (
            <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">
              {goal.prompt.trim()}
            </p>
          ) : null}
          <p className="pt-1 text-2xs text-muted-foreground/80">
            {STATUS_LABEL[goal.status]}
            {goal.status === "draft" ? " · not started" : ` · ${describeGoalProgress(goal)}`}
          </p>
          {describeGoalQueue(goal) ? (
            <p className="text-2xs text-muted-foreground/80">{describeGoalQueue(goal)}</p>
          ) : null}
          {goal.detail ? <p className="text-2xs text-muted-foreground/80">{goal.detail}</p> : null}
          {goal.waitingUntil ? (
            <p className="text-2xs text-muted-foreground/80">
              Next check for a provider that is back: {formatTime(goal.waitingUntil)}
            </p>
          ) : null}
          {goal.status === "running" || goal.status === "stopped"
            ? describeGoalPauses(goal, Date.now(), nameOf, formatTime).map((line) => (
                <p className="text-2xs text-muted-foreground/80" key={line}>
                  {line}
                </p>
              ))
            : null}
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
              <PlayIcon className="size-3.5" /> {goal.status === "draft" ? "Start" : "Start again"}
            </Button>
          )}
          {goal.status !== "draft" ? (
            <Button
              onClick={() => onAction("addAgents", goal)}
              size="sm"
              title={`Start ${ADD_AGENTS_COUNT} more agents on this goal`}
              type="button"
              variant="outline"
            >
              <PlusIcon className="size-3.5" /> {ADD_AGENTS_COUNT} agents
            </Button>
          ) : null}
          <Button
            aria-label={`Edit ${goalTitle(goal)}`}
            render={<Link search={{ environmentId, goalId: goal.id }} to="/edit-goal" />}
            size="sm"
            variant="ghost"
          >
            <PencilIcon className="size-3.5" />
          </Button>
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
      {attentionChats.length > 0 ? (
        <ul className="space-y-1">
          {attentionChats.map((chat) => (
            <li
              className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
              key={chat.threadId}
            >
              <span>
                {chat.beadTitle ?? "An agent"} · {chat.status === "failed" ? "failed" : "needs you"}
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
      ) : null}
    </li>
  );
}

/** How many agents the "more agents" button adds. */
const ADD_AGENTS_COUNT = 3;

export function GoalsPage() {
  const { environments: presentations } = useEnvironments();
  const { environments, stop, restart, addAgents, remove } = useGoals();
  const nameFor = (environmentId: EnvironmentId) => (instanceId: string) =>
    presentations
      .find((candidate) => candidate.environmentId === environmentId)
      ?.serverConfig?.providers.find((provider) => provider.instanceId === instanceId)
      ?.displayName ?? instanceId;
  const labelFor = (environmentId: EnvironmentId) =>
    presentations.find((candidate) => candidate.environmentId === environmentId)?.label ??
    "Environment";
  const total = environments.reduce((count, environment) => count + environment.goals.length, 0);

  const onAction =
    (environmentId: EnvironmentId) =>
    (action: "stop" | "restart" | "addAgents" | "remove", goal: Goal) => {
      const run =
        action === "stop"
          ? stop
          : action === "restart"
            ? restart
            : action === "addAgents"
              ? (id: EnvironmentId, goalId: Goal["id"]) => addAgents(id, goalId, ADD_AGENTS_COUNT)
              : remove;
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
        <Button
          className="ml-auto"
          render={<Link search={{}} to="/new-goal" />}
          size="sm"
          variant="outline"
        >
          <PlusIcon className="size-3.5" /> New goal
        </Button>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer className="min-h-full gap-4">
          <p className="text-xs text-muted-foreground">
            Start a goal with New goal, or from the new chat menu with Goal switched on. Open the
            pencil on a goal to change any of its settings. A goal you set up but did not start is
            kept here as a draft.
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
                        nameOf={nameFor(environment.environmentId)}
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
