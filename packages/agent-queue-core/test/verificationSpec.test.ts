// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import { verifyPlanCompletion } from "../src/completion.ts";
import { importPlanFile } from "../src/planImport.ts";
import { parsePlanMarkdown } from "../src/planGraph.ts";
import { addFollowUpTask } from "../src/overseerRepairs.ts";
import {
  inspectCheckCommand,
  parseStoredSpec,
  runSpec,
  type VerificationSpec,
} from "../src/verificationSpec.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

const task = (body: string) =>
  parsePlanMarkdown(`# Plan\n\n- [ ] **T1 — Thing.**\n  - Depends on: none.\n${body}\n`).tasks[0]!;

describe("declared checks", () => {
  it("reads several checks with working directory, timeout, resources and expected result", () => {
    const parsed = task(
      [
        "  - Checks:",
        "    - `uv run pytest tests/a.py -q` (cwd: server/, timeout: 20m)",
        "    - `./gradlew test` (cwd: android, timeout: 1h, requires: android gpu, expect: exit 0)",
        '    - `node -e "process.exit(3)"` (expect: exit 3)',
        "  - Scope: server/.",
      ].join("\n"),
    );
    expect(parsed.verification?.source).toBe("declared");
    expect(parsed.verification?.checks).toEqual([
      {
        run: "uv run pytest tests/a.py -q",
        cwd: "server",
        timeoutSeconds: 1200,
        requires: [],
        expectExitCode: 0,
      },
      {
        run: "./gradlew test",
        cwd: "android",
        timeoutSeconds: 3600,
        requires: ["android", "gpu"],
        expectExitCode: 0,
      },
      {
        run: 'node -e "process.exit(3)"',
        cwd: ".",
        timeoutSeconds: 1800,
        requires: [],
        expectExitCode: 3,
      },
    ]);
    expect(parsed.scopePatterns).toEqual(["server/"]);
  });

  it("parses opt-in check dependencies, artifacts, reuse inputs and JUnit requirements", () => {
    const parsed = task(
      [
        "  - Checks:",
        "    - `./gradlew assembleDebug` (id: build, produces: app/build/**/*.apk)",
        "    - `./gradlew connectedDebugAndroidTest` (id: instrumentation, after: build, consumes: app/build/outputs/app.apk, reuse-inputs: app/src/**|app/build.gradle, junit: app/build/reports/**/*.xml, min-tests: 12, max-skipped: 0)",
      ].join("\n"),
    );
    expect(parsed.verification?.checks).toEqual([
      {
        run: "./gradlew assembleDebug",
        cwd: ".",
        timeoutSeconds: 1800,
        requires: [],
        expectExitCode: 0,
        id: "build",
        produces: ["app/build/**/*.apk"],
      },
      {
        run: "./gradlew connectedDebugAndroidTest",
        cwd: ".",
        timeoutSeconds: 1800,
        requires: [],
        expectExitCode: 0,
        id: "instrumentation",
        dependsOn: ["build"],
        consumes: ["app/build/outputs/app.apk"],
        reuseInputs: ["app/src/**", "app/build.gradle"],
        junit: {
          reports: ["app/build/reports/**/*.xml"],
          minTests: 12,
          maxSkipped: 0,
        },
      },
    ]);
  });

  it("rejects invalid check graphs and unsafe or ambiguous artifact paths", () => {
    const invalid = [
      ["id: same", "id: same"],
      ["id: first, after: missing"],
      ["id: first, after: second", "id: second, after: first"],
      ["id: first, produces: ../outside.apk"],
      ["id: first, produces: C:\\outside.apk"],
      ["id: build, produces: dist/app.apk", "id: tests, consumes: dist/app.apk"],
      ["produces: dist/app.apk", "id: tests, consumes: dist/app.apk"],
      ["id: first, produces: dist", "id: second, produces: dist/app.apk"],
      ["id: first, produces: dist/**/*.apk", "id: second, produces: dist/app.apk"],
    ];
    for (const options of invalid) {
      const checks = options.map((option, index) => `    - \`true\` (${option})`);
      const parsed = task(["  - Checks:", ...checks].join("\n"));
      expect(parsed.verification?.source).toBe("none");
      expect(parsed.verification?.checks).toEqual([]);
      expect(parsed.verification?.rejected.length).toBeGreaterThan(0);
    }
  });

  it("allows transitive producer dependencies, external inputs and sibling artifact names", () => {
    const parsed = task(
      [
        "  - Checks:",
        "    - `true` (id: build, produces: dist/app.apk)",
        "    - `true` (id: metadata, produces: dist/app.apk.meta)",
        "    - `true` (id: prepare, after: build|metadata)",
        "    - `true` (id: tests, after: prepare, consumes: dist/app.apk|dist/app.apk.meta|fixtures/cases.zip)",
      ].join("\n"),
    );
    expect(parsed.verification?.source).toBe("declared");
    expect(parsed.verification?.checks).toHaveLength(4);
  });

  it("refuses checks that could touch live services, outside paths or secrets, and says why", () => {
    const parsed = task(
      [
        "  - Checks:",
        "    - `curl -fsS https://overseer.example.net/v1/health`",
        "    - `uv run pytest -q ; rm -rf /`",
        "    - `bash /etc/deploy.sh`",
        "    - `uv run pytest tests/ok.py -q` (cwd: ../elsewhere)",
        "    - `docker compose restart api`",
        "    - `uv run pytest tests/ok.py -q`",
      ].join("\n"),
    );
    expect(parsed.verification?.checks.map((check) => check.run)).toEqual([
      "uv run pytest tests/ok.py -q",
    ]);
    expect(parsed.verification?.rejected).toHaveLength(5);
    expect(parsed.verification?.rejected.map((entry) => entry.reason).join("|")).toMatch(
      /infrastructure.*shell control.*outside the worktree.*leaves the worktree.*infrastructure/s,
    );
  });

  it("needs a real reason for an exemption, and never treats silence as a check", () => {
    expect(
      task("  - Verify: none — reviewed manually against the owner's checklist").verification,
    ).toMatchObject({
      source: "exempt",
    });
    expect(task("  - Verify: none — n/a").verification?.source).toBe("none");
    expect(task("  - Scope: src/.").verification).toMatchObject({ source: "none", checks: [] });
  });

  it("only allows plain commands from the runners a server may execute", () => {
    expect(inspectCheckCommand("uv run pytest -q", { declared: false })).toBeNull();
    expect(inspectCheckCommand("cd server && uv run pytest -q", { declared: true })).toBeNull();
    expect(
      inspectCheckCommand("cd server && uv run pytest -q", { declared: false }),
    ).not.toBeNull();
    expect(inspectCheckCommand("git push origin main", { declared: true })).toMatch(/git push/);
    expect(inspectCheckCommand("python3 tool.py --out $(pwd)/x", { declared: false })).toMatch(
      /substitution/,
    );
    expect(inspectCheckCommand("npm run deploy", { declared: false })).toMatch(/infrastructure/);
    expect(inspectCheckCommand("pytest > out.txt", { declared: false })).toMatch(/redirection/);
  });
});

describe("running checks", () => {
  const spec = (checks: VerificationSpec["checks"]): VerificationSpec => ({
    source: "declared",
    checks,
    exemptReason: null,
    rejected: [],
  });
  const check = (run: string, extra: Partial<VerificationSpec["checks"][number]> = {}) => ({
    run,
    cwd: ".",
    timeoutSeconds: 30,
    requires: [],
    expectExitCode: 0,
    ...extra,
  });

  it("is only passed when every check ran and met its expected result; stops at the first failure", async () => {
    const repo = await createTestGitRepo("aq-spec-");
    try {
      await NodeFSP.mkdir(NodePath.join(repo.rootDir, "sub"));
      const passed = await runSpec(
        "T1",
        repo.rootDir,
        spec([
          check("pwd > where.txt || true", { cwd: "sub" }),
          check('node -e "process.exit(3)"', { expectExitCode: 3 }),
        ]),
      );
      // The first command uses redirection, which the policy refuses elsewhere; runSpec itself runs what it is given.
      expect(passed.state).toBe("passed");
      const failed = await runSpec(
        "T1",
        repo.rootDir,
        spec([
          check('node -e "process.exit(0)"'),
          check("echo bad 1>&2; exit 4"),
          check("echo never > never.txt"),
        ]),
      );
      expect(failed.state).toBe("failed");
      expect(failed.checks).toHaveLength(2);
      expect(failed.checks[1]).toMatchObject({ exitCode: 4, passed: false });
      expect(failed.summary).toContain("exited 4, expected 0");
      expect(NodeFS.existsSync(NodePath.join(repo.rootDir, "never.txt"))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  it("never reports no checks as a pass, and an exemption is not a pass either", async () => {
    const repo = await createTestGitRepo("aq-spec-");
    try {
      const none = await runSpec("T1", repo.rootDir, parseStoredSpec(null, null));
      expect(none.state).toBe("unverified");
      expect(none.state).not.toBe("passed");
      const exempt = await runSpec("T1", repo.rootDir, {
        source: "exempt",
        checks: [],
        exemptReason: "manual review recorded in docs",
        rejected: [],
      });
      expect(exempt.state).toBe("exempt");
    } finally {
      await repo.cleanup();
    }
  });

  it("fails a check whose directory is missing or escapes the worktree", async () => {
    const repo = await createTestGitRepo("aq-spec-");
    const outside = `${repo.rootDir}-outside`;
    try {
      await NodeFSP.mkdir(outside);
      await NodeFSP.symlink(outside, NodePath.join(repo.rootDir, "external"));
      for (const cwd of ["missing", "../escape", "external"]) {
        const result = await runSpec("T1", repo.rootDir, spec([check("true", { cwd })]));
        expect(result.state).toBe("failed");
      }
    } finally {
      await NodeFSP.rm(outside, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it("blocks dependent checks after a failed producer while running independent checks", async () => {
    const repo = await createTestGitRepo("aq-spec-artifacts-");
    try {
      const consumer = NodePath.join(repo.rootDir, "consumer-ran");
      const artifact = NodePath.join(repo.rootDir, "app.apk");
      await NodeFSP.writeFile(artifact, "stale artifact from an earlier build");
      const result = await runSpec(
        "T1",
        repo.rootDir,
        spec([
          check('node -e "process.exit(1)"', {
            id: "build",
            produces: ["app.apk"],
          }),
          check(`node -e "require('node:fs').writeFileSync('${consumer}', 'ran')"`, {
            id: "instrumentation",
            dependsOn: ["build"],
            consumes: ["app.apk"],
          }),
          check("true", { id: "lint" }),
        ]),
      );
      expect(result.state).toBe("failed");
      expect(result.checks).toHaveLength(3);
      expect(result.checks[0]).toMatchObject({ passed: false, failureKind: "exit-code" });
      expect(result.checks[1]).toMatchObject({ passed: false, failureKind: "blocked" });
      expect(result.checks[1]?.stderrTail).toContain("build");
      expect(result.checks[2]).toMatchObject({ passed: true });
      expect(NodeFS.existsSync(consumer)).toBe(false);
      expect(await NodeFSP.readFile(artifact, "utf8")).toBe("stale artifact from an earlier build");
    } finally {
      await repo.cleanup();
    }
  });

  it("requires fresh, valid JUnit reports even when the command exits zero", async () => {
    const repo = await createTestGitRepo("aq-spec-junit-");
    try {
      const runWithReport = async (
        xml: string,
        junit: NonNullable<VerificationSpec["checks"][number]["junit"]>,
      ) => {
        const encoded = Buffer.from(xml).toString("base64");
        return runSpec(
          "T1",
          repo.rootDir,
          spec([
            check(
              `node -e 'require("node:fs").writeFileSync("reports/run.xml", Buffer.from("${encoded}", "base64"))'`,
              {
                id: "tests",
                junit,
              },
            ),
          ]),
        );
      };
      await NodeFSP.mkdir(NodePath.join(repo.rootDir, "reports"));
      const requirement = { reports: ["reports/**/*.xml"], minTests: 1, maxSkipped: 0 };
      const passed = await runWithReport(
        '<testsuites><testsuite><testcase name="ok" /></testsuite></testsuites>',
        requirement,
      );
      expect(passed.state).toBe("passed");

      for (const fixture of [
        { xml: "<testsuite>", reason: "malformed" },
        { xml: '<testsuite tests="0"></testsuite>', reason: "0 executed" },
        {
          xml: '<testsuite><testcase name="installDebug"><failure message="INSTALL_FAILED: instrumentation launch failed" /></testcase></testsuite>',
          reason: "INSTALL_FAILED",
        },
        {
          xml: '<testsuite><testcase name="skip"><skipped /></testcase></testsuite>',
          reason: "skipped",
        },
        {
          xml: '<!DOCTYPE testsuite SYSTEM "https://example.invalid/report.dtd"><testsuite><testcase /></testsuite>',
          reason: "DTD",
        },
      ]) {
        const failed = await runWithReport(fixture.xml, requirement);
        expect(failed.state).toBe("failed");
        expect(failed.checks[0]?.passed).toBe(false);
        expect(failed.checks[0]?.failureReason).toContain(fixture.reason);
      }
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects an unchanged stale JUnit report", async () => {
    const repo = await createTestGitRepo("aq-spec-stale-junit-");
    try {
      await NodeFSP.writeFile(
        NodePath.join(repo.rootDir, "reports.xml"),
        '<testsuite><testcase name="old" /></testsuite>',
      );
      NodeFS.utimesSync(NodePath.join(repo.rootDir, "reports.xml"), new Date(0), new Date(0));
      const result = await runSpec(
        "T1",
        repo.rootDir,
        spec([
          check("true", {
            id: "tests",
            junit: { reports: ["reports.xml"], minTests: 1, maxSkipped: 0 },
          }),
        ]),
      );
      expect(result.state).toBe("failed");
      expect(result.checks[0]?.stderrTail).toContain("stale");
    } finally {
      await repo.cleanup();
    }
  });

  it("fails when a required JUnit report is missing", async () => {
    const repo = await createTestGitRepo("aq-spec-missing-junit-");
    try {
      const result = await runSpec(
        "T1",
        repo.rootDir,
        spec([
          check("true", {
            id: "tests",
            junit: { reports: ["reports/**/*.xml"], minTests: 0, maxSkipped: 0 },
          }),
        ]),
      );
      expect(result.state).toBe("failed");
      expect(result.checks[0]).toMatchObject({ passed: false, failureKind: "junit-missing" });
    } finally {
      await repo.cleanup();
    }
  });

  it("rejects artifact and JUnit paths that resolve through symlinks outside the repository", async () => {
    const repo = await createTestGitRepo("aq-spec-symlink-evidence-");
    const outside = `${repo.rootDir}-outside`;
    try {
      await NodeFSP.mkdir(outside);
      await NodeFSP.writeFile(
        NodePath.join(outside, "report.xml"),
        "<testsuite><testcase /></testsuite>",
      );
      await NodeFSP.symlink(
        NodePath.join(outside, "report.xml"),
        NodePath.join(repo.rootDir, "external.xml"),
      );
      await NodeFSP.symlink(
        NodePath.join(outside, "report.xml"),
        NodePath.join(repo.rootDir, "external.apk"),
      );

      const artifact = await runSpec(
        "T1",
        repo.rootDir,
        spec([check("true", { id: "build", produces: ["external.apk"] })]),
      );
      const report = await runSpec(
        "T1",
        repo.rootDir,
        spec([
          check("true", {
            id: "tests",
            junit: { reports: ["external.xml"], minTests: 1, maxSkipped: 0 },
          }),
        ]),
      );
      const input = await runSpec(
        "T1",
        repo.rootDir,
        spec([check("true", { id: "consumer", consumes: ["external.apk"] })]),
      );
      expect(artifact.checks[0]).toMatchObject({ passed: false, failureKind: "missing-output" });
      expect(input.checks[0]).toMatchObject({ passed: false, failureKind: "missing-input" });
      expect(report.checks[0]).toMatchObject({ passed: false, failureKind: "junit-malformed" });
    } finally {
      await NodeFSP.rm(outside, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it("serialises checks that need the same resource", async () => {
    const repo = await createTestGitRepo("aq-spec-");
    try {
      const log = NodePath.join(repo.rootDir, "order.log");
      const slow = (name: string) =>
        spec([
          check(`echo start-${name} >> ${log}; sleep 0.3; echo end-${name} >> ${log}`, {
            requires: ["gpu"],
          }),
        ]);
      await Promise.all([
        runSpec("A", repo.rootDir, slow("a")),
        runSpec("B", repo.rootDir, slow("b")),
      ]);
      const lines = (await NodeFSP.readFile(log, "utf8")).trim().split("\n");
      expect(lines[0]!.startsWith("start-")).toBe(true);
      expect(lines[1]!.replace("end-", "")).toBe(lines[0]!.replace("start-", ""));
    } finally {
      await repo.cleanup();
    }
  });
});

describe("plan import and completion", () => {
  const seed = async (plan: string, extra: Record<string, string> = {}) => {
    const repo = await createTestGitRepo("aq-spec-import-");
    await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
    for (const [name, content] of Object.entries(extra)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(repo.rootDir, name)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, name), content);
    }
    await execCommand("git", ["add", "."], repo.rootDir);
    await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
    return repo;
  };

  it("stores structured check evidence metadata when importing a plan", async () => {
    const repo = await seed(
      [
        "# P",
        "",
        "- [ ] **RP1 — Build and inspect.**",
        "  - Depends on: none.",
        "  - Checks:",
        "    - `true` (id: build, produces: artifacts/app.apk)",
        "    - `true` (id: instrumentation, after: build, consumes: artifacts/app.apk, junit: reports/run.xml, min-tests: 1, max-skipped: 0)",
      ].join("\n"),
    );
    try {
      const imported = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const row = db.prepare("SELECT verification_spec FROM tasks WHERE id = 'RP1'").get() as {
        verification_spec: string;
      };
      db.close();
      const stored = JSON.parse(row.verification_spec) as VerificationSpec;
      expect(imported.total).toBe(1);
      expect(stored.checks).toMatchObject([
        { id: "build", produces: ["artifacts/app.apk"] },
        {
          id: "instrumentation",
          dependsOn: ["build"],
          consumes: ["artifacts/app.apk"],
          junit: { reports: ["reports/run.xml"], minTests: 1, maxSkipped: 0 },
        },
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it("places a derived check in the project directory the task's scope names", async () => {
    const repo = await seed(
      [
        "# P",
        "",
        "- [ ] **T1 — Server work.**",
        "  - Depends on: none.",
        "  - Scope: server/src/a.py, server/tests/.",
        "  - Done: `uv run pytest tests/x.py -q` passes.",
        "- [ ] **T2 — Unplaceable.**",
        "  - Depends on: none.",
        "  - Scope: docs/.",
        "  - Done: `uv run pytest tests/y.py -q` passes.",
        "",
      ].join("\n"),
      { "server/pyproject.toml": "[project]\nname='x'\n" },
    );
    try {
      importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const rows = db
        .prepare("SELECT id, verification_spec FROM tasks ORDER BY id")
        .all() as Array<{
        id: string;
        verification_spec: string;
      }>;
      db.close();
      const t1 = JSON.parse(rows[0]!.verification_spec) as VerificationSpec;
      expect(t1.checks[0]).toMatchObject({ cwd: "server", run: "uv run pytest tests/x.py -q" });
      const t2 = JSON.parse(rows[1]!.verification_spec) as VerificationSpec;
      expect(t2.source).toBe("none");
      expect(t2.rejected[0]?.reason).toContain("working directory");
    } finally {
      await repo.cleanup();
    }
  });

  it("a blocking follow-up makes waiting tasks depend on it; an optional one does not", async () => {
    const repo = await seed(
      [
        "# P",
        "",
        "- [ ] **A — First.**",
        "  - Depends on: none.",
        "- [ ] **B — Second.**",
        "  - Depends on: A.",
        "",
      ].join("\n"),
    );
    try {
      const imported = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const input = {
        planId: imported.planId,
        parentTaskId: "A",
        kind: "decision" as const,
        title: "t",
        note: "needs the owner",
      };
      addFollowUpTask(db, { ...input, blocking: false });
      const deps = () =>
        JSON.parse(
          (
            db.prepare("SELECT dependencies FROM tasks WHERE id = 'B'").get() as {
              dependencies: string;
            }
          ).dependencies,
        );
      expect(deps()).toEqual(["A"]);
      addFollowUpTask(db, { ...input, note: "a requirement", blocking: true });
      expect(deps()).toEqual(["A", "A-FU2"]);
      db.close();
    } finally {
      await repo.cleanup();
    }
  });

  it("a plan with a task merged without any check is not complete until it is audited", async () => {
    const repo = await seed("# P\n\n- [ ] **A — First.**\n  - Depends on: none.\n");
    try {
      const imported = importPlanFile(repo.rootDir, "PLAN.md");
      const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
      const planRow = db.prepare("SELECT integration_branch FROM plans").get() as {
        integration_branch: string | null;
      };
      const base = (
        await execCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], repo.rootDir)
      ).stdout.trim();
      const report = () =>
        verifyPlanCompletion(db, {
          repoRoot: repo.rootDir,
          gitCommonDir: repo.gitCommonDir,
          baseBranch: base,
          integrationBranch: planRow.integration_branch ?? base,
          planId: imported.planId,
          runFinalCheck: false,
        });
      const head = (await execCommand("git", ["rev-parse", "HEAD"], repo.rootDir)).stdout.trim();
      db.prepare("UPDATE tasks SET status = 'completed', receipt_json = ? WHERE id = 'A'").run(
        JSON.stringify({
          command: "",
          stdoutTail: "No verification command; checked by git state only.",
        }),
      );
      db.prepare(
        "INSERT INTO landing_queue (task_id, source_branch, target_branch, status, commit_hash, queued_at) VALUES ('A','x',?, 'landed', ?, ?)",
      ).run(base, head, new Date().toISOString());
      expect((await report()).unchecked).toEqual(["A"]);
      expect((await report()).complete).toBe(false);
      db.prepare(
        "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES ('A','task_audited',?,?)",
      ).run(JSON.stringify({ state: "failed" }), new Date().toISOString());
      expect((await report()).unchecked).toEqual(["A"]);
      db.prepare(
        "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES ('A','task_audited',?,?)",
      ).run(JSON.stringify({ state: "passed" }), new Date().toISOString());
      expect((await report()).unchecked).toEqual([]);
      db.close();
    } finally {
      await repo.cleanup();
    }
  });
});
