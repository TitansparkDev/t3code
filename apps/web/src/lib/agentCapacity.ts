import type { HostResourcesSnapshot, ResourceTelemetryProcess } from "@t3tools/contracts";

const GIB = 1024 ** 3;
/** Used until an agent is running and can be measured. */
const ASSUMED_AGENT_BYTES = GIB;
/** Memory kept free for the operating system and the T3 server itself. */
const RESERVED_FRACTION = 0.1;

type ProcessRow = Pick<
  ResourceTelemetryProcess,
  "identity" | "childPids" | "category" | "residentBytes"
>;

/** Memory of each agent: its provider process plus everything that process started. */
export function agentFootprints(processes: ReadonlyArray<ProcessRow>): ReadonlyArray<number> {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const subtreeBytes = (process: ProcessRow, seen: Set<number>): number => {
    if (seen.has(process.identity.pid)) return 0;
    seen.add(process.identity.pid);
    return process.childPids.reduce((total, pid) => {
      const child = byPid.get(pid);
      return child ? total + subtreeBytes(child, seen) : total;
    }, process.residentBytes);
  };
  return processes
    .filter((process) => process.category === "provider-root")
    .map((process) => subtreeBytes(process, new Set()));
}

export interface AgentCapacity {
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly agentCount: number;
  readonly perAgentBytes: number;
  readonly perAgentMeasured: boolean;
  /** How many more agents fit before only the reserve is left. */
  readonly slots: number;
}

export function estimateAgentCapacity(
  host: Pick<HostResourcesSnapshot, "totalMemoryBytes" | "availableMemoryBytes">,
  footprints: ReadonlyArray<number>,
): AgentCapacity {
  const measured = footprints.length > 0;
  const perAgentBytes = measured
    ? Math.max(
        footprints.reduce((total, bytes) => total + bytes, 0) / footprints.length,
        ASSUMED_AGENT_BYTES / 4,
      )
    : ASSUMED_AGENT_BYTES;
  const spare = host.availableMemoryBytes - host.totalMemoryBytes * RESERVED_FRACTION;
  return {
    usedBytes: host.totalMemoryBytes - host.availableMemoryBytes,
    totalBytes: host.totalMemoryBytes,
    agentCount: footprints.length,
    perAgentBytes,
    perAgentMeasured: measured,
    slots: Math.max(0, Math.floor(spare / perAgentBytes)),
  };
}
