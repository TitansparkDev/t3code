// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

export interface TestGitRepo {
  readonly rootDir: string;
  readonly gitCommonDir: string;
  readonly defaultBranch: string;
  cleanup: () => Promise<void>;
}

export interface WorkerProcessSimulation {
  readonly pid: number;
  readonly promise: Promise<{ code: number | null; stdout: string; stderr: string }>;
  kill: (signal?: NodeJS.Signals) => void;
}

export function execCommand(
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = NodeChildProcess.spawn(command, args as string[], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "AgentQueue Test",
        GIT_AUTHOR_EMAIL: "aq@test.local",
        GIT_COMMITTER_NAME: "AgentQueue Test",
        GIT_COMMITTER_EMAIL: "aq@test.local",
      },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    proc.on("error", reject);
  });
}

/**
 * Creates an isolated throwaway Git repository for multi-process simulation.
 */
export async function createTestGitRepo(prefix = "aq-test-repo-"): Promise<TestGitRepo> {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  const rootDir = await NodeFSP.realpath(tempDir);

  await execCommand("git", ["init", "-b", "main"], rootDir);
  await execCommand("git", ["config", "user.name", "AgentQueue Test"], rootDir);
  await execCommand("git", ["config", "user.email", "aq@test.local"], rootDir);
  await execCommand("git", ["config", "commit.gpgsign", "false"], rootDir);

  // Create initial commit
  await NodeFSP.writeFile(NodePath.join(rootDir, "README.md"), "# Test Repo\n", "utf8");
  await execCommand("git", ["add", "README.md"], rootDir);
  await execCommand("git", ["commit", "-m", "Initial commit"], rootDir);

  // Find git common dir
  const { stdout } = await execCommand("git", ["rev-parse", "--git-common-dir"], rootDir);
  const gitCommonDir = NodePath.resolve(rootDir, stdout.trim());

  return {
    rootDir,
    gitCommonDir,
    defaultBranch: "main",
    cleanup: async () => {
      try {
        await NodeFSP.rm(rootDir, { recursive: true, force: true });
      } catch {
        // Ignore deletion errors on shutdown
      }
    },
  };
}

/**
 * Creates a linked Git worktree for testing parallel workers.
 */
export async function createTestWorktree(
  repo: TestGitRepo,
  worktreeName: string,
  branchName: string,
): Promise<{ worktreePath: string; branch: string }> {
  const worktreePath = NodePath.join(
    NodePath.dirname(repo.rootDir),
    `${NodePath.basename(repo.rootDir)}-wt-${worktreeName}`,
  );
  await execCommand(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, repo.defaultBranch],
    repo.rootDir,
  );
  return { worktreePath, branch: branchName };
}

/**
 * Simulates a worker process performing work in a worktree.
 */
export function simulateWorkerProcess(options: {
  cwd: string;
  durationMs: number;
  modifyFile?: { filePath: string; content: string };
  failVerification?: boolean;
}): WorkerProcessSimulation {
  const script = `
    const fs = require('fs');
    const path = require('path');
    ${options.modifyFile ? `fs.writeFileSync(path.resolve(${JSON.stringify(options.modifyFile.filePath || (options.modifyFile as any).NodePath)}), ${JSON.stringify(options.modifyFile.content)});` : ""}
    setTimeout(() => {
      ${options.failVerification ? "process.exit(1);" : "process.exit(0);"}
    }, ${options.durationMs});
  `;

  const proc = NodeChildProcess.spawn("node", ["-e", script], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (d) => (stdout += d.toString()));
  proc.stderr?.on("data", (d) => (stderr += d.toString()));

  const promise = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      proc.on("close", (code) => resolve({ code, stdout, stderr }));
      proc.on("error", reject);
    },
  );

  return {
    pid: proc.pid ?? -1,
    promise,
    kill: (signal = "SIGTERM") => {
      try {
        proc.kill(signal);
      } catch {
        // Ignore if already terminated
      }
    },
  };
}

/**
 * Creates conflicting file modifications on two branches to test conflict detection.
 */
export async function createConflictingBranches(
  repo: TestGitRepo,
  filename = "shared_file.txt",
): Promise<{ branchA: string; branchB: string }> {
  const branchA = "feature/conflict-a";
  const branchB = "feature/conflict-b";

  // Create branch A with line change
  await execCommand("git", ["checkout", "-b", branchA], repo.rootDir);
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, filename), "Line from Branch A\n", "utf8");
  await execCommand("git", ["add", filename], repo.rootDir);
  await execCommand("git", ["commit", "-m", "Commit on Branch A"], repo.rootDir);

  // Checkout main and create branch B with colliding line change
  await execCommand("git", ["checkout", repo.defaultBranch], repo.rootDir);
  await execCommand("git", ["checkout", "-b", branchB], repo.rootDir);
  await NodeFSP.writeFile(
    NodePath.join(repo.rootDir, filename),
    "Conflicting line from Branch B\n",
    "utf8",
  );
  await execCommand("git", ["add", filename], repo.rootDir);
  await execCommand("git", ["commit", "-m", "Commit on Branch B"], repo.rootDir);

  // Return to default branch
  await execCommand("git", ["checkout", repo.defaultBranch], repo.rootDir);

  return { branchA, branchB };
}
