import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { GoalPlanPreview } from "@t3tools/contracts/goals";
import { useEffect, useState } from "react";

import { useGoals } from "../../state/goals";

type QueueMode = "auto" | "standard" | "agentqueue";

const MODE_LABELS: Record<QueueMode, string> = {
  auto: "Auto — AgentQueue when the project has a valid plan",
  agentqueue: "AgentQueue — the server assigns each task",
  standard: "Standard — agents choose their own work with plan-work",
};

const PREVIEW_DELAY_MS = 400;

/**
 * What the goal would run on, checked on the server before it starts: the repository, the
 * plan, the mode that would be used, how many tasks are ready, and any problem. Reports
 * whether the choice is blocked so the page can keep Start disabled.
 */
export function GoalPlanPanel({
  environmentId,
  projectId,
  queueMode,
  planPath,
  onChange,
  onBlockedChange,
}: {
  environmentId: EnvironmentId | undefined;
  projectId: ProjectId;
  queueMode: QueueMode;
  planPath: string;
  onChange: (change: { queueMode?: QueueMode; planPath?: string }) => void;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const { previewPlan } = useGoals();
  const [preview, setPreview] = useState<GoalPlanPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!environmentId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      previewPlan(environmentId, {
        projectId,
        queueMode,
        ...(planPath.trim() ? { planPath: planPath.trim() } : {}),
      })
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setFailure(null);
          onBlockedChange(result.blocked);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setFailure(error instanceof Error ? error.message : "Could not check the plan.");
          // Starting would be refused or unchecked: do not offer it.
          onBlockedChange(queueMode === "agentqueue");
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [environmentId, projectId, queueMode, planPath, previewPlan, onBlockedChange]);

  const counts = preview?.counts;
  return (
    <section className="space-y-2 rounded-md border border-border/60 p-3">
      <h2 className="text-xs font-medium text-muted-foreground">How agents get their work</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="block text-xs text-muted-foreground">Mode</span>
          <select
            aria-label="Queue mode"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs"
            onChange={(event) => onChange({ queueMode: event.target.value as QueueMode })}
            value={queueMode}
          >
            {(Object.keys(MODE_LABELS) as QueueMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        {preview && preview.candidates.length > 1 ? (
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">Plan</span>
            <select
              aria-label="Plan file"
              className="rounded-md border border-border bg-background px-2 py-1 text-xs"
              onChange={(event) => onChange({ planPath: event.target.value })}
              value={planPath || preview.planPath || ""}
            >
              <option value="">Choose a plan…</option>
              {preview.candidates.map((candidate) => (
                <option key={candidate.path} value={candidate.path}>
                  {candidate.path} — {candidate.unfinishedCount} of {candidate.taskCount} unfinished
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {failure ? (
        <p className="text-2xs text-destructive-foreground">{failure}</p>
      ) : preview ? (
        <div className="space-y-1 text-2xs">
          <p className={preview.blocked ? "text-destructive-foreground" : "text-foreground"}>
            {preview.summary}
          </p>
          <p className="text-muted-foreground">
            Mode: {preview.effectiveMode === "agentqueue" ? "AgentQueue" : "Standard"}
            {preview.repoRoot ? ` · Repository: ${preview.repoRoot}` : ""}
            {preview.baseBranch ? ` · Lands on: ${preview.baseBranch}` : ""}
            {preview.planPath ? ` · Plan: ${preview.planPath}` : ""}
          </p>
          {preview.planPath && counts && counts.total > 0 ? (
            <p className="text-muted-foreground">
              {counts.total} tasks · {counts.completed} done · {counts.ready} ready now ·{" "}
              {counts.waiting} waiting on others
              {counts.active > 0 ? ` · ${counts.active} in progress` : ""}
              {counts.failed > 0 ? ` · ${counts.failed} failed or blocked` : ""}
            </p>
          ) : null}
          {preview.errors.map((message) => (
            <p className="text-destructive-foreground" key={message}>
              {message}
            </p>
          ))}
          {preview.warnings.map((message) => (
            <p className="text-warning-foreground" key={message}>
              {message}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">Checking the project's plan…</p>
      )}
    </section>
  );
}
