// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { lintPlanFile } from "../src/planImport.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

/**
 * The shape of the problems the historical Overseer plan had (a sync task that left out the Room
 * database it writes to, a production cleanup with no production access, instructions that demand a
 * mount be read-only and writable, a protected file in scope, a whole-suite check), in a repository
 * small enough to build here.
 */
const FILES: Record<string, string> = {
  "android/core/database/src/main/kotlin/db/AppDatabase.kt":
    "package com.example.db\n@Database(entities = [CaptureEntity::class], version = 3)\nabstract class AppDatabase\n",
  "android/core/database/schemas/com.example.db.AppDatabase/3.json": "{}\n",
  "android/core/sync/src/main/kotlin/sync/Delivery.kt":
    "package com.example.sync\nimport com.example.db.AppDatabase\nclass Delivery(db: AppDatabase)\n",
  "server/alembic.ini": "[alembic]\n",
  "server/migrations/versions/001_init.py": "# init\n",
  "server/src/app.py": "x = 1\n",
  "server/tests/test_app.py": "def test_x():\n    assert True\n",
  ".bridge/verify.json": "{}\n",
  "docs/note.md": "note\n",
  ".agentqueue/contract.json": JSON.stringify({
    protectedPaths: [".bridge/"],
    capabilities: {
      "production-write": {
        probe: "false",
        description: "owner-authorised writes to the live production database",
      },
    },
  }),
};

const PLAN = [
  "# Lint fixture plan",
  "",
  "- [ ] **S1 — Track every capture until it has a result.**",
  "  - Depends on: none.",
  "  - Scope: android/core/sync/",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m)',
  "  - Record the processing stage of each capture durably and synchronize it, also after a restart.",
  "",
  "- [ ] **S2 — Remove exact production fixtures and prevent their return. [production-write]**",
  "  - Depends on: none.",
  "  - Scope: server/src/",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m)',
  "  - Build a manifest of the rows and apply it with the existing cleanup CLI.",
  "",
  "- [ ] **S3 — Repair admin secrets storage.**",
  "  - Depends on: none.",
  "  - Scope: server/src/",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m)',
  "  - Both canonical and live admin secrets mount are read-only; password rotation writes there. Give admin only its required writable password state; keep server signing inputs read-only.",
  "",
  "- [ ] **S4 — Gate publication on the verification file.**",
  "  - Depends on: none.",
  "  - Scope: .bridge/verify.json, docs/note.md",
  "  - Checks:",
  "    - `uv run pytest -q` (cwd: server, timeout: 30m)",
  "  - Make publication wait for the checks.",
  "",
  "- [ ] **S5 — Soak the capture service for a day.**",
  "  - Depends on: none.",
  "  - Scope: docs/note.md",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m)',
  "  - Run it for 24 hours and have the owner check the result by hand.",
  "",
  "- [ ] **S6 — A clean task.**",
  "  - Depends on: none.",
  "  - Scope: server/src/app.py, server/tests/test_app.py",
  "  - Checks:",
  '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m)',
  "  - Change `x` to 2 in `server/src/app.py` and update its test.",
  "",
].join("\n");

describe("plan lint finds what stops small agents before any of them starts", () => {
  it("flags a missing database scope, production work, contradictions, protected files, broad checks, soaks and human steps", async () => {
    const repo = await createTestGitRepo("aq-lint-");
    try {
      for (const [file, content] of Object.entries({ ...FILES, "PLAN.md": PLAN })) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(repo.rootDir, file)), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(repo.rootDir, file), content);
      }
      await execCommand("git", ["add", "-A"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "fixture"], repo.rootDir);
      const { findings } = lintPlanFile(repo.rootDir, "PLAN.md");
      const has = (code: string, taskId: string, level?: "error" | "warning") =>
        findings.some(
          (f) => f.code === code && f.taskId === taskId && (!level || f.level === level),
        );

      expect(has("scope-missing-database", "S1", "error")).toBe(true);
      expect(findings.find((f) => f.code === "scope-missing-database")?.fix).toContain(
        "android/core/database/",
      );
      expect(has("production-change", "S2", "error")).toBe(true);
      expect(has("capability-unavailable", "S2", "error")).toBe(true);
      expect(has("conflicting-constraints", "S3")).toBe(true);
      expect(has("scope-protected", "S4", "error")).toBe(true);
      expect(has("broad-check", "S4", "warning")).toBe(true);
      expect(has("long-wait", "S5", "error")).toBe(true);
      expect(has("human-in-the-loop", "S5", "error")).toBe(true);
      // The well-formed task raises nothing.
      expect(findings.filter((f) => f.taskId === "S6")).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  it("does not mistake a prohibition for a requirement", async () => {
    const repo = await createTestGitRepo("aq-lint-neg-");
    try {
      const plan = [
        "# Plan",
        "",
        "- [ ] **N1 — Harmless.**",
        "  - Depends on: none.",
        "  - Scope: docs/note.md",
        "  - Checks:",
        '    - `node -e "process.exit(0)"` (cwd: ., timeout: 5m)',
        "  - No owner acceptance test, no new recordings, and no phone cable are part of this task. Read production to investigate only; never write to it. Update the note.",
        "",
      ].join("\n");
      await NodeFSP.mkdir(NodePath.join(repo.rootDir, "docs"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "docs/note.md"), "n\n");
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
      await execCommand("git", ["add", "-A"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "fixture"], repo.rootDir);
      expect(lintPlanFile(repo.rootDir, "PLAN.md").findings).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});
