// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { openQueueDatabase } from "../../../../packages/agent-queue-core/src/index.ts";
import {
  createTestGitRepo,
  execCommand,
} from "../../../../packages/agent-queue-core/test/harness/gitHarness.ts";
import { AgentQueueService, AgentQueueServiceLive } from "./AgentQueueService.ts";

it.effect(
  "initializes, reads snapshot, reserves tasks into isolated worktrees, and lands (AQ-030 - AQ-035)",
  () =>
    Effect.gen(function* () {
      const repo = yield* Effect.promise(() => createTestGitRepo("agent-queue-service-test-"));

      try {
        // 1. Seed plan & task in queue database
        const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
        const now = "2026-10-10T00:00:00.000Z";
        db.prepare(`
          INSERT INTO tasks (id, title, status, version, verification_command, created_at, updated_at)
          VALUES ('TASK-SRV-1', 'Server Task 1', 'pending', 1, 'node -e "process.exit(0)"', ?, ?)
        `).run(now, now);
        db.close();

        const queueSvc = yield* AgentQueueService;

        // 2. Query snapshot
        const snapshot = yield* queueSvc.getSnapshot(repo.gitCommonDir);
        expect(snapshot.counts.pending).toBe(1);
        expect(snapshot.counts.total).toBe(1);

        // 3. Reserve next task
        const reserved = yield* queueSvc.reserveNext(
          repo.gitCommonDir,
          repo.rootDir,
          "worker-t3-1",
          "main",
        );
        expect(reserved).not.toBeNull();
        expect(reserved?.taskId).toBe("TASK-SRV-1");
        expect(reserved?.worktreePath).toBeDefined();

        // 4. Heartbeat
        const renewed = yield* queueSvc.heartbeat(repo.gitCommonDir, reserved!.claimToken);
        expect(renewed).toBe(true);

        // 5. Worker makes code change in worktree
        const testFile = NodePath.join(reserved!.worktreePath, "srv-change.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(testFile, "change content\n"));
        yield* Effect.promise(() => execCommand("git", ["add", "."], reserved!.worktreePath));
        yield* Effect.promise(() =>
          execCommand("git", ["commit", "-m", "feat: srv change"], reserved!.worktreePath),
        );

        // 6. Verify and land
        const rejectedLanding = yield* queueSvc.verifyAndLand(
          repo.gitCommonDir,
          repo.rootDir,
          reserved!.taskId,
          "not-the-claim-token",
          reserved!.worktreePath,
          reserved!.branch,
          "main",
          'node -e "process.exit(0)"',
        );
        expect(rejectedLanding.success).toBe(false);

        const landingResult = yield* queueSvc.verifyAndLand(
          repo.gitCommonDir,
          repo.rootDir,
          reserved!.taskId,
          reserved!.claimToken,
          reserved!.worktreePath,
          reserved!.branch,
          "main",
          'node -e "process.exit(0)"',
        );
        expect(landingResult.success).toBe(true);
        expect(landingResult.landedCommit).toBeDefined();

        // 7. Teardown worktree
        yield* queueSvc.teardown(repo.rootDir, reserved!.worktreePath, reserved!.branch, true);

        // 8. Snapshot verification
        const finalSnapshot = yield* queueSvc.getSnapshot(repo.gitCommonDir);
        expect(finalSnapshot.counts.completed).toBe(1);
        expect(finalSnapshot.counts.pending).toBe(0);
      } finally {
        yield* Effect.promise(() => repo.cleanup());
      }
    }).pipe(Effect.provide(AgentQueueServiceLive)),
);

it.effect("reserves and counts only tasks from the Goal's selected plan", () =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() => createTestGitRepo("agent-queue-plan-scope-"));
    try {
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = "2026-10-10T00:00:00.000Z";
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES ('PLAN-A', 'a.md', 'a', 'Plan A', 'active', ?, ?),
          ('PLAN-B', 'b.md', 'b', 'Plan B', 'active', ?, ?)
      `).run(now, now, now, now);
      db.prepare(`
        INSERT INTO tasks (id, plan_id, title, status, version, dependencies, created_at, updated_at)
        VALUES ('A-1', 'PLAN-A', 'Plan A task', 'pending', 1, '[]', ?, ?),
          ('B-1', 'PLAN-B', 'Plan B task', 'pending', 1, '[]', ?, ?)
      `).run(now, now, now, now);
      db.close();

      const queueSvc = yield* AgentQueueService;
      const snapshot = yield* queueSvc.getSnapshot(repo.gitCommonDir, "PLAN-A");
      expect(snapshot.counts.total).toBe(1);
      const assignment = yield* queueSvc.reserveNext(
        repo.gitCommonDir,
        repo.rootDir,
        "worker-plan-a",
        "main",
        "PLAN-A",
      );
      expect(assignment?.taskId).toBe("A-1");
      expect(assignment?.baseBranch).toBe("main");
    } finally {
      yield* Effect.promise(() => repo.cleanup());
    }
  }).pipe(Effect.provide(AgentQueueServiceLive)),
);
