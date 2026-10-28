// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  claimCheck,
  processIsLive,
  releaseCheck,
  ResourceBroker,
  runningCheck,
  waitForCheck,
} from "../packages/agent-queue-core/src/index.ts";

const SCRIPT = NodePath.resolve(import.meta.dirname, "reliability-check.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** A throwaway repository with one tracked file, a broker home, and tiny fake compilers. */
function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-check-"));
  roots.push(root);
  const repo = NodePath.join(root, "repo");
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(repo);
  NodeFS.mkdirSync(home);
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd: repo, stdio: "ignore" },
    );
  git("init", "-q");
  NodeFS.writeFileSync(NodePath.join(repo, "source.ts"), "export const value = 1;\n");
  git("add", "source.ts");
  git("commit", "-q", "-m", "initial");

  const compiler = NodePath.join(home, "tsc");
  NodeFS.writeFileSync(
    compiler,
    [
      "#!/bin/sh",
      'echo launched >> "$FAKE_HOME/launches.log"',
      'if [ -n "$FAKE_INPUT" ]; then echo changed > "$FAKE_INPUT"; fi',
      'sleep "${FAKE_SECONDS:-0}"',
      'echo "checked"',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  NodeFS.chmodSync(compiler, 0o755);
  const hanging = NodePath.join(home, "hanging-tsc.sh");
  NodeFS.writeFileSync(
    hanging,
    ["#!/bin/sh", "sleep 60 &", 'echo $! > "$1/grandchild.pid"', "wait", ""].join("\n"),
  );
  return { root, repo, home, compiler, hanging };
}

function launches(home: string): number {
  const file = NodePath.join(home, "launches.log");
  return NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean).length
    : 0;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCheck(
  fx: ReturnType<typeof fixture>,
  options: {
    readonly flags?: string[];
    readonly command?: string;
    readonly commandArgs?: string[];
    readonly env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTQUEUE_RESOURCE_HOME: fx.home,
    AGENTQUEUE_LOCK_ROOT: NodePath.join(fx.home, "locks"),
    AGENTQUEUE_TEST_HOST_MEMORY_MB: "20000",
    FAKE_HOME: fx.home,
    ...options.env,
  };
  delete env.AGENTQUEUE_RESOURCE_TICKET;
  delete env.AGENTQUEUE_CHECK_CHAIN;
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        SCRIPT,
        "typecheck",
        ...(options.flags ?? []),
        "--",
        options.command ?? fx.compiler,
        ...(options.commandArgs ?? []),
      ],
      { cwd: fx.repo, env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function typecheckGrants(home: string): number {
  const broker = new ResourceBroker({ home });
  try {
    const row = broker.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tickets WHERE label LIKE 'typecheck:%' AND outcome IN ('ok', 'failed')",
      )
      .get() as { n: number };
    return Number(row.n);
  } finally {
    broker.close();
  }
}

describe("typecheck wrapper", () => {
  it("atomically replaces a stale claim and gives one live owner to concurrent claimants", async () => {
    const fx = fixture();
    const key = "a".repeat(64);
    const seed = new ResourceBroker({ home: fx.home });
    seed.db
      .prepare(
        "INSERT INTO check_claims (key, pid, pid_start, owner, claimed_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, 2_147_483_647, null, "stale-owner", 0);
    seed.close();

    const moduleUrl = new URL("../packages/agent-queue-core/src/checkReceipts.ts", import.meta.url)
      .href;
    const program = [
      `import { claimCheck, releaseCheck } from ${JSON.stringify(moduleUrl)};`,
      "const [key, home] = process.argv.slice(1);",
      'process.stdout.write("ready\\n");',
      "let owner = null;",
      'process.stdin.on("data", chunk => { for (const line of chunk.toString().split("\\n")) { if (line === "go") { owner = claimCheck(key, home); process.stdout.write(`claimed:${owner ?? \"\"}\\n`); } else if (line === "end") { if (owner) releaseCheck(key, owner, home); process.exit(0); } } });',
      "",
    ].join("\n");
    const start = () => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["--input-type=module", "--eval", program, key, fx.home],
        { cwd: fx.repo, stdio: ["pipe", "pipe", "pipe"] },
      );
      let text = "";
      const pending: string[] = [];
      const waiters: Array<(line: string) => void> = [];
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
        const lines = text.split("\n");
        text = lines.pop() ?? "";
        for (const line of lines) {
          const waiter = waiters.shift();
          if (waiter) waiter(line);
          else pending.push(line);
        }
      });
      const nextLine = () =>
        pending.length > 0
          ? Promise.resolve(pending.shift()!)
          : new Promise<string>((resolve) => waiters.push(resolve));
      const exited = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`claim helper exited ${code}`)),
        );
      });
      return { child, nextLine, exited };
    };
    const workers = [start(), start()];
    await Promise.all(workers.map((worker) => worker.nextLine()));
    for (const worker of workers) worker.child.stdin.write("go\n");
    const claimed = await Promise.all(workers.map((worker) => worker.nextLine()));
    expect(claimed.filter((line) => line.startsWith("claimed:") && line.length > 8)).toHaveLength(
      1,
    );
    const current = runningCheck(key, fx.home);
    expect(current?.owner).not.toBe("stale-owner");
    expect(await waitForCheck(key, fx.home, 0)).toBe(false);
    for (const worker of workers) worker.child.stdin.write("end\n");
    await Promise.all(workers.map((worker) => worker.exited));
    expect(claimCheck(key, fx.home)).not.toBeNull();
    const owner = runningCheck(key, fx.home)?.owner;
    if (owner) releaseCheck(key, owner, fx.home);
  });

  it("runs two identical concurrent requests as one compiler, and both get its result", async () => {
    const fx = fixture();
    const [first, second] = await Promise.all([
      runCheck(fx, { env: { FAKE_SECONDS: "1" } }),
      runCheck(fx, { env: { FAKE_SECONDS: "1" } }),
    ]);
    expect(launches(fx.home)).toBe(1);
    expect(typecheckGrants(fx.home)).toBe(1);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.stdout + second.stdout).toContain("checked");
  });

  it("reuses only a completed successful typecheck", async () => {
    const fx = fixture();
    const first = await runCheck(fx);
    const second = await runCheck(fx);
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(launches(fx.home)).toBe(1);
    expect(second.stderr).toContain("no compiler was launched");

    const failed = await runCheck(fx, { env: { FAKE_EXIT: "3" } });
    const repeatedFailure = await runCheck(fx, { env: { FAKE_EXIT: "3" } });
    expect([failed.code, repeatedFailure.code]).toEqual([3, 3]);
    expect(launches(fx.home)).toBe(3);
    expect(repeatedFailure.stderr).not.toContain("no compiler was launched");
  });

  it("does not reuse a passing receipt that exceeds the current timeout", async () => {
    const fx = fixture();
    const env = { FAKE_SECONDS: "1.2" };
    expect((await runCheck(fx, { env })).code).toBe(0);
    const timedOut = await runCheck(fx, { flags: ["--timeout", "1"], env });
    expect(timedOut.code).toBe(124);
    expect(launches(fx.home)).toBe(2);
  });

  it("launches a fresh check when a tracked file changed", async () => {
    const fx = fixture();
    await runCheck(fx);
    NodeFS.writeFileSync(NodePath.join(fx.repo, "source.ts"), "export const value = 2;\n");
    const changed = await runCheck(fx);
    expect(changed.code).toBe(0);
    expect(launches(fx.home)).toBe(2);
  });

  it("does not write a receipt when declared inputs change during the check", async () => {
    const fx = fixture();
    const input = NodePath.join(fx.repo, "source.ts");
    const env = { FAKE_INPUT: input };
    const invalidated = await runCheck(fx, { env });
    expect(invalidated.code).toBe(1);
    expect(invalidated.stderr).toContain("inputs changed while typecheck was running");
    expect(launches(fx.home)).toBe(1);

    const completed = await runCheck(fx, { env });
    expect(completed.code).toBe(0);
    expect(launches(fx.home)).toBe(2);
    const reused = await runCheck(fx, { env });
    expect(reused.code).toBe(0);
    expect(reused.stderr).toContain("no compiler was launched");
    expect(launches(fx.home)).toBe(2);
  });

  it("launches a fresh check when an untracked file's content changed", async () => {
    const fx = fixture();
    const extra = NodePath.join(fx.repo, "scratch.ts");
    NodeFS.writeFileSync(extra, "export const scratch = 1;\n");
    await runCheck(fx);
    NodeFS.writeFileSync(extra, "export const scratch = 2;\n");
    await runCheck(fx);
    expect(launches(fx.home)).toBe(2);
  });

  it("launches a fresh check when an ignored declared input changes", async () => {
    const fx = fixture();
    NodeFS.writeFileSync(NodePath.join(fx.repo, ".gitignore"), "ignored.ts\n");
    NodeChildProcess.execFileSync("git", ["add", ".gitignore"], { cwd: fx.repo });
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "ignore"],
      { cwd: fx.repo, stdio: "ignore" },
    );
    const ignored = NodePath.join(fx.repo, "ignored.ts");
    NodeFS.writeFileSync(ignored, "export const ignored = 1;\n");
    await runCheck(fx);
    NodeFS.writeFileSync(ignored, "export const ignored = 2;\n");
    await runCheck(fx);
    expect(launches(fx.home)).toBe(2);
  });

  it("launches a fresh check when an installed type declaration changes", async () => {
    const fx = fixture();
    const modules = NodePath.join(fx.repo, "node_modules");
    const target = NodePath.join(modules, ".pnpm", "example@1", "node_modules", "example");
    const link = NodePath.join(modules, "example");
    const declaration = NodePath.join(target, "index.d.ts");
    NodeFS.mkdirSync(target, { recursive: true });
    NodeFS.writeFileSync(declaration, "export declare const value: string;\n");
    NodeFS.symlinkSync(NodePath.relative(modules, target), link, "dir");
    await runCheck(fx);
    NodeFS.writeFileSync(declaration, "export declare const value: number;\n");
    await runCheck(fx);
    expect(launches(fx.home)).toBe(2);
  });

  it("runs again with --fresh even when a receipt exists", async () => {
    const fx = fixture();
    await runCheck(fx);
    const fresh = await runCheck(fx, { flags: ["--fresh"] });
    expect(fresh.code).toBe(0);
    expect(launches(fx.home)).toBe(2);
  });

  it("runs a check nested in a granted check under that grant, instead of waiting on itself", async () => {
    const fx = fixture();
    const outer = NodePath.join(fx.home, "outer.sh");
    NodeFS.writeFileSync(
      outer,
      [
        "#!/bin/sh",
        `${JSON.stringify(process.execPath)} ${JSON.stringify(SCRIPT)} typecheck -- sh ${JSON.stringify(fx.compiler)} "$1"`,
        "",
      ].join("\n"),
    );
    const run = await runCheck(fx, { command: "sh", commandArgs: [outer, fx.home] });
    expect(run.code).toBe(0);
    expect(launches(fx.home)).toBe(1);
    expect(typecheckGrants(fx.home)).toBe(1);
  });

  it("stops the whole process tree at its time limit, reports 124, and releases the lock", async () => {
    const fx = fixture();
    const timedOut = await runCheck(fx, {
      flags: ["--timeout", "1"],
      command: "sh",
      commandArgs: [fx.hanging, fx.home],
    });
    expect(timedOut.code).toBe(124);
    const grandchild = Number(
      NodeFS.readFileSync(NodePath.join(fx.home, "grandchild.pid"), "utf8"),
    );
    expect(processIsLive(grandchild)).toBe(false);

    // The lock is free again, and a timed-out check leaves no receipt to reuse.
    const next = await runCheck(fx);
    expect(next.code).toBe(0);
    expect(launches(fx.home)).toBe(1);
  });
});
