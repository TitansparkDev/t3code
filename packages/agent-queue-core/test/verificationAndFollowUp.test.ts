// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { attributeFailure } from "../src/baseline.ts";
import { importPlanFile } from "../src/planImport.ts";
import { addFollowUpTask } from "../src/overseerRepairs.ts";
import { reviveHeldTasks } from "../src/failures.ts";
import { parsePlanMarkdown } from "../src/planGraph.ts";
import { runVerification } from "../src/verifier.ts";
import { runSpec } from "../src/verificationSpec.ts";
import { processIsLive } from "../src/resourceBroker.ts";
import { teardownWorktree } from "../src/worktreeManager.ts";
import { createTestGitRepo, createTestWorktree, execCommand } from "./harness/gitHarness.ts";

const task = (body: string) =>
  parsePlanMarkdown(`# Plan\n\n- [ ] **RP1 — Thing.**\n  - Depends on: none.\n${body}\n`).tasks[0]!;

describe("checks written as prose Done lines", () => {
  it("chains every test-runner span, honours a leading directory, and keeps the prose for the worker", () => {
    const parsed = task(
      "  - Done: from `server/`, `uv run pytest tests/a.py -q` and `uv run pytest -m integration tests/b.py -q`, plus new cases.",
    );
    expect(parsed.verificationCommand).toBe(
      "cd server && uv run pytest tests/a.py -q && uv run pytest -m integration tests/b.py -q",
    );
    expect(parsed.verification).toMatchObject({ source: "derived" });
    expect(parsed.verification?.checks.map((check) => [check.cwd, check.run])).toEqual([
      ["server", "uv run pytest tests/a.py -q"],
      ["server", "uv run pytest -m integration tests/b.py -q"],
    ]);
    expect(parsed.description).toContain("plus new cases");
  });

  it("never turns a deployment probe, a placeholder or pure prose into a check", () => {
    expect(
      task(
        "  - Done: run `curl --fail https://example.test/v1/health` ten times and read `<file>` aloud.",
      ).verificationCommand,
    ).toBeNull();
    expect(
      task("  - Done: the worker records which handlers are real.").verificationCommand,
    ).toBeNull();
  });

  it("lets a declared check win over anything derived from prose", () => {
    const parsed = task('  - Verify: `node -e "0"`\n  - Done: also `pytest -q`.');
    expect(parsed.verification?.source).toBe("declared");
    expect(parsed.verificationCommand).toBe('node -e "0"');
  });
});

describe("runVerification", () => {
  it("keeps the exact exit code and output of a failing command", async () => {
    const repo = await createTestGitRepo("aq-verify-");
    try {
      const result = await runVerification(
        "T1",
        repo.rootDir,
        "echo out-line; echo err-line 1>&2; exit 7",
      );
      expect(result).toMatchObject({ passed: false, exitCode: 7, outcome: "failed", signal: null });
      expect(result.stdoutSnippet).toContain("out-line");
      expect(result.stderrSnippet).toContain("err-line");
    } finally {
      await repo.cleanup();
    }
  });

  it("does not block the process while a command runs", async () => {
    const repo = await createTestGitRepo("aq-verify-");
    try {
      let ticks = 0;
      const timer = setInterval(() => ticks++, 20);
      await runVerification("T1", repo.rootDir, "sleep 0.5");
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(5);
    } finally {
      await repo.cleanup();
    }
  });

  it("treats a run that did not finish as a failure and leaves no process behind", async () => {
    const repo = await createTestGitRepo("aq-verify-");
    try {
      const pidFile = NodePath.join(repo.rootDir, "child.pid");
      const result = await runVerification(
        "T1",
        repo.rootDir,
        `sleep 60 & echo $! > ${pidFile}; wait`,
        400,
      );
      expect(result).toMatchObject({ passed: false, outcome: "timed-out", exitCode: 124 });
      expect(result.stderrSnippet).toContain("not a pass");
      const pid = Number((await NodeFSP.readFile(pidFile, "utf8")).trim());
      expect(processIsLive(pid)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("keeps source diagnostics ahead of long footers and writes redacted private logs", async () => {
    const repo = await createTestGitRepo("aq-verify-log-");
    try {
      const secret = "qe-test-secret-9a32";
      const result = await runSpec(
        "T1",
        repo.rootDir,
        {
          source: "declared",
          checks: [
            {
              run: `node -e 'console.log(process.env.T3_QE_TEST_SECRET);console.log("app/src/Thing.kt:12:4: Unexpected spacing");console.log("Gradle footer ".repeat(12000));process.exit(2)'`,
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
        { env: { T3_QE_TEST_SECRET: secret } },
      );
      const check = result.checks[0]!;
      expect(result.summary.indexOf("Thing.kt:12:4")).toBeLessThan(
        result.summary.indexOf("Gradle footer"),
      );
      expect(result.summary).not.toContain(secret);
      expect(check.diagnosticLogPath).toBeTruthy();
      const log = NodeFS.readFileSync(check.diagnosticLogPath!, "utf8");
      expect(log).not.toContain(secret);
      expect(NodeFS.statSync(check.diagnosticLogPath!).mode & 0o777).toBe(0o600);
    } finally {
      await repo.cleanup();
    }
  });

  it("does not follow a symlink when creating private verification logs", async () => {
    const repo = await createTestGitRepo("aq-verify-log-symlink-");
    const outside = `${repo.rootDir}-outside`;
    const logDirectory = NodePath.join(repo.gitCommonDir, "agentqueue");
    try {
      await NodeFSP.mkdir(outside);
      await NodeFSP.symlink(outside, logDirectory);
      const result = await runVerification("T1", repo.rootDir, "true");
      expect(result.diagnosticLogPath).toBeNull();
      expect(NodeFS.readdirSync(outside)).toEqual([]);
    } finally {
      await NodeFSP.unlink(logDirectory).catch(() => undefined);
      await NodeFSP.rm(outside, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it("does not classify a missing produced artifact as an existing baseline failure", async () => {
    const repo = await createTestGitRepo("aq-verify-baseline-output-");
    const check = {
      run: "true",
      cwd: ".",
      timeoutSeconds: 30,
      requires: [],
      expectExitCode: 0,
      id: "build",
      produces: ["app.apk"],
    };
    try {
      const receipt = await runSpec("T1", repo.rootDir, {
        source: "declared",
        checks: [check],
        exemptReason: null,
        rejected: [],
      });
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const origin = await attributeFailure(db, {
        planId: "plan",
        taskId: "T1",
        repoRoot: repo.rootDir,
        integrationBranch: "missing-base-is-not-read",
        candidateWorktree: repo.rootDir,
        check,
        failed: receipt.checks[0]!,
        scope: [],
        changed: [],
      });
      const cached = db.prepare("SELECT count(*) AS count FROM check_baselines").get() as {
        count: number;
      };
      db.close();
      expect(receipt.checks[0]).toMatchObject({ failureKind: "missing-output" });
      expect(origin.origin).toBe("introduced");
      expect(cached.count).toBe(0);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("follow-up tasks", () => {
  it("parks a request next to its parent once, without changing the parent", async () => {
    const repo = await createTestGitRepo("aq-followup-");
    try {
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "PLAN.md"),
        "# P\n\n- [ ] **RP1 — Thing.**\n  - Depends on: none.\n  - Scope: src/.\n- [ ] **RP2 — Another.**\n  - Depends on: none.\n  - Scope: src/.\n- [ ] **RP3 — Waiting.**\n  - Depends on: RP1, RP2.\n  - Scope: src/.\n",
      );
      await execCommand("git", ["add", "PLAN.md"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
      const imported = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const input = {
        planId: imported.planId,
        parentTaskId: "RP1",
        kind: "decision" as const,
        blocking: true,
        title: "Needs a person after RP1",
        note: "Deploying needs an owner decision.",
        failureClass: "prerequisite" as const,
        fingerprint: "before",
      };
      const first = addFollowUpTask(db, input);
      const again = addFollowUpTask(db, input);
      expect(first).toEqual({ taskId: "RP1-FU1", created: true });
      expect(again).toEqual({ taskId: "RP1-FU1", created: false });
      expect(addFollowUpTask(db, { ...input, parentTaskId: "RP2" })).toEqual({
        taskId: first.taskId,
        created: false,
      });
      const rows = db
        .prepare("SELECT id, status, scope_patterns FROM tasks ORDER BY id")
        .all() as Array<{
        id: string;
        status: string;
        scope_patterns: string;
      }>;
      expect(rows.map((row) => [row.id, row.status])).toEqual([
        ["RP1", "pending"],
        ["RP1-FU1", "blocked"],
        ["RP2", "pending"],
        ["RP3", "pending"],
      ]);
      expect(rows[1]!.scope_patterns).toBe(rows[0]!.scope_patterns);
      const waiting = db.prepare("SELECT dependencies FROM tasks WHERE id = 'RP3'").get() as {
        dependencies: string;
      };
      expect(JSON.parse(waiting.dependencies)).toContain(first.taskId);

      const external = addFollowUpTask(db, {
        ...input,
        note: "Production still needs an operator approval.",
        failureClass: "external",
      });
      expect(reviveHeldTasks(db, imported.planId, () => "after")).toContain(external.taskId);
      const decisions = db
        .prepare("SELECT id, status FROM tasks WHERE id LIKE 'RP1-FU%' ORDER BY id")
        .all() as Array<{ id: string; status: string }>;
      expect(decisions).toEqual([
        { id: first.taskId, status: "completed" },
        { id: external.taskId, status: "pending" },
      ]);
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("baseline-repair follow-ups", () => {
  it("judges the repair by its own check and shares one open repair across parents", async () => {
    const repo = await createTestGitRepo("aq-followup-dedupe-");
    try {
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "PLAN.md"),
        "# P\n\n- [ ] **RP1 — A.**\n  - Depends on: none.\n  - Scope: a/.\n  - Checks:\n    - `true` (cwd: `.`, timeout: 60s, expect: exit 0)\n- [ ] **RP2 — B.**\n  - Depends on: none.\n  - Scope: b/.\n  - Checks:\n    - `true` (cwd: `.`, timeout: 60s, expect: exit 0)\n- [ ] **RP3 — C.**\n  - Depends on: RP1, RP2.\n  - Scope: c/.\n",
      );
      await execCommand("git", ["add", "PLAN.md"], repo.rootDir);
      await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
      const imported = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const producer = {
        id: "assemble",
        run: "gradle assembleDebug",
        cwd: ".",
        timeoutSeconds: 60,
        requires: [],
        expectExitCode: 0,
        produces: ["app/build/outputs/apk/debug/app.apk"],
        reuseInputs: ["app/src"],
      };
      const red = {
        id: "connected",
        run: "gradle connected",
        cwd: ".",
        timeoutSeconds: 60,
        requires: [],
        expectExitCode: 0,
        dependsOn: ["assemble"],
        consumes: ["app/build/outputs/apk/debug/app.apk"],
        reuseInputs: ["app/src/androidTest"],
      };
      const input = {
        planId: imported.planId,
        kind: "repair" as const,
        blocking: true,
        title: "Fix a check that already failed",
        note: "It fails on the integration branch.",
        checks: [producer, red],
        repairEvidence: {
          failedCheckId: red.id,
          producerDependencyIds: ["assemble"],
          inputFingerprint: "a".repeat(64),
          diagnostics: {
            failureKind: "exit-code",
            failureReason: "The check exited unsuccessfully.",
            diagnosticExcerpt: "x".repeat(3000),
            diagnosticLogPath: "/private/agentqueue/verify.log",
          },
        },
      };
      const first = addFollowUpTask(db, { ...input, parentTaskId: "RP1" });
      const second = addFollowUpTask(db, { ...input, parentTaskId: "RP2" });
      expect(first.created).toBe(true);
      expect(second).toEqual({ taskId: first.taskId, created: false });
      const rp3 = db.prepare("SELECT dependencies FROM tasks WHERE id = 'RP3'").get() as {
        dependencies: string;
      };
      expect(JSON.parse(rp3.dependencies)).toContain(first.taskId);
      const spec = db
        .prepare("SELECT verification_spec FROM tasks WHERE id = ?")
        .get(first.taskId) as { verification_spec: string };
      expect(JSON.parse(spec.verification_spec).checks).toEqual([producer, red]);
      const created = db
        .prepare(
          "SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = 'task_followup_created'",
        )
        .get(first.taskId) as { payload_json: string };
      expect(JSON.parse(created.payload_json)).toMatchObject({
        dedupeKey: `repair-input:${input.repairEvidence.inputFingerprint}`,
        repairEvidence: {
          failedCheckId: red.id,
          producerDependencyIds: red.dependsOn,
          inputFingerprint: input.repairEvidence.inputFingerprint,
          diagnostics: {
            failureKind: "exit-code",
            failureReason: "The check exited unsuccessfully.",
            diagnosticExcerpt: "x".repeat(2000),
            diagnosticLogPath: "/private/agentqueue/verify.log",
          },
        },
      });
      const changedInputs = addFollowUpTask(db, {
        ...input,
        parentTaskId: "RP2",
        repairEvidence: {
          ...input.repairEvidence,
          inputFingerprint: "b".repeat(64),
        },
      });
      expect(changedInputs).toEqual({ taskId: "RP2-FU1", created: true });
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});

describe("landed worktree removal", () => {
  it("keeps a worktree that still has uncommitted changes", async () => {
    const repo = await createTestGitRepo("aq-teardown-");
    try {
      const wt = await createTestWorktree(repo, "feature", "feature-branch");
      await NodeFSP.writeFile(NodePath.join(wt.worktreePath, "late.txt"), "late write\n");
      const kept = await teardownWorktree(repo.rootDir, wt.worktreePath, wt.branch, {
        isSuccess: true,
        deleteBranch: true,
        keepIfDirty: true,
      });
      expect(kept.preserved).toBe(true);
      expect(NodeFS.existsSync(wt.worktreePath)).toBe(true);
      await NodeFSP.rm(NodePath.join(wt.worktreePath, "late.txt"));
      const removed = await teardownWorktree(repo.rootDir, wt.worktreePath, wt.branch, {
        isSuccess: true,
        deleteBranch: true,
        keepIfDirty: true,
      });
      expect(removed.preserved).toBe(false);
      expect(NodeFS.existsSync(wt.worktreePath)).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });
});
