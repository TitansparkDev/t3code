// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Exclusive access to named shared resources (a GPU, an emulator, a fixed database name,
 * a package install). Two layers: a queue inside this process, so waiters are served in
 * order and never spin, and a lock file in the repository's queue directory, so a second
 * server process (or a restart while the first still runs a check) cannot collide either.
 * A lock file whose owner process is gone, or that was not renewed for `staleMs`, is taken over.
 *
 * @module resourceLocks
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const tails = new Map<string, Promise<void>>();

const STALE_MS = 6 * 3600_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === "EPERM";
  }
}

interface FileLock {
  readonly file: string;
  release: () => void;
}

function readHolder(file: string): { pid?: number; since?: number; raw: string } | null {
  try {
    const raw = NodeFS.readFileSync(file, "utf8");
    try {
      return { ...(JSON.parse(raw) as { pid?: number; since?: number }), raw };
    } catch {
      return { raw };
    }
  } catch {
    return null;
  }
}

const isStale = (holder: { pid?: number; since?: number }) =>
  (typeof holder.pid === "number" && holder.pid !== process.pid && !processAlive(holder.pid)) ||
  (typeof holder.since === "number" && Date.now() - holder.since > STALE_MS) ||
  (holder.pid === undefined && holder.since === undefined);

async function takeFileLock(lockDir: string, name: string, waitMs: number): Promise<FileLock> {
  NodeFS.mkdirSync(lockDir, { recursive: true });
  const file = NodePath.join(lockDir, `${name.replace(/[^\w.-]/g, "_")}.lock`);
  const takeover = `${file}.takeover`;
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const fd = NodeFS.openSync(file, "wx");
      NodeFS.writeSync(fd, JSON.stringify({ pid: process.pid, since: Date.now() }));
      NodeFS.closeSync(fd);
      return {
        file,
        release: () => {
          try {
            NodeFS.unlinkSync(file);
          } catch {
            // Already taken over or removed.
          }
        },
      };
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const holder = readHolder(file);
      if (holder !== null && isStale(holder)) {
        // Only one process at a time may remove a stale lock, and it re-reads the lock while
        // holding the takeover token, so a lock someone else just created is never removed.
        let token: number | null = null;
        try {
          token = NodeFS.openSync(takeover, "wx");
        } catch {
          // Another process is already cleaning up; wait for it.
        }
        if (token !== null) {
          try {
            const again = readHolder(file);
            if (again !== null && again.raw === holder.raw) NodeFS.unlinkSync(file);
          } catch {
            // Gone already.
          } finally {
            NodeFS.closeSync(token);
            try {
              NodeFS.unlinkSync(takeover);
            } catch {
              // Gone already.
            }
          }
          continue;
        }
        // A cleanup token left by a process that died mid-cleanup must not block forever.
        try {
          if (Date.now() - NodeFS.statSync(takeover).mtimeMs > 30_000) NodeFS.unlinkSync(takeover);
        } catch {
          // Gone already.
        }
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the exclusive resource "${name}" (held by another process).`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Runs `body` while holding every named resource, taken in a fixed order so waiters cannot deadlock. */
export async function withResources<A>(
  resources: ReadonlyArray<string>,
  body: () => Promise<A>,
  lockDir?: string,
  waitMs = 3 * 3600_000,
): Promise<A> {
  const names = [...new Set(resources)].sort();
  const releases: Array<() => void> = [];
  try {
    for (const name of names) {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      tails.set(
        name,
        previous.then(() => mine),
      );
      releases.push(release);
      await previous;
      if (lockDir) releases.push((await takeFileLock(lockDir, name, waitMs)).release);
    }
    return await body();
  } finally {
    for (const release of releases.toReversed()) release();
  }
}
