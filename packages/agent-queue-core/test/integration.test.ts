// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { restoreSnapshot, snapshotCheckout } from "../src/checkout.ts";
import { openQueueDatabase } from "../src/db.ts";
import {
  adoptCandidate,
  ensureIntegrationBranch,
  integrateCandidate,
  integrationBranchFor,
  submitCandidate,
} from "../src/integration.ts";
import { importPlanFile } from "../src/planImport.ts";
import { publishPlan, type PublishPolicy } from "../src/publication.ts";
import { auditUnverifiedTasks } from "../src/audit.ts";
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

const SHARED = "line1\nline2\nline3\nline4\nline5\n";
const FAST: PublishPolicy = { reconcileAbandoned: true, idleMinutes: 0 };

async function setup() {
  const repo = await createTestGitRepo("aq-integration-");
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), PLAN);
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, "shared.txt"), SHARED);
  await execCommand("git", ["add", "."], repo.rootDir);
  await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
  const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
  const goal = integrationBranchFor(planId);
  ensureIntegrationBranch(repo.rootDir, "main", goal);
  const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
  db.prepare("UPDATE plans SET integration_branch = ?, base_branch = 'main' WHERE id = ?").run(
    goal,
    planId,
  );
  const reserve = async (name: string) => {
    const outcome = await reserveNextTask(db, {
      repoRoot: repo.rootDir,
      baseBranch: goal,
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
      baseBranch: goal,
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
      integrationBranch: goal,
      taskId,
    });
  const publish = (policy: PublishPolicy = FAST) =>
    publishPlan(db, {
      repoRoot: repo.rootDir,
      gitCommonDir: repo.gitCommonDir,
      baseBranch: "main",
      integrationBranch: goal,
      planId,
      policy,
    });
  const status = (id: string) =>
    db
      .prepare("SELECT status, integration_state, integration_error FROM tasks WHERE id = ?")
      .get(id) as {
      status: string;
      integration_state: string | null;
      integration_error: string | null;
    };
  const rev = async (ref: string) =>
    (await execCommand("git", ["rev-parse", ref], repo.rootDir)).stdout.trim();
  const show = async (ref: string, file: string) =>
    (await execCommand("git", ["show", `${ref}:${file}`], repo.rootDir)).stdout;
  const finish = async (id: string, file: string, content: string) => {
    const task = await reserve(`w-${id}`);
    await commitFile(task.worktreePath, file, content);
    await submit(task);
    return { task, outcome: await integrate(task.taskId) };
  };
  return {
    repo,
    db,
    planId,
    goal,
    reserve,
    commitFile,
    submit,
    integrate,
    publish,
    status,
    rev,
    show,
    finish,
  };
}

describe("integration branch", () => {
  it("integrates a candidate into the plan branch and leaves the target branch alone", async () => {
    const t = await setup();
    try {
      const mainBefore = await t.rev("main");
      const { task, outcome } = await t.finish("a1", "a1.txt", "one\n");
      expect(outcome.kind).toBe("landed");
      expect(t.status(task.taskId)).toMatchObject({ status: "completed", integration_state: null });
      expect(await t.show(t.goal, "a1.txt")).toBe("one\n");
      expect(await t.rev("main")).toBe(mainBefore);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("the RP1 case: a verified candidate overlapping old dirty edits still integrates, and dependants start from it", async () => {
    const t = await setup();
    try {
      // Older uncommitted edit in the shared checkout, on the file the task also changes.
      await NodeFSP.writeFile(
        NodePath.join(t.repo.rootDir, "shared.txt"),
        "line1\nline2\nline3\nline4\nEDITED\n",
      );
      const first = await t.finish("a1", "shared.txt", "TASK\nline2\nline3\nline4\nline5\n");
      expect(first.outcome.kind).toBe("landed");
      const second = await t.finish("a2", "a2.txt", "two\n");
      expect(second.outcome.kind).toBe("landed");

      // The dependant becomes ready and its worktree already contains both predecessors.
      const third = await t.reserve("w-a3");
      expect(third.taskId).toBe("A3");
      expect(await NodeFSP.readFile(NodePath.join(third.worktreePath, "a2.txt"), "utf8")).toBe(
        "two\n",
      );
      expect(
        (
          await NodeFSP.readFile(NodePath.join(third.worktreePath, "shared.txt"), "utf8")
        ).startsWith("TASK"),
      ).toBe(true);
      // The shared checkout was never touched.
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "line1\nline2\nline3\nline4\nEDITED\n",
      );
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("two workers editing overlapping files in separate worktrees both integrate, the second via a verified merge", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("wa");
      const b = await t.reserve("wb");
      await t.commitFile(a.worktreePath, "shared.txt", "A1\nline2\nline3\nline4\nline5\n");
      await t.commitFile(b.worktreePath, "shared.txt", "line1\nline2\nline3\nline4\nB1\n");
      await t.submit(a);
      await t.submit(b);
      expect((await t.integrate(a.taskId)).kind).toBe("landed");
      expect((await t.integrate(b.taskId)).kind).toBe("landed");
      expect(await t.show(t.goal, "shared.txt")).toBe("A1\nline2\nline3\nline4\nB1\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("an ordinary conflict becomes a repair, keeps the commits, and integrates after the repair", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("wa");
      const b = await t.reserve("wb");
      await t.commitFile(a.worktreePath, "shared.txt", "from a\n");
      await t.commitFile(b.worktreePath, "shared.txt", "from b\n");
      await t.submit(a);
      await t.submit(b);
      expect((await t.integrate(a.taskId)).kind).toBe("landed");
      expect(await t.integrate(b.taskId)).toMatchObject({ kind: "needs-repair", exhausted: false });
      expect(t.status(b.taskId)).toMatchObject({
        status: "verifying",
        integration_state: "conflict",
      });

      const repair = await reserveNextTask(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: t.goal,
        planId: t.planId,
        workerSessionId: "repair",
      });
      if (repair.kind !== "reserved") throw new Error("expected a repair reservation");
      expect(repair.task.taskId).toBe(b.taskId);
      await execCommand("git", ["rebase", t.goal], b.worktreePath);
      await NodeFSP.writeFile(NodePath.join(b.worktreePath, "shared.txt"), "from a and b\n");
      await execCommand("git", ["add", "shared.txt"], b.worktreePath);
      await execCommand("git", ["-c", "core.editor=true", "rebase", "--continue"], b.worktreePath);
      expect((await t.submit(repair.task)).kind).toBe("submitted");
      expect((await t.integrate(b.taskId)).kind).toBe("landed");
      expect(await t.show(t.goal, "shared.txt")).toBe("from a and b\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("hands a candidate to the overseer once automatic repair is spent, and keeps a failed repair's commits", async () => {
    const t = await setup();
    try {
      const a = await t.reserve("wa");
      const b = await t.reserve("wb");
      await t.commitFile(a.worktreePath, "shared.txt", "from a\n");
      await t.commitFile(b.worktreePath, "shared.txt", "from b\n");
      await t.submit(a);
      await t.submit(b);
      await t.integrate(a.taskId);
      await t.integrate(b.taskId);
      const repair = await reserveNextTask(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: t.goal,
        planId: t.planId,
        workerSessionId: "repair",
      });
      if (repair.kind !== "reserved") throw new Error("expected repair");
      releaseClaimForRetry(t.db, repair.task.claimToken, "repair worker gave up");
      expect(t.status(b.taskId).integration_state).toBe("conflict");
      // The committed work is untouched; the worktree keeps the merge the server started for the owner.
      expect(
        (await execCommand("git", ["show", `${b.branch}:shared.txt`], t.repo.rootDir)).stdout,
      ).toBe("from b\n");
      expect(await NodeFSP.readFile(NodePath.join(b.worktreePath, "shared.txt"), "utf8")).toContain(
        "<<<<<<<",
      );
      let last = await t.integrate(b.taskId);
      for (let i = 0; i < 4 && last.kind !== "needs-repair"; i++) {
        t.db.prepare("UPDATE tasks SET integration_state = 'pending' WHERE id = ?").run(b.taskId);
        last = await t.integrate(b.taskId);
      }
      t.db
        .prepare(
          "UPDATE tasks SET integration_state = 'pending', integration_attempts = 3 WHERE id = ?",
        )
        .run(b.taskId);
      expect(await t.integrate(b.taskId)).toMatchObject({ kind: "needs-repair", exhausted: true });
      expect(t.status(b.taskId).integration_state).toBe("repair_needed");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("recognises an integration that happened before the database was updated", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w");
      await t.commitFile(task.worktreePath, "a1.txt", "one\n");
      await t.submit(task);
      const candidate = await t.rev(task.branch);
      // The branch moved (the process died right after), the record did not.
      await execCommand("git", ["update-ref", `refs/heads/${t.goal}`, candidate], t.repo.rootDir);
      expect(await t.integrate(task.taskId)).toMatchObject({ kind: "landed", reconciled: true });
      expect((await t.integrate(task.taskId)).kind).toBe("not-pending");
      const rows = t.db
        .prepare("SELECT count(*) AS n FROM landing_queue WHERE task_id = ?")
        .get(task.taskId);
      expect(rows).toMatchObject({ n: 1 });
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
      await adoptCandidate(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: t.goal,
        taskId: "A1",
        branch: "codex/preserved",
      });
      expect((await t.integrate("A1")).kind).toBe("landed");
      expect(await t.show(t.goal, "kept.txt")).toBe("kept\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });
});

describe("publication", () => {
  it("publishes with no checkout involved when the target branch is not checked out", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "a1.txt", "one\n");
      await execCommand("git", ["checkout", "--detach"], t.repo.rootDir);
      expect((await t.publish()).kind).toBe("published");
      expect(await t.show("main", "a1.txt")).toBe("one\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("fast-forwards past unrelated dirty edits and leaves them in place", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "a1.txt", "one\n");
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "shared.txt"), "mine\n");
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "scratch.txt"), "notes\n");
      expect((await t.publish()).kind).toBe("published");
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "mine\n",
      );
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "a1.txt"), "utf8")).toBe("one\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("waits, changing nothing, while a process is active in a checkout with overlapping edits", async () => {
    const t = await setup();
    const holder = NodeChildProcess.spawn("sleep", ["300"], {
      cwd: t.repo.rootDir,
      stdio: "ignore",
    });
    try {
      await t.finish("a1", "shared.txt", "TASK\nline2\nline3\nline4\nline5\n");
      await NodeFSP.writeFile(
        NodePath.join(t.repo.rootDir, "shared.txt"),
        "line1\nline2\nline3\nline4\nEDITED\n",
      );
      const before = await t.rev("main");
      const outcome = await t.publish();
      expect(outcome).toMatchObject({ kind: "pending", cause: "active-owner" });
      expect(await t.rev("main")).toBe(before);
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "line1\nline2\nline3\nline4\nEDITED\n",
      );
      expect(
        t.db.prepare("SELECT publication_state AS s FROM plans WHERE id = ?").get(t.planId),
      ).toMatchObject({ s: "pending" });
      // The verified result is still there, and the owner leaving lets it publish by itself.
      expect(await t.show(t.goal, "shared.txt")).toBe("TASK\nline2\nline3\nline4\nline5\n");
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
      expect((await t.publish()).kind).toBe("published");
    } finally {
      holder.kill();
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("preserves abandoned edits in a snapshot, reconciles them on top, and can restore them exactly", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "shared.txt", "TASK\nline2\nline3\nline4\nline5\n");
      const dirty = "line1\nline2\nline3\nline4\nEDITED\n";
      const file = NodePath.join(t.repo.rootDir, "shared.txt");
      await NodeFSP.writeFile(file, dirty);
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "untouched.txt"), "keep\n");
      const old = new Date("2000-01-01T00:00:00.000Z");
      NodeFS.utimesSync(file, old, old);
      const outcome = await t.publish({ reconcileAbandoned: true, idleMinutes: 30 });
      expect(outcome.kind).toBe("published");
      const snapshotId = outcome.kind === "published" ? outcome.snapshotId : undefined;
      expect(snapshotId).toBeDefined();
      // The checkout now has the plan's change with the old edit still on top, uncommitted.
      expect(await NodeFSP.readFile(file, "utf8")).toBe("TASK\nline2\nline3\nline4\nEDITED\n");
      expect(
        (await execCommand("git", ["status", "--porcelain"], t.repo.rootDir)).stdout,
      ).toContain("shared.txt");
      expect(await t.rev("main")).toBe(await t.rev(t.goal));
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "untouched.txt"), "utf8")).toBe(
        "keep\n",
      );

      // The snapshot can put the original state back precisely.
      await execCommand("git", ["reset", "--hard", "HEAD~1"], t.repo.rootDir);
      await NodeFSP.writeFile(file, "something else\n");
      restoreSnapshot(t.repo.gitCommonDir, snapshotId!, t.repo.rootDir);
      expect(await NodeFSP.readFile(file, "utf8")).toBe(dirty);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("does not treat recent edits as abandoned", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "shared.txt", "TASK\nline2\nline3\nline4\nline5\n");
      await NodeFSP.writeFile(
        NodePath.join(t.repo.rootDir, "shared.txt"),
        "line1\nline2\nline3\nline4\nEDITED\n",
      );
      expect(await t.publish({ reconcileAbandoned: true, idleMinutes: 30 })).toMatchObject({
        kind: "pending",
        cause: "recent-edits",
      });
      expect(await t.publish({ reconcileAbandoned: false, idleMinutes: 0 })).toMatchObject({
        kind: "pending",
        cause: "policy",
      });
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("leaves a checkout untouched when an old edit conflicts with the change, or is staged", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "shared.txt", "TASK\nline2\nline3\nline4\nline5\n");
      const file = NodePath.join(t.repo.rootDir, "shared.txt");
      await NodeFSP.writeFile(file, "OTHER\nline2\nline3\nline4\nline5\n");
      expect(await t.publish()).toMatchObject({ kind: "pending", cause: "conflicting-edits" });
      expect(await NodeFSP.readFile(file, "utf8")).toBe("OTHER\nline2\nline3\nline4\nline5\n");
      await execCommand("git", ["add", "shared.txt"], t.repo.rootDir);
      expect(await t.publish()).toMatchObject({ kind: "pending", cause: "staged-changes" });
      expect(
        (
          await execCommand("git", ["diff", "--cached", "--name-only"], t.repo.rootDir)
        ).stdout.trim(),
      ).toBe("shared.txt");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("recognises a publication that happened before it was recorded", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "a1.txt", "one\n");
      await execCommand("git", ["merge", "--ff-only", t.goal], t.repo.rootDir);
      expect(await t.publish()).toMatchObject({ kind: "published", reconciled: true });
      expect(
        t.db.prepare("SELECT publication_state AS s FROM plans WHERE id = ?").get(t.planId),
      ).toMatchObject({ s: "published" });
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("brings in commits that landed on the target meanwhile, and blocks on a real conflict", async () => {
    const t = await setup();
    try {
      await t.finish("a1", "a1.txt", "one\n");
      await t.commitFile(t.repo.rootDir, "other.txt", "elsewhere\n", "someone else");
      expect((await t.publish()).kind).toBe("published");
      expect(await t.show("main", "a1.txt")).toBe("one\n");
      expect(await t.show("main", "other.txt")).toBe("elsewhere\n");
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
    const c = await setup();
    try {
      await c.finish("a1", "shared.txt", "TASK\nline2\nline3\nline4\nline5\n");
      await c.commitFile(
        c.repo.rootDir,
        "shared.txt",
        "THEIRS\nline2\nline3\nline4\nline5\n",
        "someone else",
      );
      expect(await c.publish()).toMatchObject({ kind: "blocked" });
      expect(
        c.db.prepare("SELECT publication_state AS s FROM plans WHERE id = ?").get(c.planId),
      ).toMatchObject({ s: "blocked" });
    } finally {
      c.db.close();
      await c.repo.cleanup();
    }
  });

  it("snapshots capture untracked and modified files byte for byte", async () => {
    const t = await setup();
    try {
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "shared.txt"), "changed\n");
      await NodeFSP.writeFile(
        NodePath.join(t.repo.rootDir, "new.bin"),
        Buffer.from([0, 1, 2, 255]),
      );
      const snapshot = snapshotCheckout(t.repo.rootDir, t.repo.gitCommonDir);
      expect(snapshot.files.map((f) => f.path).sort()).toEqual(["new.bin", "shared.txt"]);
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "shared.txt"), "lost\n");
      NodeFS.unlinkSync(NodePath.join(t.repo.rootDir, "new.bin"));
      restoreSnapshot(t.repo.gitCommonDir, snapshot.id, t.repo.rootDir);
      expect(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "shared.txt"), "utf8")).toBe(
        "changed\n",
      );
      expect([...(await NodeFSP.readFile(NodePath.join(t.repo.rootDir, "new.bin")))]).toEqual([
        0, 1, 2, 255,
      ]);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });
});

/** A workspace package that declares a dependency nothing installs in the checkout it is checked in. */
const MANIFEST = '{"name":"fixture","dependencies":{"external-dep":"1.0.0"}}';

/** Keeps installed dependency folders out of every worktree's commits (the exclude file is shared). */
async function ignoreDependencyFolders(gitCommonDir: string) {
  await NodeFSP.mkdir(NodePath.join(gitCommonDir, "info"), { recursive: true });
  await NodeFSP.appendFile(NodePath.join(gitCommonDir, "info", "exclude"), "node_modules/\n");
}

const installDependency = (dir: string) =>
  NodeFSP.mkdir(NodePath.join(dir, "node_modules", "external-dep"), { recursive: true });

describe("verification dependencies", () => {
  it("repairs one baseline failure with its prerequisite closure and original evidence", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w-a1");
      await t.commitFile(task.worktreePath, "candidate.txt", "scoped candidate change\n");
      const checks = [
        {
          id: "producer",
          run: 'node -e "process.exit(0)"',
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
        },
        {
          id: "middle",
          run: 'node -e "console.log(\\\"src/legacy.test.ts FAILED\\\"); process.exit(1)"',
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
          dependsOn: ["producer"],
          reuseInputs: ["src"],
        },
        {
          id: "consumer",
          run: 'node -e "process.exit(0)"',
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
          dependsOn: ["middle"],
        },
        {
          id: "independent",
          run: 'node -e "process.exit(0)"',
          cwd: ".",
          timeoutSeconds: 30,
          requires: [],
          expectExitCode: 0,
        },
      ];
      t.db
        .prepare("UPDATE tasks SET verification_spec = ? WHERE id = ?")
        .run(
          JSON.stringify({ source: "declared", checks, exemptReason: null, rejected: [] }),
          task.taskId,
        );
      const submitted = await t.submit(task);
      expect(submitted.kind).toBe("submitted");
      const followUps = t.db
        .prepare("SELECT id, verification_spec FROM tasks WHERE id LIKE 'A1-FU%'")
        .all() as Array<{ id: string; verification_spec: string }>;
      expect(followUps).toHaveLength(1);
      const repair = followUps[0]!;
      const repairSpec = JSON.parse(repair.verification_spec) as {
        checks: Array<{ id: string }>;
      };
      expect(repairSpec.checks.map((check) => check.id)).toEqual(["producer", "middle"]);
      const event = t.db
        .prepare(
          "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task_followup_created'",
        )
        .get(repair.id) as { payload_json: string };
      expect(JSON.parse(event.payload_json)).toMatchObject({
        repairEvidence: {
          failedCheckId: "middle",
          producerDependencyIds: ["producer"],
          inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          diagnostics: {
            failureKind: "exit-code",
            diagnosticExcerpt: expect.stringContaining("src/legacy.test.ts FAILED"),
          },
        },
      });
      const receipt = t.db.prepare("SELECT receipt_json FROM tasks WHERE id = 'A1'").get() as {
        receipt_json: string;
      };
      const savedReceipt = JSON.parse(receipt.receipt_json) as {
        checks: Array<{ checkId?: string; passed: boolean }>;
      };
      expect(savedReceipt.checks.map((check) => check.checkId)).toEqual([
        "producer",
        "middle",
        "consumer",
        "independent",
      ]);
      expect(savedReceipt.checks.find((check) => check.checkId === "consumer")?.passed).toBe(false);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("stops a candidate whose dependencies are not installed before any check, with no repair", async () => {
    const t = await setup();
    try {
      const task = await t.reserve("w-a1");
      await t.commitFile(task.worktreePath, "package.json", MANIFEST);
      const submitted = await t.submit(task);
      expect(submitted).toMatchObject({
        kind: "verification-failed",
        failureClass: "prerequisite",
      });
      expect(submitted).toMatchObject({
        error: expect.stringContaining("Dependency preparation failed at candidate"),
      });
      expect(submitted).toMatchObject({ error: expect.stringContaining("external-dep") });
      const repairs = t.db.prepare("SELECT id FROM tasks WHERE id LIKE 'A1-FU%'").all();
      expect(repairs).toEqual([]);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("waits for the machine, with no repair, when the merged result cannot resolve a dependency", async () => {
    const t = await setup();
    try {
      await ignoreDependencyFolders(t.repo.gitCommonDir);
      const a1 = await t.reserve("w-a1");
      await t.commitFile(a1.worktreePath, "package.json", MANIFEST);
      await installDependency(a1.worktreePath);
      expect((await t.submit(a1)).kind).toBe("submitted");
      expect((await t.finish("a2", "a2.txt", "two\n")).outcome.kind).toBe("landed");
      const outcome = await t.integrate(a1.taskId);
      expect(outcome).toMatchObject({ kind: "environment-wait" });
      expect(outcome).toMatchObject({
        reason: expect.stringContaining("Dependency preparation failed at staged integration"),
      });
      expect(t.db.prepare("SELECT id FROM tasks WHERE id LIKE 'A1-FU%'").all()).toEqual([]);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("keeps a publication pending, not blocked by code, when the final check cannot resolve its dependencies", async () => {
    const t = await setup();
    try {
      await ignoreDependencyFolders(t.repo.gitCommonDir);
      const a1 = await t.reserve("w-a1");
      await t.commitFile(a1.worktreePath, "package.json", MANIFEST);
      await installDependency(a1.worktreePath);
      await t.submit(a1);
      expect((await t.integrate(a1.taskId)).kind).toBe("landed");
      // The target moves on its own, so the result must be combined before publishing.
      await NodeFSP.writeFile(NodePath.join(t.repo.rootDir, "main-only.txt"), "main\n");
      await execCommand("git", ["add", "main-only.txt"], t.repo.rootDir);
      await execCommand("git", ["commit", "-m", "main moves"], t.repo.rootDir);
      t.db
        .prepare("UPDATE plans SET final_verification = ? WHERE id = ?")
        .run('node -e "process.exit(0)"', t.planId);
      const outcome = await t.publish();
      expect(outcome).toMatchObject({ kind: "pending", cause: "environment" });
      expect(outcome).toMatchObject({
        reason: expect.stringContaining("Dependency preparation failed at publication"),
      });
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("an audit whose checkout cannot resolve dependencies records a wait, not a repair", async () => {
    const t = await setup();
    try {
      await ignoreDependencyFolders(t.repo.gitCommonDir);
      const a1 = await t.reserve("w-a1");
      await t.commitFile(a1.worktreePath, "package.json", MANIFEST);
      await installDependency(a1.worktreePath);
      await t.submit(a1);
      expect((await t.integrate(a1.taskId)).kind).toBe("landed");
      t.db
        .prepare("UPDATE tasks SET receipt_json = '{\"state\":\"unverified\"}' WHERE id = 'A1'")
        .run();
      const report = await auditUnverifiedTasks(t.db, {
        repoRoot: t.repo.rootDir,
        gitCommonDir: t.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: t.goal,
        planId: t.planId,
      });
      expect(report).toMatchObject({ audited: [], followUps: [] });
      const waits = t.db
        .prepare(
          "SELECT id FROM task_events WHERE task_id = 'A1' AND event_type = 'task_audit_environment_wait'",
        )
        .all();
      expect(waits.length).toBeGreaterThan(0);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });

  it("an audit whose dependencies resolve still opens a repair for a check that really fails", async () => {
    const t = await setup();
    try {
      await ignoreDependencyFolders(t.repo.gitCommonDir);
      const a1 = await t.reserve("w-a1");
      await t.commitFile(a1.worktreePath, "package.json", MANIFEST);
      await installDependency(a1.worktreePath);
      await t.submit(a1);
      expect((await t.integrate(a1.taskId)).kind).toBe("landed");
      await installDependency(t.repo.rootDir);
      t.db
        .prepare(
          "UPDATE tasks SET receipt_json = '{\"state\":\"unverified\"}', verification_spec = NULL, verification_command = ? WHERE id = 'A1'",
        )
        .run('node -e "process.exit(1)"');
      const report = await auditUnverifiedTasks(t.db, {
        repoRoot: t.repo.rootDir,
        gitCommonDir: t.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: t.goal,
        planId: t.planId,
      });
      expect(report.audited).toEqual([{ taskId: "A1", state: "failed" }]);
      expect(report.followUps).toHaveLength(1);
    } finally {
      t.db.close();
      await t.repo.cleanup();
    }
  });
});
