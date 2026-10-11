// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { adoptCandidate, integrateCandidate, submitCandidate } from "../src/integration.ts";
import { importPlanFile } from "../src/planImport.ts";
import { releaseClaimForRetry } from "../src/claimService.ts";
import { reserveNextTask } from "../src/reservation.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

const PLAN = `# Plan

- [ ] **A1 — First**
  - Depends on: none.
  - Verify: node -e "process.exit(0)"

- [ ] **A2 — Second**
  - Depends on: none.
  - Verify: node -e "process.exit(0)"

- [ ] **A3 — Needs both**
  - Depends on: A1, A2.
`;

async function setup() {
  const repo = await createTestGitRepo("aq-integration-");
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), PLAN);
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, "shared.txt"), "base\n");
  await execCommand("git", ["add", "."], repo.rootDir);
  await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
  const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
  const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
  const reserve = async (name: string) => {
    const outcome = await reserveNextTask(db, {
      repoRoot: repo.rootDir,
      baseBranch: "main",
      planId,
      workerSessionId: name,
    });
    if (outcome.kind !== "reserved") throw new Error("expected a reservation");
    return outcome.task;
  };
  const commitFile = async (cwd: string, file: string, content: string, message = "work") => {
    await NodeFSP.writeFile(NodePath.join(cwd, file), content);
    await execCommand("git", ["add", file], cwd);
    await execCommand("git", ["commit", "-m", message], cwd);
  };
  const submit = async (task: Awaited<ReturnType<typeof reserve>>) =>
    submitCandidate(db, {
      repoRoot: repo.rootDir,
      baseBranch: "main",
      taskId: task.taskId,
      claimToken: task.claimToken,
      worktreePath: task.worktreePath,
      branch: task.branch,
      verificationCommand: task.verificationCommand ?? "",
    });
  const integrate = (taskId: string) =>
    integrateCandidate(db, {
      repoRoot: repo.rootDir,
      gitCommonDir: repo.gitCommonDir,
      baseBranch: "main",
      taskId,
    });
  const status = (id: string) =>
    db
      .prepare("SELECT status, integration_state, integration_error FROM tasks WHERE id = ?")
      .get(id) as {
      status: string;
      integration_state: string | null;
      integration_error: string | null;
    };
  return { repo, db, planId, reserve, commitFile, submit, integrate, status };
}

describe("candidate integration", () => {
  it("submits work as a candidate, then lands it without the worker", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w1");
      await t.commitFile(task.worktreePath, "a1.txt", "one\n");
      const submitted = await t.submit(task);
      expect(submitted.kind).toBe("submitted");
      // Submitted work is a candidate, not unimplemented work, and holds no claim.
      expect(t.status(task.taskId)).toMatchObject({
        status: "verifying",
        integration_state: "pending",
      });
      expect(
        t.db.prepare("SELECT count(*) AS n FROM task_claims WHERE released_at IS NULL").get(),
      ).toMatchObject({ n: 0 });

      const landed = await t.integrate(task.taskId);
      expect(landed.kind).toBe("landed");
      expect(t.status(task.taskId)).toMatchObject({ status: "completed", integration_state: null });
      const log = await execCommand("git", ["log", "--oneline", "main"], t.repo.rootDir);
      expect(log.stdout).toContain("work");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("rejects a submission with no commits and keeps the claim", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w1");
      expect((await t.submit(task)).kind).toBe("no-changes");
      expect(t.status(task.taskId).status).toBe("claimed");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("lands past an unrelated dirty shared checkout and never touches its edits", async () => {
    const t = await setup();
    try {
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "shared.txt"), "someone else's edit\n");
      const task = await t.reserve("w1");
      await t.commitFile(task.worktreePath, "a1.txt", "one\n");
      await t.submit(task);
      expect((await t.integrate(task.taskId)).kind).toBe("landed");
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "someone else's edit\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "a1.txt"), "utf8")).toBe("one\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("defers, without losing the candidate, while the checkout has overlapping edits, then lands by itself", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w1");
      await t.commitFile(task.worktreePath, "shared.txt", "task version\n");
      const candidate = (
        await execCommand("git", ["rev-parse", "HEAD"], task.worktreePath)
      ).stdout.trim();
      await t.submit(task);
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "shared.txt"), "uncommitted edit\n");

      const first = await t.integrate(task.taskId);
      expect(first.kind).toBe("deferred");
      expect(first.kind === "deferred" && first.files).toEqual(["shared.txt"]);
      expect(t.status(task.taskId)).toMatchObject({
        status: "verifying",
        integration_state: "pending",
      });
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "uncommitted edit\n",
      );
      const stored = t.db
        .prepare("SELECT candidate_commit FROM tasks WHERE id = ?")
        .get(task.taskId) as {
        candidate_commit: string;
      };
      expect(stored.candidate_commit).toBe(candidate);

      // The other person finishes with the file; the next automatic retry lands.
      await execCommand("git", ["checkout", "--", "shared.txt"], t.repo.rootDir);
      expect((await t.integrate(task.taskId)).kind).toBe("landed");
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "task version\n",
      );
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("rebases work onto a moved base and verifies the merged result", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("w1");
      const b = await t.reserve("w2");
      await t.commitFile(a.worktreePath, "a.txt", "a\n");
      await t.commitFile(b.worktreePath, "b.txt", "b\n");
      await t.submit(a);
      await t.submit(b);
      const [first, second] = await Promise.all([t.integrate(a.taskId), t.integrate(b.taskId)]);
      expect([first.kind, second.kind]).toEqual(["landed", "landed"]);
      const files = await execCommand(
        "git",
        ["ls-tree", "-r", "--name-only", "main"],
        t.repo.rootDir,
      );
      expect(files.stdout).toContain("a.txt");
      expect(files.stdout).toContain("b.txt");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("turns a merge conflict into a repair, keeps the commits, and lands after the repair", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("w1");
      const b = await t.reserve("w2");
      await t.commitFile(a.worktreePath, "shared.txt", "from a\n");
      await t.commitFile(b.worktreePath, "shared.txt", "from b\n");
      await t.submit(a);
      await t.submit(b);
      expect((await t.integrate(a.taskId)).kind).toBe("landed");

      const conflict = await t.integrate(b.taskId);
      expect(conflict).toMatchObject({ kind: "needs-repair", exhausted: false });
      expect(t.status(b.taskId)).toMatchObject({
        status: "verifying",
        integration_state: "conflict",
      });
      expect(await NodeFSP.readFile(NodePath.join(b.worktreePath, "shared.txt"), "utf8")).toBe(
        "from b\n",
      );

      // A repair worker is assigned the candidate, not an unimplemented task.
      const repairOutcome = await reserveNextTask(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: "main",
        planId: t.planId,
        workerSessionId: "repair",
      });
      if (repairOutcome.kind !== "reserved") throw new Error("expected a repair reservation");
      expect(repairOutcome.task.taskId).toBe(b.taskId);
      expect(repairOutcome.task.repair?.reason).toContain("shared.txt");
      expect(repairOutcome.task.worktreePath).toBe(b.worktreePath);
      expect(t.status(b.taskId).integration_state).toBe("repairing");

      await execCommand("git", ["rebase", "main"], b.worktreePath); // stops on the conflict
      await NodeFSP.writeFile(NodePath.join(b.worktreePath, "shared.txt"), "from a and b\n");
      await execCommand("git", ["add", "shared.txt"], b.worktreePath);
      await execCommand("git", ["-c", "core.editor=true", "rebase", "--continue"], b.worktreePath);

      expect((await t.submit(repairOutcome.task)).kind).toBe("submitted");
      expect((await t.integrate(b.taskId)).kind).toBe("landed");
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "from a and b\n",
      );
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("hands a candidate to the overseer once automatic repair is spent", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("w1");
      const b = await t.reserve("w2");
      await t.commitFile(a.worktreePath, "shared.txt", "from a\n");
      await t.commitFile(b.worktreePath, "shared.txt", "from b\n");
      await t.submit(a);
      await t.submit(b);
      await t.integrate(a.taskId);
      let last = await t.integrate(b.taskId);
      for (
        let attempt = 0;
        attempt < 3 && last.kind === "needs-repair" && !last.exhausted;
        attempt++
      ) {
        t.db.prepare("UPDATE tasks SET integration_state = 'pending' WHERE id = ?").run(b.taskId);
        last = await t.integrate(b.taskId);
      }
      expect(last).toMatchObject({ kind: "needs-repair", exhausted: true });
      expect(t.status(b.taskId).integration_state).toBe("repair_needed");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("recognises a merge that happened before the database was updated", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w1");
      await t.commitFile(task.worktreePath, "a1.txt", "one\n");
      await t.submit(task);
      const candidate = (
        await execCommand("git", ["rev-parse", "HEAD"], task.worktreePath)
      ).stdout.trim();
      await execCommand("git", ["merge", "--ff-only", candidate], t.repo.rootDir);

      const outcome = await t.integrate(task.taskId);
      expect(outcome).toMatchObject({ kind: "landed", reconciled: true });
      expect(t.status(task.taskId).status).toBe("completed");
      // Repeating is harmless.
      expect((await t.integrate(task.taskId)).kind).toBe("not-pending");
      const landings = t.db
        .prepare("SELECT count(*) AS n FROM landing_queue WHERE task_id = ?")
        .get(task.taskId);
      expect(landings).toMatchObject({ n: 1 });
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("keeps a failed repair's commits and escalates after the budget", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("w1");
      const b = await t.reserve("w2");
      await t.commitFile(a.worktreePath, "shared.txt", "from a\n");
      await t.commitFile(b.worktreePath, "shared.txt", "from b\n");
      await t.submit(a);
      await t.submit(b);
      await t.integrate(a.taskId);
      await t.integrate(b.taskId);
      const repair = await reserveNextTask(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: "main",
        planId: t.planId,
        workerSessionId: "repair",
      });
      if (repair.kind !== "reserved") throw new Error("expected repair");
      releaseClaimForRetry(t.db, repair.task.claimToken, "repair worker gave up");
      expect(t.status(b.taskId).integration_state).toBe("conflict");
      expect(await NodeFSP.readFile(NodePath.join(b.worktreePath, "shared.txt"), "utf8")).toBe(
        "from b\n",
      );
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("adopts a preserved branch as a candidate without redoing the work", async () => {
    const t = await setup();
    try {
      await execCommand("git", ["checkout", "-b", "codex/preserved"], t.repo.rootDir);
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "kept.txt"), "kept\n");
      await execCommand("git", ["add", "kept.txt"], t.repo.rootDir);
      await execCommand("git", ["commit", "-m", "preserved work"], t.repo.rootDir);
      await execCommand("git", ["checkout", "main"], t.repo.rootDir);

      const adopted = await adoptCandidate(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: "main",
        taskId: "A1",
        branch: "codex/preserved",
      });
      expect(adopted.commit).toHaveLength(40);
      expect(t.status("A1")).toMatchObject({ status: "verifying", integration_state: "pending" });
      expect((await t.integrate("A1")).kind).toBe("landed");
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "kept.txt"), "utf8")).toBe(
        "kept\n",
      );
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });
});
