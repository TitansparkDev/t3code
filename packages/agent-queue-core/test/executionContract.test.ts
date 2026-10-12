// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * The execution contract end to end, on real git repositories with real guard scripts: what a
 * repository's own guards accept is discovered before a worker exists, deterministic
 * failures hold a task instead of spending workers, and fixes release the held work.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { releaseClaimForRetry } from "../src/claimService.ts";
import { environmentFingerprint, loadContract } from "../src/contract.ts";
import { probeBranchPrefix } from "../src/preflight.ts";
import { unblockTask } from "../src/overseerRepairs.ts";
import { evaluateDeadlock } from "../src/queueInspector.ts";
import { execCommand } from "./harness/gitHarness.ts";
import { guardScript, makeRepo, plan, tmpDir } from "./harness/contractHarness.ts";

describe("repository guards decide the branch name, not a hardcoded convention", () => {
  it("finds the prefix an unconfigured guarded repository accepts by really trying it", async () => {
    const r = await makeRepo({ plan: plan([{ id: "A" }]) });
    try {
      const loaded = loadContract({
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        refs: ["main"],
      });
      expect(loaded.sources).toContain("inferred");
      expect(loaded.contract.guards.map((g) => g.run)).toEqual(["node tools/guard.mjs"]);
      const probe = probeBranchPrefix({
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseRef: "main",
        loaded,
      });
      expect(probe.prefix).toBe("agent/");
      // The throwaway probe left nothing behind.
      const branches = (await execCommand("git", ["branch", "--list"], r.repo.rootDir)).stdout;
      expect(branches).not.toContain("aq-probe");
      const outcome = await r.reserve();
      expect(outcome.kind).toBe("reserved");
      if (outcome.kind !== "reserved") return;
      expect(outcome.task.branch.startsWith("agent/")).toBe(true);
      expect(outcome.task.guards.map((g) => g.command)).toEqual(["node tools/guard.mjs"]);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("a second repository with other rules gets its own branch convention", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "B" }]),
      prefixes: ["bot/"],
      agents: "Run `node tools/guard.mjs` first: it is the checkout guard.\n",
      contract: { branchPrefixes: ["bot/"] },
    });
    try {
      const outcome = await r.reserve();
      expect(outcome.kind).toBe("reserved");
      if (outcome.kind !== "reserved") return;
      expect(outcome.task.branch.startsWith("bot/")).toBe(true);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("learns a prefix the repository already uses when nothing declares one", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "C" }]),
      prefixes: ["wk/"],
      agents: "Run `node tools/guard.mjs` first: it is the checkout guard.\n",
    });
    try {
      await execCommand("git", ["branch", "wk/earlier-work"], r.repo.rootDir);
      const outcome = await r.reserve();
      expect(outcome.kind).toBe("reserved");
      if (outcome.kind !== "reserved") return;
      expect(outcome.task.branch.startsWith("wk/")).toBe(true);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("an existing worktree on the rejected default branch is corrected in place, keeping its commits", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "D" }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      // The earlier version of the queue made `agentqueue/...` branches.
      const wt = NodePath.join(r.repo.rootDir, ".worktrees", "agentqueue", "D");
      await execCommand(
        "git",
        ["worktree", "add", "-b", "agentqueue/D-task-d", wt, r.goal],
        r.repo.rootDir,
      );
      await r.commitFile(wt, "old-work.txt", "kept\n");
      const outcome = await r.reserve();
      expect(outcome.kind).toBe("reserved");
      if (outcome.kind !== "reserved") return;
      expect(outcome.task.branch).toMatch(/^agent\//);
      expect(outcome.task.existingCommits.join("\n")).toContain("work old-work.txt");
      const current = (await execCommand("git", ["branch", "--show-current"], wt)).stdout.trim();
      expect(current).toBe(outcome.task.branch);
      const claim = r.db
        .prepare("SELECT branch FROM task_claims WHERE task_id = 'D' AND released_at IS NULL")
        .get() as { branch: string };
      expect(claim.branch).toBe(outcome.task.branch);
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("a deterministic failure holds the task instead of spending workers", () => {
  it("holds tasks whose guard rejects every branch without a worker or a retry, and releases them when the guard is fixed", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B" }]),
      prefixes: ["nothing-matches/"],
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const first = await r.reserve();
      expect(first.kind).toBe("none");
      if (first.kind !== "none") return;
      expect(first.held.map((h) => h.taskId).sort()).toEqual(["A", "B"]);
      expect(r.task("A")).toMatchObject({
        status: "blocked",
        failure_class: "configuration",
        retry_count: 0,
      });
      expect(r.task("A").failure_reason).toContain("rejects this assignment");
      // Asking again changes nothing: no new failure rows.
      const failuresBefore = (
        r.db.prepare("SELECT count(*) AS c FROM task_failures").get() as { c: number }
      ).c;
      const again = await r.reserve();
      expect(again.kind).toBe("none");
      expect(
        (r.db.prepare("SELECT count(*) AS c FROM task_failures").get() as { c: number }).c,
      ).toBe(failuresBefore);
      expect(evaluateDeadlock(r.db, r.planId).awaitingEnvironment).toBe(true);

      // The repository fixes its guard on the target branch; the queue notices and resumes.
      await r.commitOnMain("tools/guard.mjs", guardScript(["agent/"]));
      const resumed = await r.reserve();
      expect(resumed.kind).toBe("reserved");
      expect(r.task("B").failure_class).toBeNull();
      expect(r.task("A").retry_count).toBe(0);
      const revived = r.db
        .prepare("SELECT count(*) AS c FROM task_events WHERE event_type = 'task_revalidated'")
        .get() as { c: number };
      expect(revived.c).toBe(2);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("does not retry a configuration failure reported by a worker, and revives it when the environment changes", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const reserved = await r.reserve();
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      const refs = ["main", r.goal];
      const loaded = loadContract({
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        refs,
      });
      const result = releaseClaimForRetry(
        r.db,
        reserved.task.claimToken,
        "The required checkout guard rejects the assigned branch",
        { fingerprint: environmentFingerprint({ repoRoot: r.repo.rootDir, loaded, refs }) },
      );
      expect(result.held).toBe(true);
      expect(r.task("A")).toMatchObject({
        status: "blocked",
        failure_class: "configuration",
        retry_count: 0,
      });
      expect((await r.reserve()).kind).toBe("none");
      // A fix lands on the target branch: the environment differs, the task is back.
      await r.commitOnMain("tools/guard.mjs", guardScript(["agent/", "agent-plan/"]));
      expect((await r.reserve()).kind).toBe("reserved");
    } finally {
      await r.repo.cleanup();
    }
  });

  it("holds the same verification failure on an unchanged commit instead of sending another worker", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A", verify: 'node -e "process.exit(3)"' }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const reserved = await r.reserve();
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      await r.commitFile(reserved.task.worktreePath, "x.txt", "x\n");
      const first = await r.submit(reserved.task);
      expect(first.kind).toBe("verification-failed");
      if (first.kind !== "verification-failed") return;
      expect(first.decision.action).toBe("retry");
      const second = await r.submit(reserved.task);
      expect(second.kind === "verification-failed" && second.decision.action).toBe("hold");
    } finally {
      await r.repo.cleanup();
    }
  });

  it("a different failure after new work is a fresh attempt, not a repeat", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A", verify: 'node -e "process.exit(3)"' }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const reserved = await r.reserve();
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      await r.commitFile(reserved.task.worktreePath, "x.txt", "x\n");
      await r.submit(reserved.task);
      await r.commitFile(reserved.task.worktreePath, "y.txt", "y\n");
      const next = await r.submit(reserved.task);
      expect(next.kind === "verification-failed" && next.decision.action).toBe("retry");
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("prerequisites and external blockers", () => {
  it("installs a missing tool the repository authorises, and only warns about an optional one", async () => {
    const marker = NodePath.join(await tmpDir("aq-tool-"), "installed");
    const r = await makeRepo({
      plan: plan([{ id: "A" }]),
      contract: {
        branchPrefixes: ["agent/"],
        tools: [
          { name: "aq-tool", probe: `test -f ${marker}`, install: `touch ${marker}` },
          { name: "aq-optional", probe: "false", optional: true },
        ],
      },
    });
    try {
      const outcome = await r.reserve();
      expect(outcome.kind).toBe("reserved");
      if (outcome.kind !== "reserved") return;
      expect(NodeFS.existsSync(marker)).toBe(true);
      expect(outcome.task.notes.join("\n")).toContain("aq-optional");
      expect(outcome.task.notes.join("\n")).toContain("installed aq-tool");
    } finally {
      await r.repo.cleanup();
    }
  });

  it("holds tasks whose mandatory tool cannot be installed", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B" }]),
      contract: { branchPrefixes: ["agent/"], tools: [{ name: "aq-missing", probe: "false" }] },
    });
    try {
      expect((await r.reserve()).kind).toBe("none");
      expect(r.task("A")).toMatchObject({ status: "blocked", failure_class: "prerequisite" });
      expect(r.task("B")).toMatchObject({ status: "blocked", failure_class: "prerequisite" });
    } finally {
      await r.repo.cleanup();
    }
  });

  it("an unavailable capability holds only the task that needs it, never claims it, and cannot be unblocked by hand", async () => {
    const flag = NodePath.join(await tmpDir("aq-cap-"), "granted");
    const r = await makeRepo({
      plan: plan([
        { id: "H", title: "Apply to production [host]" },
        { id: "I", title: "Independent work" },
        { id: "J", title: "After the host step", deps: ["H"] },
      ]),
      contract: {
        branchPrefixes: ["agent/"],
        capabilities: {
          host: { probe: `test -f ${flag}`, description: "authorised production host" },
        },
      },
    });
    try {
      const first = await r.reserve();
      expect(first.kind).toBe("reserved");
      if (first.kind !== "reserved") return;
      expect(first.task.taskId).toBe("I");
      expect(r.task("H")).toMatchObject({ status: "blocked", failure_class: "external" });
      expect(
        r.db.prepare("SELECT count(*) AS c FROM task_claims WHERE task_id = 'H'").get(),
      ).toEqual({
        c: 0,
      });
      expect(unblockTask(r.db, "H").success).toBe(false);
      expect(r.task("H").status).toBe("blocked");
      // The host step stays visible and incomplete; its dependant waits behind it.
      expect(r.task("J").status).toBe("pending");
      // The environment grants the capability: the task comes back with nobody releasing it.
      await NodeFSP.writeFile(flag, "ok");
      await r.commitFile(first.task.worktreePath, "i.txt", "i\n");
      expect((await r.submit(first.task)).kind).toBe("submitted");
      await r.integrate("I");
      const next = await r.reserve();
      expect(next.kind).toBe("reserved");
      if (next.kind !== "reserved") return;
      expect(next.task.taskId).toBe("H");
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("dependencies are checked against the real baseline", () => {
  it("does not dispatch a task whose completed dependency is not on its base", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B", deps: ["A"] }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const reserved = await r.reserve();
      if (reserved.kind !== "reserved") throw new Error("expected a reservation");
      await r.commitFile(reserved.task.worktreePath, "a.txt", "a\n");
      await r.submit(reserved.task);
      await r.integrate("A");
      // The plan's branch is rewound behind A's landed commit (a manual mistake).
      await execCommand("git", ["update-ref", `refs/heads/${r.goal}`, "main"], r.repo.rootDir);
      expect((await r.reserve()).kind).toBe("none");
      expect(r.task("B")).toMatchObject({ status: "blocked", failure_class: "configuration" });
      expect(r.task("B").failure_reason).toContain("not on");
    } finally {
      await r.repo.cleanup();
    }
  });
});
