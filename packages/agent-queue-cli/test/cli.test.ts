import { describe, expect, it } from "vite-plus/test";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { parseArgs, runCli, runCliAsync } from "../src/cli.ts";
import { runResourceCommand } from "../src/resourceCommands.ts";
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
      const planFile = NodePath.join(repo.rootDir, "SAMPLE_PLAN.md");
      await NodeFSP.writeFile(planFile, planContent, "utf8");

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
      const planFile = NodePath.join(repo.rootDir, "INTERVENE.md");
      await NodeFSP.writeFile(planFile, planContent, "utf8");
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

  it("refuses operator commands that would undo a claim or a completion", async () => {
    const repo = await createTestGitRepo("aq-cli-guard-");
    try {
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "GUARD.md"),
        "# Guard Plan\n### G-01: Running Task\n### G-02: Done Task\n",
      );
      runCli(["plan", "import", "GUARD.md", "--json"], repo.rootDir);
      const done = JSON.parse(runCli(["task", "claim", "G-02", "--json"], repo.rootDir).output);
      runCli(
        ["task", "release", "--token", done.claim.ownerToken, "--status", "completed"],
        repo.rootDir,
      );
      const claim = JSON.parse(runCli(["task", "claim", "G-01", "--json"], repo.rootDir).output);
      expect(claim.success).toBe(true);

      // A running task is not reset under its worker.
      expect(runCli(["task", "retry", "G-01", "--json"], repo.rootDir).exitCode).toBe(1);

      // Completed work is neither reopened nor turned into a failure.
      expect(runCli(["task", "retry", "G-02", "--json"], repo.rootDir).exitCode).toBe(1);
      expect(runCli(["task", "abort", "G-02", "--json"], repo.rootDir).exitCode).toBe(1);
      expect(runCli(["task", "abort", "NOPE", "--json"], repo.rootDir).exitCode).toBe(1);
      const tasks = JSON.parse(runCli(["task", "list", "--json"], repo.rootDir).output).tasks;
      expect(tasks.map((t: { id: string; status: string }) => [t.id, t.status])).toEqual([
        ["G-01", "claimed"],
        ["G-02", "completed"],
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it("renews a lease for as long as it was taken, and fails when the lease is gone", async () => {
    const repo = await createTestGitRepo("aq-cli-lease-");
    try {
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "LEASE.md"), "# Lease\n### L-01: Long\n");
      runCli(["plan", "import", "LEASE.md"], repo.rootDir);
      const claim = JSON.parse(
        runCli(["task", "claim", "L-01", "--lease", "1800", "--json"], repo.rootDir).output,
      );
      const token = claim.claim.ownerToken;
      const renewed = JSON.parse(
        runCli(["task", "heartbeat", token, "--json"], repo.rootDir).output,
      );
      expect(
        Date.parse(renewed.expiresAt) - Date.parse(claim.claim.expiresAt),
      ).toBeGreaterThanOrEqual(0);

      runCli(["task", "release", "--token", token, "--status", "pending"], repo.rootDir);
      const lost = runCli(["task", "heartbeat", token, "--json"], repo.rootDir);
      expect(lost.exitCode).toBe(3);
      expect(JSON.parse(lost.output).success).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("does not take a task id as the value of a boolean flag", () => {
    expect(parseArgs(["task", "finalize", "--json", "VG1"]).positional).toEqual(["VG1"]);
    expect(parseArgs(["task", "retry", "--force", "VG1"]).positional).toEqual(["VG1"]);
  });

  it("kills a command that needs no shared resource at its --timeout", async () => {
    const result = await runResourceCommand(
      ["run", "--timeout", "1", "--", "node", "-e", "setTimeout(() => {}, 30000)"],
      process.cwd(),
    );
    expect(result?.exitCode).toBe(124);
  });

  it("produces human/agent readable text formatting when --json is omitted (AQ-018)", async () => {
    const repo = await createTestGitRepo("aq-cli-text-");
    try {
      const planContent = `
# Readable Plan
### TXT-01: Text Task
`;
      const planFile = NodePath.join(repo.rootDir, "READABLE.md");
      await NodeFSP.writeFile(planFile, planContent, "utf8");

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

  it("prints usage for --help and -h rather than queue status", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCliAsync([flag], process.cwd());
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Usage: agentq");
      expect(result.output).not.toContain("Host:");
    }
  });
  it("reuses only the selected declared check through agentq run", async () => {
    const repo = await createTestGitRepo("aq-cli-reuse-");
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aq-cli-reuse-home-"));
    const bin = NodePath.join(home, "bin");
    await NodeFSP.mkdir(bin);
    await NodeFSP.mkdir(NodePath.join(repo.rootDir, "src"));
    await NodeFSP.writeFile(NodePath.join(repo.rootDir, "src", "source.ts"), "export {};\n");
    const counter = NodePath.join(home, "launches.log");
    const compiler = NodePath.join(bin, "tsc");
    await NodeFSP.writeFile(
      compiler,
      `#!/bin/sh\nmkdir -p build\necho result > build/output.txt\necho run >> ${JSON.stringify(counter)}\n`,
    );
    await NodeFSP.chmod(compiler, 0o755);
    const plan = NodePath.join(repo.rootDir, "CHECKS.md");
    await NodeFSP.writeFile(
      plan,
      [
        "# Cache plan",
        "",
        "- [ ] **CACHE01 — Verify source.**",
        "  - Scope: src/**.",
        "  - Checks:",
        "    - `tsc --noEmit --pretty false` (id: compile, requires: heavy_build, reuse-inputs: src/**, reuse-env: none, produces: build/output.txt)",
      ].join("\n"),
    );
    const keys = [
      "PATH",
      "AGENTQUEUE_RESOURCE_HOME",
      "AGENTQUEUE_LOCK_ROOT",
      "AGENTQUEUE_TEST_HOST_MEMORY_MB",
      "AGENTQUEUE_OWNER",
      "AGENTQUEUE_RESOURCE_TICKET",
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.PATH = `${bin}${NodePath.delimiter}${process.env.PATH ?? ""}`;
      process.env.AGENTQUEUE_RESOURCE_HOME = home;
      process.env.AGENTQUEUE_LOCK_ROOT = NodePath.join(home, "locks");
      process.env.AGENTQUEUE_TEST_HOST_MEMORY_MB = "20000";
      delete process.env.AGENTQUEUE_OWNER;
      delete process.env.AGENTQUEUE_RESOURCE_TICKET;

      const imported = runCli(["plan", "import", "CHECKS.md", "--json"], repo.rootDir);
      expect(imported.exitCode).toBe(0);
      const args = [
        "run",
        "--owner",
        "CACHE01",
        "--check",
        "compile",
        "--",
        "tsc",
        "--noEmit",
        "--pretty",
        "false",
      ];
      expect((await runCliAsync(args, repo.rootDir)).exitCode).toBe(0);
      const reused = await runCliAsync(args, repo.rootDir);
      expect(reused.exitCode).toBe(0);
      expect(reused.error).toContain("reusing the successful declared check");
      expect((await NodeFSP.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);

      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "build", "output.txt"), "changed\n");
      expect((await runCliAsync(args, repo.rootDir)).exitCode).toBe(0);
      expect((await NodeFSP.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(2);

      const ambiguousArgs = [
        "run",
        "--owner",
        "CACHE01",
        "--check",
        "compile",
        "--",
        "tsc",
        "--noEmit --pretty",
        "false",
      ];
      expect((await runCliAsync(ambiguousArgs, repo.rootDir)).exitCode).toBe(0);
      expect((await NodeFSP.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(3);

      const wrongCheck = await runCliAsync(
        [
          "run",
          "--owner",
          "CACHE01",
          "--check",
          "other",
          "--",
          "tsc",
          "--noEmit",
          "--pretty",
          "false",
        ],
        repo.rootDir,
      );
      expect(wrongCheck.exitCode).toBe(0);
      expect((await NodeFSP.readFile(counter, "utf8")).trim().split("\n")).toHaveLength(4);
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await NodeFSP.rm(home, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it("states the default run deadline in agentq run --help", async () => {
    const result = await runResourceCommand(["run", "--help"], process.cwd());
    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toContain("default 3600");
  });
});
