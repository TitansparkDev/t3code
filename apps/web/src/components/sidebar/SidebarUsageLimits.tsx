import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitAccounts,
  collectLimitPools,
  describeLimitFreshness,
  displayLimitWindows,
  type LimitPool,
} from "@t3tools/shared/usageLimits";
import { memo } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { barColor } from "../usage/UsageLimits";

// Session and weekly windows are the ones people pace work against; spend and model extras stay on the Usage page.
function sidebarWindows(pool: LimitPool) {
  const windows = displayLimitWindows(pool);
  const paced = windows.filter((window) => window.kind === "session" || window.kind === "weekly");
  return paced.length > 0 ? paced : windows;
}

export const SidebarUsageLimits = memo(function SidebarUsageLimits({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const now = Date.parse(`${useNowMinute()}:00.000Z`);
  const accounts = collectLimitAccounts(presentations);
  const pools = collectLimitPools(accounts, now);
  if (pools.length === 0) return null;
  const stale = accounts.some((account) => {
    const freshness = describeLimitFreshness(account.limits, now);
    return freshness.stale || freshness.refreshFailed;
  });

  return (
    <button
      aria-label="Open usage limits"
      className="mb-1 flex w-full min-w-0 flex-col gap-1.5 rounded-lg border border-border/65 px-2 py-1.5 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      data-testid="sidebar-usage-limits"
      onClick={onOpen}
      type="button"
    >
      <span className="flex items-center justify-between text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        <span>Limits left</span>
        {stale ? <span className="normal-case tracking-normal">may be out of date</span> : null}
      </span>
      {pools.map((pool) => {
        const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
        const color = barColor(pool.driver);
        return (
          <span className="flex min-w-0 flex-col gap-0.5" key={pool.driver}>
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
              <ProviderInstanceIcon
                driverKind={pool.driver}
                displayName={label}
                indicatorBackground="var(--sidebar)"
                className="size-3.5"
                iconClassName="size-3 text-foreground/80"
              />
              <span className="truncate">{label}</span>
              {pool.accounts.length > 1 ? (
                <span className="text-2xs text-muted-foreground">
                  {pool.accounts.length} accounts
                </span>
              ) : null}
            </span>
            {sidebarWindows(pool).map((window) => (
              <span
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_3.5rem_2.25rem] items-center gap-1.5 pl-5 text-2xs"
                key={`${window.kind}:${window.id}`}
              >
                <span className="truncate text-muted-foreground">{window.label}</span>
                <span className="h-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${window.remainingPercent}%`, backgroundColor: color }}
                  />
                </span>
                <span
                  className={cn(
                    "text-right tabular-nums",
                    window.remainingPercent <= 10
                      ? "text-destructive-foreground"
                      : "text-foreground",
                  )}
                >
                  {window.remainingPercent}%
                </span>
              </span>
            ))}
          </span>
        );
      })}
    </button>
  );
});
