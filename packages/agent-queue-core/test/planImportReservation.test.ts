// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { importPlanFile, previewPlan } from "../src/planImport.ts";
import { parsePlanMarkdown } from "../src/planGraph.ts";
import { reserveNextTask } from "../src/reservation.ts";
import { provisionWorktree } from "../src/worktreeManager.ts";
import { reconcileExpiredLeases } from "../src/leaseRecovery.ts";
import { claimTask, releaseClaim } from "../src/claimService.ts";
import { unwaiveTask, waiveTask } from "../src/stateMachine.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

const PLAN_WORK_PLAN = `# Repair plan

Intro prose.

## Bugs

- [ ] **RP1 — Make it honest.**
  - Depends on: none.
  - Scope: src/a/, src/b.py.
  - Done: \`node -e "process.exit(0)"\`

- [ ] **RP2 — Second [host]**
  - Depends on: RP1, RP3.
  - Done: prose that must never run as shell; run the suite twice.

- [ ] **RP3 — Third**
  - Depends on: RP1.

- [x] **RP4 — Already done**
  - Depends on: none.

- [ ] **RP7 — Independent**
  - Depends on: none.

## Later

Trailing prose is not a task description.
`;

async function seedRepo(plan = PLAN_WORK_PLAN) {
  const repo = await createTestGitRepo("aq-plan-import-");
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
  await execCommand("git", ["add", "PLAN.md"], repo.rootDir);
  await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
  return repo;
}

async function seedPlanFiles(files: Record<string, string>) {
  const repo = await createTestGitRepo("aq-plan-discovery-");
  for (const [path, content] of Object.entries(files)) {
    const fullPath = NodePath.join(repo.rootDir, path);
    await NodeFSP.mkdir(NodePath.dirname(fullPath), { recursive: true });
    await NodeFSP.writeFile(fullPath, content);
  }
  await execCommand("git", ["add", ...Object.keys(files)], repo.rootDir);
  await execCommand("git", ["commit", "-m", "plans"], repo.rootDir);
  return repo;
}

describe("plan-work style plans", () => {
  it("parses ids, dependencies, ticked tasks, and never treats prose as a command", () => {
    const parsed = parsePlanMarkdown(PLAN_WORK_PLAN);
    expect(parsed.tasks.map((task) => task.id)).toEqual(["RP1", "RP2", "RP3", "RP4", "RP7"]);
    const byId = new Map(parsed.tasks.map((task) => [task.id, task]));
    expect(byId.get("RP1")!.dependencies).toEqual([]);
    expect(byId.get("RP2")!.dependencies).toEqual(["RP1", "RP3"]);
    expect(byId.get("RP1")!.verificationCommand).toBe('node -e "process.exit(0)"');
    expect(byId.get("RP2")!.verificationCommand).toBeNull();
    expect(byId.get("RP2")!.description).toContain("never run as shell");
    expect(byId.get("RP4")!.checked).toBe(true);
    expect(byId.get("RP7")!.description ?? "").not.toContain("Trailing prose");
  });
});

describe("previewPlan and importPlanFile", () => {
  it("previews counts without writing a queue, then imports idempotently", async () => {
    const repo = await seedRepo();
    try {
      const preview = previewPlan(repo.rootDir);
      expect(preview.readiness).toBe("ready");
      expect(preview.planPath).toBe("PLAN.md");
      expect(preview.counts).toMatchObject({ total: 5, completed: 1, ready: 2, waiting: 2 });

      const first = importPlanFile(repo.rootDir, "PLAN.md");
      expect(first).toMatchObject({ added: 5, total: 5 });
      const second = importPlanFile(repo.rootDir, "PLAN.md");
      expect(second.added).toBe(0);

      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const rows = db.prepare("SELECT id, status FROM tasks ORDER BY id").all() as Array<{
        id: string;
        status: string;
      }>;
      expect(rows.find((row) => row.id === "RP4")!.status).toBe("completed");
      expect(rows.filter((row) => row.status === "pending")).toHaveLength(4);
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("refuses a plan whose task a legacy plan-work worker still owns", async () => {
    const repo = await seedRepo();
    try {
      const owners = NodePath.join(repo.gitCommonDir, "plan-work-owners", "plan");
      await NodeFSP.mkdir(owners, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(owners, "rp1.json"),
        JSON.stringify({ task_id: "RP1", owner_token: "x" }),
      );
      const preview = previewPlan(repo.rootDir);
      expect(preview.readiness).toBe("legacy-active");
      expect(preview.legacyOwnedTaskIds).toEqual(["RP1"]);
      expect(() => importPlanFile(repo.rootDir, "PLAN.md")).toThrow(/RP1/);
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects cycles, missing dependencies and ids that belong to another plan", async () => {
    const repo = await seedRepo(
      `# P\n\n- [ ] **A1 — a**\n  - Depends on: B1.\n\n- [ ] **B1 — b**\n  - Depends on: A1.\n`,
    );
    try {
      expect(previewPlan(repo.rootDir).readiness).toBe("invalid");
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "PLAN.md"),
        "# P\n\n- [ ] **A1 — a**\n  - Depends on: ZZ9.\n",
      );
      expect(previewPlan(repo.rootDir).errors.join(" ")).toContain("ZZ9");

      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), "# P\n\n- [ ] **A1 — a**\n");
      importPlanFile(repo.rootDir, "PLAN.md");
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "OTHER_PLAN.md"),
        "# Other\n\n- [ ] **A1 — same id**\n",
      );
      const clash = previewPlan(repo.rootDir, "OTHER_PLAN.md");
      expect(clash.readiness).toBe("invalid");
      expect(clash.errors.join(" ")).toContain("already belongs");
    } finally {
      await repo.cleanup();
    }
  });

  it("reports no plan and ambiguous plans", async () => {
    const repo = await createTestGitRepo("aq-plan-none-");
    try {
      expect(previewPlan(repo.rootDir).readiness).toBe("no-plan");
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "PLAN_A.md"),
        "# A\n\n- [ ] **A1 — a**\n",
      );
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "PLAN_B.md"),
        "# B\n\n- [ ] **B1 — b**\n",
      );
      expect(previewPlan(repo.rootDir).readiness).toBe("ambiguous");
      expect(previewPlan(repo.rootDir, "PLAN_B.md").readiness).toBe("ready");
    } finally {
      await repo.cleanup();
    }
  });

  it("finds the only unfinished plan in a .plans subdirectory", async () => {
    const repo = await seedPlanFiles({
      "PLAN.md": "# Plan\n",
      ".plans/a/A_PLAN.md": "# A\n\n- [ ] **A1 — a**\n",
    });
    try {
      expect(previewPlan(repo.rootDir)).toMatchObject({
        planPath: ".plans/a/A_PLAN.md",
        readiness: "ready",
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("reports ambiguous plans in .plans subdirectories", async () => {
    const repo = await seedPlanFiles({
      ".plans/a/A_PLAN.md": "# A\n\n- [ ] **A1 — a**\n",
      ".plans/b/B_PLAN.md": "# B\n\n- [ ] **B1 — b**\n",
    });
    try {
      const preview = previewPlan(repo.rootDir);
      expect(preview.readiness).toBe("ambiguous");
      expect(preview.errors.join(" ")).toContain(".plans/a/A_PLAN.md");
      expect(preview.errors.join(" ")).toContain(".plans/b/B_PLAN.md");
    } finally {
      await repo.cleanup();
    }
  });

  it("filters non-plan markdown from .plans and imports its plan by file stem", async () => {
    const repo = await seedPlanFiles({
      ".plans/a/A_PLAN.md": "# A\n\n- [ ] **A1 — a**\n",
      ".plans/a/notes.md": "# Notes\n",
    });
    try {
      const preview = previewPlan(repo.rootDir);
      expect(preview.candidates.map((candidate) => candidate.path)).toEqual([".plans/a/A_PLAN.md"]);
      expect(importPlanFile(repo.rootDir, ".plans/a/A_PLAN.md").planId).toBe("plan_A_PLAN");
    } finally {
      await repo.cleanup();
    }
  });
});

describe("reserveNextTask", () => {
  it("marks reimported owner tasks without changing their existing status", async () => {
    const repo = await seedRepo("# Plan\n\n- [ ] **OWNER — Verify the physical handset.**\n");
    const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
    const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    try {
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "PLAN.md"),
        [
          "# Plan",
          "",
          "- [ ] **OWNER — Verify the physical handset.**",
          "  - Kind: owner",
          "  - Verify: none — owner task.",
          "",
        ].join("\n"),
      );
      await execCommand("git", ["add", "PLAN.md"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "mark task as owner"], repo.rootDir);
      importPlanFile(repo.rootDir, "PLAN.md");

      expect(
        db.prepare("SELECT status, failure_class FROM tasks WHERE id = 'OWNER'").get(),
      ).toEqual({ status: "pending", failure_class: "owner" });
      expect(
        await reserveNextTask(db, {
          repoRoot: repo.rootDir,
          baseBranch: "main",
          planId,
          workerSessionId: "owner-reimport",
        }),
      ).toMatchObject({ kind: "none" });
      expect(
        claimTask(db, {
          taskId: "OWNER",
          workerPid: process.pid,
          worktreePath: repo.rootDir,
          branch: "owner-reimport",
        }),
      ).toMatchObject({ success: false, reason: "OWNER_TASK" });
    } finally {
      db.close();
      await repo.cleanup();
    }
  });

  it("holds owner tasks until waived, then schedules their dependants", async () => {
    const repo = await seedRepo(
      [
        "# Plan",
        "",
        "- [ ] **OWNER — Verify the physical handset.**",
        "  - Kind: owner",
        "  - Verify: none — owner task.",
        "- [ ] **CHILD — Continue after the owner task.**",
        "  - Depends on: OWNER.",
        "  - Verify: none — docs only.",
        "",
      ].join("\n"),
    );
    const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
    const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    try {
      expect(
        db.prepare("SELECT status, failure_class FROM tasks WHERE id = 'OWNER'").get(),
      ).toEqual({ status: "blocked", failure_class: "owner" });
      const changedPlan = [
        "# Plan",
        "",
        "- [x] **OWNER — Verify the physical handset.**",
        "  - Kind: owner",
        "  - Verify: none — owner task.",
        "- [ ] **CHILD — Continue after the owner task.**",
        "  - Depends on: OWNER.",
        "  - Verify: none — docs only.",
        "",
      ].join("\n");
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), changedPlan);
      await execCommand("git", ["add", "PLAN.md"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "tick owner task"], repo.rootDir);
      importPlanFile(repo.rootDir, "PLAN.md");
      expect(db.prepare("SELECT status FROM tasks WHERE id = 'OWNER'").get()).toEqual({
        status: "blocked",
      });
      const reserve = (workerSessionId: string) =>
        reserveNextTask(db, {
          repoRoot: repo.rootDir,
          baseBranch: "main",
          planId,
          workerSessionId,
        });
      expect(await reserve("before-waiver")).toMatchObject({ kind: "none" });

      waiveTask(db, { taskId: "OWNER", reason: "Physical verification was completed manually" });
      const next = await reserve("after-waiver");
      expect(next.kind === "reserved" && next.task.taskId).toBe("CHILD");
      if (next.kind === "reserved") {
        releaseClaim(db, { ownerToken: next.task.claimToken, finalStatus: "pending" });
      }
      unwaiveTask(db, "OWNER");
      expect(await reserve("after-unwaive")).toMatchObject({ kind: "none" });
      expect(
        claimTask(db, {
          taskId: "OWNER",
          workerPid: process.pid,
          worktreePath: repo.rootDir,
          branch: "owner-claim",
        }),
      ).toMatchObject({ success: false, reason: "OWNER_TASK" });
    } finally {
      db.close();
      await repo.cleanup();
    }
  });

  it("reserves only ready tasks, one claim each, even for concurrent callers", async () => {
    const repo = await seedRepo();
    try {
      const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
      const open = () => openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const reserve = async (name: string) => {
        const db = open();
        try {
          return await reserveNextTask(db, {
            repoRoot: repo.rootDir,
            baseBranch: "main",
            planId,
            workerSessionId: name,
          });
        } finally {
          db.close();
        }
      };
      const outcomes = await Promise.all(["w1", "w2", "w3", "w4", "w5"].map(reserve));
      const reserved = outcomes.filter((outcome) => outcome.kind === "reserved");
      expect(reserved).toHaveLength(2);
      const ids = reserved.map((outcome) =>
        outcome.kind === "reserved" ? outcome.task.taskId : "",
      );
      expect(ids.sort()).toEqual(["RP1", "RP7"]);
      for (const outcome of reserved) {
        if (outcome.kind !== "reserved") continue;
        const status = await execCommand(
          "git",
          ["status", "--porcelain"],
          outcome.task.worktreePath,
        );
        expect(status.code).toBe(0);
      }
      // Worktrees live outside git status.
      const rootStatus = await execCommand("git", ["status", "--porcelain"], repo.rootDir);
      expect(rootStatus.stdout).not.toContain(".worktrees");
    } finally {
      await repo.cleanup();
    }
  });

  it("unlocks dependants only after the prerequisite completes", async () => {
    const repo = await seedRepo();
    try {
      const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const take = (name: string) =>
        reserveNextTask(db, {
          repoRoot: repo.rootDir,
          baseBranch: "main",
          planId,
          workerSessionId: name,
        });
      const a = await take("a");
      const b = await take("b");
      expect(await take("c")).toMatchObject({ kind: "none" });
      if (a.kind !== "reserved" || b.kind !== "reserved") throw new Error("expected reservations");
      const rp1 = [a, b].find((o) => o.kind === "reserved" && o.task.taskId === "RP1")!;
      if (rp1.kind !== "reserved") throw new Error("unreachable");
      releaseClaim(db, { ownerToken: rp1.task.claimToken, finalStatus: "completed" });
      const next = await take("d");
      expect(next.kind === "reserved" && next.task.taskId).toBe("RP3");
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("keeps a failed worker's commits when the task is claimed again", async () => {
    const repo = await seedRepo();
    try {
      const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const first = await reserveNextTask(db, {
        repoRoot: repo.rootDir,
        baseBranch: "main",
        planId,
        workerSessionId: "w",
      });
      if (first.kind !== "reserved") throw new Error("expected reservation");
      await NodeFSP.writeFile(NodePath.join(first.task.worktreePath, "work.txt"), "mine\n");
      await execCommand("git", ["add", "work.txt"], first.task.worktreePath);
      await execCommand("git", ["commit", "-m", "wip"], first.task.worktreePath);
      releaseClaim(db, { ownerToken: first.task.claimToken, finalStatus: "pending" });

      const again = await provisionWorktree(
        repo.rootDir,
        first.task.taskId,
        "main",
        first.task.title,
      );
      expect(again.worktreePath).toBe(first.task.worktreePath);
      const content = await NodeFSP.readFile(NodePath.join(again.worktreePath, "work.txt"), "utf8");
      expect(content).toBe("mine\n");
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("does not turn a landed task back into pending when its stale claim expires", async () => {
    const repo = await seedRepo();
    try {
      const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const first = await reserveNextTask(db, {
        repoRoot: repo.rootDir,
        baseBranch: "main",
        planId,
        workerSessionId: "w",
        leaseSeconds: 1,
      });
      if (first.kind !== "reserved") throw new Error("expected reservation");
      db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(first.task.taskId);
      db.prepare("UPDATE task_claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
      reconcileExpiredLeases(db, { isOwnerAlive: () => false });
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(first.task.taskId) as {
        status: string;
      };
      expect(row.status).toBe("completed");
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
