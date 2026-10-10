// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
export function sanitizeBranchName(taskId: string, title?: string): string {
  const sanitizedTask = taskId.replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!title) return `agentqueue/${sanitizedTask}`;

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 30)
    .replace(/^-+|-+$/g, "");

  return slug ? `agentqueue/${sanitizedTask}-${slug}` : `agentqueue/${sanitizedTask}`;
}

/**
 * Provisions an isolated git worktree for a task.
 */
export async function provisionWorktree(
  repoRoot: string,
  taskId: string,
  baseRef = "HEAD",
  title?: string,
): Promise<ProvisionWorktreeResult> {
  const worktreeParent = NodePath.join(repoRoot, ".worktrees", "agentqueue");
  if (!NodeFS.existsSync(worktreeParent)) {
    NodeFS.mkdirSync(worktreeParent, { recursive: true });
  }

  const worktreePath = NodePath.join(worktreeParent, taskId);
  const branch = sanitizeBranchName(taskId, title);

  // Check if worktree or branch already exists from a previous crash/attempt
  if (NodeFS.existsSync(worktreePath)) {
    execGit(["worktree", "remove", "--force", worktreePath], repoRoot);
    if (NodeFS.existsSync(worktreePath)) {
      NodeFS.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Delete stale branch if it exists
  execGit(["branch", "-D", branch], repoRoot);
  execGit(["worktree", "prune"], repoRoot);

  // Create new worktree with branch branched off baseRef
  const addRes = execGit(["worktree", "add", "-b", branch, worktreePath, baseRef], repoRoot);
  if (addRes.code !== 0) {
    throw new Error(`Failed to provision worktree at ${worktreePath}: ${addRes.stderr}`);
  }

  return { worktreePath, branch };
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
  },
): Promise<{ preserved: boolean; salvageBranch?: string }> {
  if (!options.isSuccess && options.preserveWorktreeOnFailure) {
    const salvageBranch = `salvage/${NodePath.basename(branch)}-${Date.now()}`;
    const status = execGit(["status", "--porcelain"], worktreePath);
    if (status.code !== 0) return { preserved: true };
    if (status.stdout.length > 0) {
      const add = execGit(["add", "-A"], worktreePath);
      if (add.code !== 0) return { preserved: true };
      const commit = execGit(
        ["commit", "-m", `AgentQueue salvage for ${NodePath.basename(branch)}`],
        worktreePath,
      );
      if (commit.code !== 0) return { preserved: true };
    }
    const preserve = execGit(["branch", salvageBranch, branch], repoRoot);
    if (preserve.code !== 0) return { preserved: true };
    return { preserved: true, salvageBranch };
  }

  // Clean worktree removal
  if (NodeFS.existsSync(worktreePath)) {
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
