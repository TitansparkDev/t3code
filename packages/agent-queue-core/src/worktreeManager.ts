// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DEFAULT_BRANCH_PREFIX } from "./contract.ts";

export interface ProvisionWorktreeResult {
  readonly worktreePath: string;
  readonly branch: string;
}

export interface RebaseResult {
  readonly success: boolean;
  readonly conflictFiles?: ReadonlyArray<string>;
}

function execGit(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: (err.stdout?.toString() ?? "").trim(),
      stderr: (err.stderr?.toString() ?? err.message ?? "").trim(),
    };
  }
}

/**
 * Sanitizes task ID and title into a legal git branch name.
 */
export function sanitizeBranchName(
  taskId: string,
  title?: string,
  prefix = DEFAULT_BRANCH_PREFIX,
): string {
  const sanitizedTask = taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!title) return `${prefix}${sanitizedTask}`;

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/^-+|-+$/g, "");

  return slug ? `${prefix}${sanitizedTask}-${slug}` : `${prefix}${sanitizedTask}`;
}

/** Where a task's worktree and branch live. Deterministic, so a retry finds earlier work. */
export function planWorktree(
  repoRoot: string,
  taskId: string,
  title?: string,
  prefix = DEFAULT_BRANCH_PREFIX,
): ProvisionWorktreeResult {
  return {
    worktreePath: NodePath.join(repoRoot, ".worktrees", "agentqueue", taskId),
    branch: sanitizeBranchName(taskId, title, prefix),
  };
}

/**
 * Keeps the worktree folder, and files the agents' tooling drops into worktrees, out of
 * `git status` without touching tracked files (the repository-wide exclude file is shared by
 * every worktree, so `git add -A` in a task's worktree never commits them either).
 */
function ensureExcluded(repoRoot: string, extra: ReadonlyArray<string>): void {
  const common = execGit(["rev-parse", "--git-common-dir"], repoRoot);
  if (common.code !== 0) return;
  const excludeFile = NodePath.join(NodePath.resolve(repoRoot, common.stdout), "info", "exclude");
  try {
    const current = NodeFS.existsSync(excludeFile) ? NodeFS.readFileSync(excludeFile, "utf8") : "";
    const lines = new Set(current.split(/\r?\n/));
    const missing = ["/.worktrees/", ...extra].filter((pattern) => !lines.has(pattern));
    if (missing.length === 0) return;
    NodeFS.mkdirSync(NodePath.dirname(excludeFile), { recursive: true });
    NodeFS.appendFileSync(
      excludeFile,
      `${current.endsWith("\n") || !current ? "" : "\n"}${missing.join("\n")}\n`,
    );
  } catch {
    // The exclude file is a convenience; provisioning works without it.
  }
}

function registeredWorktrees(repoRoot: string): Map<string, string | null> {
  const listing = execGit(["worktree", "list", "--porcelain"], repoRoot);
  const result = new Map<string, string | null>();
  let path: string | null = null;
  for (const line of listing.stdout.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && path)
      result.set(path, line.slice("branch refs/heads/".length));
    else if (line === "detached" && path) result.set(path, null);
  }
  return result;
}

/**
 * Provisions an isolated git worktree for a task. Never discards earlier work: if the
 * task's worktree is already there it is reused as it is, and if only its branch is left
 * the branch is checked out again, so a retry resumes from the previous worker's commits.
 */
export async function provisionWorktree(
  repoRoot: string,
  taskId: string,
  baseRef = "HEAD",
  title?: string,
  options: {
    readonly prefix?: string;
    readonly branch?: string;
    /** Tooling files to keep out of commits (see the repository contract). */
    readonly ignore?: ReadonlyArray<string>;
  } = {},
): Promise<ProvisionWorktreeResult> {
  const planned = planWorktree(repoRoot, taskId, title, options.prefix);
  const worktreePath = planned.worktreePath;
  // A branch that already holds this task's earlier work keeps its name.
  const branch = options.branch ?? planned.branch;
  NodeFS.mkdirSync(NodePath.dirname(worktreePath), { recursive: true });
  ensureExcluded(repoRoot, options.ignore ?? []);
  execGit(["worktree", "prune"], repoRoot);

  const registered = registeredWorktrees(repoRoot);
  const realPath = NodeFS.existsSync(worktreePath)
    ? NodeFS.realpathSync(worktreePath)
    : worktreePath;
  const existingBranch = registered.get(realPath) ?? registered.get(worktreePath);
  if (existingBranch !== undefined && NodeFS.existsSync(worktreePath)) {
    if (existingBranch === null) {
      throw new Error(
        `Worktree ${worktreePath} is on a detached HEAD; resolve it before retrying.`,
      );
    }
    return { worktreePath, branch: existingBranch };
  }

  if (NodeFS.existsSync(worktreePath)) {
    // A folder git does not know about may hold a crashed worker's files: move it aside.
    NodeFS.renameSync(worktreePath, `${worktreePath}.orphan-${Date.now()}`);
  }

  const branchExists = execGit(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    repoRoot,
  );
  const addRes =
    branchExists.code === 0
      ? execGit(["worktree", "add", worktreePath, branch], repoRoot)
      : execGit(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
  if (addRes.code !== 0) {
    throw new Error(`Failed to provision worktree at ${worktreePath}: ${addRes.stderr}`);
  }

  return { worktreePath, branch };
}

/**
 * A worktree made before the plan's branch moved (a held task, a task handed back) holds
 * nothing of its own; bring it to the current base so it sees fixes and finished predecessors.
 * A branch with its own commits, or any uncommitted change, is never touched.
 */
export function refreshUnworkedWorktree(worktreePath: string, baseRef: string): boolean {
  if (execGit(["status", "--porcelain"], worktreePath).stdout !== "") return false;
  const base = execGit(["rev-parse", "--verify", "--quiet", `refs/heads/${baseRef}`], worktreePath);
  if (base.code !== 0) return false;
  if (execGit(["rev-parse", "HEAD"], worktreePath).stdout === base.stdout) return false;
  if (execGit(["merge-base", "--is-ancestor", "HEAD", base.stdout], worktreePath).code !== 0)
    return false;
  return execGit(["merge", "--ff-only", base.stdout], worktreePath).code === 0;
}

/** Renames a task branch in place, keeping every commit; the worktree that has it checked out follows. */
export function renameBranch(repoRoot: string, from: string, to: string): boolean {
  if (from === to) return true;
  if (execGit(["rev-parse", "--verify", "--quiet", `refs/heads/${to}`], repoRoot).code === 0)
    return false;
  return execGit(["branch", "-m", from, to], repoRoot).code === 0;
}

/** Whether a local branch exists. */
export function branchExists(repoRoot: string, branch: string): boolean {
  return execGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot).code === 0;
}

/**
 * Makes the worktree's branch contain a candidate commit that must be repaired. Work already
 * on the branch is never dropped: if the branch cannot simply move forward to the candidate, its
 * old tip is kept on a salvage branch first. Returns the branch tip afterwards, or an error.
 */
export function alignToCandidate(
  worktreePath: string,
  repoRoot: string,
  branch: string,
  candidate: string,
): { readonly ok: boolean; readonly detail: string } {
  if (execGit(["cat-file", "-e", `${candidate}^{commit}`], repoRoot).code !== 0) {
    return { ok: false, detail: `candidate commit ${candidate.slice(0, 9)} no longer exists` };
  }
  commitPendingChanges(worktreePath, "AgentQueue: keep edits left in the repair worktree");
  const head = execGit(["rev-parse", "HEAD"], worktreePath).stdout;
  if (execGit(["merge-base", "--is-ancestor", candidate, "HEAD"], worktreePath).code === 0) {
    return { ok: true, detail: "branch already contains the candidate" };
  }
  if (execGit(["merge-base", "--is-ancestor", "HEAD", candidate], worktreePath).code === 0) {
    const moved = execGit(["merge", "--ff-only", candidate], worktreePath);
    return moved.code === 0
      ? { ok: true, detail: "branch moved forward to the candidate" }
      : { ok: false, detail: moved.stderr };
  }
  const keep = `salvage/${NodePath.basename(branch)}-${Date.now()}`;
  execGit(["branch", keep, head], repoRoot);
  const reset = execGit(["reset", "--hard", candidate], worktreePath);
  return reset.code === 0
    ? { ok: true, detail: `branch reset to the candidate; previous tip kept on ${keep}` }
    : { ok: false, detail: reset.stderr };
}

/** Commits anything a worker left uncommitted so it is part of the branch that is verified. */
export function commitPendingChanges(worktreePath: string, message: string): boolean {
  // A merge the server started for the owner and that still has unresolved files is not "work left
  // behind": committing it would make conflict markers part of the branch.
  if (
    execGit(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktreePath).code === 0 &&
    execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath).stdout.length > 0
  ) {
    return false;
  }
  const status = execGit(["status", "--porcelain"], worktreePath);
  if (status.code !== 0 || status.stdout.length === 0) return false;
  if (execGit(["add", "-A"], worktreePath).code !== 0) return false;
  return (
    execGit(
      [
        "-c",
        "user.name=AgentQueue",
        "-c",
        "user.email=agentqueue@localhost",
        "commit",
        "-m",
        message,
      ],
      worktreePath,
    ).code === 0
  );
}

/**
 * Rebases the task worktree onto the latest base branch.
 */
export async function rebaseOntoBase(worktreePath: string, baseRef: string): Promise<RebaseResult> {
  const res = execGit(["rebase", baseRef], worktreePath);
  if (res.code === 0) {
    return { success: true };
  }

  // Rebase failed / conflicted
  const statusRes = execGit(["status", "--porcelain"], worktreePath);
  const conflictFiles = statusRes.stdout
    .split("\n")
    .filter((line) => line.startsWith("UU ") || line.startsWith("AA ") || line.startsWith("DU "))
    .map((line) => line.slice(3).trim());

  // Abort the failed rebase cleanly
  execGit(["rebase", "--abort"], worktreePath);

  return {
    success: false,
    conflictFiles,
  };
}

/**
 * Tears down a worktree. On failure, preserves the branch or worktree for diagnosis.
 */
export async function teardownWorktree(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  options: {
    readonly isSuccess: boolean;
    readonly deleteBranch?: boolean;
    readonly preserveWorktreeOnFailure?: boolean;
    /** With `isSuccess`: leave a worktree that still has uncommitted changes in place. */
    readonly keepIfDirty?: boolean;
    /** When given, a worktree with no commits beyond it and no edits holds nothing and is removed. */
    readonly emptyBaseRef?: string;
  },
): Promise<{ preserved: boolean; salvageBranch?: string }> {
  if (!options.isSuccess && options.preserveWorktreeOnFailure && options.emptyBaseRef) {
    const dirty = execGit(["status", "--porcelain"], worktreePath);
    const ahead = execGit(["rev-list", "--count", `${options.emptyBaseRef}..${branch}`], repoRoot);
    if (dirty.code === 0 && dirty.stdout === "" && ahead.code === 0 && ahead.stdout === "0") {
      execGit(["worktree", "remove", "--force", worktreePath], repoRoot);
      execGit(["worktree", "prune"], repoRoot);
      execGit(["branch", "-D", branch], repoRoot);
      return { preserved: false };
    }
  }
  if (!options.isSuccess && options.preserveWorktreeOnFailure) {
    const salvageBranch = `salvage/${NodePath.basename(branch)}-${Date.now()}`;
    const status = execGit(["status", "--porcelain"], worktreePath);
    if (status.code !== 0) return { preserved: true };
    if (status.stdout.length > 0) {
      const add = execGit(["add", "-A"], worktreePath);
      if (add.code !== 0) return { preserved: true };
      const commit = execGit(
        [
          "-c",
          "user.name=AgentQueue",
          "-c",
          "user.email=agentqueue@localhost",
          "commit",
          "-m",
          `AgentQueue salvage for ${NodePath.basename(branch)}`,
        ],
        worktreePath,
      );
      if (commit.code !== 0) return { preserved: true };
    }
    const preserve = execGit(["branch", salvageBranch, branch], repoRoot);
    if (preserve.code !== 0) return { preserved: true };
    return { preserved: true, salvageBranch };
  }

  // Clean worktree removal. Edits made after the work was landed are somebody's unsaved work
  // (a late write from a test or a woken worker): keep the worktree and let a person look.
  if (NodeFS.existsSync(worktreePath)) {
    if (options.isSuccess && options.keepIfDirty) {
      const dirty = execGit(["status", "--porcelain"], worktreePath);
      if (dirty.code !== 0 || dirty.stdout !== "") return { preserved: true };
    }
    execGit(["worktree", "remove", "--force", worktreePath], repoRoot);
    if (NodeFS.existsSync(worktreePath)) {
      NodeFS.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  execGit(["worktree", "prune"], repoRoot);

  if (options.isSuccess && options.deleteBranch) {
    execGit(["branch", "-D", branch], repoRoot);
  }

  return { preserved: false };
}
