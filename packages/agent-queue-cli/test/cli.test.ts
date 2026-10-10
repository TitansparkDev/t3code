import { describe, expect, it } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runCli } from "../src/cli.ts";
import { createTestGitRepo } from "../../agent-queue-core/test/harness/gitHarness.ts";

describe("AgentQueue CLI & Human Intervention (AQ-016, AQ-017, AQ-018)", () => {
  it("imports a plan file, lists tasks, claims, heartbeats, and releases with --json output", async () => {
    const repo = await createTestGitRepo("aq-cli-test-");
    try {
      // 1. Create a markdown plan file
      const planContent = `
# Sample Project Plan

### TASK-01: First Task
Scope: src/**
Verify: vp test src

### TASK-02: Second Task
Depends on: TASK-01
Verify: vp test src/second
`;
      const planFile = path.join(repo.rootDir, "SAMPLE_PLAN.md");
      await fs.writeFile(planFile, planContent, "utf8");

      // 2. agentqueue plan import SAMPLE_PLAN.md --json
      const importRes = runCli(["plan", "import", "SAMPLE_PLAN.md", "--json"], repo.rootDir);
      expect(importRes.exitCode).toBe(0);
      const importData = JSON.parse(importRes.output);
      expect(importData.success).toBe(true);
      expect(importData.taskCount).toBe(2);

      // 3. agentqueue task list --json
      const listRes = runCli(["task", "list", "--json"], repo.rootDir);
      expect(listRes.exitCode).toBe(0);
      const listData = JSON.parse(listRes.output);
      expect(listData.count).toBe(2);
      expect(listData.tasks[0].id).toBe("TASK-01");
      expect(listData.tasks[1].id).toBe("TASK-02");

      // 4. agentqueue task claim --json (should auto-claim TASK-01 because TASK-02 is blocked on TASK-01)
      const claimRes = runCli(["task", "claim", "--json"], repo.rootDir);
      expect(claimRes.exitCode).toBe(0);
      const claimData = JSON.parse(claimRes.output);
      expect(claimData.success).toBe(true);
      expect(claimData.claim.taskId).toBe("TASK-01");
      const token = claimData.claim.ownerToken;

      // 5. agentqueue task heartbeat --token <token> --json
      const hbRes = runCli(["task", "heartbeat", "--token", token, "--json"], repo.rootDir);
      expect(hbRes.exitCode).toBe(0);
      const hbData = JSON.parse(hbRes.output);
      expect(hbData.success).toBe(true);

      // 6. agentqueue task release --token <token> --status completed --json
      const relRes = runCli(
        ["task", "release", "--token", token, "--status", "completed", "--json"],
        repo.rootDir,
      );
      expect(relRes.exitCode).toBe(0);
      const relData = JSON.parse(relRes.output);
      expect(relData.success).toBe(true);

      // 7. Now TASK-02 is ready! Claim it:
      const claim2Res = runCli(["task", "claim", "--json"], repo.rootDir);
      expect(claim2Res.exitCode).toBe(0);
      const claim2Data = JSON.parse(claim2Res.output);
      expect(claim2Data.success).toBe(true);
      expect(claim2Data.claim.taskId).toBe("TASK-02");

      // 8. agentqueue status --json
      const statusRes = runCli(["status", "--json"], repo.rootDir);
      expect(statusRes.exitCode).toBe(0);
      const statusData = JSON.parse(statusRes.output);
      expect(statusData.snapshot.counts.completed).toBe(1);
      expect(statusData.snapshot.counts.claimed).toBe(1);
      expect(statusData.deadlock.isDeadlocked).toBe(false);

      // 9. agentqueue events --json
      const eventsRes = runCli(["events", "--json"], repo.rootDir);
      expect(eventsRes.exitCode).toBe(0);
      const eventsData = JSON.parse(eventsRes.output);
      expect(eventsData.events.length).toBeGreaterThan(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("supports operator intervention commands: abort, retry, block, unblock, and note (AQ-017)", async () => {
    const repo = await createTestGitRepo("aq-cli-intervene-");
    try {
      const planContent = `
# Intervention Plan
### INT-01: Intervention Task
`;
      const planFile = path.join(repo.rootDir, "INTERVENE.md");
      await fs.writeFile(planFile, planContent, "utf8");
      runCli(["plan", "import", "INTERVENE.md", "--json"], repo.rootDir);

      // 1. Block task
      const blockRes = runCli(
        ["task", "block", "INT-01", "--reason", "Waiting for upstream spec", "--json"],
        repo.rootDir,
      );
      expect(blockRes.exitCode).toBe(0);
      const blockData = JSON.parse(blockRes.output);
      expect(blockData.status).toBe("blocked");

      // 2. Unblock task
      const unblockRes = runCli(["task", "unblock", "INT-01", "--json"], repo.rootDir);
      expect(unblockRes.exitCode).toBe(0);
      const unblockData = JSON.parse(unblockRes.output);
      expect(unblockData.status).toBe("pending");

      // 3. Add operator note
      const noteRes = runCli(
        ["task", "note", "INT-01", "--text", "Check section 4.2 carefully", "--json"],
        repo.rootDir,
      );
      expect(noteRes.exitCode).toBe(0);
      const noteData = JSON.parse(noteRes.output);
      expect(noteData.noteText).toContain("section 4.2");

      // 4. Abort task
      const abortRes = runCli(
        ["task", "abort", "INT-01", "--reason", "Duplicate task", "--json"],
        repo.rootDir,
      );
      expect(abortRes.exitCode).toBe(0);
      const abortData = JSON.parse(abortRes.output);
      expect(abortData.status).toBe("failed");
      expect(abortData.reason).toBe("Duplicate task");

      // 5. Retry task
      const retryRes = runCli(["task", "retry", "INT-01", "--json"], repo.rootDir);
      expect(retryRes.exitCode).toBe(0);
      const retryData = JSON.parse(retryRes.output);
      expect(retryData.status).toBe("pending");
    } finally {
      await repo.cleanup();
    }
  });

  it("produces human/agent readable text formatting when --json is omitted (AQ-018)", async () => {
    const repo = await createTestGitRepo("aq-cli-text-");
    try {
      const planContent = `
# Readable Plan
### TXT-01: Text Task
`;
      const planFile = path.join(repo.rootDir, "READABLE.md");
      await fs.writeFile(planFile, planContent, "utf8");

      const importRes = runCli(["plan", "import", "READABLE.md"], repo.rootDir);
      expect(importRes.exitCode).toBe(0);
      expect(importRes.output).toContain("Imported plan 'Readable Plan'");

      const listRes = runCli(["task", "list"], repo.rootDir);
      expect(listRes.exitCode).toBe(0);
      expect(listRes.output).toContain("[PENDING] TXT-01");

      const statusRes = runCli(["status"], repo.rootDir);
      expect(statusRes.exitCode).toBe(0);
      expect(statusRes.output).toContain("=== AgentQueue Status ===");
      expect(statusRes.output).toContain("Queue Healthy");
    } finally {
      await repo.cleanup();
    }
  });

  it("supports repo init and repo doctor commands (AQ-051)", async () => {
    const repo = await createTestGitRepo("aq-cli-repo-test-");
    try {
      // 1. repo init
      const initRes = runCli(["repo", "init", "--json"], repo.rootDir);

      expect(initRes.exitCode).toBe(0);
      const initData = JSON.parse(initRes.output);
      expect(initData.success).toBe(true);
      expect(initData.gitCommonDir).toBe(repo.gitCommonDir);

      // 2. repo doctor
      const doctorRes = runCli(["repo", "doctor", "--json"], repo.rootDir);
      expect(doctorRes.exitCode).toBe(0);
      const doctorData = JSON.parse(doctorRes.output);
      expect(doctorData.healthy).toBe(true);
      expect(doctorData.checks.isGitRepo.ok).toBe(true);
      expect(doctorData.checks.gitCommonDirWritable.ok).toBe(true);
      expect(doctorData.checks.dbIntegrity.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});
