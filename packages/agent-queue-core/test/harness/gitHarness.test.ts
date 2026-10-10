// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import {
  createTestGitRepo,
  createTestWorktree,
  simulateWorkerProcess,
  createConflictingBranches,
  execCommand,
} from "./gitHarness.ts";

describe("AgentQueue Git Test Harness", () => {
  it("initializes a throwaway Git repo with common dir", async () => {
    const repo = await createTestGitRepo("aq-harness-init-");
    try {
      expect(repo.rootDir).toBeTruthy();
      expect(repo.gitCommonDir).toBeTruthy();
      expect(repo.gitCommonDir).toContain(".git");

      const readme = await NodeFSP.readFile(NodePath.join(repo.rootDir, "README.md"), "utf8");
      expect(readme).toContain("# Test Repo");
    } finally {
      await repo.cleanup();
    }
  });

  it("provisions and tracks independent worktrees", async () => {
    const repo = await createTestGitRepo("aq-harness-wt-");
    try {
      const { worktreePath, branch } = await createTestWorktree(
        repo,
        "worker-1",
        "feature/worker-1",
      );
      expect(branch).toBe("feature/worker-1");

      const exists = await NodeFSP.stat(worktreePath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Verify git rev-parse --git-common-dir points back to main repo
      const { stdout } = await execCommand("git", ["rev-parse", "--git-common-dir"], worktreePath);
      const wtCommonDir = NodePath.resolve(worktreePath, stdout.trim());
      expect(wtCommonDir).toBe(repo.gitCommonDir);

      // Cleanup worktree
      await execCommand("git", ["worktree", "remove", "--force", worktreePath], repo.rootDir);
    } finally {
      await repo.cleanup();
    }
  });

  it("simulates concurrent worker processes with exit codes", async () => {
    const repo = await createTestGitRepo("aq-harness-proc-");
    try {
      const workerSuccess = simulateWorkerProcess({
        cwd: repo.rootDir,
        durationMs: 50,
        modifyFile: { NodePath: "success.txt", content: "Worker success\n" },
        failVerification: false,
      });

      const workerFail = simulateWorkerProcess({
        cwd: repo.rootDir,
        durationMs: 50,
        failVerification: true,
      });

      const [resSuccess, resFail] = await Promise.all([workerSuccess.promise, workerFail.promise]);
      expect(resSuccess.code).toBe(0);
      expect(resFail.code).toBe(1);

      const content = await NodeFSP.readFile(NodePath.join(repo.rootDir, "success.txt"), "utf8");
      expect(content).toBe("Worker success\n");
    } finally {
      await repo.cleanup();
    }
  });

  it("simulates conflicting branches for merge coordination", async () => {
    const repo = await createTestGitRepo("aq-harness-conflict-");
    try {
      const { branchA, branchB } = await createConflictingBranches(repo, "conflict.txt");
      expect(branchA).toBe("feature/conflict-a");
      expect(branchB).toBe("feature/conflict-b");

      // Merging branch A succeeds
      const mergeA = await execCommand("git", ["merge", branchA], repo.rootDir);
      expect(mergeA.code).toBe(0);

      // Merging branch B into default branch should result in conflict
      const mergeB = await execCommand("git", ["merge", branchB], repo.rootDir);
      expect(mergeB.code).not.toBe(0);

      // Abort merge to leave repo clean
      await execCommand("git", ["merge", "--abort"], repo.rootDir);
    } finally {
      await repo.cleanup();
    }
  });
});
