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
} from "../src/resourceBroker.ts";
import {
  DEFAULT_RUN_MS,
  EmulatorPrerequisiteError,
  inferResourceDemands,
  inferResources,
  isCompilerCommand,
  lockFilesFor,
  requestedAndroidSerial,
  runUnderBroker,
  withBrokerResources,
} from "../src/resourceRunner.ts";

const homes: string[] = [];
const newHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-runner-"));
  homes.push(home);
  process.env.AGENTQUEUE_LOCK_ROOT = NodePath.join(home, "locks");
  return home;
};
afterEach(() => {
  delete process.env.AGENTQUEUE_RESOURCE_TICKET;
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
