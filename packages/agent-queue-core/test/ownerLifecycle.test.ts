// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { auditUnverifiedTasks } from "../src/audit.ts";
import { bindOwner, ownerOf } from "../src/taskOwner.ts";
import { execCommand } from "./harness/gitHarness.ts";
import { makeRepo, plan } from "./harness/contractHarness.ts";

const CONTRACT = { branchPrefixes: ["agent/"], scopeEnforcement: "strict" };

const showFile = async (r: Awaited<ReturnType<typeof makeRepo>>, ref: string, file: string) =>
  (await execCommand("git", ["show", `${ref}:${file}`], r.repo.rootDir)).stdout;

describe("a task keeps one accountable owner through a real conflict", () => {
  it("prepares the merge in the owner's worktree, takes back an unfinished merge, and lands the resolved work", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/" },
        { id: "B", scope: "src/" },
      ]),
      contract: CONTRACT,
      files: { "src/shared.txt": "line one\nline two\nline three\n" },
    });
    try {
      const a = await r.reserve();
      expect(a.kind).toBe("reserved");
      if (a.kind !== "reserved") return;
      // A and B overlap in scope, so B starts once A is done: make A land first, then let B start
      // from the OLD base by reserving it before A lands.
      await r.commitFile(
        a.task.worktreePath,
        "src/shared.txt",
        "line one\nline TWO from A\nline three\n",
      );
      expect((await r.submit(a.task)).kind).toBe("submitted");
      const b = await r.reserve();
      expect(b.kind).toBe("reserved");
      if (b.kind !== "reserved") return;
      bindOwner(r.db, "B", "thread-B");
      await r.commitFile(
        b.task.worktreePath,
        "src/shared.txt",
        "line one\nline two from B\nline three\n",
      );
      expect((await r.submit(b.task)).kind).toBe("submitted");
      expect((await r.integrate("A")).kind).toBe("landed");

      const conflict = await r.integrate("B");
      expect(conflict.kind).toBe("needs-repair");
      expect(r.task("B").integration_state).toBe("conflict");

      // The task's own worker is brought back into the SAME worktree, with the merge prepared.
      const again = await r.reserve();
      expect(again.kind).toBe("reserved");
      if (again.kind !== "reserved") return;
      expect(again.task.taskId).toBe("B");
      expect(again.task.worktreePath).toBe(b.task.worktreePath);
      expect(again.task.ownerRef).toBe("thread-B");
      expect(again.task.repair?.mergeState).toBe("conflicted");
      expect(again.task.repair?.files).toEqual(["src/shared.txt"]);
      const status = (await execCommand("git", ["status", "--porcelain"], again.task.worktreePath))
        .stdout;
      expect(status).toContain("UU src/shared.txt");
      expect(
        NodeFS.readFileSync(NodePath.join(again.task.worktreePath, "src/shared.txt"), "utf8"),
      ).toContain("<<<<<<<");

      // Handing it in with the conflict still open is sent straight back, nothing is committed.
      const unfinished = await r.submit(again.task);
      expect(unfinished.kind).toBe("verification-failed");
      expect(unfinished.kind === "verification-failed" && unfinished.error).toContain(
        "merge is not finished",
      );

      NodeFS.writeFileSync(
        NodePath.join(again.task.worktreePath, "src/shared.txt"),
        "line one\nline TWO from A and B\nline three\n",
      );
      await execCommand("git", ["add", "src/shared.txt"], again.task.worktreePath);
      await execCommand(
        "git",
        ["commit", "-qm", "resolve: keep both intents"],
        again.task.worktreePath,
      );
      expect((await r.submit(again.task)).kind).toBe("submitted");
      expect((await r.integrate("B")).kind).toBe("landed");
      expect(await showFile(r, r.goal, "src/shared.txt")).toContain("A and B");
      expect(ownerOf(r.db, "B").ownerRef).toBe("thread-B");
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);

  it("keeps both sides' lines in union-merged files without waking anyone", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/a/" },
        { id: "B", scope: "src/b/" },
      ]),
      contract: { ...CONTRACT, unionMerge: ["src/index.ts"], supportingPaths: ["src/index.ts"] },
      files: { "src/index.ts": "export * from './core';\n" },
    });
    try {
      const a = await r.reserve();
      const b = await r.reserve();
      if (a.kind !== "reserved" || b.kind !== "reserved")
        throw new Error("both tasks should start");
      await r.commitFile(a.task.worktreePath, "src/a/a.ts", "export const a = 1;\n");
      await r.commitFile(
        a.task.worktreePath,
        "src/index.ts",
        "export * from './core';\nexport * from './a/a';\n",
      );
      await r.commitFile(b.task.worktreePath, "src/b/b.ts", "export const b = 2;\n");
      await r.commitFile(
        b.task.worktreePath,
        "src/index.ts",
        "export * from './core';\nexport * from './b/b';\n",
      );
      expect((await r.submit(a.task)).kind).toBe("submitted");
      expect((await r.submit(b.task)).kind).toBe("submitted");
      expect((await r.integrate("A")).kind).toBe("landed");
      expect((await r.integrate("B")).kind).toBe("landed");
      const index = await showFile(r, r.goal, "src/index.ts");
      expect(index).toContain("./a/a");
      expect(index).toContain("./b/b");
      expect(index).not.toContain("<<<<<<<");
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);

  it("does not spend the repair budget on a new situation, only on the same failure against the same tip", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/" },
        { id: "B", scope: "src/" },
        { id: "C", scope: "src/" },
      ]),
      contract: CONTRACT,
      files: { "src/s.txt": "base\n" },
    });
    try {
      const claims = [];
      for (const id of ["A", "B", "C"]) {
        const reserved = await r.reserve();
        if (reserved.kind !== "reserved") throw new Error(`${id} should start`);
        claims.push(reserved.task);
        // Same-scope tasks serialise normally; here each is made to start by completing the previous submit.
        await r.commitFile(
          reserved.task.worktreePath,
          "src/s.txt",
          `${reserved.task.taskId} wrote this\n`,
        );
        expect((await r.submit(reserved.task)).kind).toBe("submitted");
      }
      expect((await r.integrate("A")).kind).toBe("landed");
      const first = await r.integrate("B");
      expect(first.kind).toBe("needs-repair");
      expect(r.task("B").integration_attempts).toBe(1);
      // Integrating the same candidate against the same tip again is the same failure: counted.
      r.db.prepare("UPDATE tasks SET integration_state = 'pending' WHERE id = 'B'").run();
      await r.integrate("B");
      expect(r.task("B").integration_attempts).toBe(2);
      // C lands after A moved the tip: a different tip is a different problem; the count starts over.
      expect((await r.integrate("C")).kind).toBe("needs-repair");
      expect(r.task("C").integration_attempts).toBe(1);
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);
});

describe("whose failure is it", () => {
  const verifyScript = (name: string) => `node ${name}`;

  it("sets aside a check that already fails the same way before the task, keeps it as its own blocking task, and never calls it passed", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A", scope: "src/a/", verify: "node tests/preexisting.js" }]),
      contract: CONTRACT,
      files: {
        "tests/preexisting.js": "console.error('FAILED test_unrelated_thing'); process.exit(1);\n",
      },
    });
    try {
      const a = await r.reserve();
      if (a.kind !== "reserved") throw new Error("A should start");
      await r.commitFile(a.task.worktreePath, "src/a/a.txt", "a\n");
      const submitted = await r.submit(a.task);
      expect(submitted.kind).toBe("submitted");
      if (submitted.kind !== "submitted") return;
      expect(submitted.receipt.state).toBe("baseline-failed");
      const followUps = r.db
        .prepare("SELECT id, status, title FROM tasks WHERE id LIKE 'A-FU%'")
        .all() as Array<{ id: string; title: string }>;
      expect(followUps).toHaveLength(1);
      expect(followUps[0]!.title).toContain("already failed");
      // The plan cannot finish while that follow-up is open.
      expect(r.db.prepare("SELECT status FROM tasks WHERE id = 'A-FU1'").get()).toEqual({
        status: "pending",
      });
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);

  it("holds the task responsible when the check passes on the untouched branch", async () => {
    const r = await makeRepo({
      plan: plan([{ id: "A", scope: "src/a/", verify: verifyScript("tests/check.js") }]),
      contract: CONTRACT,
      files: {
        "tests/check.js":
          "const fs=require('fs');if(fs.existsSync('src/a/broken')){console.error('FAILED test_a');process.exit(1)}\n",
      },
    });
    try {
      const a = await r.reserve();
      if (a.kind !== "reserved") throw new Error("A should start");
      await r.commitFile(a.task.worktreePath, "src/a/broken", "x\n");
      const result = await r.submit(a.task);
      expect(result.kind).toBe("verification-failed");
      expect(r.db.prepare("SELECT count(*) AS c FROM tasks WHERE id LIKE 'A-FU%'").get()).toEqual({
        c: 0,
      });
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);
});

describe("change-impact audit", () => {
  it("runs again only the checks something later could have broken, and blames the landing that broke it", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/a/", verify: "node tests/a.js" },
        { id: "C", scope: "src/c/", verify: "node tests/c.js" },
        { id: "B", scope: "src/a/", deps: ["A"], verify: 'node -e "process.exit(0)"' },
      ]),
      contract: { ...CONTRACT, scopeEnforcement: "report" },
      files: {
        "tests/a.js":
          "const fs=require('fs');fs.appendFileSync(process.env.RUNLOG,'a\\n');if(fs.readFileSync('src/a/value.txt','utf8').trim()!=='1')process.exit(1);\n",
        "tests/c.js": "const fs=require('fs');fs.appendFileSync(process.env.RUNLOG,'c\\n');\n",
        "src/a/value.txt": "0\n",
      },
    });
    const runLog = NodePath.join(r.repo.rootDir, "..", `runlog-${Date.now()}`);
    process.env.RUNLOG = runLog;
    try {
      const land = async (id: string, file: string, content: string) => {
        const reserved = await r.reserve();
        if (reserved.kind !== "reserved" || reserved.task.taskId !== id)
          throw new Error(`expected ${id}`);
        bindOwner(r.db, id, `thread-${id}`);
        await r.commitFile(reserved.task.worktreePath, file, content);
        expect((await r.submit(reserved.task)).kind).toBe("submitted");
        expect((await r.integrate(id)).kind).toBe("landed");
      };
      await land("A", "src/a/value.txt", "1\n");
      await land("C", "src/c/c.txt", "c\n");
      await land("B", "src/a/value.txt", "2\n"); // breaks A's check
      NodeFS.writeFileSync(runLog, "");
      const report = await auditUnverifiedTasks(r.db, {
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: r.goal,
        planId: r.planId,
      });
      const ran = NodeFS.readFileSync(runLog, "utf8").trim().split("\n").filter(Boolean);
      // C's check was not repeated: nothing that landed after it touched what it owns.
      expect(ran.filter((line) => line === "c")).toHaveLength(0);
      expect(ran).toContain("a");
      expect(report.followUps).toHaveLength(1);
      const followUp = r.db
        .prepare("SELECT id, description, owner_ref FROM tasks WHERE id = ?")
        .get(report.followUps[0]!) as {
        id: string;
        description: string;
        owner_ref: string | null;
      };
      // B's change broke A's check, so B's owner gets the repair.
      expect(followUp.id.startsWith("B-FU")).toBe(true);
      expect(followUp.description).toContain("B's");
      expect(followUp.owner_ref).toBe("thread-B");
    } finally {
      delete process.env.RUNLOG;
      await r.repo.cleanup();
    }
  }, 90_000);
});

describe("what the worker runs before finishing agrees with the server", () => {
  it("approves a necessary extra file now, runs the repository's finalizer with the real allowed paths, and refuses protected files", async () => {
    const { finalizeTask } = await import("../src/finalize.ts");
    const guard = [
      'const { execFileSync } = require("node:child_process");',
      "const allowed = process.argv.slice(2);",
      "const base = process.env.BASE;",
      'const changed = execFileSync("git", ["diff", "--name-only", base + "...HEAD"]).toString().split("\\n").filter(Boolean);',
      "const bad = changed.filter((f) => !allowed.some((a) => f === a || f.startsWith(a)));",
      'if (bad.length) { console.error("outside: " + bad.join(", ")); process.exit(1); }',
    ].join("\n");
    const r = await makeRepo({
      plan: plan([{ id: "A", scope: "src/a/" }]),
      contract: {
        ...CONTRACT,
        protectedPaths: ["tools/"],
        guards: [
          {
            name: "scope-guard",
            run: "BASE={base} node tools/scope-guard.js {scopePaths}",
            phase: "submit",
          },
        ],
      },
      files: { "tools/scope-guard.js": guard },
    });
    try {
      const a = await r.reserve();
      if (a.kind !== "reserved") throw new Error("A should start");
      await r.commitFile(a.task.worktreePath, "src/a/one.ts", "1\n");
      await r.commitFile(a.task.worktreePath, "src/shared/needed.ts", "n\n");
      const report = finalizeTask(r.db, {
        taskId: "A",
        worktree: a.task.worktreePath,
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
      });
      // The shared helper is approved by the same rule the server uses, so the finalizer passes.
      expect(report.ok).toBe(true);
      expect(report.approved).toContain("src/shared/needed.ts");
      // And the server then accepts exactly the same commit.
      expect((await r.submit(a.task)).kind).toBe("submitted");

      const b = await makeRepo({
        plan: plan([{ id: "A", scope: "src/a/" }]),
        contract: { ...CONTRACT, protectedPaths: ["tools/"] },
        files: { "tools/x.js": "x\n" },
      });
      try {
        const reserved = await b.reserve();
        if (reserved.kind !== "reserved") throw new Error("A should start");
        await b.commitFile(reserved.task.worktreePath, "tools/x.js", "changed\n");
        const refused = finalizeTask(b.db, {
          taskId: "A",
          worktree: reserved.task.worktreePath,
          repoRoot: b.repo.rootDir,
          gitCommonDir: b.repo.gitCommonDir,
        });
        expect(refused.ok).toBe(false);
        expect(refused.problems.join(" ")).toContain("protected");
      } finally {
        await b.repo.cleanup();
      }
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);
});

describe("a repair that waited is retried without a worker when the branch moved", () => {
  it("puts the candidate back to be merged when the integration branch changed since it failed", async () => {
    const r = await makeRepo({
      plan: plan([
        { id: "A", scope: "src/" },
        { id: "B", scope: "src/" },
        { id: "C", scope: "other/" },
      ]),
      contract: CONTRACT,
      files: { "src/s.txt": "base\n" },
    });
    try {
      const tasks = [];
      for (const id of ["A", "B", "C"]) {
        const reserved = await r.reserve();
        if (reserved.kind !== "reserved") throw new Error(`${id} should start`);
        tasks.push(reserved.task);
        const file = reserved.task.taskId === "C" ? "other/c.txt" : "src/s.txt";
        await r.commitFile(reserved.task.worktreePath, file, `${reserved.task.taskId}\n`);
        expect((await r.submit(reserved.task)).kind).toBe("submitted");
      }
      expect((await r.integrate("A")).kind).toBe("landed");
      expect((await r.integrate("B")).kind).toBe("needs-repair");
      expect(r.task("B").integration_state).toBe("conflict");
      // Something else lands: B's failure was about an older branch.
      expect((await r.integrate("C")).kind).toBe("landed");
      const next = await r.reserve();
      expect(next.kind).toBe("none");
      if (next.kind === "none")
        expect(next.skipped.map((s) => s.reason)).toContain("INTEGRATION_RETRY");
      expect(r.task("B").integration_state).toBe("pending");
    } finally {
      await r.repo.cleanup();
    }
  }, 60_000);
});
