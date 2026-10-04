import { useEffect, useMemo } from "react";

import { agentFootprints, estimateAgentCapacity } from "../../lib/agentCapacity";
import { cn } from "../../lib/utils";
import { useResourceTelemetry } from "../../lib/resourceTelemetryState";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const REFRESH_MS = 10_000;
const GIB = 1024 ** 3;
const gb = (bytes: number) => (bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1);

/**
 * Memory in use on the machine running the server, how many agents it runs,
 * and how many more fit. Polls slowly and only while the window is visible.
 */
export function HostCapacityChip() {
  const environment = usePrimaryEnvironment();
  const environmentId = environment?.environmentId ?? null;
  const host = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hostResources({ environmentId, input: {} }),
  );
  const telemetry = useResourceTelemetry(environmentId);
  const refreshHost = host.refresh;
  const refreshTelemetry = telemetry.refresh;

  useEffect(() => {
    if (environmentId === null) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refreshHost();
      refreshTelemetry();
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [environmentId, refreshHost, refreshTelemetry]);

  const capacity = useMemo(
    () =>
      host.data
        ? estimateAgentCapacity(host.data, agentFootprints(telemetry.data?.processes ?? []))
        : null,
    [host.data, telemetry.data],
  );
  if (!capacity) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "relative z-10 ml-2 hidden shrink-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] tabular-nums md:inline-flex",
              capacity.slots <= 1 ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {gb(capacity.usedBytes)}/{gb(capacity.totalBytes)} GB · {capacity.agentCount} agent
            {capacity.agentCount === 1 ? "" : "s"} · {capacity.slots} free
          </span>
        }
      />
      <TooltipPopup side="bottom">
        {environment?.label}: {gb(capacity.usedBytes)} of {gb(capacity.totalBytes)} GB used.{" "}
        {capacity.perAgentMeasured ? "Each agent averages" : "Assuming"}{" "}
        {gb(capacity.perAgentBytes)} GB, so about {capacity.slots} more fit with 10% kept free.
      </TooltipPopup>
    </Tooltip>
  );
}
