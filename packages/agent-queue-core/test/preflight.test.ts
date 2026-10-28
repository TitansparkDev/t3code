// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { loadContract } from "../src/contract.ts";
import { openQueueDatabase } from "../src/db.ts";
import { importPlanFile } from "../src/planImport.ts";
import { preflightAssignment } from "../src/preflight.ts";
import { createTestGitRepo, createTestWorktree, execCommand } from "./harness/gitHarness.ts";

const PLAN = [
  "# Artifact readiness",
  "",
  "- [ ] **PRODUCER — Build the APK.**",
  "  - Depends on: none.",
  "  - Scope: artifacts/.",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m, id: apk, produces: artifacts/app.apk)',
  "",
  "- [ ] **CONSUMER — Verify the APK.**",
  "  - Depends on: PRODUCER.",
  "  - Scope: tests/.",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m, id: verify-apk, consumes: artifacts/app.apk)',
  "",
].join("\n");

describe("preflight artifact readiness", () => {
  it("allows a future dependency output and holds after the completed producer omits it", async () => {
    const repo = await createTestGitRepo("aq-preflight-artifact-");
    let worktree: Awaited<ReturnType<typeof createTestWorktree>> | undefined;
    let db: ReturnType<typeof openQueueDatabase> | undefined;
    try {
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), PLAN);
      await execCommand("git", ["add", "PLAN.md"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "artifact plan"], repo.rootDir);
      importPlanFile(repo.rootDir, "PLAN.md");
      db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      worktree = await createTestWorktree(repo, "consumer", "agentqueue/CONSUMER");
      const row = db
        .prepare("SELECT verification_spec, verification_command FROM tasks WHERE id = ?")
        .get("CONSUMER") as {
        verification_spec: string | null;
        verification_command: string | null;
      };
      const loaded = loadContract({
        repoRoot: repo.rootDir,
        gitCommonDir: repo.gitCommonDir,
        refs: [repo.defaultBranch],
      });
      const input = {
        db,
        repoRoot: repo.rootDir,
        gitCommonDir: repo.gitCommonDir,
        baseRef: repo.defaultBranch,
        loaded,
        task: {
          id: "CONSUMER",
          title: "Verify the APK",
          scope: ["tests/"],
          dependencies: ["PRODUCER"],
          verification_spec: row.verification_spec,
          verification_command: row.verification_command,
        },
        worktreePath: worktree.worktreePath,
        branch: worktree.branch,
        claimToken: "claim-consumer",
        allowedPaths: ["tests/"],
        env: {},
      } as const;

      expect(
        preflightAssignment(input).findings.filter(
          (finding) => finding.code === "artifact-prerequisite",
        ),
      ).toEqual([]);

      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'PRODUCER'").run();
      const missing = preflightAssignment(input);
      expect(missing.ok).toBe(false);
      expect(
        missing.findings.some(
          (finding) =>
            finding.code === "artifact-prerequisite" &&
            finding.message.includes("completed producer PRODUCER"),
        ),
      ).toBe(true);
      expect(missing.repairs).toEqual([]);

      await NodeFSP.mkdir(NodePath.join(worktree.worktreePath, "artifacts"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(worktree.worktreePath, "artifacts/app.apk"), "fixture");
      expect(
        preflightAssignment(input).findings.filter(
          (finding) => finding.code === "artifact-prerequisite",
        ),
      ).toEqual([]);
    } finally {
      db?.close();
      if (worktree) {
        try {
          await execCommand(
            "git",
            ["worktree", "remove", "--force", worktree.worktreePath],
            repo.rootDir,
          );
        } finally {
          await NodeFSP.rm(worktree.worktreePath, { recursive: true, force: true });
        }
      }
      await repo.cleanup();
    }
  });
});
