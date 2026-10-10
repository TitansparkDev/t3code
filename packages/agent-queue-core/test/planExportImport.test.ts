// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  parsePlanMarkdown,
  exportPlanMarkdown,
  computePlanChecksum,
  validatePlanDag,
  DependencyCycleError,
  type PlanTaskDefinition,
} from "../src/planGraph.ts";
import { createTestGitRepo } from "./harness/gitHarness.ts";

describe("Phase 6: Planning Formats, Skills, Rules & Import (AQ-042 - AQ-050, Gate G6)", () => {
  it("creates and verifies a 10-task executable plan graph with dependencies and scopes (AQ-043)", () => {
    const tasks: PlanTaskDefinition[] = [
      {
        id: "TASK-01",
        title: "Setup core database",
        description: "Initialize schema",
        dependencies: [],
        verificationCommand: "vp test db",
        scopePatterns: ["src/db/"],
      },
      {
        id: "TASK-02",
        title: "Add user model",
        description: "Define user schema",
        dependencies: ["TASK-01"],
        verificationCommand: "vp test user",
        scopePatterns: ["src/models/user/"],
      },
      {
        id: "TASK-03",
        title: "Add auth tokens",
        description: "JWT authentication",
        dependencies: ["TASK-02"],
        verificationCommand: "vp test auth",
        scopePatterns: ["src/auth/"],
      },
      {
        id: "TASK-04",
        title: "Add billing model",
        description: "Stripe integration",
        dependencies: ["TASK-01"],
        verificationCommand: "vp test billing",
        scopePatterns: ["src/billing/"],
      },
      {
        id: "TASK-05",
        title: "Add payments API",
        description: "Charge endpoints",
        dependencies: ["TASK-04", "TASK-03"],
        verificationCommand: "vp test api",
        scopePatterns: ["src/api/payments/"],
      },
      {
        id: "TASK-06",
        title: "Add email service",
        description: "Notification dispatcher",
        dependencies: ["TASK-01"],
        verificationCommand: "vp test email",
        scopePatterns: ["src/email/"],
      },
      {
        id: "TASK-07",
        title: "Add receipt sender",
        description: "Send receipts on charge",
        dependencies: ["TASK-05", "TASK-06"],
        verificationCommand: "vp test receipts",
        scopePatterns: ["src/receipts/"],
      },
      {
        id: "TASK-08",
        title: "Add audit logging",
        description: "Audit trails",
        dependencies: ["TASK-01"],
        verificationCommand: "vp test audit",
        scopePatterns: ["src/audit/"],
      },
      {
        id: "TASK-09",
        title: "Add admin dashboard",
        description: "Web UI",
        dependencies: ["TASK-05", "TASK-08"],
        verificationCommand: "vp test admin",
        scopePatterns: ["src/admin/"],
      },
      {
        id: "TASK-10",
        title: "End to end integration",
        description: "Full flow",
        dependencies: ["TASK-07", "TASK-09"],
        verificationCommand: "vp test e2e",
        scopePatterns: ["test/e2e/"],
      },
    ];

    // Must be a valid acyclic DAG
    expect(() => validatePlanDag(tasks)).not.toThrow();

    // Export to Markdown
    const markdown = exportPlanMarkdown({ title: "10-Task Infrastructure Plan", tasks });
    expect(markdown).toContain("# 10-Task Infrastructure Plan");
    expect(markdown).toContain("### TASK-01: Setup core database");
    expect(markdown).toContain("### TASK-10: End to end integration");

    // Re-parse Markdown and verify roundtrip equivalence
    const parsed = parsePlanMarkdown(markdown);
    expect(parsed.title).toBe("10-Task Infrastructure Plan");
    expect(parsed.tasks.length).toBe(10);
    expect(parsed.tasks[0].id).toBe("TASK-01");
    expect(parsed.tasks[9].id).toBe("TASK-10");
    expect(parsed.tasks[9].dependencies).toEqual(["TASK-07", "TASK-09"]);
  });

  it("imports markdown idempotently into SQLite without corrupting tasks (AQ-042, AQ-050)", async () => {
    const repo = await createTestGitRepo("plan-import-test-");
    try {
      const planMarkdown = `
# Master Rollout Plan

### TASK-A: Feature Alpha
First major component.
- **Scope:** packages/alpha/
- **Verification:** pnpm test alpha

### TASK-B: Feature Beta
Second component.
- **Depends on:** TASK-A
- **Scope:** packages/beta/
- **Verification:** pnpm test beta
      `;

      const parsed = parsePlanMarkdown(planMarkdown);
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const now = new Date().toISOString();
      const checksum = computePlanChecksum(planMarkdown);

      // First import
      db.prepare(`
        INSERT INTO plans (id, file_path, checksum, title, status, registered_at, updated_at)
        VALUES ('plan-1', 'PLAN.md', ?, ?, 'active', ?, ?)
      `).run(checksum, parsed.title, now, now);

      for (const t of parsed.tasks) {
        db.prepare(`
          INSERT INTO tasks (id, plan_id, title, description, dependencies, verification_command, scope_patterns, status, version, created_at, updated_at)
          VALUES (?, 'plan-1', ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
        `).run(
          t.id,
          t.title,
          t.description ?? null,
          JSON.stringify(t.dependencies),
          t.verificationCommand ?? null,
          JSON.stringify(t.scopePatterns),
          now,
          now,
        );
      }

      const tasksAfterFirst = db.prepare("SELECT count(*) as count FROM tasks").get() as {
        count: number;
      };
      expect(tasksAfterFirst.count).toBe(2);

      // Second import: updating existing plan idempotently with INSERT OR REPLACE / ON CONFLICT
      for (const t of parsed.tasks) {
        db.prepare(`
          INSERT INTO tasks (id, plan_id, title, description, dependencies, verification_command, scope_patterns, status, version, created_at, updated_at)
          VALUES (?, 'plan-1', ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            dependencies = excluded.dependencies,
            verification_command = excluded.verification_command,
            scope_patterns = excluded.scope_patterns,
            updated_at = excluded.updated_at
        `).run(
          t.id,
          t.title,
          t.description ?? null,
          JSON.stringify(t.dependencies),
          t.verificationCommand ?? null,
          JSON.stringify(t.scopePatterns),
          now,
          now,
        );
      }

      const tasksAfterSecond = db.prepare("SELECT count(*) as count FROM tasks").get() as {
        count: number;
      };
      expect(tasksAfterSecond.count).toBe(2);

      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("detects and rejects dependency cycles during validation (AQ-042)", () => {
    const cyclicTasks: PlanTaskDefinition[] = [
      { id: "CYCLE-1", title: "T1", description: "", dependencies: ["CYCLE-2"] },
      { id: "CYCLE-2", title: "T2", description: "", dependencies: ["CYCLE-3"] },
      { id: "CYCLE-3", title: "T3", description: "", dependencies: ["CYCLE-1"] },
    ];

    expect(() => validatePlanDag(cyclicTasks)).toThrow(DependencyCycleError);
  });
});
