// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Coalescing for repository checks: a type check is a pure function of its inputs, so two identical
 * requests should not run two compilers. The first request claims the check and runs it; a second
 * one waits for the same outcome, and a later one reads the stored receipt. A changed input is a
 * different check and runs fresh.
 *
 * Identity covers the source revision and the content of every uncommitted or untracked change, the
 * lock file and installed checker versions, the environment, the command, and the account. Receipts
 * and claims live in the account's broker home, so another account never reads them. A claim is
 * taken only after the check has been granted its resources: a waiter that holds resources must
 * never wait on a claim whose owner is still queued for them.
 *
 * @module checkReceipts
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { brokerHome, processIsLive, processStartTicks } from "./resourceBroker.ts";

/** Checker packages whose installed versions are part of a check's identity. */
const CHECKERS = ["typescript", "tsc-rs", "@effect/tsgo"] as const;
/** Receipts older than this are removed when another receipt is written. */
const RECEIPT_RETENTION_MS = 7 * 24 * 3600_000;

export interface CheckIdentity {
  readonly key: string;
  readonly checkers: Readonly<Record<string, string | null>>;
}

export interface CheckReceipt {
  readonly key: string;
  readonly command: string;
  /** Only completed runs are kept; a timeout or a lost resource says nothing about the inputs. */
  readonly outcome: "ok" | "failed";
  readonly exitCode: number;
  readonly tail: string;
  readonly elapsedMs: number;
  /** Peak resident memory of the check's process tree, in KiB. */
  readonly peakRssKb: number;
  readonly checkers: Readonly<Record<string, string | null>>;
  readonly finishedAt: number;
}

interface RunningMarker {
  readonly pid: number;
  readonly start: number | null;
}

const sha256 = (value: string | Buffer): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

function git(cwd: string, args: ReadonlyArray<string>): Buffer | null {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    maxBuffer: 1 << 30,
  });
  return result.status === 0 ? result.stdout : null;
}

/** The installed version of a package, found the way Node finds it: the nearest node_modules. */
function installedVersion(cwd: string, name: string): string | null {
  let dir = cwd;
  while (true) {
    try {
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(dir, "node_modules", name, "package.json"), "utf8"),
      ) as { version?: unknown };
      return typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      // not installed here; try the parent directory
    }
    const parent = NodePath.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The identity of running `argv` in `cwd`, or null when the directory is not a git repository with a
 * commit. A null identity is never coalesced or reused: the check just runs.
 */
export function checkIdentity(input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
}): CheckIdentity | null {
  const top = git(input.cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  const root = top.toString().trim();
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const diff = git(root, ["diff", "--binary", "HEAD"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!head || !diff || !untracked) return null;

  // Uncommitted content is part of the source: HEAD alone says nothing about a dirty tree.
  const worktree = NodeCrypto.createHash("sha256").update(diff);
  for (const file of untracked.toString().split("\0")) {
    if (file === "") continue;
    worktree.update(`\0${file}\0`);
    try {
      worktree.update(NodeFS.readFileSync(NodePath.join(root, file)));
    } catch {
      worktree.update("<unreadable>");
    }
  }

  const lockfile = NodeFS.existsSync(NodePath.join(root, "pnpm-lock.yaml"))
    ? sha256(NodeFS.readFileSync(NodePath.join(root, "pnpm-lock.yaml")))
    : null;
  const checkers = Object.fromEntries(
    CHECKERS.map((name) => [name, installedVersion(input.cwd, name)]),
  );
  const key = sha256(
    JSON.stringify({
      account: NodeOS.userInfo().uid,
      argv: input.argv,
      directory: NodePath.relative(root, input.cwd),
      revision: head.toString().trim(),
      worktree: worktree.digest("hex"),
      lockfile,
      checkers,
      node: process.version,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
    }),
  );
  return { key, checkers };
}

function checksDir(home: string): string {
  return NodePath.join(home, "checks");
}

function ensureChecksDir(home: string): string {
  const dir = checksDir(home);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const receiptPath = (key: string, home: string) => NodePath.join(checksDir(home), `${key}.json`);
const markerPath = (key: string, home: string) => NodePath.join(checksDir(home), `${key}.running`);

/** The receipt of a completed check with these exact inputs, if there is one. */
export function readReceipt(key: string, home: string = brokerHome()): CheckReceipt | null {
  try {
    return JSON.parse(NodeFS.readFileSync(receiptPath(key, home), "utf8")) as CheckReceipt;
  } catch {
    return null;
  }
}

function readMarker(key: string, home: string): RunningMarker | null {
  try {
    return JSON.parse(NodeFS.readFileSync(markerPath(key, home), "utf8")) as RunningMarker;
  } catch {
    return null;
  }
}

/**
 * The live process running this check now, or null. A claim left by a process that is gone is
 * removed, so a crashed check never blocks the next one.
 */
export function runningCheck(key: string, home: string = brokerHome()): RunningMarker | null {
  const marker = readMarker(key, home);
  if (!marker) return null;
  if (processIsLive(marker.pid, marker.start)) return marker;
  try {
    NodeFS.rmSync(markerPath(key, home));
  } catch {
    // another waiter removed it first
  }
  return null;
}

/** Claim the right to run this check. Of all processes asking at once, exactly one wins. */
export function claimCheck(key: string, home: string = brokerHome()): boolean {
  ensureChecksDir(home);
  const body = JSON.stringify({
    pid: process.pid,
    start: processStartTicks(process.pid),
  } satisfies RunningMarker);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = NodeFS.openSync(markerPath(key, home), "wx", 0o600);
      NodeFS.writeSync(fd, body);
      NodeFS.closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (runningCheck(key, home)) return false;
    }
  }
  return false;
}

/** Release this process's claim. A claim held by anyone else is left alone. */
export function releaseCheck(key: string, home: string = brokerHome()): void {
  if (readMarker(key, home)?.pid !== process.pid) return;
  try {
    NodeFS.rmSync(markerPath(key, home));
  } catch {
    // already released
  }
}

/** Store the receipt of a completed check, then prune receipts past their retention. */
export function writeReceipt(receipt: CheckReceipt, home: string = brokerHome()): void {
  const dir = ensureChecksDir(home);
  const path = receiptPath(receipt.key, home);
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify(receipt), { mode: 0o600 });
  NodeFS.renameSync(temp, path);
  const cutoff = Date.now() - RECEIPT_RETENTION_MS;
  for (const file of NodeFS.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      if (NodeFS.statSync(NodePath.join(dir, file)).mtimeMs < cutoff)
        NodeFS.rmSync(NodePath.join(dir, file));
    } catch {
      // removed concurrently
    }
  }
}
