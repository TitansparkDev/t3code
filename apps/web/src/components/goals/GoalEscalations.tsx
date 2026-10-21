import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Goal, GoalEscalation, GoalEscalationResolveAction } from "@t3tools/contracts/goals";
import {
  describeEscalationKind,
  describeEscalationStatus,
  isEscalationOpen,
  sortEscalationsNewestFirst,
} from "@t3tools/client-runtime/goal-progress";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** What the Goals page does with an escalation; each call refreshes the list and reports failures. */
export interface EscalationActions {
  readonly resolve: (
    id: string,
    action: GoalEscalationResolveAction,
    note: string,
  ) => Promise<void>;
  readonly cancel: (id: string) => Promise<void>;
  readonly ask: (goalId: Goal["id"], threadId: ThreadId | undefined, note: string) => Promise<void>;
}

const REASON_CLAMP_THRESHOLD = 160;

const STATUS_BADGE_VARIANT: Record<
  GoalEscalation["status"],
  "info" | "warning" | "success" | "secondary"
> = {
  open: "info",
  reviewing: "info",
  "needs-person": "warning",
  resolved: "success",
  cancelled: "secondary",
};

/** A note the person sends with an answer or a question. Empty is allowed; the overseer still reads the rest. */
function NoteForm({
  placeholder,
  submitLabel,
  onSubmit,
  onDone,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (note: string) => Promise<void>;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        // A failure is reported by the caller; the form stays open with the note so it can be sent again.
        void onSubmit(note.trim())
          .then(onDone, () => undefined)
          .finally(() => setBusy(false));
      }}
    >
      <Textarea
        aria-label={placeholder}
        disabled={busy}
        maxLength={4000}
        onChange={(event) => setNote(event.target.value)}
        placeholder={placeholder}
        rows={2}
        size="sm"
        value={note}
      />
      <div className="flex justify-end gap-1">
        <Button onClick={onDone} size="sm" type="button" variant="ghost">
          Close
        </Button>
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A button that opens a note box to ask the overseer something. */
export function AskOverseerControl({
  label,
  onAsk,
}: {
  label: string;
  onAsk: (note: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="xs" type="button" variant="outline">
        <MessageSquareIcon className="size-3" /> {label}
      </Button>
    );
  }
  return (
    <div className="w-full">
      <NoteForm
        onDone={() => setOpen(false)}
        onSubmit={onAsk}
        placeholder="What should the overseer look at?"
        submitLabel="Ask"
      />
    </div>
  );
}

function EscalationRow({
  environmentId,
  escalation,
  actions,
}: {
  environmentId: EnvironmentId;
  escalation: GoalEscalation;
  actions: EscalationActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<GoalEscalationResolveAction | null>(null);
  const open = isEscalationOpen(escalation);
  const needsPerson = escalation.status === "needs-person";
  const clamped = escalation.reason.length > REASON_CLAMP_THRESHOLD && !expanded;

  return (
    <li
      className={
        needsPerson
          ? "space-y-2 rounded-md border border-warning/60 p-3"
          : "space-y-2 rounded-md border border-border/60 p-3"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{describeEscalationKind(escalation)}</span>
        <Badge size="sm" variant={STATUS_BADGE_VARIANT[escalation.status]}>
          {describeEscalationStatus(escalation)}
        </Badge>
      </div>
      <p
        className={
          clamped
            ? "line-clamp-3 whitespace-pre-line text-xs text-muted-foreground"
            : "whitespace-pre-line text-xs text-muted-foreground"
        }
      >
        {escalation.reason}
      </p>
      {escalation.reason.length > REASON_CLAMP_THRESHOLD ? (
        <button
          className="text-2xs text-muted-foreground underline underline-offset-2"
          onClick={() => setExpanded((value) => !value)}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {escalation.threadId ? (
          <Button
            render={
              <Link
                params={{ environmentId, threadId: escalation.threadId }}
                to="/$environmentId/$threadId"
              />
            }
            size="xs"
            variant="outline"
          >
            <ExternalLinkIcon className="size-3" /> Worker chat
          </Button>
        ) : null}
        {escalation.overseerThreadId ? (
          <Button
            render={
              <Link
                params={{ environmentId, threadId: escalation.overseerThreadId }}
                to="/$environmentId/$threadId"
              />
            }
            size="xs"
            variant="outline"
          >
            <ExternalLinkIcon className="size-3" /> Overseer chat
          </Button>
        ) : null}
      </div>
      {escalation.resolution ? (
        <p className="text-2xs text-muted-foreground/80">
          {escalation.resolution.by === "person" ? "You" : "Overseer"}:{" "}
          {escalation.resolution.note || escalation.resolution.action}
        </p>
      ) : null}
      {open ? (
        <div className="space-y-2">
          {pendingAction ? (
            <NoteForm
              onDone={() => setPendingAction(null)}
              onSubmit={(note) => actions.resolve(escalation.id, pendingAction, note)}
              placeholder={
                pendingAction === "retry"
                  ? "A short note for the worker, e.g. what to change"
                  : "Why the task should be given up"
              }
              submitLabel={pendingAction === "retry" ? "Tell worker to retry" : "Give up task"}
            />
          ) : (
            <div className="flex flex-wrap gap-1">
              <Button
                onClick={() => setPendingAction("retry")}
                size="xs"
                type="button"
                variant="outline"
              >
                Tell worker to retry
              </Button>
              <Button
                onClick={() => setPendingAction("give-up")}
                size="xs"
                type="button"
                variant="outline"
              >
                Give up task
              </Button>
              <Button
                onClick={() => void actions.cancel(escalation.id).catch(() => undefined)}
                size="xs"
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** The goal's escalations, newest first, with the person's answers while any are open. */
export function GoalOverseerSection({
  environmentId,
  goal,
  actions,
}: {
  environmentId: EnvironmentId;
  goal: Goal;
  actions: EscalationActions;
}) {
  const escalations = sortEscalationsNewestFirst(goal.escalations ?? []);
  return (
    <section className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium">Overseer</h3>
        <AskOverseerControl
          label="Ask overseer"
          onAsk={(note) => actions.ask(goal.id, undefined, note)}
        />
      </div>
      {escalations.length === 0 ? (
        <p className="text-2xs text-muted-foreground/80">No problems raised.</p>
      ) : (
        <ul className="space-y-2">
          {escalations.map((escalation) => (
            <EscalationRow
              actions={actions}
              environmentId={environmentId}
              escalation={escalation}
              key={escalation.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
