import {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2TurnItem,
  OrchestrationV2ShellSnapshot,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";

import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
} from "@t3tools/client-runtime/testing/orchestration-v2-fixtures";

const RTT_MS = [0, 80, 250] as const;
const BANDWIDTH_MBPS = [1, 5, 20, 100] as const;
const CACHE_STATES = ["empty", "disk", "memory"] as const;
const LARGE_COMMAND_BODY_BYTES = 4_096;

interface WorkloadFixture {
  readonly name: string;
  readonly snapshot?: OrchestrationV2ThreadDetailSnapshot;
  readonly shellSnapshot?: OrchestrationV2ShellSnapshot;
  readonly items: number;
  readonly active: boolean;
  readonly largeBodies: boolean;
}

function commandItem(fixture: string, index: number, threadId: ThreadId): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`perf-${fixture}-item-${index}`),
    type: "command_execution",
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed",
    title: `Command ${index}`,
    input: `command-${index}`,
    output: "x".repeat(LARGE_COMMAND_BODY_BYTES),
    exitCode: 0,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  };
}

function threadSnapshot(name: string, itemCount: number, active = false): WorkloadFixture {
  const threadId = ThreadId.make(`perf-${name}`);
  const thread = {
    ...v2Projection.thread,
    id: threadId,
    title: `Synthetic ${name}`,
    providerInstanceId: active
      ? ProviderInstanceId.make("antigravity")
      : v2Projection.thread.providerInstanceId,
  };
  const turnItems = Array.from({ length: itemCount }, (_, index) =>
    commandItem(name, index, threadId),
  );
  const providerInstanceId = thread.providerInstanceId;
  const modelSelection = thread.modelSelection;
  const messages =
    itemCount <= 3
      ? (["user", "assistant"] as const).map((role) => ({
          createdBy: role === "user" ? ("user" as const) : ("agent" as const),
          creationSource: "mobile" as const,
          id: MessageId.make(`perf-${name}-${role}`),
          threadId,
          runId: null,
          nodeId: null,
          role,
          text:
            role === "user"
              ? "Summarize this small synthetic thread."
              : "A short synthetic answer.",
          attachments: [],
          streaming: false,
          createdAt: v2Now,
          updatedAt: v2Now,
        }))
      : [];
  const projection = {
    ...v2Projection,
    thread,
    turnItems,
    messages,
    ...(active
      ? {
          runs: [
            {
              id: RunId.make(`perf-${name}-run`),
              threadId,
              ordinal: 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make(`perf-${name}-message`),
              rootNodeId: null,
              activeAttemptId: null,
              status: "running" as const,
              requestedAt: v2Now,
              startedAt: v2Now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
        }
      : {}),
  };
  return {
    name,
    snapshot: {
      snapshotSequence: itemCount,
      projection,
    } satisfies OrchestrationV2ThreadDetailSnapshot,
    items: itemCount + messages.length,
    active,
    largeBodies: itemCount > 100,
  };
}

function makeFixtures(): ReadonlyArray<WorkloadFixture> {
  const shells = Array.from({ length: 200 }, (_, index) => ({
    ...v2ShellSnapshot.threads[0]!,
    id: ThreadId.make(`perf-shell-${index}`),
    title: `Synthetic shell ${index}`,
  }));
  return [
    threadSnapshot("small-text", 0),
    threadSnapshot("long-command-heavy", 10_000),
    threadSnapshot("active-agy", 24, true),
    {
      name: "shell-list-200",
      shellSnapshot: {
        ...v2ShellSnapshot,
        threads: shells,
      },
      items: 200,
      active: false,
      largeBodies: false,
    },
  ];
}

function encodedBytes(fixture: WorkloadFixture): number {
  return Buffer.byteLength(JSON.stringify(fixture.snapshot ?? fixture.shellSnapshot), "utf8");
}

function report(): object {
  const fixtures = makeFixtures();
  const fixtureBytes = new Map(fixtures.map((fixture) => [fixture.name, encodedBytes(fixture)]));
  const scenarios = [];
  for (const fixture of fixtures) {
    const bytes = fixtureBytes.get(fixture.name)!;
    for (const cache of CACHE_STATES) {
      for (const rttMs of RTT_MS) {
        for (const bandwidthMbps of BANDWIDTH_MBPS) {
          const transferBytes =
            cache === "empty" ? bytes : cache === "disk" ? Math.min(bytes, 2_048) : 0;
          const transferMs =
            transferBytes === 0 ? 0 : rttMs + (transferBytes * 8) / (bandwidthMbps * 1_000);
          const localLoadMs = cache === "disk" ? bytes / 100_000 : 0;
          const decodeMs = bytes / 30_000;
          scenarios.push({
            fixture: fixture.name,
            cache,
            rttMs,
            bandwidthMbps,
            bytes,
            transferBytes,
            proxyStagesMs: {
              routeSelection: 1,
              stateSelection: localLoadMs,
              transferEstimate: Number(transferMs.toFixed(2)),
              snapshotDecodeProxy: Number(decodeMs.toFixed(2)),
              environmentReadiness: 20,
              subscriptionResume: fixture.active ? 35 : 12,
              feedDerivationProxy: Math.min(fixture.items, 48) * 0.12,
              firstViewportProxy: 16,
              finalLayoutProxy: 30,
            },
            renderedRowLimit: 48,
            interruptions: ["none", "before-response", "after-response"],
            routeChanges: ["stable", "switch-before-response", "switch-after-response"],
            limitations: [
              "JS/fixture proxy",
              "no native paint measurement",
              "no home-link speed claim",
            ],
          });
        }
      }
    }
  }
  return {
    title: "Mobile thread-open deterministic workload report",
    clock: "synthetic monotonic stage model",
    stageAccounting:
      "transfer estimate is reported separately from selection, decode, and list-readiness proxies",
    fixtures: fixtures.map((fixture) => ({
      name: fixture.name,
      items: fixture.items,
      bytes: fixtureBytes.get(fixture.name)!,
      active: fixture.active,
      largeBodies: fixture.largeBodies,
    })),
    counts: {
      fixtures: fixtures.length,
      scenarios: scenarios.length,
      stageEvents: scenarios.length * Object.keys(scenarios[0]?.proxyStagesMs ?? {}).length,
      estimatedBytesAcrossEmptyCacheScenarios: scenarios
        .filter((scenario) => scenario.cache === "empty")
        .reduce((total, scenario) => total + scenario.bytes, 0),
      uniqueRowsPerViewportMaximum: 48,
    },
    scenarios,
  };
}

if (process.argv[1]?.endsWith("mobile-thread-performance.ts")) {
  process.stdout.write(`${JSON.stringify(report(), null, 2)}\n`);
}

export { makeFixtures, report };
