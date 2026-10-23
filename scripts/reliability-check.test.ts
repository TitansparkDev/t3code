// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { processIsLive, ResourceBroker } from "../packages/agent-queue-core/src/index.ts";

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

  const compiler = NodePath.join(home, "fake-tsc.sh");
  NodeFS.writeFileSync(
    compiler,
    [
      "#!/bin/sh",
      'echo launched >> "$1/launches.log"',
      'sleep "${FAKE_SECONDS:-0}"',
      'echo "checked"',
      'exit "${FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
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
    readonly env?: Record<string, string>;
  } = {},
): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTQUEUE_RESOURCE_HOME: fx.home,
    AGENTQUEUE_LOCK_ROOT: NodePath.join(fx.home, "locks"),
    AGENTQUEUE_TEST_HOST_MEMORY_MB: "20000",
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
        "sh",
        options.command ?? fx.compiler,
        fx.home,
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

  it("answers a later identical request from the stored receipt, with the same exit status", async () => {
    const fx = fixture();
    const first = await runCheck(fx, { env: { FAKE_EXIT: "3" } });
    const second = await runCheck(fx, { env: { FAKE_EXIT: "3" } });
    expect(first.code).toBe(3);
    expect(second.code).toBe(3);
    expect(launches(fx.home)).toBe(1);
    expect(second.stderr).toContain("no compiler was launched");
    expect(second.stdout).toContain("checked");
  });

  it("launches a fresh check when a tracked file changed", async () => {
    const fx = fixture();
    await runCheck(fx);
    NodeFS.writeFileSync(NodePath.join(fx.repo, "source.ts"), "export const value = 2;\n");
    const changed = await runCheck(fx);
    expect(changed.code).toBe(0);
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
    const run = await runCheck(fx, { command: outer });
    expect(run.code).toBe(0);
    expect(launches(fx.home)).toBe(1);
    expect(typecheckGrants(fx.home)).toBe(1);
  });

  it("stops the whole process tree at its time limit, reports 124, and releases the lock", async () => {
    const fx = fixture();
    const timedOut = await runCheck(fx, { flags: ["--timeout", "1"], command: fx.hanging });
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
