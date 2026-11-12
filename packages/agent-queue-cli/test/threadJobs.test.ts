import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { runResourceCommand, runThreadJob } from "../src/resourceCommands.ts";
import { openBroker, ResourceBroker } from "../../agent-queue-core/src/index.ts";
import { createTestGitRepo } from "../../agent-queue-core/test/harness/gitHarness.ts";

const KEYS = [
  "AGENTQUEUE_RESOURCE_HOME",
  "AGENTQUEUE_LOCK_ROOT",
  "AGENTQUEUE_TEST_HOST_MEMORY_MB",
  "AGENTQUEUE_OWNER",
  "AGENTQUEUE_RESOURCE_TICKET",
  "AGENTQUEUE_FOREGROUND_SECONDS",
  "T3CODE_THREAD_ID",
] as const;

describe("agentq thread jobs", () => {
  let home = "";
  let previous = new Map<string, string | undefined>();

  beforeEach(async () => {
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aq-thread-jobs-"));
    previous = new Map(KEYS.map((key) => [key, process.env[key]]));
    process.env.AGENTQUEUE_RESOURCE_HOME = home;
    process.env.AGENTQUEUE_LOCK_ROOT = NodePath.join(home, "locks");
    process.env.AGENTQUEUE_TEST_HOST_MEMORY_MB = "20000";
    delete process.env.AGENTQUEUE_OWNER;
    delete process.env.AGENTQUEUE_RESOURCE_TICKET;
    delete process.env.AGENTQUEUE_FOREGROUND_SECONDS;
    delete process.env.T3CODE_THREAD_ID;
  });

  afterEach(async () => {
    for (const key of KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await NodeFSP.rm(home, { recursive: true, force: true });
  });

  it("runs in the foreground when no thread runner is alive", async () => {
    const repo = await createTestGitRepo("aq-thread-foreground-");
    try {
      process.env.T3CODE_THREAD_ID = "thread-foreground";
      const result = await runResourceCommand(
        ["run", "--resource", "heavy_build", "--", "true"],
        repo.rootDir,
      );
      expect(result?.exitCode).toBe(0);
      const broker = openBroker({ home });
      try {
        expect(broker.forOwner("thread:thread-foreground")).toEqual([]);
      } finally {
        broker.close();
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("stores a long command for the thread runner and returns STILL RUNNING", async () => {
    const repo = await createTestGitRepo("aq-thread-stored-");
    const broker = openBroker({ home });
    try {
      broker.registerRunner(process.pid, ResourceBroker.THREAD_JOBS_REPO);
      process.env.T3CODE_THREAD_ID = "thread-stored";
      process.env.AGENTQUEUE_FOREGROUND_SECONDS = "0";
      const result = await runResourceCommand(
        ["run", "--resource", "heavy_build", "--", "vp", "test", "run"],
        repo.rootDir,
      );
      expect(result?.exitCode).toBe(75);
      expect(result?.stderr).toContain("STILL RUNNING as rt-");
      expect(result?.stderr).toContain("agentq wait rt-");
      const [job] = broker.forOwner("thread:thread-stored");
      expect(job).toMatchObject({ kind: "job", repo: ResourceBroker.THREAD_JOBS_REPO });
      expect(job?.job?.command).toBe("vp test run");
    } finally {
      broker.close();
      await repo.cleanup();
    }
  });

  it("passes the stored job's exit code through when it finishes inside the window", async () => {
    const broker = openBroker({ home });
    try {
      const writes: string[] = [];
      const ownerRef = "thread:thread-window";
      const result = await runThreadJob(
        {
          threadId: "thread-window",
          demands: [{ name: "heavy_build" }],
          hints: {},
          command: ["vp", "test", "run"],
          cwd: home,
          label: "vp test run",
          env: {},
          waitMs: 60_000,
          runMs: 60_000,
          foregroundMs: 100_000,
        },
        {
          broker,
          write: (text) => writes.push(text),
          // The job finishes while the agent is waiting: its log and result are then written.
          sleep: async () => {
            const [job] = broker.forOwner(ownerRef);
            await NodeFSP.mkdir(NodePath.join(home, "logs"), { recursive: true });
            await NodeFSP.writeFile(NodePath.join(home, "logs", `${job!.id}.log`), "hello\n");
            broker.finish(job!.id, { outcome: "failed", exitCode: 3, tail: "hello\n" });
          },
        },
      );
      expect(result.exitCode).toBe(3);
      expect(writes.join("")).toBe("hello\n");
      const [job] = broker.forOwner(ownerRef);
      expect(job?.reportedAt).not.toBeNull();
    } finally {
      broker.close();
    }
  });

  it("agentq wait returns a finished job's exit code and marks it reported", async () => {
    const broker = openBroker({ home });
    try {
      const ticket = broker.enqueue({
        resources: [{ name: "heavy_build" }],
        label: "vp check",
        ownerRef: "thread:thread-wait",
        repo: ResourceBroker.THREAD_JOBS_REPO,
        job: { command: "vp check", cwd: home, env: {} },
      });
      broker.finish(ticket.id, { outcome: "failed", exitCode: 2, tail: "lint error\n" });

      const result = await runResourceCommand(["wait", ticket.id], home);
      expect(result?.exitCode).toBe(2);
      expect(result?.stdout).toContain(`Resource job ${ticket.id}`);
      expect(result?.stdout).toContain("failed (exit 2)");
      expect(broker.unreportedJobs()).toEqual([]);
    } finally {
      broker.close();
    }
  });

  it("agentq wait exits 2 for an unknown job", async () => {
    const result = await runResourceCommand(["wait", "rt-missing"], home);
    expect(result?.exitCode).toBe(2);
    expect(result?.stderr).toContain("Unknown job rt-missing");
  });
});
