// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * A verification-repair follow-up whose problem is already gone, and the machine failures that
 * must never become code work. Mirrors the Overseer Goal that stalled: NR2 was submitted, its
 * Android check failed in the server's own environment ("SDK location not found"), the same
 * check failed on the integration branch, a repair follow-up (NR2-FU1) was created, and the
 * owner reran the check, found it passing and had nothing to commit. The server then insisted
 * on a commit it could never get.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { openQueueDatabase } from "../src/db.ts";
import {
  ensureIntegrationBranch,
  integrateCandidate,
  integrationBranchFor,
  submitCandidate,
} from "../src/integration.ts";
import { addFollowUpTask } from "../src/overseerRepairs.ts";
import { claimTask } from "../src/claimService.ts";
import { settleUnchangedFollowUp } from "../src/followUpResolution.ts";
import { importPlanFile } from "../src/planImport.ts";
import { reserveNextTask } from "../src/reservation.ts";
import {
  androidSdkLocation,
  environmentFailureOf,
  toolchainEnvironment,
  toolchainFingerprint,
} from "../src/toolchain.ts";
import { createTestGitRepo, execCommand } from "./harness/gitHarness.ts";

/** Keep executable checks inside their fixture repo; only their mutable marker state lives in tmp. */
function script(dir: string, name: string, body: string) {
  const fileName = `${name}.cjs`;
  return {
    command: `node ${fileName}`,
    fileName,
    source: `const fs=require('fs');const path=require('path');const here=${JSON.stringify(dir)};\n${body}\n`,
  };
}

const tempDir = (prefix: string) => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));

/** Fails with a named failing item unless `open` exists in the folder. */
const gated = (dir: string) =>
  script(
    dir,
    "gate",
    "if(!fs.existsSync(path.join(here,'open'))){console.log('FAILED gate_check');process.exit(1)}",
  );

const planOf = (tasks: ReadonlyArray<{ id: string; verify: string; scope?: string }>) =>
  [
    "# Plan",
    "",
    ...tasks.flatMap((task) => [
      `- [ ] **${task.id} — Task ${task.id}**`,
      "  - Depends on: none.",
      ...(task.scope ? [`  - Scope: ${task.scope}.`] : []),
      `  - Verify: ${task.verify}`,
      "",
    ]),
  ].join("\n");

async function setup(plan: string, files: Record<string, string> = {}) {
  const repo = await createTestGitRepo("aq-followup-");
  await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
  for (const [name, content] of Object.entries(files)) {
    await NodeFSP.writeFile(NodePath.join(repo.rootDir, name), content);
  }
  await execCommand("git", ["add", "."], repo.rootDir);
  await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
  const { planId } = importPlanFile(repo.rootDir, "PLAN.md");
  const goal = integrationBranchFor(planId);
  ensureIntegrationBranch(repo.rootDir, "main", goal);
  const db = openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
  db.prepare("UPDATE plans SET integration_branch = ?, base_branch = 'main' WHERE id = ?").run(
    goal,
    planId,
  );
  const reserve = async (name: string) => {
    const outcome = await reserveNextTask(db, {
      repoRoot: repo.rootDir,
      baseBranch: goal,
      planId,
      workerSessionId: name,
    });
    if (outcome.kind !== "reserved")
      throw new Error(`expected a reservation: ${JSON.stringify(outcome)}`);
    return outcome.task;
  };
  const reserveTask = async (name: string, taskId: string) => {
    const task = await reserve(name);
    if (task.taskId !== taskId) throw new Error(`reserved ${task.taskId}, wanted ${taskId}`);
    return task;
  };
  const commit = async (cwd: string, file: string, content: string) => {
    await NodeFSP.writeFile(NodePath.join(cwd, file), content);
    await execCommand("git", ["add", file], cwd);
    await execCommand("git", ["commit", "-m", `work ${file}`], cwd);
  };
  const submit = (task: Awaited<ReturnType<typeof reserve>>) =>
    submitCandidate(db, {
      repoRoot: repo.rootDir,
      baseBranch: goal,
      taskId: task.taskId,
      claimToken: task.claimToken,
      worktreePath: task.worktreePath,
      branch: task.branch,
      verificationCommand: task.verificationCommand ?? "",
    });
  const integrate = (taskId: string) =>
    integrateCandidate(db, {
      repoRoot: repo.rootDir,
      gitCommonDir: repo.gitCommonDir,
      baseBranch: "main",
      integrationBranch: goal,
      taskId,
    });
  const row = (id: string) =>
    db
      .prepare(
        "SELECT status, integration_state, integration_error, failure_class FROM tasks WHERE id = ?",
      )
      .get(id) as {
      status: string;
      integration_state: string | null;
      integration_error: string | null;
      failure_class: string | null;
    };
  const events = (id: string, type: string) =>
    db
      .prepare("SELECT payload_json FROM task_events WHERE task_id = ? AND event_type = ?")
      .all(id, type) as Array<{ payload_json: string }>;
  const followUps = (parent: string) =>
    (
      db.prepare("SELECT id FROM tasks WHERE id LIKE ? ORDER BY id").all(`${parent}-FU%`) as Array<{
        id: string;
      }>
    ).map((entry) => entry.id);
  return {
    repo,
    db,
    goal,
    planId,
    reserve,
    reserveTask,
    commit,
    submit,
    integrate,
    row,
    events,
    followUps,
    cleanup: async () => {
      db.close();
      await repo.cleanup();
    },
  };
}

const SDK_ERROR =
  "SDK location not found. Define a valid SDK location with an ANDROID_HOME environment variable or by setting the sdk.dir path in your project's local properties file";

describe("a repair follow-up whose problem is already gone", () => {
  /**
   * A1's check fails everywhere (the gate is closed) with a named failing item, so it is set aside
   * as a baseline failure and tracked as A1-FU1. B1 lands first so A1 must merge, which reruns its
   * check on the merged result.
   */
  const scenario = async () => {
    const dir = await tempDir("aq-gate-");
    const gate = NodePath.join(dir, "open");
    const gateCheck = gated(dir);
    const flakyCheck = script(
      dir,
      "flaky",
      "const c=path.join(here,'runs');const n=fs.existsSync(c)?+fs.readFileSync(c,'utf8'):0;fs.writeFileSync(c,String(n+1));if(n===0){console.log('FAILED flaky_check');process.exit(1)}",
    );
    const brokenCheck = script(
      dir,
      "broken",
      `fs.appendFileSync(path.join(here,'env-runs'),'x');console.error(${JSON.stringify(SDK_ERROR)});process.exit(1)`,
    );
    const t = await setup(
      planOf([
        { id: "A1", verify: gateCheck.command },
        { id: "B1", verify: 'node -e "process.exit(0)"' },
      ]),
      {
        [gateCheck.fileName]: gateCheck.source,
        [flakyCheck.fileName]: flakyCheck.source,
        [brokenCheck.fileName]: brokenCheck.source,
      },
    );
    const a = await t.reserveTask("wa", "A1");
    const b = await t.reserveTask("wb", "B1");
    await t.commit(a.worktreePath, "a1.txt", "one\n");
    await t.commit(b.worktreePath, "b1.txt", "two\n");
    const submitted = await t.submit(a);
    expect(submitted).toMatchObject({ kind: "submitted" });
    expect((await t.submit(b)).kind).toBe("submitted");
    expect(t.followUps("A1")).toEqual(["A1-FU1"]);
    expect((await t.integrate("B1")).kind).toBe("landed");
    // A1 merges with B1 and its check fails again on the merged result: it needs repair.
    expect((await t.integrate("A1")).kind).toBe("needs-repair");
    expect(t.row("A1")).toMatchObject({ status: "verifying", integration_state: "conflict" });
    // The follow-up's owner picks up the follow-up (the parent's repair is not what it is asked).
    const followUp = await t.db
      .prepare("SELECT 1 FROM tasks WHERE id = 'A1-FU1' AND status = 'pending'")
      .get();
    expect(followUp).toBeDefined();
    return { t, gate, dir, flakyCheck, brokenCheck };
  };

  const claimFollowUp = async (t: Awaited<ReturnType<typeof setup>>) => {
    // The follow-up is claimed directly: the live Goal's owner was bound to it the moment it existed.
    const claimed = await import("../src/claimService.ts").then((module) =>
      module.claimTask(t.db, {
        taskId: "A1-FU1",
        workerPid: process.pid,
        workerSessionId: "owner",
        worktreePath: NodePath.join(t.repo.rootDir, ".worktrees", "agentqueue", "A1-FU1"),
        branch: "agent/aq/A1-FU1",
        leaseSeconds: 600,
      }),
    );
    if (!claimed.success) throw new Error(`could not claim the follow-up: ${claimed.reason}`);
    await execCommand(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "agent/aq/A1-FU1",
        NodePath.join(t.repo.rootDir, ".worktrees", "agentqueue", "A1-FU1"),
        t.goal,
      ],
      t.repo.rootDir,
    );
    return {
      claimToken: claimed.claim.ownerToken,
      worktreePath: NodePath.join(t.repo.rootDir, ".worktrees", "agentqueue", "A1-FU1"),
      branch: "agent/aq/A1-FU1",
    };
  };

  const submitFollowUp = (
    t: Awaited<ReturnType<typeof setup>>,
    claim: Awaited<ReturnType<typeof claimFollowUp>>,
  ) =>
    submitCandidate(t.db, {
      repoRoot: t.repo.rootDir,
      baseBranch: t.goal,
      taskId: "A1-FU1",
      claimToken: claim.claimToken,
      worktreePath: claim.worktreePath,
      branch: claim.branch,
      verificationCommand: "",
    });

  it("resolves with no commit when the server itself sees the check pass, then lets the parent merge", async () => {
    const { t, gate, dir } = await scenario();
    try {
      const claim = await claimFollowUp(t);
      // Whatever made it fail is gone (here: the gate opened). The follow-up's owner has nothing to commit.
      await NodeFSP.writeFile(gate, "open\n");

      // Concurrent completion attempts verify in separate worktrees and only one owns completion.
      const outcomes = await Promise.all([submitFollowUp(t, claim), submitFollowUp(t, claim)]);
      expect(outcomes.filter((result) => result.kind === "resolved")).toHaveLength(1);
      expect(outcomes.some((result) => result.kind === "claim-lost")).toBe(true);
      const outcome = outcomes.find((result) => result.kind === "resolved");

      expect(outcome).toMatchObject({
        kind: "resolved",
        parentTaskId: "A1",
        parentRetried: true,
        flaky: false,
      });
      expect(t.row("A1-FU1")).toMatchObject({ status: "completed", integration_state: null });
      // It is on record as resolved by the server's own observation, not by a commit.
      const resolved = t.events("A1-FU1", "task_followup_resolved");
      expect(resolved).toHaveLength(1);
      expect(JSON.parse(resolved[0]!.payload_json)).toMatchObject({
        reason: "check-passes-without-change",
        parentTaskId: "A1",
      });
      expect(
        t.db.prepare("SELECT receipt_json FROM tasks WHERE id = 'A1-FU1'").get(),
      ).toMatchObject({ receipt_json: expect.stringContaining('"resolvedWithoutChange":true') });
      // No commit was invented, and the claim is released.
      expect(
        (
          await execCommand(
            "git",
            ["rev-list", "--count", `${t.goal}..${claim.branch}`],
            t.repo.rootDir,
          )
        ).stdout.trim(),
      ).toBe("0");
      expect(
        t.db
          .prepare(
            "SELECT count(*) AS n FROM task_claims WHERE task_id = 'A1-FU1' AND released_at IS NULL",
          )
          .get(),
      ).toMatchObject({ n: 0 });

      // The original work continues: it merges now that its check passes, with no repair worker.
      expect(t.row("A1")).toMatchObject({ status: "verifying", integration_state: "pending" });
      expect((await t.integrate("A1")).kind).toBe("landed");
      expect(t.row("A1")).toMatchObject({ status: "completed", integration_state: null });
    } finally {
      await t.cleanup();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not resolve a genuine regression: the check still fails, so the worker is told", async () => {
    const { t, dir } = await scenario();
    try {
      const claim = await claimFollowUp(t);
      const outcome = await submitFollowUp(t, claim);

      expect(outcome).toMatchObject({ kind: "verification-failed", failureClass: "verification" });
      if (outcome.kind !== "verification-failed") throw new Error("unreachable");
      expect(outcome.error).toContain("still fails");
      expect(t.row("A1-FU1").status).toBe("claimed");
      expect(t.events("A1-FU1", "task_followup_resolved")).toHaveLength(0);
      // The parent is not set to merge again on a failure that is still there.
      expect(t.row("A1")).toMatchObject({ integration_state: "conflict" });
    } finally {
      await t.cleanup();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("calls a check that fails once and then passes flaky, resolves it, and says so", async () => {
    const { t, gate, dir, flakyCheck } = await scenario();
    try {
      const claim = await claimFollowUp(t);
      // The stored check now fails on its first run only.
      const counter = NodePath.join(dir, "runs");
      t.db
        .prepare(
          "UPDATE tasks SET verification_command = ?, verification_spec = NULL WHERE id = 'A1-FU1'",
        )
        .run(flakyCheck.command);
      expect(NodeFS.existsSync(gate)).toBe(false);

      const outcome = await submitFollowUp(t, claim);

      expect(outcome).toMatchObject({ kind: "resolved", flaky: true });
      expect(NodeFS.readFileSync(counter, "utf8")).toBe("2");
      expect(
        JSON.parse(t.events("A1-FU1", "task_followup_resolved")[0]!.payload_json),
      ).toMatchObject({ flaky: true });
    } finally {
      await t.cleanup();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("holds for the machine, without demanding a commit or rerunning, when the toolchain is missing", async () => {
    const { t, dir, brokenCheck } = await scenario();
    try {
      const claim = await claimFollowUp(t);
      const counter = NodePath.join(dir, "env-runs");
      t.db
        .prepare(
          "UPDATE tasks SET verification_command = ?, verification_spec = NULL WHERE id = 'A1-FU1'",
        )
        .run(brokenCheck.command);

      const outcome = await submitFollowUp(t, claim);

      expect(outcome).toMatchObject({
        kind: "verification-failed",
        failureClass: "prerequisite",
        decision: { action: "hold" },
      });
      // One run showed it; a second would only repeat the wall.
      expect(NodeFS.readFileSync(counter, "utf8")).toBe("x");
      expect(t.row("A1-FU1").status).toBe("claimed");
    } finally {
      await t.cleanup();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an ordinary task with no commit as no-changes", async () => {
    const t = await setup(planOf([{ id: "A1", verify: 'node -e "process.exit(0)"' }]));
    try {
      const a = await t.reserveTask("wa", "A1");
      expect(await t.submit(a)).toEqual({ kind: "no-changes" });
      expect(t.row("A1").status).toBe("claimed");
    } finally {
      await t.cleanup();
    }
  });
});

describe("failures that belong to the machine, not the code", () => {
  it("recognises toolchain failures and nothing a test prints", () => {
    expect(environmentFailureOf(`> ${SDK_ERROR}\nBUILD FAILED`)).toContain(
      "SDK location not found",
    );
    expect(
      environmentFailureOf("JAVA_HOME is not set and no 'java' command could be found"),
    ).not.toBeNull();
    expect(
      environmentFailureOf("FAILED test_auth_permission_denied: credential rejected"),
    ).toBeNull();
    expect(environmentFailureOf("AssertionError: expected 3 to equal 4")).toBeNull();
  });

  it("does not turn a missing SDK into a follow-up task or a repair: the task is held for the machine", async () => {
    const dir = await tempDir("aq-sdk-missing-");
    const check = script(dir, "sdk", `console.error(${JSON.stringify(SDK_ERROR)});process.exit(1)`);
    const t = await setup(
      planOf([
        {
          id: "A1",
          verify: check.command,
        },
      ]),
      { [check.fileName]: check.source },
    );
    try {
      const a = await t.reserveTask("wa", "A1");
      await t.commit(a.worktreePath, "a1.txt", "one\n");

      const outcome = await t.submit(a);

      expect(outcome).toMatchObject({
        kind: "verification-failed",
        failureClass: "prerequisite",
        decision: { action: "hold" },
      });
      expect(t.followUps("A1")).toEqual([]);
      expect(t.events("A1", "task_failure_attributed")[0]?.payload_json).toContain("environment");
    } finally {
      await t.cleanup();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("a merge whose checks cannot run here waits for the machine instead of becoming a conflict", async () => {
    const dir = await tempDir("aq-env-");
    const counter = NodePath.join(dir, "runs");
    const ready = NodePath.join(dir, "ready");
    // Passes on its first run (when submitted, on the base it started from); after that it fails on
    // this machine with the SDK error until `ready` exists.
    const check = script(
      dir,
      "merge-env",
      `const c=path.join(here,'runs');fs.appendFileSync(c,'x');if(!fs.existsSync(path.join(here,'ready'))&&fs.readFileSync(c,'utf8').length>1){console.error(${JSON.stringify(SDK_ERROR)});process.exit(1)}`,
    );
    const t = await setup(
      planOf([
        { id: "A1", verify: check.command },
        { id: "B1", verify: 'node -e "process.exit(0)"' },
      ]),
      { [check.fileName]: check.source },
    );
    const previous = { home: process.env.ANDROID_HOME, root: process.env.ANDROID_SDK_ROOT };
    try {
      delete process.env.ANDROID_HOME;
      delete process.env.ANDROID_SDK_ROOT;
      const a = await t.reserveTask("wa", "A1");
      const b = await t.reserveTask("wb", "B1");
      await t.commit(a.worktreePath, "a1.txt", "one\n");
      await t.commit(b.worktreePath, "b1.txt", "two\n");
      expect((await t.submit(a)).kind).toBe("submitted");
      expect((await t.submit(b)).kind).toBe("submitted");
      expect((await t.integrate("B1")).kind).toBe("landed");

      const first = await t.integrate("A1");
      expect(first.kind).toBe("environment-wait");
      expect(t.row("A1")).toMatchObject({ status: "verifying", integration_state: "pending" });
      expect(t.row("A1").integration_error).toContain("Waiting for the machine");
      expect(t.followUps("A1")).toEqual([]);
      const runs = NodeFS.readFileSync(counter, "utf8").length;

      // Looked at again a moment later: not run again, however often the scheduler asks.
      expect((await t.integrate("A1")).kind).toBe("environment-wait");
      expect((await t.integrate("A1")).kind).toBe("environment-wait");
      expect(NodeFS.readFileSync(counter, "utf8").length).toBe(runs);

      // The machine gains a toolchain: the candidate is tried again at once and merges.
      await NodeFSP.writeFile(ready, "yes\n");
      const sdk = NodePath.join(dir, "sdk");
      await NodeFSP.mkdir(sdk);
      process.env.ANDROID_HOME = sdk;
      expect((await t.integrate("A1")).kind).toBe("landed");
      expect(t.row("A1")).toMatchObject({ status: "completed", integration_state: null });
    } finally {
      if (previous.home === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = previous.home;
      if (previous.root === undefined) delete process.env.ANDROID_SDK_ROOT;
      else process.env.ANDROID_SDK_ROOT = previous.root;
      await t.cleanup();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the toolchain the server's own checks run with", () => {
  it("finds the SDK the way the checkout does when the process was not started from a shell that exports it", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "aq-sdk-"));
    try {
      const sdk = NodePath.join(dir, "sdk");
      const repoRoot = NodePath.join(dir, "repo");
      await NodeFSP.mkdir(NodePath.join(repoRoot, "android"), { recursive: true });
      await NodeFSP.mkdir(sdk);
      const home = NodePath.join(dir, "home");
      await NodeFSP.mkdir(home);
      const env = { HOME: home } as NodeJS.ProcessEnv;
      expect(androidSdkLocation({ repoRoot, env })).toBeNull();
      expect(toolchainEnvironment({ repoRoot, env })).toEqual({});

      await NodeFSP.writeFile(
        NodePath.join(repoRoot, "android", "local.properties"),
        `sdk.dir=${sdk}\n`,
      );
      expect(androidSdkLocation({ repoRoot, env })).toBe(sdk);
      expect(toolchainEnvironment({ repoRoot, env })).toEqual({ ANDROID_HOME: sdk });
      // An explicit variable wins and nothing is added.
      expect(toolchainEnvironment({ repoRoot, env: { ...env, ANDROID_HOME: sdk } })).toEqual({});

      const before = toolchainFingerprint({ repoRoot, env: { HOME: home } as NodeJS.ProcessEnv });
      await NodeFSP.rm(NodePath.join(repoRoot, "android", "local.properties"));
      expect(toolchainFingerprint({ repoRoot, env: { HOME: home } as NodeJS.ProcessEnv })).not.toBe(
        before,
      );

      // Gradle's own machine-wide setting is honoured too.
      await NodeFSP.mkdir(NodePath.join(home, ".gradle"));
      await NodeFSP.writeFile(
        NodePath.join(home, ".gradle", "gradle.properties"),
        `org.gradle.daemon=false\nsystemProp.android.home=${sdk}\n`,
      );
      expect(androidSdkLocation({ repoRoot, env })).toBe(sdk);
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("why a ready task cannot start", () => {
  it("names the task that holds the files", async () => {
    const t = await setup(
      planOf([
        { id: "A1", verify: 'node -e "process.exit(0)"', scope: "shared/" },
        { id: "B1", verify: 'node -e "process.exit(0)"', scope: "shared/b/" },
      ]),
    );
    try {
      await t.reserveTask("wa", "A1");
      const second = await reserveNextTask(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: t.goal,
        planId: t.planId,
        workerSessionId: "wb",
      });
      expect(second).toMatchObject({
        kind: "none",
        skipped: [{ taskId: "B1", reason: "SCOPE_CONFLICT (held by A1)" }],
      });
    } finally {
      await t.cleanup();
    }
  });
});

describe("one task that cannot be prepared", () => {
  it("does not stop the independent tasks behind it from starting", async () => {
    const t = await setup(
      planOf([
        { id: "A1", verify: 'node -e "process.exit(0)"' },
        { id: "B1", verify: 'node -e "process.exit(0)"' },
      ]),
    );
    let other: string | undefined;
    try {
      // A1's branch is already checked out somewhere else, so its worktree cannot be made.
      const { planWorktree } = await import("../src/worktreeManager.ts");
      const planned = planWorktree(t.repo.rootDir, "A1", "Task A1");
      other = NodePath.join(NodeOS.tmpdir(), `aq-elsewhere-${NodePath.basename(t.repo.rootDir)}`);
      await execCommand(
        "git",
        ["worktree", "add", "-b", planned.branch, other, t.goal],
        t.repo.rootDir,
      );

      const first = await t.reserve("w1");
      expect(first.taskId).toBe("B1");
      expect(t.events("A1", "task_provision_failed")).toHaveLength(1);
      // A1 is not hammered on every pass, and is reported with the reason.
      const again = await reserveNextTask(t.db, {
        repoRoot: t.repo.rootDir,
        baseBranch: t.goal,
        planId: t.planId,
        workerSessionId: "w2",
      });
      expect(again).toMatchObject({
        kind: "none",
        skipped: [{ taskId: "A1", reason: expect.stringContaining("WORKTREE_FAILED") }],
      });
      expect(t.events("A1", "task_provision_failed")).toHaveLength(1);
      expect(t.row("A1").status).toBe("pending");
      await execCommand("git", ["worktree", "remove", "--force", other], t.repo.rootDir);
      other = undefined;
    } finally {
      if (other) {
        await execCommand("git", ["worktree", "remove", "--force", other], t.repo.rootDir).catch(
          () => undefined,
        );
      }
      await t.cleanup();
    }
  });

  it("a repair with a broken worktree does not stop an independent task", async () => {
    const t = await setup(
      planOf([
        { id: "A1", verify: 'node -e "process.exit(0)"' },
        { id: "B1", verify: 'node -e "process.exit(0)"' },
      ]),
    );
    const repair = await t.reserveTask("w1", "A1");
    let movedWorktree: string | undefined;
    try {
      await t.commit(repair.worktreePath, "a1.txt", "one\n");
      expect((await t.submit(repair)).kind).toBe("submitted");
      const { stdout: tip } = await execCommand(
        "git",
        ["rev-parse", `refs/heads/${t.goal}`],
        t.repo.rootDir,
      );
      t.db
        .prepare(
          "UPDATE tasks SET integration_state = 'conflict', integration_tip = ? WHERE id = ?",
        )
        .run(tip.trim(), "A1");

      // Keep A1's candidate branch checked out, but move it away from the expected repair path.
      movedWorktree = NodePath.join(
        NodeOS.tmpdir(),
        `aq-repair-away-${NodePath.basename(t.repo.rootDir)}`,
      );
      await execCommand(
        "git",
        ["worktree", "move", repair.worktreePath, movedWorktree],
        t.repo.rootDir,
      );

      const independent = await t.reserve("w2");
      expect(independent.taskId).toBe("B1");
      expect(t.events("A1", "task_provision_failed")).toHaveLength(1);
      expect(t.row("A1")).toMatchObject({ status: "verifying", integration_state: "conflict" });

      await execCommand(
        "git",
        ["worktree", "move", movedWorktree, repair.worktreePath],
        t.repo.rootDir,
      );
      movedWorktree = undefined;
    } finally {
      if (movedWorktree) {
        await execCommand(
          "git",
          ["worktree", "remove", "--force", movedWorktree],
          t.repo.rootDir,
        ).catch(() => undefined);
      }
      await t.cleanup();
    }
  });
});

describe("a follow-up whose checks need dependencies that are not installed", () => {
  const MANIFEST = '{"name":"fixture","dependencies":{"external-dep":"1.0.0"}}';

  /** Opens a repair follow-up of A1 and claims it, as the server does for its owner. */
  const openClaimedFollowUp = async (t: Awaited<ReturnType<typeof setup>>) => {
    const followUp = addFollowUpTask(t.db, {
      planId: t.planId,
      parentTaskId: "A1",
      kind: "repair",
      blocking: true,
      title: "Repair A1",
      note: "The check fails on the integration branch.",
    });
    const claimed = claimTask(t.db, {
      taskId: followUp.taskId,
      workerPid: process.pid,
      workerSessionId: "owner",
      worktreePath: NodePath.join(t.repo.rootDir, ".worktrees", "agentqueue", followUp.taskId),
      branch: `agent/aq/${followUp.taskId}`,
      leaseSeconds: 600,
    });
    if (!claimed.success) throw new Error(`could not claim: ${claimed.reason}`);
    return { taskId: followUp.taskId, claimToken: claimed.claim.ownerToken };
  };

  const settle = (
    t: Awaited<ReturnType<typeof setup>>,
    follow: { taskId: string; claimToken: string },
  ) =>
    settleUnchangedFollowUp(t.db, {
      taskId: follow.taskId,
      claimToken: follow.claimToken,
      repoRoot: t.repo.rootDir,
      gitCommonDir: t.repo.gitCommonDir,
      baseBranch: t.goal,
    });

  it("waits for the environment, with no second repair, when a declared dependency is not installed", async () => {
    const t = await setup(planOf([{ id: "A1", verify: 'node -e "process.exit(0)"' }]), {
      "package.json": MANIFEST,
    });
    try {
      const follow = await openClaimedFollowUp(t);
      const outcome = await settle(t, follow);
      expect(outcome).toMatchObject({
        kind: "resource-wait",
        message: expect.stringContaining("Dependency preparation failed at follow-up"),
      });
      expect(outcome).toMatchObject({ message: expect.stringContaining("external-dep") });
      expect(t.followUps("A1")).toEqual([follow.taskId]);
      expect(t.events(follow.taskId, "task_verification_failed")).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });

  it("still reports a genuinely failing check once its dependencies are installed", async () => {
    const dir = await tempDir("aq-gate-deps-");
    const check = gated(dir);
    const t = await setup(planOf([{ id: "A1", verify: check.command }]), {
      "package.json": MANIFEST,
      [check.fileName]: check.source,
    });
    try {
      await NodeFSP.mkdir(NodePath.join(t.repo.rootDir, "node_modules", "external-dep"), {
        recursive: true,
      });
      const follow = await openClaimedFollowUp(t);
      expect(await settle(t, follow)).toMatchObject({ kind: "still-failing" });
    } finally {
      await t.cleanup();
    }
  });
});
