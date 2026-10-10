// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { claimTask, renewLease, releaseClaim } from "../src/claimService.ts";
import { getReadyTasks } from "../src/planGraph.ts";
import { reconcileExpiredLeases } from "../src/leaseRecovery.ts";
import { getQueueSnapshot, evaluateDeadlock } from "../src/queueInspector.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("AgentQueue Phase 1 Core Concurrency & Chaos Gate (AQ-015)", () => {
  it("executes 8 concurrent workers claiming, heartbeating, and recovering under chaos", async () => {
    const repo = await createTestGitRepo("aq-chaos-gate-");
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();

      // Seed 16 tasks: 8 roots, 8 dependent leaves
      for (let i = 1; i <= 8; i++) {
        db.prepare(`
          INSERT INTO tasks (id, title, status, version, dependencies, max_retries, retry_count, created_at, updated_at)
          VALUES (?, ?, 'pending', 1, '[]', 2, 0, ?, ?)
        `).run(`ROOT-${i}`, `Root task ${i}`, now, now);

        db.prepare(`
          INSERT INTO tasks (id, title, status, version, dependencies, max_retries, retry_count, created_at, updated_at)
          VALUES (?, ?, 'pending', 1, ?, 2, 0, ?, ?)
        `).run(`LEAF-${i}`, `Leaf task ${i}`, JSON.stringify([`ROOT-${i}`]), now, now);
      }

      // Simulate 8 worker loops
      const numWorkers = 8;
      const workerPromises: Promise<number>[] = [];

      const runWorker = async (workerId: number): Promise<number> => {
        let tasksCompleted = 0;
        const workerDb = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });

        for (let iteration = 0; iteration < 20; iteration++) {
          // 1. Fetch pending tasks and find ready tasks
          const allTasks = workerDb
            .prepare("SELECT id, status, dependencies FROM tasks")
            .all() as Array<{ id: string; status: string; dependencies: string }>;

          const parsed = allTasks.map((t) => ({
            id: t.id,
            status: t.status,
            dependencies: JSON.parse(t.dependencies || "[]") as string[],
          }));

          const ready = getReadyTasks(parsed);
          if (ready.length === 0) {
            // Check if all done
            const snapshot = getQueueSnapshot(workerDb);
            if (snapshot.counts.completed + snapshot.counts.failed === snapshot.counts.total) {
              break;
            }
            await new Promise((r) => setTimeout(r, 20));
            continue;
          }

          // Pick first ready task and attempt claim
          const targetTaskId = ready[0];
          const claimRes = claimTask(workerDb, {
            taskId: targetTaskId,
            workerPid: 20000 + workerId,
            worktreePath: `/tmp/wt-worker-${workerId}`,
            branch: `aq/worker-${workerId}`,
            leaseSeconds: 1, // Short lease for quick expiration testing
          });

          if (!claimRes.success) {
            // Contention or scope conflict - retry shortly
            await new Promise((r) => setTimeout(r, 10));
            continue;
          }

          // Claimed successfully!
          const { claim } = claimRes;

          // Simulate chaos: 25% chance of simulated worker "crash" (leaves lease abandoned)
          const willCrash = (workerId + iteration) % 4 === 0;
          if (willCrash) {
            // Abandon task without releasing. Let recovery handle it.
            await new Promise((r) => setTimeout(r, 30));
            continue;
          }

          // Simulate normal execution: heartbeat then release completed
          renewLease(workerDb, claim.ownerToken, 5);
          await new Promise((r) => setTimeout(r, 15));

          const released = releaseClaim(workerDb, {
            ownerToken: claim.ownerToken,
            finalStatus: "completed",
          });

          if (released) {
            tasksCompleted++;
          }
        }

        workerDb.close();
        return tasksCompleted;
      };

      // Periodic recovery supervisor running in background
      let stopSupervisor = false;
      const supervisorPromise = (async () => {
        const supDb = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
        while (!stopSupervisor) {
          reconcileExpiredLeases(supDb);
          await new Promise((r) => setTimeout(r, 50));
        }
        supDb.close();
      })();

      // Start all 8 workers
      for (let w = 1; w <= numWorkers; w++) {
        workerPromises.push(runWorker(w));
      }

      await Promise.all(workerPromises);
      stopSupervisor = true;
      await supervisorPromise;

      // Wait for any remaining 1-second leases to fully expire
      await new Promise((r) => setTimeout(r, 1200));

      // Final sweep of recovery
      reconcileExpiredLeases(db);

      // Verify PRAGMA integrity_check
      const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");

      // Verify snapshot: no tasks in 'claimed' or 'running' status left hanging
      const finalSnapshot = getQueueSnapshot(db);
      expect(finalSnapshot.counts.claimed).toBe(0);
      expect(finalSnapshot.counts.running).toBe(0);
      expect(finalSnapshot.counts.verifying).toBe(0);
      expect(finalSnapshot.activeLeases).toHaveLength(0);

      // Verify all completed tasks actually had their dependencies completed first
      const completedTasks = db
        .prepare("SELECT id, dependencies FROM tasks WHERE status = 'completed'")
        .all() as Array<{ id: string; dependencies: string }>;

      const completedSet = new Set(completedTasks.map((t) => t.id));
      for (const ct of completedTasks) {
        const deps: string[] = JSON.parse(ct.dependencies || "[]");
        for (const dep of deps) {
          expect(completedSet.has(dep)).toBe(true);
        }
      }

      db.close();
    } finally {
      await repo.cleanup();
    }
  }, 30_000);
});
