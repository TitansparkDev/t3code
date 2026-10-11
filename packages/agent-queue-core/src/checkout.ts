// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Looking at, preserving and (only when safe) reconciling someone's working checkout.
 *
 * AgentQueue integrates into its own branch, so a dirty checkout never blocks task
 * progress. This module is only used when the finished plan is published to the branch a
 * checkout has open. Nothing here ever resets, stashes or cleans a checkout: edits are
 * first copied byte for byte into a durable snapshot that can put the checkout back exactly
 * as it was, and only the few files the publication changes are touched afterwards.
 *
 * @module checkout
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function run(
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly env?: NodeJS.ProcessEnv; readonly input?: string } = {},
): { readonly code: number; readonly stdout: string; readonly stderr: string } {
  const result = NodeChildProcess.spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    ...(options.input !== undefined ? { input: options.input } : {}),
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export interface DirtyEntry {
  readonly path: string;
  /** Two-letter porcelain status: first column index, second column working tree. */
  readonly status: string;
  readonly staged: boolean;
  readonly untracked: boolean;
}

/** Every uncommitted entry (modified, staged, deleted, untracked) of a checkout. */
export function listDirty(checkout: string): DirtyEntry[] {
  const out = run(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const entries = out.split("\0").filter(Boolean);
  const dirty: DirtyEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    dirty.push({
      path: entry.slice(3),
      status,
      staged: status[0] !== " " && status[0] !== "?",
      untracked: status === "??",
    });
    // A rename or copy lists the old path as a second entry.
    if (status[0] === "R" || status[0] === "C") index++;
  }
  return dirty;
}

/** A merge, rebase, cherry-pick, revert or bisect in progress, or a Git lock held. */
export function unfinishedOperation(checkout: string): string | null {
  const gitDir = run(checkout, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  if (!gitDir) return "not a Git checkout";
  for (const marker of [
    "MERGE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "index.lock",
  ]) {
    if (NodeFS.existsSync(NodePath.join(gitDir, marker))) return marker;
  }
  return null;
}

export interface ActiveProcess {
  readonly pid: number;
  readonly command: string;
}

/**
 * Processes (other than this one) whose working directory is inside the checkout itself,
 * not inside one of its linked worktrees under `.worktrees/`. A shell, editor or agent
 * sitting in a checkout owns it as far as we are concerned. Returns null where the
 * operating system cannot tell, which callers must treat as "someone may be there".
 */
export function activeProcessesIn(checkout: string): ReadonlyArray<ActiveProcess> | null {
  if (NodeOS.type() !== "Linux") return null;
  const root = NodeFS.realpathSync(checkout);
  const nested = NodePath.join(root, ".worktrees") + NodePath.sep;
  const found: ActiveProcess[] = [];
  let pids: string[];
  try {
    pids = NodeFS.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return null;
  }
  for (const name of pids) {
    const pid = Number(name);
    if (pid === process.pid) continue;
    let cwd: string;
    try {
      cwd = NodeFS.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (cwd !== root && !cwd.startsWith(root + NodePath.sep)) continue;
    if (cwd.startsWith(nested)) continue;
    let command = "";
    try {
      command = NodeFS.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      // The process ended while we looked.
    }
    found.push({ pid, command });
  }
  return found;
}

export interface CheckoutAnalysis {
  readonly holder: string;
  readonly dirty: ReadonlyArray<DirtyEntry>;
  /** Dirty entries for files the incoming change also touches. */
  readonly overlap: ReadonlyArray<DirtyEntry>;
  readonly unrelated: ReadonlyArray<DirtyEntry>;
  readonly unfinished: string | null;
  readonly activeProcesses: ReadonlyArray<ActiveProcess> | null;
  /** Milliseconds since the newest overlapping file was written (Infinity when none). */
  readonly overlapIdleMs: number;
}

/** What the checkout looks like relative to a change about to land on its branch. */
export function analyzeCheckout(holder: string, incoming: ReadonlySet<string>): CheckoutAnalysis {
  const dirty = listDirty(holder);
  const overlaps = (entry: DirtyEntry) =>
    incoming.has(entry.path) ||
    (entry.path.endsWith("/") && [...incoming].some((file) => file.startsWith(entry.path)));
  const overlap = dirty.filter(overlaps);
  let newest = 0;
  for (const entry of overlap) {
    try {
      newest = Math.max(newest, NodeFS.statSync(NodePath.join(holder, entry.path)).mtimeMs);
    } catch {
      // A deleted file has no write time; it does not make the checkout look active.
    }
  }
  return {
    holder,
    dirty,
    overlap,
    unrelated: dirty.filter((entry) => !overlaps(entry)),
    unfinished: unfinishedOperation(holder),
    activeProcesses: activeProcessesIn(holder),
    overlapIdleMs:
      overlap.length === 0 || newest === 0 ? Number.POSITIVE_INFINITY : Date.now() - newest,
  };
}

export interface SnapshotManifest {
  readonly id: string;
  readonly createdAt: string;
  readonly checkout: string;
  readonly headOid: string;
  readonly branch: string | null;
  /** Commit holding the whole dirty state (tracked and untracked), under refs/agentqueue/snapshots. */
  readonly ref: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly status: string;
    /** Absent for a file that was deleted in the working tree. */
    readonly sha256?: string;
    readonly mode?: number;
  }>;
}

const snapshotRoot = (gitCommonDir: string) =>
  NodePath.join(gitCommonDir, "agentqueue", "snapshots");

const sha256 = (data: Buffer) => NodeCrypto.createHash("sha256").update(data).digest("hex");

/**
 * Copy a checkout's uncommitted state somewhere durable without touching it: every dirty
 * file's bytes, the Git index file, a manifest, and a commit (built in a private index)
 * that holds the full working state. Verified before it returns; throws if anything about
 * the copy cannot be confirmed, so callers never proceed on a snapshot they cannot trust.
 */
export function snapshotCheckout(checkout: string, gitCommonDir: string): SnapshotManifest {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${NodeCrypto.randomBytes(3).toString("hex")}`;
  const dir = NodePath.join(snapshotRoot(gitCommonDir), id);
  const filesDir = NodePath.join(dir, "files");
  NodeFS.mkdirSync(filesDir, { recursive: true });

  const headOid = run(checkout, ["rev-parse", "HEAD"]).stdout.trim();
  const branch = run(checkout, ["branch", "--show-current"]).stdout.trim() || null;
  const dirty = listDirty(checkout);

  const files: Array<SnapshotManifest["files"][number]> = [];
  for (const entry of dirty) {
    if (entry.path.endsWith("/")) continue;
    const source = NodePath.join(checkout, entry.path);
    if (!NodeFS.existsSync(source)) {
      files.push({ path: entry.path, status: entry.status });
      continue;
    }
    const stat = NodeFS.lstatSync(source);
    if (!stat.isFile()) {
      // A symlink or directory entry: record it, and copy a symlink's target text.
      if (stat.isSymbolicLink()) {
        const target = NodeFS.readlinkSync(source);
        const copy = NodePath.join(filesDir, entry.path);
        NodeFS.mkdirSync(NodePath.dirname(copy), { recursive: true });
        NodeFS.writeFileSync(copy, target);
        files.push({ path: entry.path, status: entry.status, sha256: sha256(Buffer.from(target)) });
      }
      continue;
    }
    const data = NodeFS.readFileSync(source);
    const copy = NodePath.join(filesDir, entry.path);
    NodeFS.mkdirSync(NodePath.dirname(copy), { recursive: true });
    NodeFS.writeFileSync(copy, data);
    files.push({ path: entry.path, status: entry.status, sha256: sha256(data), mode: stat.mode });
  }

  const indexPath = run(checkout, ["rev-parse", "--git-path", "index"]).stdout.trim();
  const absoluteIndex = NodePath.isAbsolute(indexPath)
    ? indexPath
    : NodePath.join(checkout, indexPath);
  if (NodeFS.existsSync(absoluteIndex))
    NodeFS.copyFileSync(absoluteIndex, NodePath.join(dir, "index"));

  // A commit with the whole working state, built in a private index so the real one is untouched.
  const privateIndex = NodePath.join(NodeOS.tmpdir(), `aq-snapshot-index-${id}`);
  const env = { ...process.env, GIT_INDEX_FILE: privateIndex };
  let ref = "";
  try {
    run(checkout, ["read-tree", "HEAD"], { env });
    run(checkout, ["add", "-A"], { env });
    const tree = run(checkout, ["write-tree"], { env }).stdout.trim();
    const commit = run(
      checkout,
      [
        "-c",
        "user.name=AgentQueue",
        "-c",
        "user.email=agentqueue@localhost",
        "commit-tree",
        tree,
        "-p",
        headOid,
        "-m",
        `AgentQueue snapshot ${id}`,
      ],
      { env },
    ).stdout.trim();
    if (!commit) throw new Error("could not create the snapshot commit");
    ref = `refs/agentqueue/snapshots/${id}`;
    if (run(checkout, ["update-ref", ref, commit]).code !== 0) {
      throw new Error("could not record the snapshot reference");
    }
  } finally {
    try {
      NodeFS.unlinkSync(privateIndex);
    } catch {
      // Already gone.
    }
  }

  const manifest: SnapshotManifest = {
    id,
    createdAt: new Date().toISOString(),
    checkout,
    headOid,
    branch,
    ref,
    files,
  };
  NodeFS.writeFileSync(NodePath.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Verify before anyone relies on it.
  for (const file of files) {
    if (file.sha256 === undefined) continue;
    const copy = NodeFS.readFileSync(NodePath.join(filesDir, file.path));
    if (sha256(copy) !== file.sha256)
      throw new Error(`snapshot copy of ${file.path} does not match`);
  }
  if (run(checkout, ["cat-file", "-e", `${ref}^{commit}`]).code !== 0) {
    throw new Error("snapshot commit is not readable");
  }
  return manifest;
}

export function readSnapshot(gitCommonDir: string, id: string): SnapshotManifest {
  return JSON.parse(
    NodeFS.readFileSync(NodePath.join(snapshotRoot(gitCommonDir), id, "manifest.json"), "utf8"),
  ) as SnapshotManifest;
}

/**
 * Put a checkout's uncommitted state back exactly as the snapshot recorded it: the saved
 * bytes of every dirty file (and removal of files that were deleted), then the saved index.
 * Meant for when the checkout is still at the snapshot's commit; refuses otherwise.
 */
export function restoreSnapshot(gitCommonDir: string, id: string, checkout?: string): void {
  const manifest = readSnapshot(gitCommonDir, id);
  const target = checkout ?? manifest.checkout;
  const head = run(target, ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== manifest.headOid) {
    throw new Error(
      `The checkout is at ${head.slice(0, 9)}, not ${manifest.headOid.slice(0, 9)} where the snapshot was taken; restore it by hand from ${manifest.ref}.`,
    );
  }
  const filesDir = NodePath.join(snapshotRoot(gitCommonDir), id, "files");
  for (const file of manifest.files) {
    const destination = NodePath.join(target, file.path);
    if (file.sha256 === undefined) {
      try {
        NodeFS.unlinkSync(destination);
      } catch {
        // Already absent.
      }
      continue;
    }
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
    NodeFS.writeFileSync(destination, NodeFS.readFileSync(NodePath.join(filesDir, file.path)));
    if (file.mode !== undefined) NodeFS.chmodSync(destination, file.mode & 0o777);
  }
  const savedIndex = NodePath.join(snapshotRoot(gitCommonDir), id, "index");
  if (NodeFS.existsSync(savedIndex)) {
    const indexPath = run(target, ["rev-parse", "--git-path", "index"]).stdout.trim();
    NodeFS.copyFileSync(
      savedIndex,
      NodePath.isAbsolute(indexPath) ? indexPath : NodePath.join(target, indexPath),
    );
  }
}

export type ReconcilePlan =
  | {
      readonly ok: true;
      /** Files whose uncommitted edits must be re-applied on top of the new commit. */
      readonly reapply: ReadonlyArray<{ readonly path: string; readonly merged: Buffer }>;
      /** Untracked files whose content the new commit already contains. */
      readonly redundant: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Work out, without touching the checkout, how each overlapping uncommitted edit would
 * sit on top of the new commit: a clean three-way merge keeps the edit, a file whose
 * content already equals the new one needs nothing, and anything else is a refusal.
 */
export function planReconcile(
  holder: string,
  baseOid: string,
  newOid: string,
  overlap: ReadonlyArray<DirtyEntry>,
): ReconcilePlan {
  const reapply: Array<{ path: string; merged: Buffer }> = [];
  const redundant: string[] = [];
  const blob = (oid: string, path: string): Buffer | null => {
    const result = NodeChildProcess.spawnSync("git", ["cat-file", "blob", `${oid}:${path}`], {
      cwd: holder,
      maxBuffer: 256 * 1024 * 1024,
    });
    return result.status === 0 ? (result.stdout as Buffer) : null;
  };
  for (const entry of overlap) {
    if (entry.staged) return { ok: false, reason: `${entry.path} has staged changes.` };
    const abs = NodePath.join(holder, entry.path);
    if (entry.path.endsWith("/"))
      return { ok: false, reason: `${entry.path} is an untracked folder.` };
    const theirs = NodeFS.existsSync(abs) ? NodeFS.readFileSync(abs) : null;
    const next = blob(newOid, entry.path);
    if (entry.untracked) {
      if (theirs && next && theirs.equals(next)) redundant.push(entry.path);
      else
        return { ok: false, reason: `Untracked ${entry.path} differs from the file being added.` };
      continue;
    }
    const base = blob(baseOid, entry.path);
    if (theirs === null || base === null || next === null) {
      return { ok: false, reason: `${entry.path} was deleted or added on one side.` };
    }
    if (theirs.equals(next)) {
      // The uncommitted edit already is the new content: nothing to keep.
      reapply.push({ path: entry.path, merged: next });
      continue;
    }
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-merge-"));
    try {
      NodeFS.writeFileSync(NodePath.join(tmp, "ours"), theirs);
      NodeFS.writeFileSync(NodePath.join(tmp, "base"), base);
      NodeFS.writeFileSync(NodePath.join(tmp, "theirs"), next);
      // Their edit is "ours" here: base -> their edit is kept, base -> new commit is merged in.
      const merged = NodeChildProcess.spawnSync(
        "git",
        [
          "merge-file",
          "-p",
          NodePath.join(tmp, "ours"),
          NodePath.join(tmp, "base"),
          NodePath.join(tmp, "theirs"),
        ],
        { maxBuffer: 256 * 1024 * 1024 },
      );
      if (merged.status !== 0) {
        return {
          ok: false,
          reason: `The uncommitted edit to ${entry.path} conflicts with the new change.`,
        };
      }
      reapply.push({ path: entry.path, merged: merged.stdout as Buffer });
    } finally {
      NodeFS.rmSync(tmp, { recursive: true, force: true });
    }
  }
  return { ok: true, reapply, redundant };
}
