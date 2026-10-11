import { GitForkIcon } from "lucide-react";

import type { HandoffQuotaStatus, HandoffTargetOption } from "@t3tools/shared/handoffTargets";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { cn } from "~/lib/utils";

function quotaStatusLabel(option: HandoffTargetOption): string {
  if (option.remainingPercent !== undefined) return `${option.remainingPercent}% remaining`;
  switch (option.quotaStatus) {
    case "stale":
      return "Stale quota";
    case "not-exposed":
      return "Quota not exposed";
    case "no-data":
      return "No quota data yet";
  }
  return "Quota unavailable";
}

function quotaStatusClass(status: HandoffQuotaStatus): string {
  switch (status) {
    case "fresh":
      return "text-success-foreground";
    case "stale":
      return "text-warning-foreground";
    case "not-exposed":
    case "no-data":
      return "text-muted-foreground";
  }
}

export function HandoffTargetDialog(props: {
  readonly open: boolean;
  readonly options: ReadonlyArray<HandoffTargetOption>;
  readonly sourceTitle: string | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (option: HandoffTargetOption) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <GitForkIcon className="size-4" />
              Choose a handoff target
            </span>
          </DialogTitle>
          <DialogDescription>
            {props.sourceTitle
              ? `Choose the quota pool for a new thread from “${props.sourceTitle}”.`
              : "Choose the quota pool for the new thread."}{" "}
            The handoff stays unsent until you send it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.options.length === 0 ? (
            <p className="rounded-lg border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
              No available provider accounts were reported by this server.
            </p>
          ) : (
            <div className="space-y-2" role="listbox" aria-label="Handoff quota pools">
              {props.options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role="option"
                  aria-label={`${option.groupLabel}, ${quotaStatusLabel(option)}, ${option.modelName}`}
                  className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-background p-3 text-left transition-colors hover:border-border hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => props.onSelect(option)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{option.groupLabel}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {option.accountLabel} · {option.modelName}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-xs font-medium tabular-nums",
                      quotaStatusClass(option.quotaStatus),
                    )}
                  >
                    {quotaStatusLabel(option)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
