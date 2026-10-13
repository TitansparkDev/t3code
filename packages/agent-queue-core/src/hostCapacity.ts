// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * What this machine can carry right now. Admission decisions (start another worker, run
 * another heavy command) are made from measured memory and load, never from a fixed agent
 * count: swapping or an OOM kill costs far more than a short wait.
 *
 * @module hostCapacity
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

export interface HostSnapshot {
  readonly totalMb: number;
  /** Memory the kernel can hand out without swapping (MemAvailable). */
  readonly availableMb: number;
  readonly swapUsedMb: number;
  readonly swapTotalMb: number;
  readonly cpus: number;
  /** One-minute load average. */
  readonly load1: number;
}

const meminfoField = (text: string, key: string): number => {
  const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
  return match ? Math.round(Number(match[1]) / 1024) : 0;
};

export function readHost(): HostSnapshot {
  let text = "";
  try {
    text = NodeFS.readFileSync("/proc/meminfo", "utf8");
  } catch {
    // Not Linux: fall back to what the runtime knows.
  }
  const totalMb = text ? meminfoField(text, "MemTotal") : Math.round(NodeOS.totalmem() / 1048576);
  const availableMb = text
    ? meminfoField(text, "MemAvailable")
    : Math.round(NodeOS.freemem() / 1048576);
  const swapTotalMb = text ? meminfoField(text, "SwapTotal") : 0;
  const swapFreeMb = text ? meminfoField(text, "SwapFree") : 0;
  return {
    totalMb,
    availableMb,
    swapUsedMb: Math.max(swapTotalMb - swapFreeMb, 0),
    swapTotalMb,
    cpus: NodeOS.cpus().length || 1,
    load1: NodeOS.loadavg()[0] ?? 0,
  };
}

/** Memory kept free for the desktop, the T3 server and the agents' own processes. */
export const DEFAULT_RESERVE_MB = 3072;
/** What one running worker (provider process, tools, a first build) is expected to need. */
export const WORKER_FOOTPRINT_MB = 1200;

export interface AdmissionVerdict {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly snapshot: HostSnapshot;
}

/**
 * May another worker start? Waiting for headroom is not a failure: the caller simply starts
 * nothing now and looks again when something finishes. `running` workers are already part of
 * `availableMb`, so only the newcomer's footprint is added.
 */
export function admitWorker(
  options: {
    readonly reserveMb?: number;
    readonly footprintMb?: number;
    readonly snapshot?: HostSnapshot;
    /** How many workers are running; at least one may always run so a loaded host still makes progress. */
    readonly running?: number;
  } = {},
): AdmissionVerdict {
  const snapshot = options.snapshot ?? readHost();
  const reserve = options.reserveMb ?? DEFAULT_RESERVE_MB;
  const footprint = options.footprintMb ?? WORKER_FOOTPRINT_MB;
  if ((options.running ?? 0) === 0) return { ok: true, reason: null, snapshot };
  if (snapshot.availableMb < reserve + footprint) {
    return {
      ok: false,
      reason: `Only ${snapshot.availableMb} MB of memory is free (a new worker needs ${footprint} MB beyond a ${reserve} MB reserve).`,
      snapshot,
    };
  }
  // Heavy swapping with a hot CPU queue: more work now makes everything slower.
  if (snapshot.load1 > snapshot.cpus * 1.5 && snapshot.swapUsedMb > snapshot.swapTotalMb * 0.6) {
    return {
      ok: false,
      reason: `The machine is overloaded (load ${snapshot.load1.toFixed(1)} on ${snapshot.cpus} CPUs, ${snapshot.swapUsedMb} MB swapped).`,
      snapshot,
    };
  }
  return { ok: true, reason: null, snapshot };
}
