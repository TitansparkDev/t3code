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
import * as NodePath from "node:path";

export interface HostSnapshot {
  readonly totalMb: number;
  /** Memory the kernel can hand out without swapping (MemAvailable). */
  readonly availableMb: number;
  /**
   * Headroom left in the shared memory budget (cgroup limits above the caller's own scope), when
   * one applies. Already a hard ceiling, so the host reserve is not subtracted from it again.
   */
  readonly budgetAvailableMb?: number;
  readonly swapUsedMb: number;
  readonly swapTotalMb: number;
  readonly cpus: number;
  /** One-minute load average. */
  readonly load1: number;
  /** Recent memory stalls (PSI avg10, percent) and swap activity, when Linux exposes them. */
  readonly memoryPressure?: number;
  readonly swapPressure?: boolean;
  /** Space an unprivileged process can still write on the disk holding the account's home. */
  readonly diskFreeMb?: number;
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
  let totalMb = text ? meminfoField(text, "MemTotal") : Math.round(NodeOS.totalmem() / 1048576);
  let availableMb = text
    ? meminfoField(text, "MemAvailable")
    : Math.round(NodeOS.freemem() / 1048576);
  const swapTotalMb = text ? meminfoField(text, "SwapTotal") : 0;
  const swapFreeMb = text ? meminfoField(text, "SwapFree") : 0;
  let memoryPressure: number | undefined;
  let swapPressure = false;
  let budgetAvailableMb: number | undefined;
  if (text) {
    try {
      const cgroups = NodeFS.readFileSync("/proc/self/cgroup", "utf8");
      const cgroupPath = /^0::(.+)$/m.exec(cgroups)?.[1];
      if (cgroupPath !== undefined) {
        let path = NodePath.resolve("/sys/fs/cgroup", `.${cgroupPath}`);
        const root = NodePath.resolve("/sys/fs/cgroup");
        const levels: Array<{ name: string; max: string; current: string; stat: string }> = [];
        const readLevel = (file: string) => {
          try {
            return NodeFS.readFileSync(file, "utf8");
          } catch {
            return "";
          }
        };
        while (path === root || path.startsWith(`${root}/`)) {
          levels.push({
            name: NodePath.basename(path),
            max: readLevel(NodePath.join(path, "memory.max")),
            current: readLevel(NodePath.join(path, "memory.current")),
            stat: readLevel(NodePath.join(path, "memory.stat")),
          });
          if (path === root) break;
          path = NodePath.dirname(path);
        }
        const effective = effectiveMemorySnapshot(
          { totalMb, availableMb },
          sharedBudgetLevels(levels),
        );
        totalMb = effective.totalMb;
        budgetAvailableMb = effective.availableMb;
      }
      const psi = NodeFS.readFileSync("/proc/pressure/memory", "utf8");
      const some = /^some .*?avg10=(\d+(?:\.\d+)?)/m.exec(psi);
      if (some) memoryPressure = Number(some[1]);
      // PSI captures reclaim stalls; swap counters catch active paging even before stalls rise.
      const vmstat = NodeFS.readFileSync("/proc/vmstat", "utf8");
      const pages = (key: string) =>
        Number(new RegExp(`^${key}\\s+(\\d+)`, "m").exec(vmstat)?.[1] ?? 0);
      const now = Date.now();
      const counters = { in: pages("pswpin"), out: pages("pswpout"), at: now };
      const previous = previousSwapCounters;
      previousSwapCounters = counters;
      swapPressure =
        previous !== undefined &&
        (counters.in > previous.in || counters.out > previous.out) &&
        now - previous.at <= 30_000;
    } catch {
      // Cgroups, PSI and vmstat are not available on every Linux host/container.
    }
  }
  const diskFreeMb = readDiskFreeMb();
  return {
    totalMb,
    availableMb,
    ...(budgetAvailableMb === undefined ? {} : { budgetAvailableMb }),
    swapUsedMb: Math.max(swapTotalMb - swapFreeMb, 0),
    swapTotalMb,
    cpus: NodeOS.cpus().length || 1,
    load1: NodeOS.loadavg()[0] ?? 0,
    ...(memoryPressure === undefined ? {} : { memoryPressure }),
    swapPressure,
    ...(diskFreeMb === undefined ? {} : { diskFreeMb }),
  };
}

/**
 * Free space on the disk that holds worktrees, caches and build output. Whatever is filling it,
 * work that writes there waits below the reserve instead of taking the disk to 100%.
 */
export function readDiskFreeMb(path?: string): number | undefined {
  try {
    let home = path;
    if (home === undefined) {
      try {
        home = NodeOS.userInfo().homedir;
      } catch {
        home = NodeOS.homedir();
      }
    }
    const stats = NodeFS.statfsSync(home);
    return Math.floor((stats.bavail * stats.bsize) / 1048576);
  } catch {
    return undefined;
  }
}

let previousSwapCounters: { in: number; out: number; at: number } | undefined;

/** Parse cgroup-v2 byte limits; `max`, missing controllers and invalid values are unbounded. */
export function parseCgroupMemoryValue(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const bytes = Number(trimmed);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/**
 * Levels that bound work the broker admits. The caller's own leaf scope (T3 puts each agent
 * session in an 8 GiB `.scope`) is skipped: the kernel already caps the job inside it, and counting
 * it made an 8 GiB compiler demand unadmissible from every agent session.
 */
export function sharedBudgetLevels<Level extends { readonly name: string }>(
  levels: ReadonlyArray<Level>,
): ReadonlyArray<Level> {
  let first = 0;
  while (first < levels.length && levels[first]!.name.endsWith(".scope")) first++;
  return levels.slice(first);
}

/** Usable memory: the host keeps its reserve, a cgroup budget is its own ceiling. */
export function freeMemoryMb(snapshot: HostSnapshot, reserveMb: number): number {
  return Math.min(
    snapshot.availableMb - reserveMb,
    snapshot.budgetAvailableMb ?? Number.POSITIVE_INFINITY,
  );
}

/** Return the effective memory ceiling and headroom across all visible ancestors. */
export function effectiveCgroupMemory(
  levels: ReadonlyArray<{ readonly max: string; readonly current: string; readonly stat?: string }>,
): { readonly limitBytes: number | undefined; readonly availableBytes: number | undefined } {
  let limitBytes: number | undefined;
  let availableBytes: number | undefined;
  for (const level of levels) {
    const max = parseCgroupMemoryValue(level.max);
    const current = parseCgroupMemoryValue(level.current);
    if (max === undefined) continue;
    limitBytes = Math.min(limitBytes ?? max, max);
    if (current !== undefined) {
      // memory.current counts page cache; the kernel reclaims inactive file pages before the
      // limit bites, so they are headroom, not usage (MemAvailable treats them the same way).
      const reclaimable = Number(/^inactive_file (\d+)$/m.exec(level.stat ?? "")?.[1] ?? 0);
      const available = Math.max(max - Math.max(current - reclaimable, 0), 0);
      availableBytes = Math.min(availableBytes ?? available, available);
    }
  }
  return { limitBytes, availableBytes };
}

export function effectiveMemorySnapshot(
  host: { readonly totalMb: number; readonly availableMb: number },
  levels: ReadonlyArray<{ readonly max: string; readonly current: string; readonly stat?: string }>,
): { readonly totalMb: number; readonly availableMb: number } {
  const budget = effectiveCgroupMemory(levels);
  return {
    totalMb:
      budget.limitBytes === undefined
        ? host.totalMb
        : Math.min(host.totalMb, Math.floor(budget.limitBytes / 1048576)),
    availableMb:
      budget.availableBytes === undefined
        ? host.availableMb
        : Math.min(host.availableMb, Math.floor(budget.availableBytes / 1048576)),
  };
}

/** Memory kept free for the desktop, the T3 server and the agents' own processes. */
export const DEFAULT_RESERVE_MB = 3072;
/** Free disk kept for the system, T3's database and running work; new heavy work waits below it. */
export const DEFAULT_DISK_RESERVE_MB = 40 * 1024;
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
    readonly diskReserveMb?: number;
    readonly footprintMb?: number;
    readonly snapshot?: HostSnapshot;
    /** Number of workers already running. */
    readonly running?: number;
  } = {},
): AdmissionVerdict {
  const snapshot = options.snapshot ?? readHost();
  const reserve = options.reserveMb ?? DEFAULT_RESERVE_MB;
  const footprint = options.footprintMb ?? WORKER_FOOTPRINT_MB;
  const free = freeMemoryMb(snapshot, reserve);
  if (free < footprint) {
    return {
      ok: false,
      reason: `Only ${Math.max(Math.round(free), 0)} MB of memory is usable (a new worker needs ${footprint} MB; the host keeps a ${reserve} MB reserve).`,
      snapshot,
    };
  }
  const diskReserve = options.diskReserveMb ?? DEFAULT_DISK_RESERVE_MB;
  if (snapshot.diskFreeMb !== undefined && snapshot.diskFreeMb < diskReserve) {
    return {
      ok: false,
      reason: diskLowReason(snapshot.diskFreeMb, diskReserve),
      snapshot,
    };
  }
  if ((snapshot.memoryPressure ?? 0) >= 10 || snapshot.swapPressure === true) {
    return {
      ok: false,
      reason: `Memory pressure is elevated (PSI ${snapshot.memoryPressure ?? 0}%, active swap I/O ${snapshot.swapPressure === true ? "yes" : "no"}).`,
      snapshot,
    };
  }
  return { ok: true, reason: null, snapshot };
}

export function diskLowReason(freeMb: number, reserveMb: number): string {
  const gb = (mb: number) => `${Math.max(Math.round(mb / 1024), 0)} GB`;
  return `Only ${gb(freeMb)} of disk is free; new work waits until ${gb(reserveMb)} is free so the disk never fills.`;
}
