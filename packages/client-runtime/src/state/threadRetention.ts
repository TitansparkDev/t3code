export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

export interface ThreadSnapshotRetentionPolicy {
  readonly idleTtlMs: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly persistBoundedCache?: boolean;
}

export const DEFAULT_THREAD_SNAPSHOT_RETENTION: ThreadSnapshotRetentionPolicy = {
  idleTtlMs: THREAD_SNAPSHOT_IDLE_TTL_MS,
};

/** Keeps snapshots in the existing resumable state cache, bounded for mobile's larger detours. */
export function createThreadSnapshotRetention<T>(policy: ThreadSnapshotRetentionPolicy) {
  type Entry = {
    snapshot: T | undefined;
    owner: object | undefined;
    bytes: number;
    touchedAt: number;
  };
  const entries = new Map<string, Entry>();
  const estimateBytes = (snapshot: T) => {
    try {
      const encoded = JSON.stringify(snapshot);
      return encoded === undefined
        ? Number.POSITIVE_INFINITY
        : new TextEncoder().encode(encoded).byteLength;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const forget = (key: string, entry: Entry) => {
    entry.snapshot = undefined;
    entry.bytes = 0;
    if (entry.owner === undefined) entries.delete(key);
  };
  const expireDetached = (now: number) => {
    for (const [key, entry] of entries) {
      if (
        entry.owner === undefined &&
        entry.snapshot !== undefined &&
        now - entry.touchedAt > policy.idleTtlMs
      ) {
        forget(key, entry);
      }
    }
  };
  const enforceDetachedBudget = (now: number) => {
    expireDetached(now);
    const maxEntries = policy.maxEntries ?? Number.POSITIVE_INFINITY;
    const maxBytes = policy.maxBytes ?? Number.POSITIVE_INFINITY;
    const detached = () =>
      [...entries.entries()]
        .filter(([, entry]) => entry.owner === undefined && entry.snapshot !== undefined)
        .sort((a, b) => a[1].touchedAt - b[1].touchedAt);
    let retained = detached();
    let bytes = retained.reduce((total, [, entry]) => total + entry.bytes, 0);
    while (retained.length > maxEntries || bytes > maxBytes) {
      const oldest = retained.shift();
      if (oldest === undefined) break;
      bytes -= oldest[1].bytes;
      forget(oldest[0], oldest[1]);
    }
  };
  const cache = (key: string) => {
    const current =
      entries.get(key) ??
      ({ snapshot: undefined, owner: undefined, bytes: 0, touchedAt: Date.now() } satisfies Entry);
    return {
      get snapshot() {
        if (current.owner === undefined && current.snapshot !== undefined) {
          const now = Date.now();
          if (now - current.touchedAt > policy.idleTtlMs) forget(key, current);
          else current.touchedAt = now;
        }
        return current.snapshot;
      },
      set snapshot(snapshot: T | undefined) {
        current.snapshot = snapshot;
        current.bytes = snapshot === undefined ? 0 : estimateBytes(snapshot);
        current.touchedAt = Date.now();
        if (snapshot === undefined && current.owner === undefined) entries.delete(key);
        else entries.set(key, current);
        enforceDetachedBudget(current.touchedAt);
      },
      get owner() {
        return current.owner;
      },
      set owner(owner: object | undefined) {
        const now = Date.now();
        if (current.owner !== undefined && owner === undefined && current.snapshot !== undefined) {
          current.touchedAt = now;
        } else if (current.owner === undefined && current.snapshot !== undefined) {
          if (now - current.touchedAt > policy.idleTtlMs) forget(key, current);
          else current.touchedAt = now;
        }
        current.owner = owner;
        if (current.snapshot !== undefined || owner !== undefined) entries.set(key, current);
        else entries.delete(key);
        enforceDetachedBudget(now);
      },
    };
  };
  const clearEnvironment = (environmentId: string) => {
    const prefix = `${environmentId}\u0000`;
    for (const [key, entry] of entries) {
      if (key.startsWith(prefix)) {
        entry.snapshot = undefined;
        entry.owner = undefined;
        entries.delete(key);
      }
    }
  };
  const clear = () => {
    for (const entry of entries.values()) {
      entry.snapshot = undefined;
      entry.owner = undefined;
    }
    entries.clear();
  };
  return { cache, clear, clearEnvironment, policy };
}
