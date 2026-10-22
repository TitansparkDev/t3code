declare const __DEV__: boolean;
declare const process: { readonly env: { readonly EXPO_PUBLIC_T3_THREAD_PERF?: string } };

export type ThreadOpenStage =
  | "route-selection"
  | "memory-hit"
  | "sqlite-load-decode"
  | "environment-ready"
  | "http-start"
  | "http-response"
  | "snapshot-decode"
  | "subscription-resumed"
  | "feed-derived"
  | "first-visible-viewport"
  | "final-list-layout";

export interface ThreadOpenTrace {
  readonly correlationId: string;
  mark(stage: ThreadOpenStage): void;
  finish(): void;
  cancel(): void;
}

interface StageMark {
  readonly atMs: number;
  readonly durationMs: number;
}

interface PerformanceMarks {
  readonly mark?: (name: string) => void;
  readonly measure?: (name: string, startMark: string, endMark: string) => void;
  readonly clearMarks?: (name?: string) => void;
  readonly clearMeasures?: (name?: string) => void;
}

const traces = new Map<string, ThreadOpenTraceRecorder>();
let sequence = 0;

export function threadOpenTraceKey(environmentId: string, threadId: string): string {
  return `${environmentId}\u0000${threadId}`;
}

function now(): number {
  return globalThis.performance?.now?.() ?? 0;
}

export function isThreadOpenPerformanceEnabled(): boolean {
  return (
    typeof __DEV__ !== "undefined" &&
    __DEV__ &&
    typeof process !== "undefined" &&
    process.env.EXPO_PUBLIC_T3_THREAD_PERF === "1"
  );
}

export class ThreadOpenTraceRecorder implements ThreadOpenTrace {
  readonly correlationId = `thread-open-${++sequence}`;
  readonly #startedAt: number;
  readonly #stages = new Map<ThreadOpenStage, StageMark>();
  #closed = false;
  private readonly key: string;
  private readonly clock: () => number;
  private readonly emit: (entry: {
    readonly correlationId: string;
    readonly outcome: string;
    readonly stages: object;
  }) => void;

  constructor(
    key: string,
    clock: () => number = now,
    emit: (entry: {
      readonly correlationId: string;
      readonly outcome: string;
      readonly stages: object;
    }) => void = () => {},
  ) {
    this.key = key;
    this.clock = clock;
    this.emit = emit;
    this.#startedAt = this.clock();
    this.mark("route-selection");
  }

  mark(stage: ThreadOpenStage): void {
    if (this.#closed || this.#stages.has(stage)) return;
    const timestamp = this.clock();
    const previous = [...this.#stages.values()].at(-1)?.atMs ?? this.#startedAt;
    this.#stages.set(stage, {
      atMs: Number((timestamp - this.#startedAt).toFixed(2)),
      durationMs: Number((timestamp - previous).toFixed(2)),
    });
    const perf = (globalThis as { readonly performance?: PerformanceMarks }).performance;
    const previousStage = [...this.#stages.keys()].at(-2);
    const startMark = `t3.thread-open.${this.correlationId}.${previousStage ?? stage}`;
    const endMark = `t3.thread-open.${this.correlationId}.${stage}`;
    perf?.mark?.(endMark);
    if (this.#stages.size > 1)
      perf?.measure?.(`t3.thread-open.${this.correlationId}.${stage}`, startMark, endMark);
  }

  hasStage(stage: ThreadOpenStage): boolean {
    return this.#stages.has(stage);
  }

  finish(): void {
    this.close("complete");
  }

  cancel(): void {
    this.close("cancelled");
  }

  private close(outcome: "complete" | "cancelled"): void {
    if (this.#closed) return;
    this.#closed = true;
    if (traces.get(this.key) === this) traces.delete(this.key);
    const perf = (globalThis as { readonly performance?: PerformanceMarks }).performance;
    for (const stage of this.#stages.keys()) {
      perf?.clearMarks?.(`t3.thread-open.${this.correlationId}.${stage}`);
      perf?.clearMeasures?.(`t3.thread-open.${this.correlationId}.${stage}`);
    }
    this.emit({
      correlationId: this.correlationId,
      outcome,
      stages: Object.fromEntries(this.#stages),
    });
  }
}

export function startThreadOpenTrace(
  key: string,
  emit?: ConstructorParameters<typeof ThreadOpenTraceRecorder>[2],
): ThreadOpenTrace | null {
  if (!isThreadOpenPerformanceEnabled()) return null;
  traces.get(key)?.cancel();
  const trace = new ThreadOpenTraceRecorder(key, now, emit);
  traces.set(key, trace);
  return trace;
}

export function markThreadOpenStage(key: string, stage: ThreadOpenStage): void {
  if (!isThreadOpenPerformanceEnabled()) return;
  const trace = traces.get(key);
  trace?.mark(stage);
  if (trace?.hasStage("final-list-layout") && trace.hasStage("subscription-resumed")) {
    trace.finish();
  }
}
