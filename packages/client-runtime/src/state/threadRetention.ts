export const THREAD_SNAPSHOT_IDLE_TTL_MS = 5 * 60_000;

export interface ThreadSnapshotRetentionPolicy {
  readonly idleTtlMs: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
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
  const caches = new Map<string, { snapshot: T | undefined; owner: object | undefined }>();
  const estimateBytes = (snapshot: T) => {
    try {
      return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    } catch {
      return 0;
    }
  };
  const cache = (key: string) => {
    let entry = entries.get(key);
    if (entry === undefined) {
      entry = { snapshot: undefined, owner: undefined, bytes: 0, touchedAt: Date.now() };
      entries.set(key, entry);
    }
    const current = entry;
    let result = caches.get(key);
    if (result === undefined) {
      result = {
        get snapshot() {
          if (Date.now() - current.touchedAt > policy.idleTtlMs) {
            current.snapshot = undefined;
            current.bytes = 0;
            entries.delete(key);
          }
          return current.snapshot;
        },
        set snapshot(snapshot: T | undefined) {
          entries.set(key, current);
          current.snapshot = snapshot;
          current.bytes = snapshot === undefined ? 0 : estimateBytes(snapshot);
          current.touchedAt = Date.now();
          if (snapshot !== undefined) {
            const maxEntries = policy.maxEntries ?? Number.POSITIVE_INFINITY;
            const maxBytes = policy.maxBytes ?? Number.POSITIVE_INFINITY;
            while (entries.size > maxEntries || totalBytes() > maxBytes) {
              const oldest = [...entries.entries()]
                .filter(([candidate]) => candidate !== key)
                .sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
              if (oldest === undefined) break;
              oldest[1].snapshot = undefined;
              oldest[1].bytes = 0;
              entries.delete(oldest[0]);
            }
          }
        },
        get owner() {
          return current.owner;
        },
        set owner(owner: object | undefined) {
          current.owner = owner;
        },
      };
      caches.set(key, result);
    }
    return result;
  };
  const totalBytes = () => {
    let bytes = 0;
    for (const entry of entries.values()) bytes += entry.bytes;
    return bytes;
  };
  const clearEnvironment = (environmentId: string) => {
    const prefix = `${environmentId}\u0000`;
    for (const [key, retained] of caches) {
      if (key.startsWith(prefix)) {
        retained.snapshot = undefined;
        retained.owner = undefined;
      }
    }
    for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    for (const key of caches.keys()) if (key.startsWith(prefix)) caches.delete(key);
  };
  const clear = () => {
    for (const retained of caches.values()) {
      retained.snapshot = undefined;
      retained.owner = undefined;
    }
    entries.clear();
    caches.clear();
  };
  return { cache, clear, clearEnvironment, policy };
}
