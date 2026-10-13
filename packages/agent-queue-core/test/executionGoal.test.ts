// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * A realistic multi-worker goal on a repository with its own guard rules: concurrent workers,
 * a guard that rejects the default branch convention, generated files every task touches,
 * a scope mistake, a failing check, and a task that needs an external capability. The queue
 * must finish everything it can, spend no worker on the same problem twice, keep the
 * external task visible and incomplete, and finish the plan once the capability exists.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { verifyPlanCompletion } from "../src/completion.ts";
import { publishPlan } from "../src/publication.ts";
import { evaluateDeadlock } from "../src/queueInspector.ts";
import { execCommand } from "./harness/gitHarness.ts";
import { makeRepo, plan, tmpDir } from "./harness/contractHarness.ts";

type Repo = Awaited<ReturnType<typeof makeRepo>>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a multi-worker goal with foreseeable failures", () => {
  it("recovers by itself, wastes no worker, keeps the external task visible, and completes once it can", async () => {
    const flag = NodePath.join(await tmpDir("aq-goal-cap-"), "granted");
    const r: Repo = await makeRepo({
      plan: plan([
        { id: "T1", scope: "src/t1/" },
        { id: "T2", scope: "src/t2/" },
        { id: "T3", scope: "src/t3/", deps: ["T1"] },
        { id: "T4", title: "Apply to the live host [host]", scope: "src/t4/" },
        { id: "T5", scope: "src/t5/", deps: ["T4"] },
        { id: "T6", scope: "src/t6/", verify: "test -f src/t6/ok.txt" },
        { id: "T7", scope: "src/t7/", deps: ["T2", "T6"] },
      ]),
      // No contract names the branch convention or the guard: both are inferred from the
      // repository's own documents and probed. The generated file list is declared.
      contract: {
        generated: [{ paths: ["tree.txt"], regenerate: "git ls-files | LC_ALL=C sort > tree.txt" }],
        protectedPaths: ["tools/"],
        capabilities: {
          host: { probe: `test -f ${flag}`, description: "authorised production host" },
        },
      },
      files: { "tree.txt": "PLAN.md\n" },
    });
    try {
      const claimsByTask = new Map<string, number>();
      let concurrent = 0;
      let maxConcurrent = 0;
      const attempts = new Map<string, number>();

      const work = async (workerId: string): Promise<void> => {
        for (let idle = 0; idle < 40;) {
          const outcome = await r.reserve(workerId);
          if (outcome.kind === "none") {
            idle++;
            await sleep(40);
            continue;
          }
          idle = 0;
          const task = outcome.task;
          claimsByTask.set(task.taskId, (claimsByTask.get(task.taskId) ?? 0) + 1);
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          try {
            const id = task.taskId.toLowerCase();
            expect(task.branch).toMatch(/^agent\//);
            await r.commitFile(task.worktreePath, `src/${id}/file.txt`, `${task.taskId}\n`);
            // Every task also appends to the generated file list, as a commit hook would.
            const tree = await NodeFSP.readFile(
              NodePath.join(task.worktreePath, "tree.txt"),
              "utf8",
            );
            await r.commitFile(task.worktreePath, "tree.txt", `${tree}src/${id}/file.txt\n`);
            if (task.taskId === "T2")
              await r.commitFile(task.worktreePath, ".env", "TOKEN=stray\n");
            await sleep(30);

            for (;;) {
              const submitted = await r.submit(task);
              attempts.set(task.taskId, (attempts.get(task.taskId) ?? 0) + 1);
              if (submitted.kind === "submitted") break;
              if (submitted.kind === "scope-violation") {
                // The "chat" is sent back with the paths; the worker reverts them.
                for (const path of submitted.paths) {
                  await execCommand("git", ["rm", "-q", "--", path], task.worktreePath);
                }
                await execCommand(
                  "git",
                  ["commit", "-qm", "revert stray files"],
                  task.worktreePath,
                );
              } else if (submitted.kind === "verification-failed") {
                await r.commitFile(task.worktreePath, "src/t6/ok.txt", "ok\n");
              } else {
                throw new Error(`unexpected ${submitted.kind}`);
              }
            }
            for (let i = 0; i < 5; i++) {
              const merged = await r.integrate(task.taskId);
              if (merged.kind === "landed") break;
              if (merged.kind !== "deferred") throw new Error(`merge ${JSON.stringify(merged)}`);
            }
          } finally {
            concurrent--;
          }
        }
      };

      await Promise.all([work("w1"), work("w2"), work("w3")]);

      // Everything that does not need the host is done; the host task and its dependant are not.
      const status = Object.fromEntries(
        ["T1", "T2", "T3", "T4", "T5", "T6", "T7"].map((id) => [id, r.task(id).status]),
      );
      expect(status).toEqual({
        T1: "completed",
        T2: "completed",
        T3: "completed",
        T4: "blocked",
        T5: "pending",
        T6: "completed",
        T7: "completed",
      });
      expect(r.task("T4").failure_class).toBe("external");
      expect(evaluateDeadlock(r.db, r.planId).awaitingEnvironment).toBe(true);
      const early = await verifyPlanCompletion(r.db, {
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: r.goal,
        planId: r.planId,
        runFinalCheck: false,
      });
      expect(early.complete).toBe(false);

      // Nothing was wasted: one claim per task, no requeue, no retry spent, and the only
      // recorded failures are the two the workers fixed within their own claim.
      expect([...claimsByTask.entries()].filter(([, n]) => n !== 1)).toEqual([]);
      expect(claimsByTask.has("T4")).toBe(false);
      expect(
        r.db
          .prepare(
            "SELECT count(*) AS c FROM task_events WHERE event_type IN ('task_requeued','task_failed','task_recovered')",
          )
          .get(),
      ).toEqual({ c: 0 });
      expect(r.db.prepare("SELECT coalesce(sum(retry_count),0) AS c FROM tasks").get()).toEqual({
        c: 0,
      });
      const failures = r.db
        .prepare(
          "SELECT task_id, class FROM task_failures WHERE class != 'external' ORDER BY task_id",
        )
        .all();
      expect(failures).toEqual([
        { task_id: "T2", class: "scope" },
        { task_id: "T6", class: "verification" },
      ]);
      expect(attempts.get("T2")).toBe(2);
      expect(attempts.get("T6")).toBe(2);
      expect(maxConcurrent).toBeGreaterThan(1);
      const tree = (await execCommand("git", ["show", `${r.goal}:tree.txt`], r.repo.rootDir))
        .stdout;
      for (const id of ["t1", "t2", "t3", "t6", "t7"]) expect(tree).toContain(`src/${id}/file.txt`);
      expect(tree).not.toContain(".env");

      // The environment grants the capability: the held task and its dependant finish.
      await NodeFSP.writeFile(flag, "ok");
      await work("w4");
      for (const id of ["T4", "T5"]) expect(r.task(id).status).toBe("completed");

      const published = await publishPlan(r.db, {
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: r.goal,
        planId: r.planId,
        policy: { reconcileAbandoned: true, idleMinutes: 0 },
      });
      expect(published.kind).toBe("published");
      const done = await verifyPlanCompletion(r.db, {
        repoRoot: r.repo.rootDir,
        gitCommonDir: r.repo.gitCommonDir,
        baseBranch: "main",
        integrationBranch: r.goal,
        planId: r.planId,
        runFinalCheck: true,
      });
      expect(done.reason).toBeNull();
      expect(done.complete).toBe(true);
    } finally {
      await r.repo.cleanup();
    }
  }, 120_000);
});
