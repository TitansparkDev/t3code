// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Ownership, scope, generated files, merge repair, exclusive resources and recovery, on real
 * git repositories: the lifecycle guarantees behind autonomous operation.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { claimTask } from "../src/claimService.ts";
import { auditUnverifiedTasks } from "../src/audit.ts";
import { loadContract } from "../src/contract.ts";
import { auditScope, parseScopeRequests } from "../src/scopeAudit.ts";
import { runSpec } from "../src/verificationSpec.ts";
import { withResources } from "../src/resourceLocks.ts";
import { importPlanFile } from "../src/planImport.ts";
import { ensureSlot, taskEnvironment } from "../src/taskEnvironment.ts";
import { execCommand } from "./harness/gitHarness.ts";
import { makeRepo, plan, tmpDir } from "./harness/contractHarness.ts";

const CONTRACT = {
  branchPrefixes: ["agent/"],
  generated: [{ paths: ["tree.txt"], regenerate: "git ls-files | LC_ALL=C sort > tree.txt" }],
  supportingPaths: ["docs/evidence/"],
  protectedPaths: ["tools/", ".agentqueue/"],
};

const reserved = async (r: Awaited<ReturnType<typeof makeRepo>>) => {
  const outcome = await r.reserve();
  if (outcome.kind !== "reserved")
    throw new Error(`expected a reservation: ${JSON.stringify(outcome)}`);
  return outcome.task;
};

describe("scope: strict, with legitimate generated and supporting changes", () => {
  it("classifies generated, supporting and unrelated paths", () => {
    const loaded = loadContract({
      repoRoot: import.meta.dirname,
      gitCommonDir: "/nonexistent",
      refs: [],
    });
    const verdict = auditScope({
      changed: ["src/a/x.ts", "tree.txt", "docs/evidence/RP1/notes.md", "other/y.ts"],
      scope: ["src/a/"],
      contract: { ...loaded.contract, ...CONTRACT, scopeEnforcement: "strict" } as never,
      amendments: [],
    });
    expect(verdict.inScope).toEqual(["src/a/x.ts"]);
    expect(verdict.generated).toEqual(["tree.txt"]);
    expect(verdict.supporting).toEqual(["docs/evidence/RP1/notes.md"]);
    expect(verdict.violations).toEqual(["other/y.ts"]);
  });

  it("parses scope requests from a final message", () => {
    expect(
      parseScopeRequests(
        "Done.\nSCOPE-REQUEST: src/shared/util.ts, src/shared/types.ts — the new field needs both\n",
      ),
    ).toEqual([
      { paths: ["src/shared/util.ts", "src/shared/types.ts"], reason: "the new field needs both" },
    ]);
  });

  it("approves necessary files by itself, refuses protected ones, and waits for files another running task holds", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/a/" },
        { id: "B", scope: "src/b/" },
      ]),
      contract: CONTRACT,
      files: { "tree.txt": "PLAN.md\n" },
    });
    try {
      const a = await reserved(r);
      expect(a.taskId).toBe("A");
      const b = await reserved(r); // B is running too: its scope is held
      await r.commitFile(a.worktreePath, "src/a/one.ts", "1\n");
      await r.commitFile(a.worktreePath, "tree.txt", "PLAN.md\nsrc/a/one.ts\n");
      await r.commitFile(a.worktreePath, "src/shared/util.ts", "u\n");
      await r.commitFile(a.worktreePath, "src/b/stolen.ts", "s\n");
      await r.commitFile(a.worktreePath, "tools/guard.mjs", "// weakened\n");

      const first = await r.submit(a);
      expect(first.kind).toBe("scope-violation");
      if (first.kind !== "scope-violation") return;
      // The shared helper is simply granted. The protected guard is refused. B's file is B's.
      expect(first.paths).toEqual(["src/b/stolen.ts", "tools/guard.mjs"]);
      expect(first.amendment?.auto).toEqual(["src/shared/util.ts"]);
      expect(first.amendment?.waits.map((w) => w.ownerTaskId)).toEqual(["B"]);
      expect(first.amendment?.denied.map((d) => d.path)).toEqual(["tools/guard.mjs"]);
      expect(first.amendment?.denied[0]?.why).toContain("protected");

      await execCommand("git", ["rm", "-q", "src/b/stolen.ts"], a.worktreePath);
      await execCommand("git", ["checkout", r.goal, "--", "tools/guard.mjs"], a.worktreePath);
      await execCommand("git", ["commit", "-qm", "revert what is not mine"], a.worktreePath);
      const done = await r.submit(a);
      expect(done.kind).toBe("submitted");
      if (done.kind !== "submitted") return;
      expect(done.scope.generated).toEqual(["tree.txt"]);
      expect(done.scope.amended).toEqual(["src/shared/util.ts"]);
      expect(b.taskId).toBe("B");
    } finally {
      await r.repo.cleanup();
    }
  });

  it("parks a task that needs a file another running task holds, keeps its work, and resumes it when the file is free", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/a/" },
        { id: "B", scope: "src/b/" },
      ]),
      contract: CONTRACT,
    });
    try {
      const a = await reserved(r);
      const b = await reserved(r);
      await r.commitFile(a.worktreePath, "src/a/one.ts", "1\n");
      await r.commitFile(a.worktreePath, "src/b/needed.ts", "needed\n");
      const parked = await r.submit(a);
      expect(parked.kind).toBe("scope-wait");
      if (parked.kind !== "scope-wait") return;
      expect(parked.waitsFor).toEqual(["B"]);
      expect(r.task("A").status).toBe("pending");
      // Nothing is wasted on it while B holds the file.
      expect((await r.reserve()).kind).toBe("none");
      // B finishes and lands: A is handed out again, with its commit kept.
      await r.commitFile(b.worktreePath, "src/b/two.ts", "2\n");
      expect((await r.submit(b)).kind).toBe("submitted");
      expect((await r.integrate("B")).kind).toBe("landed");
      const again = await r.reserve();
      expect(again.kind).toBe("reserved");
      if (again.kind !== "reserved") return;
      expect(again.task.taskId).toBe("A");
      expect(again.task.existingCommits.length).toBeGreaterThan(0);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("does not grant a sensitive file just because it was changed, and holds a repeated attempt", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A", scope: "src/a/" }]),
      contract: CONTRACT,
    });
    try {
      const a = await reserved(r);
      await r.commitFile(a.worktreePath, "src/a/one.ts", "1\n");
      await r.commitFile(a.worktreePath, ".env", "TOKEN=1\n");
      const first = await r.submit(a);
      const second = await r.submit(a);
      expect(first.kind).toBe("scope-violation");
      expect(second.kind === "scope-violation" && second.decision.action).toBe("hold");
      expect(r.db.prepare("SELECT count(*) AS c FROM scope_amendments").get()).toEqual({ c: 0 });
      // With a reason, it is granted.
      const withReason = await r.submit(a, [
        { paths: [".env"], reason: "the integration test needs a local placeholder value" },
      ]);
      expect(withReason.kind).toBe("submitted");
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("integration: generated files are rebuilt, real conflicts are repaired from the preserved commits", () => {
  it("rebuilds a generated file that conflicts, and keeps both tasks' entries", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B" }]),
      contract: CONTRACT,
      files: { "tree.txt": "PLAN.md\n" },
    });
    try {
      const a = await reserved(r);
      const b = await reserved(r);
      await r.commitFile(a.worktreePath, "a.txt", "a\n");
      await r.commitFile(a.worktreePath, "tree.txt", "PLAN.md\na.txt\n");
      await r.commitFile(b.worktreePath, "b.txt", "b\n");
      await r.commitFile(b.worktreePath, "tree.txt", "PLAN.md\nb.txt\n");
      expect((await r.submit(a)).kind).toBe("submitted");
      expect((await r.submit(b)).kind).toBe("submitted");
      expect((await r.integrate("A")).kind).toBe("landed");
      const second = await r.integrate("B");
      expect(second.kind).toBe("landed");
      const tree = (await execCommand("git", ["show", `${r.goal}:tree.txt`], r.repo.rootDir))
        .stdout;
      expect(tree.split("\n").filter(Boolean)).toEqual(
        expect.arrayContaining(["a.txt", "b.txt", "tree.txt"]),
      );
    } finally {
      await r.repo.cleanup();
    }
  });

  it("a real conflict becomes a repair that starts from the preserved commits, and then lands", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B" }]),
      contract: CONTRACT,
      files: { "shared.txt": "base\n", "tree.txt": "PLAN.md\n" },
    });
    try {
      const a = await reserved(r);
      const b = await reserved(r);
      await r.commitFile(a.worktreePath, "shared.txt", "from A\n");
      await r.commitFile(a.worktreePath, "tree.txt", "PLAN.md\nshared.txt\n");
      await r.commitFile(b.worktreePath, "shared.txt", "from B\n");
      await r.commitFile(b.worktreePath, "tree.txt", "PLAN.md\nshared.txt\n");
      await r.submit(a);
      await r.submit(b);
      expect((await r.integrate("A")).kind).toBe("landed");
      const conflict = await r.integrate("B");
      expect(conflict.kind).toBe("needs-repair");
      if (conflict.kind !== "needs-repair") return;
      expect(conflict.files).toEqual(["shared.txt"]); // tree.txt is rebuilt, never handed to a person
      const candidate = r.task("B").candidate_commit as string;

      // B's worker is gone; its worktree is removed. The repair still gets the same commits.
      await execCommand("git", ["worktree", "remove", "--force", b.worktreePath], r.repo.rootDir);
      const repair = await reserved(r);
      expect(repair.taskId).toBe("B");
      expect(repair.repair?.candidateCommit).toBe(candidate);
      expect(repair.repair?.files).toEqual(["shared.txt"]);
      expect(repair.repair?.commits.join("\n")).toContain("work shared.txt");
      expect(
        (
          await execCommand(
            "git",
            ["merge-base", "--is-ancestor", candidate, "HEAD"],
            repair.worktreePath,
          )
        ).code,
      ).toBe(0);

      // The server already started the merge in the worktree and left only the real conflict.
      expect(repair.repair?.mergeState).toBe("conflicted");
      NodeFS.writeFileSync(NodePath.join(repair.worktreePath, "shared.txt"), "from A and B\n");
      await execCommand("git", ["add", "shared.txt"], repair.worktreePath);
      await execCommand("git", ["commit", "-qm", "resolve"], repair.worktreePath);
      expect((await r.submit(repair)).kind).toBe("submitted");
      expect((await r.integrate("B")).kind).toBe("landed");
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("ownership and recovery", () => {
  it("exactly one worker owns a task and a worktree, even when reservers race", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B" }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const outcomes = await Promise.all([r.reserve("w1"), r.reserve("w2"), r.reserve("w3")]);
      const got = outcomes.flatMap((o) => (o.kind === "reserved" ? [o.task] : []));
      expect(got.map((t) => t.taskId).sort()).toEqual(["A", "B"]);
      expect(new Set(got.map((t) => t.worktreePath)).size).toBe(2);
      expect(new Set(got.map((t) => t.branch)).size).toBe(2);
      expect(new Set(got.map((t) => t.environment.AGENTQUEUE_PORT_BASE)).size).toBe(2);
      expect(new Set(got.map((t) => t.environment.AGENTQUEUE_DB_NAME)).size).toBe(2);
      // The database refuses a second active claim on the same worktree or branch.
      const taken = got[0]!;
      r.db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'B'").run();
      const rival = claimTask(r.db, {
        taskId: "B",
        workerPid: 1,
        worktreePath: taken.worktreePath,
        branch: "agent/other",
      });
      expect(rival.success).toBe(false);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("a crashed worker's commits and edits survive and the same worktree goes to exactly one new owner", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const first = await reserved(r);
      await r.commitFile(first.worktreePath, "kept.txt", "committed\n");
      await NodeFSP.writeFile(NodePath.join(first.worktreePath, "wip.txt"), "uncommitted\n");
      // The server restarts: the lease expired and nobody renewed it.
      r.db.prepare("UPDATE task_claims SET expires_at = '2000-01-01T00:00:00.000Z'").run();
      const second = await reserved(r);
      expect(second.worktreePath).toBe(first.worktreePath);
      expect(second.branch).toBe(first.branch);
      expect(second.existingCommits.join("\n")).toContain("work kept.txt");
      expect(NodeFS.existsSync(NodePath.join(second.worktreePath, "kept.txt"))).toBe(true);
      const active = r.db
        .prepare("SELECT count(*) AS c FROM task_claims WHERE released_at IS NULL")
        .get();
      expect(active).toEqual({ c: 1 });
      // The uncommitted edit was preserved on a recovery branch before the task was handed over.
      const recovery = (
        await execCommand("git", ["branch", "--list", "recovery/*"], r.repo.rootDir)
      ).stdout;
      expect(recovery).toContain("recovery/A-");
      expect((await r.reserve()).kind).toBe("none");
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("exclusive resources and long-running checks", () => {
  it("serialises checks that need the same resource inside one process", async () => {
    const dir = await tmpDir("aq-res-");
    const log = NodePath.join(dir, "log.txt");
    const check = (name: string) => ({
      source: "declared" as const,
      checks: [
        {
          run: `node -e "const fs=require('fs');fs.appendFileSync('${log}','start ${name}\\n');setTimeout(()=>{fs.appendFileSync('${log}','end ${name}\\n')},400)"`,
          cwd: ".",
          timeoutSeconds: 30,
          requires: ["aq-db"],
          expectExitCode: 0,
        },
      ],
      exemptReason: null,
      rejected: [],
    });
    await Promise.all([
      runSpec("A", dir, check("A"), undefined, { lockDir: NodePath.join(dir, "locks") }),
      runSpec("B", dir, check("B"), undefined, { lockDir: NodePath.join(dir, "locks") }),
      runSpec("C", dir, check("C"), undefined, { lockDir: NodePath.join(dir, "locks") }),
    ]);
    const lines = NodeFS.readFileSync(log, "utf8").trim().split("\n");
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]!.replace("start ", "")).toBe(lines[i + 1]!.replace("end ", ""));
    }
  });

  it("serialises across processes through the broker, and frees a dead owner's hold", async () => {
    const dir = await tmpDir("aq-xproc-");
    const lockDir = NodePath.join(dir, "locks");
    const log = NodePath.join(dir, "log.txt");
    const script = NodePath.join(dir, "child.mts");
    NodeFS.writeFileSync(
      script,
      `import * as fs from "node:fs";
import { withResources } from ${JSON.stringify(NodePath.resolve(import.meta.dirname, "../src/resourceLocks.ts"))};
const name = process.argv[2];
await withResources(["gpu"], async () => {
  fs.appendFileSync(${JSON.stringify(log)}, "start " + name + "\\n");
  await new Promise((r) => setTimeout(r, 500));
  fs.appendFileSync(${JSON.stringify(log)}, "end " + name + "\\n");
}, ${JSON.stringify(lockDir)});
`,
    );
    const runChild = (name: string) =>
      new Promise<number | null>((resolve) =>
        NodeChildProcess.spawn(process.execPath, [script, name], {
          stdio: "ignore",
          env: {
            ...process.env,
            AGENTQUEUE_RESOURCE_HOME: dir,
            AGENTQUEUE_LOCK_ROOT: lockDir,
            AGENTQUEUE_RESOURCE_CONFIG: NodePath.join(dir, "resources.json"),
          },
        }).on("close", resolve),
      );
    NodeFS.writeFileSync(
      NodePath.join(dir, "resources.json"),
      JSON.stringify({ resources: { gpu: { capacity: 1, memoryMb: 0 } } }),
    );
    // A hold left by a process that no longer exists must not block anyone.
    const { ResourceBroker } = await import("../src/resourceBroker.ts");
    const dead = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    const broker = new ResourceBroker({
      home: dir,
      config: () => ({ reserveMb: 0, resources: { gpu: { capacity: 1, memoryMb: 0 } } }),
    });
    broker.enqueue({ resources: [{ name: "gpu" }], pid: dead.pid!, label: "left behind" });
    broker.pump();
    dead.kill("SIGKILL");
    broker.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const codes = await Promise.all([runChild("one"), runChild("two"), runChild("three")]);
    expect(codes).toEqual([0, 0, 0]);
    const lines = NodeFS.readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]!.replace("start ", "")).toBe(lines[i + 1]!.replace("end ", ""));
    }
    await withResources([], async () => undefined, lockDir);
  });

  it("waits for a long-running check and never counts one that did not finish as a pass", async () => {
    const dir = await tmpDir("aq-long-");
    const slow = (timeoutSeconds: number) => ({
      source: "declared" as const,
      checks: [
        {
          run: `node -e "setTimeout(()=>{},2500)"`,
          cwd: ".",
          timeoutSeconds,
          requires: [],
          expectExitCode: 0,
        },
      ],
      exemptReason: null,
      rejected: [],
    });
    expect((await runSpec("A", dir, slow(30))).state).toBe("passed");
    const stopped = await runSpec("A", dir, slow(1));
    expect(stopped.state).toBe("timed-out");
    expect(stopped.summary).toContain("did not finish");
  });

  it("gives every check run its task's private names", async () => {
    const dir = await tmpDir("aq-env-");
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B" }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      const slotA = ensureSlot(r.db, "A");
      const slotB = ensureSlot(r.db, "B");
      expect(slotA).not.toBe(slotB);
      const loaded = loadContract({
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        refs: ["main"],
      });
      const envA = taskEnvironment({
        taskId: "A",
        slot: slotA,
        gitCommonDir: r.repo.gitCommonDir,
        contract: loaded.contract,
      });
      const out = NodePath.join(dir, "env.txt");
      const result = await runSpec(
        "A",
        dir,
        {
          source: "declared",
          checks: [
            {
              run: `node -e "require('fs').writeFileSync('${out}', process.env.AGENTQUEUE_DB_NAME + ' ' + process.env.AGENTQUEUE_PORT_BASE)"`,
              cwd: ".",
              timeoutSeconds: 30,
              requires: [],
              expectExitCode: 0,
            },
          ],
          exemptReason: null,
          rejected: [],
        },
        undefined,
        { env: envA.variables },
      );
      expect(result.state).toBe("passed");
      expect(NodeFS.readFileSync(out, "utf8")).toBe(
        `${envA.variables.AGENTQUEUE_DB_NAME} ${envA.variables.AGENTQUEUE_PORT_BASE}`,
      );
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("landed is not checked: auditing", () => {
  it("runs a landed task's stored check against the integrated branch and turns a failure into a blocking repair", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", verify: 'node -e "process.exit(0)"' },
        { id: "B", verify: 'node -e "process.exit(2)"' },
      ]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      for (const id of ["A", "B"]) {
        r.db
          .prepare("UPDATE tasks SET status = 'completed', receipt_json = ? WHERE id = ?")
          .run(JSON.stringify({ state: "unverified" }), id);
      }
      const report = await auditUnverifiedTasks(r.db, {
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: r.goal,
        planId: r.planId,
      });
      expect(report.audited).toEqual([
        { taskId: "A", state: "passed" },
        { taskId: "B", state: "failed" },
      ]);
      expect(report.followUps).toEqual(["B-FU1"]);
      expect(r.task("B-FU1")).toMatchObject({ status: "pending" });
      // Not repeated on the same tip.
      const again = await auditUnverifiedTasks(r.db, {
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: r.goal,
        planId: r.planId,
      });
      expect(again.audited).toEqual([]);
    } finally {
      await r.repo.cleanup();
    }
  });

  it("fills in the missing check of a task imported before checks were stored, so it can be audited", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      r.db
        .prepare(
          "UPDATE tasks SET status = 'completed', verification_spec = NULL, verification_command = NULL WHERE id = 'A'",
        )
        .run();
      importPlanFile(r.repo.rootDir, "PLAN.md");
      expect(r.task("A").verification_spec).toContain("process.exit(0)");
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("generated files that land, and queue-added dependencies", () => {
  it("rebuilds the generated file list when work lands, so task branches never carry it", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }]),
      contract: {
        branchPrefixes: ["agent/"],
        generated: [
          {
            paths: ["tree.txt"],
            regenerate: "git ls-files | LC_ALL=C sort > tree.txt",
            refreshOnLand: true,
          },
        ],
      },
      files: { "tree.txt": "PLAN.md\n" },
    });
    try {
      const a = await reserved(r);
      await r.commitFile(a.worktreePath, "a.txt", "a\n");
      expect((await r.submit(a)).kind).toBe("submitted");
      expect((await r.integrate("A")).kind).toBe("landed");
      const tree = (await execCommand("git", ["show", `${r.goal}:tree.txt`], r.repo.rootDir))
        .stdout;
      expect(tree).toContain("a.txt");
    } finally {
      await r.repo.cleanup();
    }
  });

  it("re-reading the plan keeps a task waiting behind a follow-up the queue added", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A" }, { id: "B", deps: ["A"] }]),
      contract: { branchPrefixes: ["agent/"] },
    });
    try {
      r.db
        .prepare(
          "INSERT INTO tasks (id, plan_id, title, status, created_at, updated_at) VALUES ('A-FU1', ?, 'follow-up', 'blocked', 'x', 'x')",
        )
        .run(r.planId);
      r.db.prepare("UPDATE tasks SET dependencies = '[\"A\",\"A-FU1\"]' WHERE id = 'B'").run();
      importPlanFile(r.repo.rootDir, "PLAN.md");
      expect(JSON.parse(r.task("B").dependencies)).toEqual(["A", "A-FU1"]);
    } finally {
      await r.repo.cleanup();
    }
  });
});

describe("exclusive resources the repository cannot share", () => {
  it("does not keep a task from starting because another task will use the same fixed database", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", verify: 'node -e "process.exit(0)" integration-a' },
        { id: "B", verify: 'node -e "process.exit(0)" integration-b' },
      ]),
      contract: {
        branchPrefixes: ["agent/"],
        resources: [{ name: "fixed-db", limit: 1, commands: ["integration-"] }],
      },
    });
    try {
      const first = await reserved(r);
      const second = await reserved(r);
      // The database is taken per command (agentq run / the server's checks), not per task.
      expect([first.taskId, second.taskId]).toEqual(["A", "B"]);
      expect(first.resources).toEqual(["fixed-db"]);
      expect(first.notes.join(" ")).toMatch(/agentq run/);
    } finally {
      await r.repo.cleanup();
    }
  });
});
