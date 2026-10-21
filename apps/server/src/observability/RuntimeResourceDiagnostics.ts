// @effect-diagnostics nodeBuiltinImport:off - only the server's own cgroup and memory counters are read.
import * as NodeFSP from "node:fs/promises";

import { RotatingFileSink } from "@t3tools/shared/logging";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { increment, runtimeResourceSamplesTotal } from "./Metrics.ts";

const SAMPLE_INTERVAL = "10 seconds";
const SAMPLE_LIMIT = 512;
const MAX_ACTIVE_ACTIVITIES = 128;
const FILE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_COUNT = 7;

export function retainSample(
  samples: Array<RuntimeResourceSample>,
  sample: RuntimeResourceSample,
): void {
  samples.push(sample);
  if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
}

export interface RuntimeActivity {
  readonly runtimeId: string;
  readonly runId: string;
  readonly tool: string;
  readonly brokerTicketId?: string;
  readonly deadlineAt?: number;
  readonly lastProgressAt: number;
  readonly cancelRequestedAt?: number;
  readonly cancellationLatencyMs?: number;
}

export interface RuntimeResourceSample {
  readonly sampledAt: string;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly anonymousBytes: number | null;
  readonly fileBytes: number | null;
  readonly swapBytes: number | null;
  readonly cgroupMemoryCurrentBytes: number | null;
  readonly cgroupMemoryHighBytes: number | null;
  readonly cgroupMemoryMaxBytes: number | null;
  readonly cgroupHighEvents: number | null;
  readonly cgroupMaxEvents: number | null;
  readonly cgroupOomEvents: number | null;
  readonly stage: "idle" | "provider-runtime-active" | "resource-pressure";
  readonly active: ReadonlyArray<RuntimeActivity>;
  readonly recentlyCancelled: ReadonlyArray<RuntimeActivity & { readonly finishedAt: number }>;
}

export class RuntimeResourceDiagnostics extends Context.Service<
  RuntimeResourceDiagnostics,
  {
    readonly begin: (activity: Omit<RuntimeActivity, "lastProgressAt">) => Effect.Effect<void>;
    readonly progress: (runtimeId: string, runId: string) => Effect.Effect<void>;
    readonly cancel: (runtimeId: string, runId: string) => Effect.Effect<void>;
    readonly finish: (runtimeId: string, runId: string) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<ReadonlyArray<RuntimeResourceSample>>;
  }
>()("t3/observability/RuntimeResourceDiagnostics") {}

const safeLabel = (value: string) => value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 128);

const parseCounters = (text: string) =>
  new Map(
    text
      .trim()
      .split("\n")
      .flatMap((line) => {
        const [key, value] = line.split(/\s+/, 2);
        return key && value && /^\d+$/.test(value) ? [[key, Number(value)] as const] : [];
      }),
  );

const readText = (path: string) => NodeFSP.readFile(path, "utf8").catch(() => "");

async function pruneExpiredFiles(filePath: string): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await Promise.all(
    Array.from({ length: FILE_COUNT }, async (_, index) => {
      const candidate = index === 0 ? filePath : `${filePath}.${index}`;
      const metadata = await NodeFSP.stat(candidate).catch(() => undefined);
      if (metadata && metadata.mtimeMs < cutoff)
        await NodeFSP.unlink(candidate).catch(() => undefined);
    }),
  );
}

async function sampleProcess(
  active: ReadonlyArray<RuntimeActivity>,
  recentlyCancelled: ReadonlyArray<RuntimeActivity & { readonly finishedAt: number }>,
): Promise<RuntimeResourceSample> {
  const memory = process.memoryUsage();
  const [smaps, cgroup] = await Promise.all([
    readText("/proc/self/smaps_rollup"),
    readText("/proc/self/cgroup"),
  ]);
  const currentPath = /^0::(.+)$/m.exec(cgroup)?.[1];
  const cgroupRoot = currentPath ? `/sys/fs/cgroup${currentPath}` : undefined;
  const [eventsText, currentText, highText, maxText, swapText] = cgroupRoot
    ? await Promise.all([
        readText(`${cgroupRoot}/memory.events`),
        readText(`${cgroupRoot}/memory.current`),
        readText(`${cgroupRoot}/memory.high`),
        readText(`${cgroupRoot}/memory.max`),
        readText(`${cgroupRoot}/memory.swap.current`),
      ])
    : ["", "", "", "", ""];
  const stat = parseCounters(smaps);
  const events = parseCounters(eventsText);
  const scalar = (value: string): number | null =>
    /^\d+$/.test(value.trim()) ? Number(value) : null;
  const cgroupPressure =
    scalar(currentText) !== null &&
    scalar(highText) !== null &&
    scalar(highText)! > 0 &&
    scalar(currentText)! >= scalar(highText)!;
  return {
    sampledAt: new Date().toISOString(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    anonymousBytes: stat.get("Anonymous") === undefined ? null : stat.get("Anonymous")! * 1024,
    fileBytes: stat.get("File") === undefined ? null : stat.get("File")! * 1024,
    swapBytes: scalar(swapText),
    cgroupMemoryCurrentBytes: scalar(currentText),
    cgroupMemoryHighBytes: scalar(highText),
    cgroupMemoryMaxBytes: scalar(maxText),
    cgroupHighEvents: events.get("high") ?? null,
    cgroupMaxEvents: events.get("max") ?? null,
    cgroupOomEvents: events.get("oom") ?? null,
    stage: cgroupPressure
      ? "resource-pressure"
      : active.length
        ? "provider-runtime-active"
        : "idle",
    active,
    recentlyCancelled,
  };
}

const encodeLine = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const layerWith = (filePath: string, makeSample: typeof sampleProcess = sampleProcess) =>
  Layer.effect(
    RuntimeResourceDiagnostics,
    Effect.gen(function* () {
      const active = new Map<string, RuntimeActivity>();
      const recentlyCancelled: Array<RuntimeActivity & { readonly finishedAt: number }> = [];
      const samples: Array<RuntimeResourceSample> = [];
      let lastPrunedAt = Date.now();
      yield* Effect.tryPromise(() => pruneExpiredFiles(filePath)).pipe(
        Effect.catch(() => Effect.void),
      );
      let sink: RotatingFileSink | undefined;
      try {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: FILE_MAX_BYTES,
          maxFiles: FILE_COUNT,
          throwOnError: true,
        });
      } catch {
        yield* Effect.logWarning("runtime resource diagnostic log unavailable");
      }
      const key = (runtimeId: string, runId: string) => `${runtimeId}\u0000${runId}`;
      const service = RuntimeResourceDiagnostics.of({
        begin: (input) =>
          Effect.sync(() => {
            const now = Date.now();
            const id = key(input.runtimeId, input.runId);
            if (!active.has(id) && active.size >= MAX_ACTIVE_ACTIVITIES) return;
            active.set(id, {
              ...input,
              runtimeId: safeLabel(input.runtimeId),
              runId: safeLabel(input.runId),
              tool: safeLabel(input.tool),
              ...(input.brokerTicketId ? { brokerTicketId: safeLabel(input.brokerTicketId) } : {}),
              lastProgressAt: now,
            });
          }),
        progress: (runtimeId, runId) =>
          Effect.sync(() => {
            const id = key(runtimeId, runId);
            const current = active.get(id);
            if (current) active.set(id, { ...current, lastProgressAt: Date.now() });
          }),
        cancel: (runtimeId, runId) =>
          Effect.sync(() => {
            const id = key(runtimeId, runId);
            const current = active.get(id);
            if (current) active.set(id, { ...current, cancelRequestedAt: Date.now() });
          }),
        finish: (runtimeId, runId) =>
          Effect.sync(() => {
            const id = key(runtimeId, runId);
            const current = active.get(id);
            if (current?.cancelRequestedAt !== undefined) {
              recentlyCancelled.push({
                ...current,
                cancellationLatencyMs: Math.max(0, Date.now() - current.cancelRequestedAt),
                finishedAt: Date.now(),
              });
              if (recentlyCancelled.length > SAMPLE_LIMIT) recentlyCancelled.shift();
            }
            active.delete(id);
          }),
        snapshot: Effect.sync(() => samples.slice()),
      });
      const tick = Effect.gen(function* () {
        if (Date.now() - lastPrunedAt > 24 * 60 * 60 * 1000) {
          yield* Effect.tryPromise(() => pruneExpiredFiles(filePath)).pipe(
            Effect.catch(() => Effect.void),
          );
          lastPrunedAt = Date.now();
        }
        const result = yield* Effect.tryPromise(() =>
          makeSample([...active.values()], recentlyCancelled.slice()),
        );
        const previous = samples.at(-1);
        const pressureEvent =
          previous !== undefined &&
          ((result.cgroupHighEvents ?? 0) > (previous.cgroupHighEvents ?? 0) ||
            (result.cgroupMaxEvents ?? 0) > (previous.cgroupMaxEvents ?? 0) ||
            (result.cgroupOomEvents ?? 0) > (previous.cgroupOomEvents ?? 0));
        const attributed =
          pressureEvent && result.stage !== "resource-pressure"
            ? { ...result, stage: "resource-pressure" as const }
            : result;
        retainSample(samples, attributed);
        yield* increment(runtimeResourceSamplesTotal, { stage: attributed.stage });
        if (sink) {
          const line = yield* encodeLine(attributed).pipe(Effect.catch(() => Effect.succeed("{}")));
          yield* Effect.try(() => sink!.write(`${line}\n`)).pipe(Effect.catch(() => Effect.void));
        }
      });
      yield* Effect.forever(Effect.sleep(SAMPLE_INTERVAL).pipe(Effect.andThen(tick))).pipe(
        Effect.forkScoped,
      );
      return service;
    }),
  );

export const layerTest = Layer.succeed(
  RuntimeResourceDiagnostics,
  RuntimeResourceDiagnostics.of({
    begin: () => Effect.void,
    progress: () => Effect.void,
    cancel: () => Effect.void,
    finish: () => Effect.void,
    snapshot: Effect.succeed([]),
  }),
);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { serverTracePath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return layerWith(path.join(path.dirname(serverTracePath), "runtime-resources.ndjson"));
  }),
);
