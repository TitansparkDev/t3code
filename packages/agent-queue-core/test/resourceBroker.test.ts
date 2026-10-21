// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  LEASE_MS,
  RAMP_MS,
  ResourceBroker,
  STARVATION_MS,
  TYPECHECK_DEMAND_MB,
  type BrokerOptions,
  type ResourceConfig,
} from "../src/resourceBroker.ts";
import {
  createJobRunner,
  describeJob,
  inferResources,
  runUnderBroker,
  waitForGrant,
  withBrokerResources,
  ResourceWaitError,
} from "../src/resourceRunner.ts";

const homes: string[] = [];
const newHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "aq-broker-"));
  homes.push(home);
  process.env.AGENTQUEUE_LOCK_ROOT = NodePath.join(home, "locks");
  return home;
};
afterEach(() => {
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

const CONFIG: ResourceConfig = {
  reserveMb: 1000,
  resources: {
    heavy_build: { capacity: 2, memoryMb: 3000 },
    android: { capacity: 2, memoryMb: 5000 },
    docker: { capacity: 3, memoryMb: 0 },
    gpu: { capacity: 0, memoryMb: 0 },
    db: { capacity: 1, memoryMb: 0 },
  },
};

function makeBroker(
  extra: Partial<BrokerOptions> & { clock?: { now: number }; free?: { mb: number } } = {},
) {
  const home = extra.home ?? newHome();
  const clock = extra.clock ?? { now: 1_000_000 };
  const free = extra.free ?? { mb: 20_000 };
  const killed: number[] = [];
  const broker = new ResourceBroker({
    home,
    now: () => clock.now,
    host: () => ({
      totalMb: 25_430,
      availableMb: free.mb,
      swapUsedMb: 0,
      swapTotalMb: 8000,
      cpus: 16,
      load1: 1,
    }),
    config: () => CONFIG,
    killGroup: (pgid) => killed.push(pgid),
    ...extra,
  });
  return { broker, clock, free, killed, home };
}

describe("resource broker queue", () => {
  it("grants up to capacity, in arrival order, and hands slots to the next waiter on release", () => {
    const { broker } = makeBroker();
    const [a, b, c] = ["a", "b", "c"].map((label) =>
      broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid, label }),
    );
    const granted = broker.pump();
    expect(granted.map((t) => t.label)).toEqual(["a", "b"]);
    expect(granted.map((t) => t.slots.heavy_build?.[0])).toEqual([0, 1]);
    expect(broker.get(c!.id)!.state).toBe("waiting");
    expect(broker.position(c!.id)).toBe(1);

    broker.finish(a!.id, { outcome: "ok" });
    expect(broker.pump().map((t) => t.label)).toEqual(["c"]);
    expect(broker.get(c!.id)!.slots.heavy_build).toEqual([0]);
    expect(broker.get(b!.id)!.state).toBe("granted");
  });

  it("takes several resources atomically, so two multi-resource requests cannot deadlock", () => {
    const { broker } = makeBroker();
    // Each wants both; capacity 1 of "db" and 2 of heavy_build. Whoever is first gets both.
    const first = broker.enqueue({
      resources: [{ name: "db" }, { name: "heavy_build" }],
      pid: process.pid,
      label: "first",
    });
    const second = broker.enqueue({
      resources: [{ name: "heavy_build" }, { name: "db" }],
      pid: process.pid,
      label: "second",
    });
    broker.pump();
    expect(broker.get(first.id)!.state).toBe("granted");
    expect(broker.get(second.id)!.state).toBe("waiting");
    broker.finish(first.id, { outcome: "ok" });
    broker.pump();
    expect(broker.get(second.id)!.state).toBe("granted");
  });

  it("refuses a resource the machine does not have, saying so", () => {
    const { broker } = makeBroker();
    const ticket = broker.enqueue({ resources: [{ name: "gpu" }], pid: process.pid });
    expect(ticket.state).toBe("done");
    expect(ticket.outcome).toBe("unavailable");
    expect(ticket.note).toMatch(/no gpu/);
  });

  it("holds a request back until the host has memory headroom, counting fresh grants that have not used theirs yet", () => {
    const { broker, clock, free } = makeBroker({ free: { mb: 8_000 } });
    const a = broker.enqueue({
      resources: [{ name: "heavy_build" }],
      pid: process.pid,
      label: "a",
    });
    const b = broker.enqueue({
      resources: [{ name: "heavy_build" }],
      pid: process.pid,
      label: "b",
    });
    broker.pump();
    // 8000 - 1000 reserve = 7000: one build (3000) fits, the second also fits (4000 left)...
    expect(broker.get(a.id)!.state).toBe("granted");
    expect(broker.get(b.id)!.state).toBe("granted");
    broker.finish(b.id, { outcome: "ok" });
    // ...but a third request right after must count a's 3000 that is not yet in MemAvailable.
    free.mb = 4_500;
    const c = broker.enqueue({
      resources: [{ name: "heavy_build" }],
      pid: process.pid,
      label: "c",
    });
    broker.pump();
    expect(broker.get(c.id)!.state).toBe("waiting");
    expect(broker.get(c.id)!.note).toMatch(/memory/);
    // Once a's memory shows up in the host reading, the headroom is real.
    clock.now += RAMP_MS + 1;
    free.mb = 9_000;
    broker.pump();
    expect(broker.get(c.id)!.state).toBe("granted");
  });

  it("does not admit a compiler's 7.5 GiB demand under a 3.5 GB per-unit estimate", () => {
    const { broker, free } = makeBroker({
      free: { mb: 5_000 },
      config: () => ({
        ...CONFIG,
        resources: { ...CONFIG.resources, heavy_build: { capacity: 2, memoryMb: 3500 } },
      }),
    });
    const gradle = broker.enqueue({
      resources: [{ name: "heavy_build" }],
      pid: process.pid,
      label: "gradle",
    });
    const compiler = broker.enqueue({
      resources: [{ name: "typecheck", memoryMb: TYPECHECK_DEMAND_MB }],
      pid: process.pid,
      label: "tsc",
    });
    broker.pump();
    expect(broker.get(gradle.id)!.state).toBe("granted");
    // 5000 - 1000 reserve - 3500 for gradle, which has not shown in the host reading yet.
    expect(broker.get(compiler.id)!.state).toBe("waiting");
    expect(broker.get(compiler.id)!.note).toMatch(/needs 8192 MB/);
    // 13000 - 1000 reserve - 3500 ramping for gradle leaves 8500, which covers the 8192 demand.
    free.mb = 13_000;
    broker.pump();
    expect(broker.get(compiler.id)!.state).toBe("granted");
  });

  it("lets a small request backfill but stops everything behind a ticket that has waited too long", () => {
    const { broker, clock, free } = makeBroker({ free: { mb: 4_500 } });
    const big = broker.enqueue({
      resources: [{ name: "android" }],
      pid: process.pid,
      label: "big",
    });
    broker.pump();
    // 4500 - 1000 = 3500 < 5000: android cannot start; a docker request (no memory) is not blocked yet.
    expect(broker.get(big.id)!.state).toBe("waiting");
    const small1 = broker.enqueue({
      resources: [{ name: "docker" }],
      pid: process.pid,
      label: "small1",
    });
    broker.pump();
    expect(broker.get(small1.id)!.state).toBe("granted");
    broker.finish(small1.id, { outcome: "ok" });
    clock.now += STARVATION_MS + 1;
    const small2 = broker.enqueue({
      resources: [{ name: "docker" }],
      pid: process.pid,
      label: "small2",
    });
    broker.pump();
    expect(broker.get(small2.id)!.state).toBe("waiting"); // the aged head blocks backfill
    free.mb = 20_000;
    const granted = broker.pump().map((t) => t.label);
    expect(granted).toEqual(["big", "small2"]);
  });

  it("keeps an idle ticket waiting until external memory pressure recovers", () => {
    const { broker, clock, free } = makeBroker({ free: { mb: 4_000 } });
    const lone = broker.enqueue({
      resources: [{ name: "android" }],
      pid: process.pid,
      label: "lone",
    });
    broker.pump();
    expect(broker.get(lone.id)!.state).toBe("waiting");
    clock.now += 6 * 60_000;
    broker.pump();
    expect(broker.get(lone.id)!.state).toBe("waiting");
    free.mb = 8_000;
    broker.pump();
    expect(broker.get(lone.id)!.state).toBe("granted");
  });

  it("does not overlap oversized requests against an effective 16 GiB agent budget", () => {
    const { broker } = makeBroker({
      free: { mb: 16_000 },
      config: () => ({
        reserveMb: 3_072,
        resources: { ...CONFIG.resources, heavy_build: { capacity: 2, memoryMb: 8_192 } },
      }),
    });
    const first = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    const second = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    broker.pump();
    expect(broker.get(first.id)!.state).toBe("granted");
    expect(broker.get(second.id)!.state).toBe("waiting");
  });

  it("holds memory requests during PSI or active swap pressure, then admits after recovery", () => {
    const pressure = { memoryPressure: 12, swapPressure: false };
    const { broker } = makeBroker({
      host: () => ({
        totalMb: 25_430,
        availableMb: 20_000,
        swapUsedMb: 7_000,
        swapTotalMb: 8_000,
        cpus: 16,
        load1: 1,
        ...pressure,
      }),
    });
    const ticket = broker.enqueue({ resources: [{ name: "heavy_build" }], pid: process.pid });
    broker.pump();
    expect(broker.get(ticket.id)!.state).toBe("waiting");
    pressure.memoryPressure = 0;
    pressure.swapPressure = true;
    broker.pump();
    expect(broker.get(ticket.id)!.state).toBe("waiting");
    pressure.swapPressure = false;
    broker.pump();
    expect(broker.get(ticket.id)!.state).toBe("granted");
  });

  it("frees the units of a holder whose process is gone, at once", () => {
    const { broker } = makeBroker();
    const child = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    const dead = broker.enqueue({
      resources: [{ name: "db" }],
      pid: child.pid!,
      label: "dead holder",
    });
    const next = broker.enqueue({ resources: [{ name: "db" }], pid: process.pid, label: "next" });
    broker.pump();
    expect(broker.get(dead.id)!.state).toBe("granted");
    expect(broker.get(next.id)!.state).toBe("waiting");
    child.kill("SIGKILL");
    NodeChildProcess.spawnSync("sleep", ["0.2"]);
    broker.pump();
    expect(broker.get(dead.id)!.state).toBe("expired");
    expect(broker.get(dead.id)!.note).toMatch(/vanished/);
    expect(broker.get(next.id)!.state).toBe("granted");
  });

  it("tears down a live holder that stopped heartbeating before giving its units away", () => {
    const { broker, clock, killed } = makeBroker();
    const stalled = broker.enqueue({
      resources: [{ name: "db" }],
      pid: process.pid,
      label: "stalled",
    });
    const next = broker.enqueue({ resources: [{ name: "db" }], pid: process.pid, label: "next" });
    broker.pump();
    broker.markRunning(stalled.id, 424242);
    clock.now += LEASE_MS + 1;
    broker.pump();
    expect(killed).toEqual([424242]);
    expect(broker.get(stalled.id)!.state).toBe("expired");
    expect(broker.get(next.id)!.state).toBe("granted");
  });

  it("keeps a heartbeating holder and drops a waiter whose process died", () => {
    const { broker, clock } = makeBroker();
    const holder = broker.enqueue({
      resources: [{ name: "db" }],
      pid: process.pid,
      label: "holder",
    });
    const child = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    const waiter = broker.enqueue({
      resources: [{ name: "db" }],
      pid: child.pid!,
      label: "waiter",
    });
    broker.pump();
    clock.now += LEASE_MS - 10;
    broker.heartbeat(holder.id);
    clock.now += LEASE_MS - 10;
    broker.pump();
    expect(broker.get(holder.id)!.state).toBe("granted");
    child.kill("SIGKILL");
    NodeChildProcess.spawnSync("sleep", ["0.2"]);
    broker.pump();
    expect(broker.get(waiter.id)!.state).toBe("cancelled");
  });

  it("separates running out of patience (exhausted) from running over time (timed-out)", async () => {
    const { broker, clock } = makeBroker();
    broker.enqueue({ resources: [{ name: "db" }], pid: process.pid, label: "blocker" });
    broker.pump();
    const waiter = broker.enqueue({
      resources: [{ name: "db" }],
      pid: process.pid,
      label: "patient",
      waitMs: 5_000,
    });
    clock.now += 6_000;
    broker.pump();
    expect(broker.get(waiter.id)!.outcome).toBe("exhausted");
    await expect(waitForGrant(broker, waiter.id)).rejects.toBeInstanceOf(ResourceWaitError);
  });

  it("remembers a repository's own exclusive resource and serves it one at a time", () => {
    const { broker } = makeBroker();
    const hints = { "fixed-test-postgres": { capacity: 1 } };
    const a = broker.enqueue({
      resources: [{ name: "fixed-test-postgres" }],
      pid: process.pid,
      hints,
    });
    const b = broker.enqueue({
      resources: [{ name: "fixed-test-postgres" }],
      pid: process.pid,
      hints,
    });
    broker.pump();
    expect([broker.get(a.id)!.state, broker.get(b.id)!.state]).toEqual(["granted", "waiting"]);
  });
});

describe("running under the broker", () => {
  it("infers shared resources from the command line and the repository's rules", () => {
    expect(inferResources("./gradlew :app:testDebugUnitTest")).toEqual(["heavy_build"]);
    expect(inferResources("./gradlew connectedDebugAndroidTest")).toEqual([
      "android",
      "heavy_build",
    ]);
    expect(inferResources("docker compose up -d db")).toEqual(["docker"]);
    expect(inferResources("pnpm install --frozen-lockfile")).toEqual(["package_install"]);
    expect(inferResources("uv run pytest -m gpu")).toEqual(["gpu"]);
    expect(inferResources("vp test run src/a.test.ts")).toEqual([]);
    expect(
      inferResources("uv run pytest -m integration", [
        { name: "fixed-test-postgres", commands: ["-m\\s+integration"] },
      ]),
    ).toEqual(["fixed-test-postgres"]);
  });

  it("runs a command only while holding its resource, releases it afterwards, and reports a failing exit code", async () => {
    const home = newHome();
    const { broker } = makeBroker({ home });
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "db" }],
      argv: ["bash", "-c", "echo $AGENTQUEUE_SLOT_DB; exit 3"],
      cwd: home,
      stdio: "pipe",
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(ran.result.exitCode).toBe(3);
    expect(ran.result.outcome).toBe("failed");
    expect(ran.result.tail.trim()).toBe("0");
    expect(broker.status().resources.find((r) => r.name === "db")!.active).toBe(0);
  });

  it("kills a command at its time limit and says it timed out, not that the resource was exhausted", async () => {
    const home = newHome();
    const { broker } = makeBroker({ home });
    const ran = await runUnderBroker({
      broker,
      resources: [{ name: "db" }],
      argv: ["sleep", "30"],
      cwd: home,
      runMs: 300,
    });
    expect(ran.kind).toBe("ran");
    if (ran.kind !== "ran") return;
    expect(ran.result.outcome).toBe("timed-out");
    expect(ran.result.exitCode).toBe(124);
    expect(broker.get(ran.ticket.id)!.state).toBe("done");
  });

  it("serves independent processes one at a time through the physical lock, even without the broker's help", async () => {
    // Two server-style checks use the same resource concurrently: the second must wait.
    const home = newHome();
    const { broker } = makeBroker({ home });
    let active = 0;
    let peak = 0;
    const work = () =>
      withBrokerResources(
        ["db"],
        async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 150));
          active--;
        },
        { broker },
      );
    await Promise.all([work(), work(), work()]);
    expect(peak).toBe(1);
  });

  it("limits real parallel processes to the capacity under heavy contention", async () => {
    const home = newHome();
    // A tiny script: each process records how many holders it saw inside its critical section.
    const marker = NodePath.join(home, "inside");
    NodeFS.mkdirSync(marker);
    const script = NodePath.join(home, "worker.mjs");
    NodeFS.writeFileSync(
      script,
      `import * as fs from "node:fs";
       import { runUnderBroker } from ${JSON.stringify(NodePath.resolve(import.meta.dirname, "../src/resourceRunner.ts"))};
       const id = process.argv[2];
       const result = await runUnderBroker({
         resources: [{ name: "heavy_build" }],
         argv: ["bash", "-c", "touch ${marker}/" + id + "; sleep 0.4; ls ${marker} | wc -l > ${home}/seen-" + id + "; rm ${marker}/" + id],
         cwd: ${JSON.stringify(home)},
       });
       process.exit(result.kind === "ran" ? result.result.exitCode : 9);`,
    );
    const env = {
      ...process.env,
      AGENTQUEUE_RESOURCE_HOME: home,
      AGENTQUEUE_LOCK_ROOT: NodePath.join(home, "locks"),
      // This test proves cross-process slot exclusion; host memory pressure is unrelated.
      AGENTQUEUE_RESOURCE_CONFIG: NodePath.join(home, "resources.json"),
    };
    NodeFS.writeFileSync(
      env.AGENTQUEUE_RESOURCE_CONFIG,
      JSON.stringify({ reserveMb: 0, resources: { heavy_build: { capacity: 2, memoryMb: 0 } } }),
    );
    const children = Array.from(
      { length: 6 },
      (_, index) =>
        new Promise<number>((resolve) => {
          const child = NodeChildProcess.spawn("node", [script, String(index)], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let err = "";
          child.stderr!.on("data", (d) => (err += d));
          child.on("close", (code) => {
            if (code) console.error(err);
            resolve(code ?? 1);
          });
        }),
    );
    const codes = await Promise.all(children);
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const seen = [0, 1, 2, 3, 4, 5].map((i) =>
      Number(NodeFS.readFileSync(NodePath.join(home, `seen-${i}`), "utf8")),
    );
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("stored jobs", () => {
  it("stores a command, runs it when the resource frees up, and keeps the result for its owner", async () => {
    const home = newHome();
    const { broker, killed } = makeBroker({ home });
    expect(killed).toEqual([]);
    const blocker = broker.enqueue({
      resources: [{ name: "db" }],
      pid: process.pid,
      label: "blocker",
    });
    broker.pump();
    const job = broker.enqueue({
      resources: [{ name: "db" }],
      ownerRef: "T1",
      label: "gradle test",
      job: { command: "echo job-output; exit 0", cwd: home },
    });
    expect(job.kind).toBe("job");
    const runner = createJobRunner({ repo: null, broker });
    await runner.tick();
    expect(broker.get(job.id)!.state).toBe("waiting"); // blocked behind the live holder, nobody was spawned
    expect(broker.openJobsFor("T1").map((t) => t.id)).toEqual([job.id]);

    broker.finish(blocker.id, { outcome: "ok" });
    const started = await runner.tick();
    expect(started).toEqual([job.id]);
    for (let i = 0; i < 100 && broker.get(job.id)!.state !== "done"; i++)
      await new Promise((r) => setTimeout(r, 50));
    const done = broker.get(job.id)!;
    expect(done.outcome).toBe("ok");
    expect(done.tail).toContain("job-output");
    expect(broker.unreportedJobs().map((t) => t.id)).toEqual([job.id]);
    expect(describeJob(done)).toMatch(/passed/);
    broker.markReported(job.id);
    expect(broker.unreportedJobs()).toEqual([]);
  });

  it("does not start a job when no runner exists, and puts a job back in line when its runner dies", () => {
    const { broker, clock } = makeBroker();
    const job = broker.enqueue({
      resources: [{ name: "db" }],
      ownerRef: "T2",
      job: { command: "true", cwd: "/tmp" },
    });
    broker.pump();
    expect(broker.get(job.id)!.state).toBe("waiting"); // no runner registered

    const dyingRunner = NodeChildProcess.spawn("sleep", ["30"], { stdio: "ignore" });
    broker.registerRunner(dyingRunner.pid!, null);
    broker.pump();
    expect(broker.get(job.id)!.state).toBe("granted");
    expect(broker.get(job.id)!.pid).toBe(dyingRunner.pid);
    dyingRunner.kill("SIGKILL");
    NodeChildProcess.spawnSync("sleep", ["0.2"]);
    clock.now += 1;
    broker.pump();
    const requeued = broker.get(job.id)!;
    expect(requeued.state).toBe("waiting");
    expect(requeued.attempts).toBe(1);
  });

  it("converts a waiting command into a job when the caller will not wait", async () => {
    const home = newHome();
    const { broker } = makeBroker({ home });
    broker.enqueue({ resources: [{ name: "db" }], pid: process.pid, label: "holder" });
    broker.pump();
    const result = await runUnderBroker({
      broker,
      resources: [{ name: "db" }],
      argv: ["echo", "later"],
      cwd: home,
      ownerRef: "T3",
      deferAfterMs: 200,
    });
    expect(result.kind).toBe("deferred");
    const stored = broker.openJobsFor("T3");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.job!.command).toBe("echo later");
  });
});
