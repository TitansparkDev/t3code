// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/**
 * Real-agent proof of the execution contract. NOT part of the unit suite (it spends model
 * usage): run it with
 *
 *   node --experimental-strip-types test/realAgent/realAgentGoal.mts [haiku-model-id]
 *
 * Two throwaway repositories with different rules, each a multi-worker goal run by real
 * Claude Code workers (the same prompt the server sends, the same queue, submit, integrate,
 * repair and completion code the server runs). The scripted difficulties are the ones that
 * wasted agents in production:
 *
 *  repo "aurora": a guard that rejects the default branch convention (and says only `bot/`),
 *    a contract that only declares a capability (the guard and branch prefix are inferred and probed); a task that needs one file outside
 *    its declared scope (a justified amendment); a task needing a capability the machine
 *    lacks; a task waiting behind that one.
 *  repo "borealis": other rules (`wk/`, a committed contract); a commit hook that rebuilds a
 *    generated file on every task branch (merge conflicts the server rebuilds); a fixed-port
 *    test two tasks cannot run at once; a task whose runner is not installed; a concurrent
 *    change to the same file (merge conflict repaired from the preserved commits).
 *
 * It prints what happened and exits non-zero if the queue wasted a worker, lost work, or
 * completed something it should not have.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  integrateCandidate,
  ensureIntegrationBranch,
  importPlanFile,
  integrationBranchFor,
  openQueueDatabase,
  parseScopeRequests,
  publishPlan,
  renewLease,
  reserveNextTask,
  submitCandidate,
  verifyPlanCompletion,
  probeBranchPrefix,
  loadContract,
  type ReservedTask,
} from "../../src/index.ts";
import { queueWorkerPrompt } from "../../../contracts/src/goals.ts";

const MODEL = process.argv[2] ?? "claude-haiku-5-5";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sh = (command: string, cwd: string) =>
  NodeChildProcess.execSync(command, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const write = (root: string, file: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, file), content);
};

interface Scenario {
  readonly label: string;
  readonly root: string;
  readonly files: Record<string, string>;
  readonly plan: string;
  /** Called with each reserved task before its worker starts (to inject a concurrent change). */
  readonly onReserved?: (task: ReservedTask, root: string, goal: string) => void;
  readonly expectPrefix: string;
  readonly expectComplete: ReadonlyArray<string>;
  readonly expectHeld: Readonly<Record<string, string>>;
  readonly grantable?: { readonly file: string; readonly completes: ReadonlyArray<string> };
}

const taskBlock = (
  id: string,
  title: string,
  o: { deps?: string[]; scope: string; verify: string; text: string },
) =>
  [
    `- [ ] **${id} — ${title}.**`,
    `  - Depends on: ${o.deps?.length ? o.deps.join(", ") : "none"}.`,
    `  - Scope: ${o.scope}.`,
    `  - ${o.text}`,
    `  - Verify: \`${o.verify}\``,
    "",
  ].join("\n");

function auroraScenario(tmp: string): Scenario {
  const root = NodePath.join(tmp, "aurora");
  const grant = NodePath.join(tmp, "aurora-host-granted");
  const files: Record<string, string> = {
    "package.json": '{ "name": "aurora", "version": "1.0.0" }\n',
    "src/index.js": "module.exports = {};\n",
    "tools/guard.js": [
      'const { execFileSync } = require("node:child_process");',
      'const branch = execFileSync("git", ["branch", "--show-current"]).toString().trim();',
      'if (!branch.startsWith("bot/")) {',
      '  console.error("GUARD: work happens on a bot/ branch in a linked worktree only; this branch is " + branch);',
      "  process.exit(1);",
      "}",
      'console.log("guard ok");',
      "",
    ].join("\n"),
    "AGENTS.md": [
      "# Aurora rules",
      "",
      "Every automated worker must run `node tools/guard.js` (the branch guard) before its first write; it fails on an unsuitable branch and you must not work around it.",
      "Keep changes small and inside the task's scope.",
      "",
    ].join("\n"),
    ".githooks/pre-commit":
      '#!/bin/sh\ncase "$(git symbolic-ref --quiet --short HEAD)" in bot/*) exit 0;; esac\ngit ls-files | sort > FILES.txt\ngit add FILES.txt\n',
    "FILES.txt": "",
    "test/check_a1.js": [
      'const assert = require("node:assert");',
      'const { greet } = require("../src/greet.js");',
      'assert.strictEqual(greet("Ada"), "Hello, Ada!");',
      'console.log("ok");',
      "",
    ].join("\n"),
    "test/check_a2.js": [
      'const assert = require("node:assert");',
      'const index = require("../src/index.js");',
      'const { farewell } = require("../src/farewell.js");',
      'assert.strictEqual(farewell("Ada"), "Goodbye, Ada!");',
      'assert.strictEqual(index.farewell("Bo"), "Goodbye, Bo!");',
      'console.log("ok");',
      "",
    ].join("\n"),
    "test/check_a3.js": [
      'const assert = require("node:assert");',
      'const { summary } = require("../src/summary.js");',
      'assert.strictEqual(summary("Ada"), "Hello, Ada! Goodbye, Ada!");',
      'console.log("ok");',
      "",
    ].join("\n"),
  };
  const plan = [
    "# Aurora plan",
    "",
    "## Tasks",
    "",
    taskBlock("A1", "Add the greeting module", {
      scope: "src/greet.js",
      verify: "node test/check_a1.js",
      text: "Create `src/greet.js` exporting `greet(name)` returning `Hello, <name>!` (CommonJS).",
    }),
    taskBlock("A2", "Add the farewell module and export it", {
      scope: "src/farewell.js",
      verify: "node test/check_a2.js",
      text: "Create `src/farewell.js` exporting `farewell(name)` returning `Goodbye, <name>!`. The package entry `src/index.js` must also export `farewell` (add one line there; that file is not in this task's declared scope, so ask for it as the instructions say).",
    }),
    taskBlock("A3", "Add the summary module", {
      deps: ["A1", "A2"],
      scope: "src/summary.js",
      verify: "node test/check_a3.js",
      text: "Create `src/summary.js` exporting `summary(name)` returning the greeting and the farewell for the name joined by a space, using `src/greet.js` and `src/farewell.js`.",
    }),
    taskBlock("A4", "Publish the package to the live registry [host]", {
      scope: "docs/publish.md",
      verify: "test -f docs/publish.md",
      text: "Write `docs/publish.md` describing the publish steps.",
    }),
    taskBlock("A5", "Announce the release", {
      deps: ["A4"],
      scope: "docs/announce.md",
      verify: "test -f docs/announce.md",
      text: "Write `docs/announce.md` with one sentence announcing the release.",
    }),
  ].join("\n");
  files["PLAN.md"] = plan;
  files[".agentqueue/contract.json"] = JSON.stringify({
    capabilities: { host: { probe: `test -f ${grant}`, description: "the live registry host" } },
  });
  return {
    label: "aurora",
    root,
    files,
    plan,
    expectPrefix: "bot/",
    expectComplete: ["A1", "A2", "A3"],
    expectHeld: { A4: "external" },
    grantable: { file: grant, completes: ["A4", "A5"] },
  };
}

function borealisScenario(tmp: string): Scenario {
  const root = NodePath.join(tmp, "borealis");
  const files: Record<string, string> = {
    "package.json": '{ "name": "borealis", "version": "1.0.0" }\n',
    "src/registry.js": "// registry entries\nmodule.exports = [];\n",
    "scripts/preflight.js": [
      'const { execFileSync } = require("node:child_process");',
      'const branch = execFileSync("git", ["branch", "--show-current"]).toString().trim();',
      'if (!branch.startsWith("wk/")) { console.error("PREFLIGHT: branch " + branch + " is not an accepted wk/ branch"); process.exit(1); }',
      'console.log("preflight ok");',
      "",
    ].join("\n"),
    "AGENTS.md": [
      "# Borealis conventions",
      "",
      "- Start every task with the preflight command given in your assignment.",
      "- Do not edit FILES.txt by hand; it is generated.",
      "- Tests must never use ports other than the ones assigned to you, except the legacy port test below.",
      "",
    ].join("\n"),
    // A commit hook that is aligned with nothing: it rebuilds the generated file on every branch.
    ".githooks/pre-commit": "#!/bin/sh\ngit ls-files | sort > FILES.txt\ngit add FILES.txt\n",
    "FILES.txt": "",
    "test/port_test.js": [
      'const net = require("node:net");',
      "const server = net.createServer();",
      'server.on("error", (e) => { console.error("PORT IN USE", e.code); process.exit(1); });',
      "server.listen(47311, () => setTimeout(() => server.close(() => { console.log('ok'); }), 2500));",
      "",
    ].join("\n"),
    "test/check_b1.js":
      'const assert = require("node:assert"); assert.ok(require("../src/b1.js").name === "b1"); console.log("ok");\n',
    "test/check_b2.js":
      'const assert = require("node:assert"); assert.ok(require("../src/registry.js").includes("b2")); assert.strictEqual(require("../src/b2.js").name, "b2"); console.log("ok");\n',
    "test/check_b3.js":
      'const assert = require("node:assert"); const r = require("../src/registry.js"); assert.ok(r.includes("b3")); assert.strictEqual(require("../src/b3.js").name, "b3"); console.log("ok");\n',
  };
  const plan = [
    "# Borealis plan",
    "",
    "## Tasks",
    "",
    taskBlock("B1", "Add module b1", {
      scope: "src/b1.js",
      verify: "node test/check_b1.js",
      text: 'Create `src/b1.js` exporting `{ name: "b1" }` (CommonJS).',
    }),
    taskBlock("B2", "Add module b2 and register it", {
      scope: "src/b2.js, src/registry.js",
      verify: "node test/check_b2.js",
      text: 'Create `src/b2.js` exporting `{ name: "b2" }` and add the string "b2" to the array exported by `src/registry.js`.',
    }),
    taskBlock("B3", "Add module b3 and register it", {
      deps: ["B1"],
      scope: "src/b3.js, src/registry.js",
      verify: "node test/check_b3.js",
      text: 'Create `src/b3.js` exporting `{ name: "b3" }` and add the string "b3" to the array exported by `src/registry.js`, keeping every entry already there. Keep the whole array on one line, like `module.exports = ["b2", "b3"];`.',
    }),
    taskBlock("B4", "Port test for the legacy listener", {
      scope: "docs/port.md",
      verify: "node test/port_test.js",
      text: "Write `docs/port.md` with one sentence about the legacy listener. Its check runs the fixed-port test.",
    }),
    taskBlock("B6", "Port test for the second listener", {
      scope: "docs/port2.md",
      verify: "node test/port_test.js",
      text: "Write `docs/port2.md` with one sentence about the second listener. Its check runs the fixed-port test.",
    }),
    taskBlock("B5", "Type checks for the tools folder", {
      scope: "tools/",
      verify: "mypy src",
      text: "Add `tools/README.md` with one sentence. Its check needs the mypy type checker.",
    }),
  ].join("\n");
  files["PLAN.md"] = plan;
  files[".agentqueue/contract.json"] = JSON.stringify({
    branchPrefixes: ["wk/"],
    guards: [
      {
        name: "preflight",
        run: "node scripts/preflight.js",
        phase: "start",
        branchSensitive: true,
      },
    ],
    generated: [{ paths: ["FILES.txt"], regenerate: "git ls-files | LC_ALL=C sort > FILES.txt" }],
    protectedPaths: ["scripts/", ".agentqueue/", ".githooks/"],
    resources: [{ name: "legacy-port", limit: 1, commands: ["port_test"] }],
  });
  return {
    label: "borealis",
    root,
    files,
    plan,
    expectPrefix: "wk/",
    expectComplete: ["B1", "B2", "B3", "B4", "B6"],
    expectHeld: { B5: "prerequisite" },
    // B3 branches from the plan's branch and is made to meet a concurrent change to the registry.
    onReserved: (task, repo, goal) => {
      if (task.taskId !== "B3" || task.repair) return;
      const staging = NodePath.join(repo, ".worktrees", "concurrent-change");
      sh(`git worktree add --detach ${staging} ${goal}`, repo);
      const current = NodeFS.readFileSync(NodePath.join(staging, "src/registry.js"), "utf8");
      write(
        staging,
        "src/registry.js",
        current.replace(
          /module\.exports = \[(.*)\];/,
          (_m, inner: string) => `module.exports = [${inner ? `${inner}, ` : ""}"seed"];`,
        ),
      );
      sh(
        'git add -A && git -c user.name=other -c user.email=o@o commit -qm "another task registers seed" --no-verify',
        staging,
      );
      const tip = sh("git rev-parse HEAD", staging);
      sh(`git update-ref refs/heads/${goal} ${tip}`, repo);
      sh(`git worktree remove --force ${staging}`, repo);
    },
  };
}

// ───────────────────────────── running one scenario ─────────────────────────────

interface Stats {
  workerRuns: Record<string, number>;
  claims: Record<string, number>;
  costUsd: number;
  log: string[];
}

function claudeRun(
  cwd: string,
  prompt: string,
  env: Readonly<Record<string, string>>,
  resume?: string,
): Promise<{ result: string; sessionId: string; cost: number }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--model",
      MODEL,
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      ...(resume ? ["--resume", resume] : []),
    ];
    const child = NodeChildProcess.spawn("claude", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        resolve({
          result: String(parsed.result ?? ""),
          sessionId: String(parsed.session_id ?? ""),
          cost: Number(parsed.total_cost_usd ?? 0),
        });
      } catch {
        reject(new Error(`claude produced no JSON: ${out.slice(-300)} ${err.slice(-300)}`));
      }
    });
  });
}

async function runScenario(scenario: Scenario, tmp: string) {
  const { root } = scenario;
  NodeFS.mkdirSync(root, { recursive: true });
  sh(
    "git init -q -b main && git config user.email t@t && git config user.name t && git config core.hooksPath .githooks",
    root,
  );
  for (const [file, content] of Object.entries(scenario.files)) write(root, file, content);
  for (const hook of NodeFS.existsSync(NodePath.join(root, ".githooks"))
    ? NodeFS.readdirSync(NodePath.join(root, ".githooks"))
    : []) {
    NodeFS.chmodSync(NodePath.join(root, ".githooks", hook), 0o755);
  }
  sh("git add -A && git commit -qm init --no-verify", root);

  const gitCommonDir = NodePath.join(root, ".git");
  const { planId } = importPlanFile(root, "PLAN.md");
  const goal = integrationBranchFor(planId);
  ensureIntegrationBranch(root, "main", goal);
  const refs = ["main", goal];
  const probe = probeBranchPrefix({
    repoRoot: root,
    gitCommonDir,
    baseRef: "main",
    loaded: loadContract({ repoRoot: root, gitCommonDir, refs }),
  });
  const stats: Stats = { workerRuns: {}, claims: {}, costUsd: 0, log: [] };
  const say = (line: string) => {
    stats.log.push(line);
    console.log(`[${scenario.label}] ${line}`);
  };
  say(
    `bind probe: prefix=${probe.prefix} tried=${probe.tried.join(",")} (${probe.detail.slice(0, 80)})`,
  );
  if (probe.prefix !== scenario.expectPrefix)
    throw new Error(`expected prefix ${scenario.expectPrefix}, probe said ${probe.prefix}`);

  const db = openQueueDatabase({ gitCommonDir });
  db.prepare("UPDATE plans SET integration_branch = ?, base_branch = 'main' WHERE id = ?").run(
    goal,
    planId,
  );

  const assignment = (task: ReservedTask, lastFailure: string | null) => ({
    taskId: task.taskId,
    title: task.title,
    description: task.description,
    verificationCommand: task.verificationCommand,
    worktreePath: task.worktreePath,
    branch: task.branch,
    baseBranch: task.baseBranch,
    planPath: "PLAN.md",
    retryCount: task.retryCount,
    lastFailure,
    repair: task.repair?.reason ?? null,
    existingCommits: task.repair ? task.repair.commits : task.existingCommits,
    conflictFiles: task.repair?.files ?? [],
    allowedPaths: task.scope.length > 0 ? task.allowedPaths : [],
    guards: task.guards,
    generatedPaths: task.generatedPaths,
    environmentNotes: [
      `Your private resources: ports ${task.environment.AGENTQUEUE_PORT_BASE}+, database ${task.environment.AGENTQUEUE_DB_NAME}.`,
    ],
    notes: task.notes,
  });
  const goalShape = {
    name: "Complete the plan",
    prompt: "Complete the plan",
    concurrency: 3,
  } as never;

  const handle = async (task: ReservedTask) => {
    stats.claims[task.taskId] = (stats.claims[task.taskId] ?? 0) + 1;
    scenario.onReserved?.(task, root, goal);
    say(
      `${task.taskId}${task.repair ? " (repair)" : ""} reserved on ${task.branch}; resources=${task.resources.join(",") || "-"}; existing commits=${task.existingCommits.length}`,
    );
    // The server renews a running worker's lease; so does the harness.
    const heartbeat = setInterval(() => renewLease(db, task.claimToken, 300), 15_000);
    try {
      await work(task);
    } finally {
      clearInterval(heartbeat);
    }
  };

  const work = async (task: ReservedTask) => {
    let run = await claudeRun(
      task.worktreePath,
      queueWorkerPrompt(goalShape, assignment(task, task.lastFailure)),
      task.environment,
    );
    stats.workerRuns[task.taskId] = (stats.workerRuns[task.taskId] ?? 0) + 1;
    stats.costUsd += run.cost;
    for (let attempt = 0; attempt < 4; attempt++) {
      const outcome = await submitCandidate(db, {
        repoRoot: root,
        gitCommonDir,
        baseBranch: goal,
        targetBranch: "main",
        taskId: task.taskId,
        claimToken: task.claimToken,
        worktreePath: task.worktreePath,
        branch: task.branch,
        verificationCommand: "",
        scopeRequests: parseScopeRequests(run.result),
      });
      say(
        `${task.taskId} submit -> ${outcome.kind}${"error" in outcome ? `: ${String(outcome.error).slice(0, 140)}` : ""}`,
      );
      if (outcome.kind === "submitted") return;
      if (outcome.kind === "claim-lost") return;
      if ("decision" in outcome && outcome.decision.action === "hold") {
        say(`${task.taskId} held: ${outcome.decision.why}`);
        return;
      }
      const feedback =
        outcome.kind === "no-changes"
          ? "The server found no commit on your branch. Commit your work."
          : outcome.kind === "scope-violation"
            ? `The server found changes outside your allowed paths:\n${outcome.error}\nRevert what you cannot justify (git rm / git checkout <base> -- path) and commit, or end your final message with a line: SCOPE-REQUEST: <path> — <why the task needs it>.`
            : `The server ran the task's check and it failed:\n${outcome.error}\nFix it, run the check yourself, and commit.`;
      run = await claudeRun(task.worktreePath, feedback, task.environment, run.sessionId);
      stats.workerRuns[task.taskId] = (stats.workerRuns[task.taskId] ?? 0) + 1;
      stats.costUsd += run.cost;
    }
  };

  const integrateAll = async () => {
    const pending = db
      .prepare("SELECT id FROM tasks WHERE integration_state = 'pending'")
      .all() as Array<{ id: string }>;
    for (const { id } of pending) {
      const result = await integrateCandidate(db, {
        repoRoot: root,
        gitCommonDir,
        baseBranch: "main",
        integrationBranch: goal,
        taskId: id,
      });
      say(
        `${id} integrate -> ${result.kind}${result.kind === "needs-repair" ? `: ${result.reason.slice(0, 120)}` : ""}`,
      );
    }
  };

  let idle = 0;
  const worker = async (name: string) => {
    while (idle < 6) {
      const reserved = await reserveNextTask(db, {
        repoRoot: root,
        baseBranch: goal,
        targetBranch: "main",
        gitCommonDir,
        planId,
        workerSessionId: name,
        isOwnerAlive: () => false,
      });
      if (reserved.kind === "none") {
        await integrateAll();
        const busy = (
          db.prepare("SELECT count(*) AS c FROM task_claims WHERE released_at IS NULL").get() as {
            c: number;
          }
        ).c;
        const waiting = (
          db
            .prepare("SELECT count(*) AS c FROM tasks WHERE integration_state IS NOT NULL")
            .get() as { c: number }
        ).c;
        if (busy === 0 && waiting === 0) idle++;
        await sleep(1500);
        continue;
      }
      idle = 0;
      try {
        await handle(reserved.task);
      } catch (error) {
        say(`${reserved.task.taskId} worker error: ${(error as Error).message}`);
        db.prepare("UPDATE task_claims SET released_at = ? WHERE owner_token = ?").run(
          new Date().toISOString(),
          reserved.task.claimToken,
        );
        db.prepare("UPDATE tasks SET status = 'pending' WHERE id = ? AND status = 'claimed'").run(
          reserved.task.taskId,
        );
      }
      await integrateAll();
    }
  };

  await Promise.all([worker("w1"), worker("w2"), worker("w3")]);
  await integrateAll();

  const status = (id: string) =>
    db.prepare("SELECT status, failure_class, retry_count FROM tasks WHERE id = ?").get(id) as {
      status: string;
      failure_class: string | null;
      retry_count: number;
    };
  const failures: string[] = [];
  for (const id of scenario.expectComplete) {
    if (status(id).status !== "completed")
      failures.push(`${id} is ${status(id).status}, expected completed`);
  }
  for (const [id, cls] of Object.entries(scenario.expectHeld)) {
    const row = status(id);
    if (row.status !== "blocked" || row.failure_class !== cls)
      failures.push(`${id} is ${row.status}/${row.failure_class}, expected blocked/${cls}`);
    if (stats.claims[id]) failures.push(`${id} was given to a worker although it cannot run here`);
  }
  for (const [id, runs] of Object.entries(stats.workerRuns)) {
    if (runs > 4) failures.push(`${id} used ${runs} worker turns`);
  }
  const retried = (
    db.prepare("SELECT id FROM tasks WHERE retry_count > 0").all() as Array<{ id: string }>
  ).map((r) => r.id);
  if (retried.length > 0) failures.push(`retries were spent on ${retried.join(", ")}`);

  if (scenario.grantable) {
    NodeFS.writeFileSync(scenario.grantable.file, "ok");
    idle = 0;
    await Promise.all([worker("w4"), worker("w5")]);
    await integrateAll();
    for (const id of scenario.grantable.completes) {
      if (status(id).status !== "completed")
        failures.push(
          `${id} did not complete after the capability was granted (${status(id).status})`,
        );
    }
    const published = await publishPlan(db, {
      repoRoot: root,
      gitCommonDir,
      baseBranch: "main",
      integrationBranch: goal,
      planId,
      policy: { reconcileAbandoned: true, idleMinutes: 0 },
    });
    say(`publish -> ${published.kind}`);
    const done = await verifyPlanCompletion(db, {
      repoRoot: root,
      gitCommonDir,
      baseBranch: "main",
      integrationBranch: goal,
      planId,
      runFinalCheck: true,
    });
    say(`plan complete=${done.complete} ${done.reason ?? ""}`);
    if (!done.complete) failures.push(`plan not complete: ${done.reason}`);
  }

  say(
    `worker turns: ${JSON.stringify(stats.workerRuns)} claims: ${JSON.stringify(stats.claims)} cost $${stats.costUsd.toFixed(3)}`,
  );
  return { failures, stats };
}

const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-real-agent-"));
console.log(`real-agent run in ${tmp} with ${MODEL}`);
let failed = 0;
let cost = 0;
for (const make of [auroraScenario, borealisScenario].filter(
  (candidate) => !process.env.ONLY || candidate.name.startsWith(process.env.ONLY),
)) {
  const scenario = make(tmp);
  try {
    const { failures, stats } = await runScenario(scenario, tmp);
    cost += stats.costUsd;
    if (failures.length > 0) {
      failed += failures.length;
      console.error(`[${scenario.label}] FAILURES:\n  - ${failures.join("\n  - ")}`);
    } else console.log(`[${scenario.label}] OK`);
  } catch (error) {
    failed++;
    console.error(`[${scenario.label}] ERROR`, error);
  }
}
console.log(
  `total model cost $${cost.toFixed(3)}; ${failed === 0 ? "ALL PASSED" : `${failed} problem(s)`}`,
);
process.exit(failed === 0 ? 0 : 1);
