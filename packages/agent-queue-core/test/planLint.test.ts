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

  it("flags a pytest check whose marker filter leaves no test to run", async () => {
    const repo = await createTestGitRepo("aq-lint-pytest-");
    try {
      const files: Record<string, string> = {
        "server/pyproject.toml": "[tool.pytest.ini_options]\naddopts = '-m \"not integration\"'\n",
        "server/tests/test_db.py":
          "import pytest\n\n@pytest.mark.integration\nasync def test_a():\n    pass\n\n@pytest.mark.integration\ndef test_b():\n    pass\n",
        "server/tests/test_unit.py": "def test_c():\n    pass\n",
      };
      const task = (id: string, check: string) => [
        `- [ ] **${id} — Change the database layer.**`,
        "  - Depends on: none.",
        "  - Scope: server/tests/",
        "  - Checks:",
        `    - \`${check}\` (cwd: server, timeout: 5m)`,
        "  - Update the tests.",
        "",
      ];
      const plan = [
        "# Plan",
        "",
        ...task("P1", "uv run pytest tests/test_db.py -q"),
        ...task("P2", "uv run pytest tests/test_db.py -m 'not integration' -q"),
        ...task("P3", "uv run pytest tests/test_db.py -m integration -q"),
        ...task("P4", "uv run pytest tests/test_db.py tests/test_unit.py -q"),
      ].join("\n");
      for (const [path, content] of Object.entries(files)) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(repo.rootDir, path)), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(repo.rootDir, path), content);
      }
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
      await execCommand("git", ["add", "-A"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "fixture"], repo.rootDir);
      const flagged = lintPlanFile(repo.rootDir, "PLAN.md")
        .findings.filter((finding) => finding.code === "check-selects-nothing")
        .map((finding) => finding.taskId);
      expect(flagged).toEqual(["P1", "P2"]);
    } finally {
      await repo.cleanup();
    }
  });

  it("checks structured artifact order, Gradle targets, focused reports, combined gates, and repair scopes", async () => {
    const repo = await createTestGitRepo("aq-lint-readiness-");
    try {
      const task = (
        id: string,
        title: string,
        dependency: string,
        scope: string,
        command: string,
      ) => {
        const optionsStart = command.indexOf(" (cwd:");
        const run = optionsStart < 0 ? command : command.slice(0, optionsStart);
        const options = optionsStart < 0 ? "" : ` ${command.slice(optionsStart + 1)}`;
        return [
          `- [ ] **${id} — ${title}**`,
          `  - Depends on: ${dependency}.`,
          `  - Scope: ${scope}`,
          "  - Checks:",
          `    - \`${run}\`${options}`,
          "  - Update the focused test evidence.",
          "",
        ];
      };
      const plan = [
        "# Readiness plan",
        "",
        ...task(
          "BUILD",
          "Build the instrumentation APK",
          "none",
          "android/app/",
          "./gradlew :app:assembleDebug (cwd: android, timeout: 5m, id: apk, produces: android/app/build/outputs/apk/debug/app-debug.apk)",
        ),
        ...task(
          "TEST",
          "Run focused instrumentation coverage",
          "BUILD",
          "android/app/src/androidTest/",
          "./gradlew :app:connectedDebugAndroidTest --tests com.example.Smoke (cwd: android, timeout: 5m, id: smoke, consumes: android/app/build/outputs/apk/debug/app-debug.apk, junit: android/app/build/reports/android/TEST-*.xml, min-tests: 1, max-skipped: 0)",
        ),
        ...task(
          "ORPHAN",
          "Check an unprovisioned golden",
          "none",
          "android/app/src/test/",
          "./gradlew :app:testDebugUnitTest (cwd: android, timeout: 5m, id: orphan, consumes: android/testdata/reviewed-golden.png)",
        ),
        ...task(
          "WRONG",
          "Run an absent module target",
          "none",
          "android/app/src/androidTest/",
          "./gradlew :missing:connectedDebugAndroidTest --tests com.example.Smoke (cwd: android, timeout: 5m, id: wrong-target, junit: android/app/build/reports/android/TEST.xml, min-tests: 1)",
        ),
        ...task(
          "COMBINED",
          "Keep two gates separate",
          "none",
          "android/app/",
          "./gradlew :app:lintDebug :app:testDebugUnitTest (cwd: android, timeout: 5m, id: combined)",
        ),
        ...task(
          "REPAIR",
          "Repair the protected verification file",
          "none",
          ".bridge/verify.json",
          'node -e "process.exit(0)" (cwd: ., timeout: 5m)',
        ),
      ].join("\n");
      const files: Record<string, string> = {
        "android/settings.gradle": 'include ":app"\n',
        "android/app/src/androidTest/java/com/example/Smoke.kt": "class Smoke\n",
        "android/app/src/test/java/com/example/Unit.kt": "class Unit\n",
        "android/app/build.gradle": "plugins { }\n",
        ".bridge/verify.json": "{}\n",
        ".agentqueue/contract.json": JSON.stringify({ protectedPaths: [".bridge/"] }),
        "PLAN.md": plan,
      };
      for (const [path, content] of Object.entries(files)) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(repo.rootDir, path)), {
          recursive: true,
        });
        await NodeFSP.writeFile(NodePath.join(repo.rootDir, path), content);
      }
      await execCommand("git", ["add", "-A"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "readiness fixture"], repo.rootDir);
      const findings = lintPlanFile(repo.rootDir, "PLAN.md").findings;
      const has = (code: string, id: string) =>
        findings.some((finding) => finding.code === code && finding.taskId === id);

      expect(has("artifact-task-dependency-missing", "TEST")).toBe(false);
      expect(has("artifact-producer-missing", "TEST")).toBe(false);
      expect(has("artifact-producer-missing", "ORPHAN")).toBe(true);
      expect(has("check-gradle-project-missing", "WRONG")).toBe(true);
      expect(
        findings.find((finding) => finding.code === "check-gradle-project-missing")?.level,
      ).toBe("warning");
      expect(has("combined-gate", "COMBINED")).toBe(true);
      expect(has("repair-scope-protected", "REPAIR")).toBe(true);
      expect(
        findings.some(
          (finding) =>
            finding.taskId === "TEST" &&
            ["check-selection-missing", "check-report-missing"].includes(finding.code),
        ),
      ).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});
