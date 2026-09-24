import { isQuotaSnapshotStale, type AccountQuotaSnapshot } from "@t3tools/contracts/quota";
import { memo } from "react";

import { cn } from "../../lib/utils";
import {
  formatQuotaAge,
  formatQuotaReset,
  quotaRemainingPercent,
  quotaWindowLabel,
} from "./quotaFormat";

export const QuotaAccountDetails = memo(function QuotaAccountDetails({
  snapshot,
  nowMs,
}: {
  snapshot: AccountQuotaSnapshot;
  nowMs: number;
}) {
  const stale = isQuotaSnapshotStale(snapshot, nowMs);

  return (
    <div className="w-64 space-y-2.5 p-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">Subscription limits</span>
        <span className={cn("text-muted-foreground", stale && "text-warning-foreground")}>
          {stale ? `Stale · ${formatQuotaAge(snapshot.observedAt, nowMs)}` : "Live"}
        </span>
      </div>

      {snapshot.groups.map((group) => (
        <div className="space-y-1.5" key={group.key}>
          {snapshot.groups.length > 1 ? (
            <div className="text-[11px] font-medium text-muted-foreground">{group.displayName}</div>
          ) : null}
          {group.windows.length === 0 ? (
            <div className="text-xs text-muted-foreground">Usage figures not exposed</div>
          ) : (
            group.windows.map((window) => {
              const remaining = quotaRemainingPercent(window.usedPercent);
              return (
                <div className="space-y-1" key={`${window.kind}:${window.label ?? ""}`}>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span>{quotaWindowLabel(window)}</span>
                    <span className="tabular-nums font-medium">{remaining}% left</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        remaining <= 10
                          ? "bg-destructive"
                          : remaining <= 30
                            ? "bg-warning"
                            : "bg-foreground/55",
                      )}
                      style={{ width: `${remaining}%` }}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {formatQuotaReset(window.resetsAt, nowMs)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ))}

      <div className="border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
        {snapshot.source === "provider-event"
          ? "Reported by the provider"
          : snapshot.source === "state-file"
            ? "Recovered from provider state"
            : snapshot.source === "antigravity-quota-summary"
              ? "Structured quota summary"
              : snapshot.source === "antigravity-model-fallback"
                ? "Estimated from per-model limits"
                : "Detected from a limit signal"}
        {snapshot.planType ? ` · ${snapshot.planType}` : ""}
      </div>
    </div>
  );
});
