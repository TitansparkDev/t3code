// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  processIsLive,
  ResourceBroker,
  TYPECHECK_DEMAND_MB,
  type ResourceConfig,
  type Ticket,
} from "../src/resourceBroker.ts";
import {
  createJobRunner,
  DEFAULT_RUN_MS,
  describeJob,
  EmulatorPrerequisiteError,
  inferResourceDemands,
  inferResources,
  isCompilerCommand,
  lockFilesFor,
  requestedAndroidSerial,
  runUnderBroker,
  tryRemote,
  withBrokerResources,
  type RemoteInput,
} from "../src/resourceRunner.ts";
import type {
  RemoteDeps,
  RemoteHostConfig,
  RemoteHostStatus,
  RemoteRunResult,
} from "../src/remoteHosts.ts";

const homes: string[] = [];
const newHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-runner-"));
  homes.push(home);
  process.env.AGENTQUEUE_LOCK_ROOT = NodePath.join(home, "locks");
  return home;
};
afterEach(() => {
  delete process.env.AGENTQUEUE_RESOURCE_TICKET;
  delete process.env.AGENTQUEUE_REMOTE;
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

const CONFIG: ResourceConfig = {
  reserveMb: 1000,
  resources: {
    heavy_build: { capacity: 1, memoryMb: 3500 },
  },
};

const ANDROID_CONFIG: ResourceConfig = {
  reserveMb: 1000,
  resources: { android: { capacity: 1, memoryMb: 0 } },
};

describe("Android device resource locks", () => {
  it("locks emulator slots and named serials separately", () => {
    const home = newHome();
    expect(lockFilesFor("android", 1)).toContain(
      NodePath.join(home, "locks", "devices", "emulator-5556.lock"),
    );
    expect(lockFilesFor("device_r58m", 0)).toEqual([
      NodePath.join(home, "locks", "devices", "r58m.lock"),
    ]);
  });

  it("finds serials from command assignments and environment", () => {
    expect(requestedAndroidSerial(["env", "A=b", "ANDROID_SERIAL=env-device", "cmd"], {})).toBe(
      "env-device",
    );
    expect(requestedAndroidSerial(["ANDROID_SERIAL=leading", "cmd"], {})).toBe("leading");
    expect(
      requestedAndroidSerial(["bash", "-c", "ANDROID_SERIAL=script-device adb shell"], {}),
    ).toBe("script-device");
    expect(requestedAndroidSerial(["adb", "devices"], { ANDROID_SERIAL: "environment" })).toBe(
      "environment",
    );
    expect(requestedAndroidSerial(["adb", "devices"], {})).toBeNull();
  });
});

function makeBroker(home: string, free = 20_000, config = CONFIG) {
  return new ResourceBroker({
    home,
    host: () => ({
      totalMb: 25_000,
      availableMb: free,
      swapUsedMb: 0,
      swapTotalMb: 8000,
      cpus: 16,
      load1: 1,
    }),
    config: () => config,
  });
}

describe("run deadline", () => {
  it("gives a command with no deadline the default run limit", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(ran.ticket.runMs).toBe(DEFAULT_RUN_MS);
    broker.close();
  });
});

describe("memory kills", () => {
  it("queues a command the kernel killed for memory again, then reports it after the last retry", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    let kills = 0;
    const probes = { usedKb: () => 0, oomKills: () => kills++ };
    const retries: number[] = [];
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
      ownerRef: "TASK-1",
      repo: "/repo/one/.git",
      checkId: "memory-test",
      probes,
      onMemoryRetry: (attempt) => retries.push(attempt),
    });
    expect(retries).toEqual([1, 2]);
    expect(ran.kind).toBe("ran");
    if (ran.kind === "ran") expect(ran.result.oomKilled).toBe(true);
    const attempts = broker.forOwner("TASK-1", "/repo/one/.git");
    expect(attempts).toHaveLength(3);
    expect(attempts.map((ticket) => ticket.checkId)).toEqual([
      "memory-test",
      "memory-test",
      "memory-test",
    ]);
    expect(attempts.map((ticket) => ticket.reportedAt !== null)).toEqual([false, false, true]);
    expect(new Set(attempts.map((ticket) => ticket.id)).size).toBe(3);
    broker.close();
  });
});

describe("compiler classification", () => {
  const launches = [
    "tsc --noEmit",
    "./node_modules/.bin/tsc -p apps/server",
    "/usr/local/bin/tsgo --noEmit",
    "tsc-rs --noEmit",
    "effect-tsgo patch",
    "node node_modules/typescript/bin/tsc -b",
    "node ./node_modules/.bin/tsc.js",
    "bash -lc 'pnpm --filter t3 typecheck'",
    'sh -c "tsc --noEmit"',
    "FOO=1 env -i PATH=/bin tsc",
    "timeout 600 tsc",
    "nice -n 5 tsc",
    "pnpm typecheck",
    "pnpm -F server typecheck",
    "npm run tc",
    "pnpm exec tsc --noEmit",
    "vp run -r --concurrency-limit 2 typecheck",
    "echo ok && tsc",
    "echo ok; tsc --noEmit",
    "echo $(tsc --noEmit)",
    'echo "$(tsc --noEmit)"',
    '"tsc" --noEmit',
    "\\tsc --noEmit",
    '/usr/bin/time -f "%e s %M KB" tsc-rs --noEmit',
    "env -u CI tsc --noEmit",
  ];
  it.each(launches)("treats as a compiler launch: %s", (command) => {
    expect(isCompilerCommand(command)).toBe(true);
  });

  const mentions = [
    "echo tsc",
    'echo "run tsc later"',
    "git commit -m 'fix tsc build'",
    "grep -r tsc packages",
    "cat tsc.log",
    "printf '%s' 'tsc --noEmit'",
    "cat > tsc < input.txt",
    "bash -c 'echo tsc'",
    "vp test run src/tsc.test.ts",
    "pnpm test",
    "git log --grep=typecheck",
    "command -v tsc",
  ];
  it.each(mentions)("does not treat a mention as a launch: %s", (command) => {
    expect(isCompilerCommand(command)).toBe(false);
  });

  it("asks the broker for the compiler's measured demand, while other work keeps its own estimate", () => {
    expect(inferResourceDemands("tsc --noEmit")).toEqual([
      { name: "heavy_build", memoryMb: TYPECHECK_DEMAND_MB },
    ]);
    expect(inferResources("tsc --noEmit")).toEqual(["heavy_build"]);
    expect(inferResourceDemands("./gradlew :app:test")).toEqual([{ name: "heavy_build" }]);
  });
});

describe("nested invocation", () => {
  it("runs a command nested in a grant its caller holds, without queueing for the same unit", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const outer = broker.enqueue({
      resources: [{ name: "typecheck", memoryMb: TYPECHECK_DEMAND_MB }],
      pid: process.pid,
      label: "outer",
    });
    broker.pump();
    expect(broker.get(outer.id)!.state).toBe("granted");

    process.env.AGENTQUEUE_RESOURCE_TICKET = outer.id;
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "typecheck" }],
      argv: ["bash", "-c", "exit 4"],
      cwd: home,
      stdio: "pipe",
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(ran.result.exitCode).toBe(4);
    expect(broker.get(outer.id)!.state).toBe("granted");
    broker.close();
  });

  it("queues normally when the enclosing grant does not cover the resource asked for", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const outer = broker.enqueue({ resources: [{ name: "docker" }], pid: process.pid });
    broker.pump();
    process.env.AGENTQUEUE_RESOURCE_TICKET = outer.id;
    const result = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
      shouldStop: () => true,
    });
    expect(result.kind).toBe("superseded");
    broker.close();
  });
});

describe("running under the broker", () => {
  it("blocks checks when an explicitly requested emulator cannot be provisioned", async () => {
    const home = newHome();
    const sdk = NodePath.join(home, "sdk");
    const adb = NodePath.join(sdk, "platform-tools", "adb");
    const emulator = NodePath.join(sdk, "emulator", "emulator");
    const emulatorLaunch = NodePath.join(home, "emulator-launched");
    NodeFS.mkdirSync(NodePath.dirname(adb), { recursive: true });
    NodeFS.mkdirSync(NodePath.dirname(emulator), { recursive: true });
    NodeFS.writeFileSync(adb, "#!/bin/sh\nexit 0\n");
    NodeFS.writeFileSync(
      emulator,
      `#!/bin/sh\nif [ "$1" = "-list-avds" ]; then echo other_profile; else echo launched >> ${JSON.stringify(emulatorLaunch)}; fi\n`,
    );
    NodeFS.chmodSync(adb, 0o755);
    NodeFS.chmodSync(emulator, 0o755);
    const keys = [
      "ANDROID_HOME",
      "ANDROID_SDK_ROOT",
      "ANDROID_AVD_HOME",
      "AGENTQUEUE_AVD",
      "AGENTQUEUE_AVD_API",
      "AGENTQUEUE_LEGACY_ANDROID_LOCK",
      "AGENTQUEUE_RESOURCE_HOME",
      "AGENTQUEUE_NO_EMULATOR_BOOT",
      "AGENTQUEUE_RESOURCE_TICKET",
      "VITEST",
    ] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    const broker = makeBroker(home, 20_000, ANDROID_CONFIG);
    const marker = NodePath.join(home, "ran");
    try {
      process.env.ANDROID_HOME = sdk;
      process.env.ANDROID_AVD_HOME = NodePath.join(home, "avds");
      process.env.AGENTQUEUE_LEGACY_ANDROID_LOCK = NodePath.join(home, "android-heavy.lock");
      process.env.AGENTQUEUE_RESOURCE_HOME = home;
      process.env.AGENTQUEUE_AVD = "required_profile";
      process.env.AGENTQUEUE_AVD_API = "35";
      delete process.env.ANDROID_SDK_ROOT;
      delete process.env.AGENTQUEUE_NO_EMULATOR_BOOT;
      delete process.env.AGENTQUEUE_RESOURCE_TICKET;
      delete process.env.VITEST;

      const worker = await runUnderBroker({
        broker,
        resources: [{ name: "android" }],
        argv: ["touch", marker],
        cwd: home,
        waitMs: 3_000,
        stdio: "pipe",
      });
      expect(worker.kind).toBe("ran");
      if (worker.kind !== "ran") return;
      expect(worker.result.outcome).toBe("unavailable");
      expect(worker.result.exitCode).toBe(77);
      expect(worker.result.tail).toContain("not in the provisioned inventory");
      expect(NodeFS.existsSync(marker)).toBe(false);
      expect(NodeFS.existsSync(emulatorLaunch)).toBe(false);

      let serverCheckRan = false;
      await expect(
        withBrokerResources(
          ["android"],
          async () => {
            serverCheckRan = true;
          },
          { broker, waitMs: 3_000 },
        ),
      ).rejects.toBeInstanceOf(EmulatorPrerequisiteError);
      expect(serverCheckRan).toBe(false);
    } finally {
      broker.close();
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("stops the whole process tree at its time limit and releases the resource", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const pidFile = NodePath.join(home, "grandchild.pid");
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["bash", "-c", `sleep 60 & echo $! > ${pidFile}; wait`],
      cwd: home,
      runMs: 300,
      stdio: "pipe",
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(ran.result.outcome).toBe("timed-out");
    expect(ran.result.exitCode).toBe(124);
    const grandchild = Number(NodeFS.readFileSync(pidFile, "utf8"));
    expect(processIsLive(grandchild)).toBe(false);
    expect(broker.status().resources.find((r) => r.name === "heavy_build")!.active).toBe(0);
    broker.close();
  });

  it("reports the resident memory its process tree reached", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["sleep", "1.5"],
      cwd: home,
      stdio: "pipe",
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    if (NodeFS.existsSync("/proc/self/status")) expect(ran.result.peakRssKb).toBeGreaterThan(0);
    broker.close();
  });

  it("withdraws a request whose work is already done before it is granted", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const result = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
      shouldStop: () => true,
    });
    expect(result.kind).toBe("superseded");
    if (result.kind !== "superseded") return;
    expect(broker.get(result.ticket.id)!.state).toBe("cancelled");
    expect(broker.get(result.ticket.id)!.slots).toEqual({});
    broker.close();
  });

  it("releases a grant that is withdrawn after admission, without running the command", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const marker = NodePath.join(home, "ran");
    const result = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["touch", marker],
      cwd: home,
      stdio: "pipe",
      beforeRun: () => false,
    });
    expect(result.kind).toBe("superseded");
    expect(NodeFS.existsSync(marker)).toBe(false);
    expect(broker.status().resources.find((r) => r.name === "heavy_build")!.active).toBe(0);
    broker.close();
  });
});

const LEGION: RemoteHostConfig = {
  name: "legion",
  client: "/nonexistent/legion",
  enabled: true,
  pathMap: {},
};

/** Remote hosts that answer from `script` in order (the last answer repeats). Nothing leaves this process. */
function fakeRemote(
  script: ReadonlyArray<Partial<RemoteRunResult>> = [],
  options: { readonly free?: number; readonly onRun?: () => void } = {},
) {
  const steps = [...script];
  const runs: Array<{ host: string; argv: ReadonlyArray<string> }> = [];
  const coolDowns: Array<[string, number]> = [];
  const avoids: Array<[string, string]> = [];
  const deps: RemoteDeps = {
    hosts: () => [LEGION],
    statuses: async (): Promise<ReadonlyArray<RemoteHostStatus>> => [
      {
        name: "legion",
        reachable: true,
        accepting: true,
        wakeable: false,
        free: { heavy_build: options.free ?? 1, android: 0 },
        checkedAt: 0,
      },
    ],
    plan: (input) => ({
      class: "heavy_build",
      dir: input.cwd,
      cwdRel: "",
      wsKey: "fake",
      avoidKey: "fake-avoid",
      argvFor: () => [...input.argv],
    }),
    run: async (host, plan) => {
      runs.push({ host: host.name, argv: plan.argvFor(host) });
      options.onRun?.();
      const answer = steps.length > 1 ? steps.shift()! : (steps[0] ?? {});
      return {
        host: host.name,
        placed: true,
        lost: false,
        code: 0,
        envFailure: false,
        tail: "",
        runMs: 1,
        ...answer,
      };
    },
    coolDown: (host, ms) => {
      coolDowns.push([host, ms]);
    },
    recordAvoid: (key, reason) => {
      avoids.push([key, reason]);
    },
  };
  return { deps, runs, coolDowns, avoids };
}

const remoteInput = (cwd: string): RemoteInput => ({ argv: ["true"], cwd, stdio: "pipe" });

describe("remote hosts", () => {
  it("runs a queued command on a free remote host without granting this machine's slot", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const remote = fakeRemote([{ code: 3, tail: "boom\n" }]);
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
      ownerRef: "TASK-R",
      remote: remote.deps,
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(remote.runs).toEqual([{ host: "legion", argv: ["true"] }]);
    expect(ran.result.exitCode).toBe(3);
    expect(ran.result.outcome).toBe("failed");
    expect(ran.ticket.host).toBe("legion");
    expect(ran.ticket.slots).toEqual({});
    expect(describeJob(ran.ticket)).toContain("Ran on: legion");
    broker.close();
  });

  it("gives back a run its host refused, in the same place in line, and runs it here once the slot is free", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const seqs: number[] = [];
    const remote = fakeRemote([{ placed: false }], {
      onRun: () => seqs.push(broker.forOwner("TASK-P")[0]!.seq),
    });
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
      ownerRef: "TASK-P",
      remote: remote.deps,
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(remote.runs).toHaveLength(1);
    expect(remote.coolDowns).toEqual([["legion", 60_000]]);
    expect(seqs).toEqual([ran.ticket.seq]);
    expect(ran.ticket.host).toBeNull();
    expect(ran.result.outcome).toBe("ok");
    broker.close();
  });

  it("stops offering a command to remote hosts once one refuses it for a reason only this machine can fix", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const remote = fakeRemote([
      { code: 127, envFailure: true, tail: "bash: keystore: not found\n" },
    ]);
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["true"],
      cwd: home,
      stdio: "pipe",
      remote: remote.deps,
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(remote.runs).toHaveLength(1);
    expect(remote.avoids).toEqual([["fake-avoid", "bash: keystore: not found"]]);
    expect(ran.ticket.host).toBeNull();
    expect(ran.result.exitCode).toBe(0);
    broker.close();
  });

  it("sends a lost run back once, and fails the request when the connection is lost again", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const ticket = broker.enqueue({
      resources: [{ name: "heavy_build" }],
      pid: process.pid,
      label: "lost",
      runMs: 60_000,
    });
    const remote = fakeRemote([{ lost: true, code: 255 }]);
    expect(await tryRemote(broker, ticket, remoteInput(home), remote.deps)).toEqual({
      retry: true,
    });
    expect(broker.get(ticket.id)!.state).toBe("waiting");
    expect(await tryRemote(broker, ticket, remoteInput(home), remote.deps)).toMatchObject({
      ran: { outcome: "failed", exitCode: 255 },
    });
    expect(broker.get(ticket.id)!.note).toBe("lost contact with legion twice");
    expect(remote.runs).toHaveLength(2);
    broker.close();
  });

  it("keeps the retry's result when the connection was lost only once", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const ticket = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    const remote = fakeRemote([{ lost: true, code: 255 }, { code: 0 }]);
    expect(await tryRemote(broker, ticket, remoteInput(home), remote.deps)).toEqual({
      retry: true,
    });
    expect(await tryRemote(broker, ticket, remoteInput(home), remote.deps)).toMatchObject({
      ran: { outcome: "ok", exitCode: 0 },
    });
    expect(broker.get(ticket.id)!.host).toBe("legion");
    broker.close();
  });

  it("lets a waiter ahead in line take the only free remote slot before a later one", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const earlier = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    const later = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    const remote = fakeRemote([], { free: 1 });
    expect(await tryRemote(broker, later, remoteInput(home), remote.deps)).toBeNull();
    expect(remote.runs).toHaveLength(0);
    expect(broker.get(later.id)!.state).toBe("waiting");
    expect(await tryRemote(broker, earlier, remoteInput(home), remote.deps)).toMatchObject({
      ran: { outcome: "ok" },
    });
    expect(remote.runs).toHaveLength(1);
    broker.close();
  });

  it("does not run remotely a request whose beforeRun says the work is already done", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const ticket = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    const remote = fakeRemote();
    expect(
      await tryRemote(broker, ticket, remoteInput(home), remote.deps, {
        beforeRun: () => false,
      }),
    ).toEqual({ superseded: true });
    expect(remote.runs).toHaveLength(0);
    expect(broker.get(ticket.id)!.state).toBe("cancelled");
    broker.close();
  });

  it("keeps every command here when remote hosts are switched off", async () => {
    process.env.AGENTQUEUE_REMOTE = "off";
    const home = newHome();
    const broker = makeBroker(home);
    const ticket = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    const remote = fakeRemote();
    expect(await tryRemote(broker, ticket, remoteInput(home), remote.deps)).toBeNull();
    expect(remote.runs).toHaveLength(0);
    expect(broker.get(ticket.id)!.state).toBe("waiting");
    broker.close();
  });

  it("places a stored job on a free remote host when the runner ticks, before this machine grants it", async () => {
    const home = newHome();
    const broker = makeBroker(home);
    const job = broker.enqueue({
      resources: [{ name: "heavy_build" }],
      ownerRef: "TASK-J",
      job: { command: "echo remote-job", cwd: home },
    });
    const remote = fakeRemote();
    const finished = Promise.withResolvers<Ticket>();
    const runner = createJobRunner({
      repo: null,
      broker,
      remote: remote.deps,
      onFinished: (ticket) => finished.resolve(ticket),
    });
    expect(await runner.tick()).toEqual([]);
    const done = await finished.promise;
    expect(done.id).toBe(job.id);
    expect(done.host).toBe("legion");
    expect(done.outcome).toBe("ok");
    expect(remote.runs).toEqual([{ host: "legion", argv: ["bash", "-c", "echo remote-job"] }]);
    expect(broker.status().resources.find((r) => r.name === "heavy_build")!.active).toBe(0);
    broker.close();
  });

  it("asks the kernel to take a local command before the agents and server under memory pressure", async () => {
    if (!NodeFS.existsSync("/proc/self/oom_score_adj")) return;
    const home = newHome();
    const broker = makeBroker(home);
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "heavy_build" }],
      argv: ["cat", "/proc/self/oom_score_adj"],
      cwd: home,
      stdio: "pipe",
      remote: fakeRemote([], { free: 0 }).deps,
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(ran.result.tail.trim()).toBe("800");
    broker.close();
  });
});
