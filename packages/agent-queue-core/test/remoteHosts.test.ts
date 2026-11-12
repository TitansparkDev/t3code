// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  coolDown,
  loadRemoteHosts,
  pickHost,
  planRemote,
  recordAvoid,
  remoteStatuses,
  runRemote,
  type RemoteHostConfig,
  type RemotePlan,
  type RemoteRunOptions,
} from "../src/remoteHosts.ts";

const ORIGINAL_ENV = {
  AGENTQUEUE_RESOURCE_HOME: process.env.AGENTQUEUE_RESOURCE_HOME,
  AGENTQUEUE_RESOURCE_CONFIG: process.env.AGENTQUEUE_RESOURCE_CONFIG,
  AGENTQUEUE_REMOTE: process.env.AGENTQUEUE_REMOTE,
};
const roots: string[] = [];

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

const EPOCH = 1_800_000_000_000;

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly client: string;
  readonly broker: string;
  readonly config: string;
}

/** A temp git worktree, a private broker home and config, and a path for the fake client. */
function fixture(): Fixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-remote-"));
  roots.push(root);
  const repo = NodePath.join(root, "repo");
  NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
  const broker = NodePath.join(root, "broker");
  const config = NodePath.join(root, "resources.json");
  process.env.AGENTQUEUE_RESOURCE_HOME = broker;
  process.env.AGENTQUEUE_RESOURCE_CONFIG = config;
  delete process.env.AGENTQUEUE_REMOTE;
  return { root, repo, client: NodePath.join(root, "fake-client"), broker, config };
}

function configure(fx: Fixture, remotes: ReadonlyArray<Record<string, unknown>>): void {
  NodeFS.writeFileSync(fx.config, JSON.stringify({ remotes }));
}

/** A bash client; rewritten in place when a test needs different behavior on a later call. */
function writeClient(file: string, body: string): void {
  NodeFS.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

function hostOf(fx: Fixture, pathMap: Record<string, string> = {}): RemoteHostConfig {
  return { name: "fake", client: fx.client, enabled: true, pathMap };
}

const statusJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    host: "fake",
    accepting: true,
    wakeable: false,
    reason: null,
    slots: {
      heavy_build: { used: 1, total: 2 },
      android: { used: 1, total: 1 },
      job: { used: 0, total: 4 },
    },
    mem_available_mb: 20900,
    ...overrides,
  });

const printStatus = (overrides?: Record<string, unknown>): string =>
  `echo '${statusJson(overrides)}'`;

interface CacheFile {
  readonly hosts: Record<string, { coolingUntil?: number; wakeRequestedAt?: number }>;
}

const readCache = (fx: Fixture): CacheFile =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(fx.broker, "remote-status.json"), "utf8"));

const writeCache = (fx: Fixture, hosts: Record<string, unknown>): void => {
  NodeFS.mkdirSync(fx.broker, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(fx.broker, "remote-status.json"), JSON.stringify({ hosts }));
};

function expectPlan(result: RemotePlan | { readonly local: string }): RemotePlan {
  if ("local" in result) throw new Error(`expected a remote plan, got local: ${result.local}`);
  return result;
}

function planFor(
  fx: Fixture,
  argv: ReadonlyArray<string>,
  resources: ReadonlyArray<string> = ["heavy_build"],
): RemotePlan {
  return expectPlan(planRemote({ argv, cwd: fx.repo, resources, env: {} }));
}

function localReason(result: RemotePlan | { readonly local: string }): string {
  if (!("local" in result)) throw new Error("expected a local reason, got a remote plan");
  return result.local;
}

describe("loadRemoteHosts", () => {
  it("reads enabled remotes with a client in order and defaults the pathMap", () => {
    const fx = fixture();
    configure(fx, [
      { name: "legion", client: "/c/legion", pathMap: { "/opt/t/": "/srv/t/" } },
      { name: "off", client: "/c/off", enabled: false },
      { name: "no-client" },
      { name: "laptop", client: "/c/laptop", enabled: true },
    ]);
    expect(loadRemoteHosts()).toEqual([
      { name: "legion", client: "/c/legion", enabled: true, pathMap: { "/opt/t/": "/srv/t/" } },
      { name: "laptop", client: "/c/laptop", enabled: true, pathMap: {} },
    ]);
  });

  it("returns no remotes when AGENTQUEUE_REMOTE is off", () => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: "/c/legion" }]);
    process.env.AGENTQUEUE_REMOTE = "off";
    expect(loadRemoteHosts()).toEqual([]);
  });

  it("sees no remotes under test without a config file", () => {
    fixture();
    delete process.env.AGENTQUEUE_RESOURCE_CONFIG;
    expect(loadRemoteHosts()).toEqual([]);
  });
});

describe("remoteStatuses", () => {
  it("parses status and counts free heavy_build and android slots", async () => {
    const fx = fixture();
    writeClient(fx.client, printStatus());
    const [status] = await remoteStatuses([hostOf(fx)]);
    expect(status).toEqual({
      name: "fake",
      reachable: true,
      accepting: true,
      wakeable: false,
      free: { heavy_build: 1, android: 0 },
      checkedAt: expect.any(Number),
    });
  });

  it("is unreachable and not accepting when the client exits 255", async () => {
    const fx = fixture();
    writeClient(fx.client, "exit 255");
    const [status] = await remoteStatuses([hostOf(fx)]);
    expect(status).toMatchObject({ reachable: false, accepting: false, wakeable: false });
  });

  it("reuses a fresh cache entry without probing again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(EPOCH);
    const fx = fixture();
    writeCache(fx, {
      fake: {
        name: "fake",
        reachable: true,
        accepting: true,
        wakeable: false,
        free: { heavy_build: 1, android: 0 },
        checkedAt: EPOCH,
      },
    });
    writeClient(fx.client, printStatus({ accepting: false }));
    const [status] = await remoteStatuses([hostOf(fx)]);
    expect(status).toMatchObject({ accepting: true });
  });

  it("probes again when the cache entry is stale", async () => {
    const fx = fixture();
    writeCache(fx, {
      fake: {
        name: "fake",
        reachable: true,
        accepting: true,
        wakeable: false,
        free: { heavy_build: 1, android: 0 },
        checkedAt: 1,
      },
    });
    writeClient(fx.client, printStatus({ accepting: false }));
    const [status] = await remoteStatuses([hostOf(fx)]);
    expect(status).toMatchObject({ accepting: false });
  });

  it("carries a cool-down across a status refresh", async () => {
    const fx = fixture();
    writeClient(fx.client, printStatus());
    coolDown("fake", 600_000);
    const cooled = readCache(fx).hosts.fake?.coolingUntil;
    expect(cooled).toBeTypeOf("number");
    const [status] = await remoteStatuses([hostOf(fx)]);
    expect(status?.coolingUntil).toBe(cooled);
    expect(pickHost([status!], "heavy_build")).toBeNull();
  });

  it("records a wake request when a wakeable host is not accepting", async () => {
    const fx = fixture();
    writeClient(fx.client, printStatus({ accepting: false, wakeable: true }));
    const [status] = await remoteStatuses([hostOf(fx)]);
    expect(status).toMatchObject({ reachable: true, accepting: false, wakeable: true });
    expect(readCache(fx).hosts.fake?.wakeRequestedAt).toBeTypeOf("number");
  });
});

describe("planRemote", () => {
  it("places a heavy_build request on the remote with its worktree identity", () => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: fx.client }]);
    const plan = planFor(fx, ["vp", "run", "typecheck"]);
    expect(plan.class).toBe("heavy_build");
    expect(plan.dir).toBe(NodeFS.realpathSync(fx.repo));
    expect(plan.cwdRel).toBe("");
    expect(plan.wsKey).toMatch(/^repo-[0-9a-f]{8}$/);
    expect(plan.argvFor(hostOf(fx))).toEqual(["vp", "run", "typecheck"]);
  });

  it("selects the android class and keeps the cwd relative to the worktree top", () => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: fx.client }]);
    NodeFS.mkdirSync(NodePath.join(fx.repo, "apps", "mobile"), { recursive: true });
    const plan = expectPlan(
      planRemote({
        argv: ["vp", "test"],
        cwd: NodePath.join(fx.repo, "apps", "mobile"),
        resources: ["android"],
        env: {},
      }),
    );
    expect(plan.class).toBe("android");
    expect(plan.cwdRel).toBe(NodePath.join("apps", "mobile"));
  });

  it.each([
    ["no remotable resource", { argv: ["vp", "test"], resources: [] }, /no remotable resource/],
    [
      "a resource the VM keeps",
      { argv: ["vp", "test"], resources: ["heavy_build", "docker"] },
      /resource docker stays on the VM/,
    ],
    ["git history", { argv: ["git", "status"], resources: ["heavy_build"] }, /needs git history/],
    [
      "check:changed",
      { argv: ["vp", "run", "check:changed"], resources: ["heavy_build"] },
      /needs git history/,
    ],
    [
      "a path outside the worktree",
      { argv: ["/home/ajay/tools/x"], resources: ["heavy_build"] },
      /path outside the worktree: \/home\/ajay\/tools\/x/,
    ],
  ])("keeps %s on the VM", (_name, request, reason) => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: fx.client }]);
    expect(localReason(planRemote({ ...request, cwd: fx.repo, env: {} }))).toMatch(reason);
  });

  it("keeps a request on the VM when ANDROID_SERIAL pins a device", () => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: fx.client }]);
    const result = planRemote({
      argv: ["vp", "test"],
      cwd: fx.repo,
      resources: ["android"],
      env: { ANDROID_SERIAL: "emulator-5554" },
    });
    expect(localReason(result)).toMatch(/ANDROID_SERIAL/);
  });

  it("keeps a request on the VM when the directory is not a git worktree", () => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: fx.client }]);
    const result = planRemote({
      argv: ["vp", "test"],
      cwd: fx.root,
      resources: ["heavy_build"],
      env: {},
    });
    expect(localReason(result)).toMatch(/not a git worktree/);
  });

  it("keeps a path only some hosts map on the VM", () => {
    const fx = fixture();
    configure(fx, [
      { name: "legion", client: fx.client, pathMap: { "/opt/tools/": "/srv/tools/" } },
      { name: "laptop", client: fx.client },
    ]);
    const result = planRemote({
      argv: ["/opt/tools/bin/tool"],
      cwd: fx.repo,
      resources: ["heavy_build"],
      env: {},
    });
    expect(localReason(result)).toMatch(/path outside the worktree/);
  });

  it("rewrites argv and bash -c scripts through the host's pathMap", () => {
    const fx = fixture();
    const pathMap = {
      "/opt/tools/": "/srv/tools/",
      "/home/ajay/flutter/bin/": "",
    };
    configure(fx, [
      { name: "legion", client: fx.client, pathMap },
      { name: "laptop", client: fx.client, pathMap: { ...pathMap, "/opt/tools/": "C:/tools/" } },
    ]);
    const [legion] = loadRemoteHosts();
    const direct = planFor(fx, ["/opt/tools/bin/tool", "--x", "/home/ajay/flutter/bin/flutter"]);
    expect(direct.argvFor(legion!)).toEqual(["/srv/tools/bin/tool", "--x", "flutter"]);
    const script = planFor(fx, [
      "bash",
      "-c",
      "/opt/tools/bin/tool build && /home/ajay/flutter/bin/flutter test",
    ]);
    expect(script.argvFor(legion!)).toEqual([
      "bash",
      "-c",
      "/srv/tools/bin/tool build && flutter test",
    ]);
  });

  it("refuses a remembered environment failure until it expires", () => {
    const fx = fixture();
    configure(fx, [{ name: "legion", client: fx.client }]);
    const plan = planFor(fx, ["vp", "run", "typecheck"]);
    recordAvoid(plan.avoidKey, "SDK location not found");
    const blocked = planRemote({
      argv: ["vp", "run", "typecheck"],
      cwd: fx.repo,
      resources: ["heavy_build"],
      env: {},
    });
    expect(localReason(blocked)).toBe("remembered: SDK location not found");
    NodeFS.writeFileSync(
      NodePath.join(fx.broker, "remote-avoid.json"),
      JSON.stringify({ [plan.avoidKey]: { reason: "old", until: 1 } }),
    );
    expect(planFor(fx, ["vp", "run", "typecheck"]).avoidKey).toBe(plan.avoidKey);
  });
});

describe("runRemote", () => {
  const runOptions = (overrides: Partial<RemoteRunOptions> = {}): RemoteRunOptions => ({
    timeoutSec: 60,
    label: "t",
    stdio: "pipe",
    ...overrides,
  });

  const started = (exit: string) =>
    `echo '[remote] STARTED host=fake job=7' >&2\necho "ran: $*"\n${exit}`;

  it("reports a started job that exits 3 as placed with its code", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, started("exit 3"));
    let starts = 0;
    const result = await runRemote(
      hostOf(fx),
      planFor(fx, ["echo", "hi"]),
      runOptions({ onStart: () => (starts += 1) }),
    );
    expect(result).toMatchObject({
      host: "fake",
      placed: true,
      lost: false,
      code: 3,
      envFailure: false,
    });
    expect(starts).toBe(1);
    expect(result.tail).toContain("--resource heavy_build");
    expect(result.tail).toContain("-- echo hi");
  });

  it("reports a refusal before STARTED as not placed", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, "echo refused >&2\nexit 76");
    const result = await runRemote(hostOf(fx), planFor(fx, ["echo", "hi"]), runOptions());
    expect(result).toMatchObject({ placed: false, lost: false, code: 76 });
  });

  it("reports a connection lost after STARTED as lost", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, started("exit 255"));
    const result = await runRemote(hostOf(fx), planFor(fx, ["echo", "hi"]), runOptions());
    expect(result).toMatchObject({ placed: true, lost: true, code: 255, envFailure: false });
  });

  it("classifies exit 127 after start as an environment failure", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, started("exit 127"));
    const result = await runRemote(hostOf(fx), planFor(fx, ["echo", "hi"]), runOptions());
    expect(result).toMatchObject({ placed: true, code: 127, envFailure: true });
  });

  it("classifies a missing Android SDK in the output as an environment failure", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, `${started("")}\necho "SDK location not found"\nexit 1`);
    const result = await runRemote(hostOf(fx), planFor(fx, ["echo", "hi"]), runOptions());
    expect(result).toMatchObject({ placed: true, code: 1, envFailure: true });
  });

  it("does not treat an ordinary failure as an environment failure", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, `${started("")}\necho "3 tests failed"\nexit 2`);
    const result = await runRemote(hostOf(fx), planFor(fx, ["echo", "hi"]), runOptions());
    expect(result).toMatchObject({ placed: true, code: 2, envFailure: false });
  });

  it("writes the command output to the log file", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    writeClient(fx.client, `${started("")}\necho "build output line"\nexit 0`);
    const logFile = NodePath.join(fx.root, "logs", "run.log");
    const result = await runRemote(
      hostOf(fx),
      planFor(fx, ["echo", "hi"]),
      runOptions({ logFile }),
    );
    expect(result).toMatchObject({ placed: true, code: 0 });
    expect(NodeFS.readFileSync(logFile, "utf8")).toContain("build output line");
  });

  it("reports a client that cannot be started as not placed", async () => {
    const fx = fixture();
    configure(fx, [{ name: "fake", client: fx.client }]);
    const missing: RemoteHostConfig = { ...hostOf(fx), client: NodePath.join(fx.root, "missing") };
    const result = await runRemote(missing, planFor(fx, ["echo", "hi"]), runOptions());
    expect(result).toMatchObject({ placed: false, lost: false, envFailure: false });
  });
});
