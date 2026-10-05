// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAgentsSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makeChatAgentsAdapter, parseWorkerOutput } from "./ChatAgentsAdapter.ts";

const decodeSettings = Schema.decodeSync(ChatAgentsSettings);
const decodeLogLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const MISSING_CONVERSATION = "deadbeef-2222-3333-4444-555555555555";

/**
 * A stand-in for W's desktop worker. It reads the request file the adapter
 * writes, prints one JSON result line, and appends each request to a log.
 */
const writeFakeWorker = (directory: string) =>
  writeFakeCli({
    directory,
    name: "worker",
    source: [
      'import { readFileSync, appendFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'const requestFile = args[args.indexOf("--request-file") + 1];',
      'const request = JSON.parse(readFileSync(requestFile, "utf8"));',
      'appendFileSync(process.env.WORKER_LOG ?? "/dev/null", JSON.stringify({ args, request }) + "\\n");',
      `if (request.conversation_id === "${MISSING_CONVERSATION}") {`,
      '  console.log(JSON.stringify({ status: "error", failure_code: "CONVERSATION_NOT_FOUND", message: "gone" }));',
      "  process.exit(1);",
      "}",
      'if (request.prompt.startsWith("slow")) await new Promise((resolve) => setTimeout(resolve, 60000));',
      'if (request.prompt.startsWith("fail")) {',
      '  console.log(JSON.stringify({ status: "error", failure_code: "CHAT_UI_UNKNOWN", message: "the composer was not ready" }));',
      "  process.exit(1);",
      "}",
      "console.log(JSON.stringify({",
      '  status: "success",',
      `  conversation_id: request.conversation_id ?? "${CONVERSATION}",`,
      '  response_text: "echo: " + request.prompt + (request.conversation_id ? " (continued)" : " (new chat)"),',
      "}));",
      "",
    ].join("\n"),
  });

const makeAdapter = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-chat-agents-" });
  const log = NodePath.join(directory, "worker.log");
  const workerPath = writeFakeWorker(directory);
  const adapter = yield* makeChatAgentsAdapter(
    decodeSettings({
      enabled: true,
      workerPath,
      pythonPath: "/usr/bin/python3",
      runtimeRoot: directory,
      turnTimeoutMinutes: "1",
    }),
    {
      environment: { ...process.env, WORKER_LOG: log },
      instanceId: ProviderInstanceId.make("chatAgents"),
    },
  );
  const readLog = Effect.gen(function* () {
    const raw = (yield* fs.exists(log)) ? yield* fs.readFileString(log) : "";
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          decodeLogLine(line) as {
            readonly args: ReadonlyArray<string>;
            readonly request: {
              readonly role: string;
              readonly prompt: string;
              readonly conversation_id: string | null;
            };
          },
      );
  });
  return { adapter, readLog };
});

const runtimeMode = "full-access" as const;

it.layer(NodeServices.layer)("ChatAgentsAdapterLive", (it) => {
  it.effect("opens a new chat on the first turn and continues it on the next", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, readLog } = yield* makeAdapter;
        const threadId = ThreadId.make("chat-agents-continue");
        yield* adapter.startSession({ threadId, runtimeMode });

        const first = yield* adapter.sendTurn({ threadId, input: "hello" });
        assert.deepStrictEqual(first.resumeCursor, {
          schemaVersion: 1,
          conversationId: CONVERSATION,
        });
        yield* adapter.sendTurn({ threadId, input: "and again" });

        const requests = yield* readLog;
        assert.deepStrictEqual(
          requests.map((entry) => [entry.request.role, entry.request.conversation_id]),
          [
            ["owner", null],
            ["owner", CONVERSATION],
          ],
        );
        assert.isTrue(requests[0]?.args.includes("--request-file"));
      }),
    ),
  );

  it.effect("delivers the reply as one assistant message and completes the turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* makeAdapter;
        const threadId = ThreadId.make("chat-agents-events");
        const events: Array<ProviderRuntimeEvent> = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped,
        );
        // Let the collector subscribe before anything is published.
        yield* Effect.yieldNow;
        yield* adapter.startSession({ threadId, runtimeMode });

        yield* adapter.sendTurn({ threadId, input: "hello" });
        yield* adapter.stopSession(threadId);
        yield* Fiber.interrupt(collector);

        const types = events.map((event) => event.type);
        assert.includeMembers(types, ["turn.started", "content.delta", "turn.completed"]);
        const delta = events.find((event) => event.type === "content.delta");
        assert.strictEqual(
          delta?.type === "content.delta" ? delta.payload.delta : undefined,
          "echo: hello (new chat)",
        );
        const completed = events.find((event) => event.type === "turn.completed");
        assert.strictEqual(
          completed?.type === "turn.completed" ? completed.payload.state : undefined,
          "completed",
        );
      }),
    ),
  );

  it.effect("fails the turn with the worker's reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* makeAdapter;
        const threadId = ThreadId.make("chat-agents-failure");
        yield* adapter.startSession({ threadId, runtimeMode });
        const exit = yield* Effect.exit(adapter.sendTurn({ threadId, input: "fail please" }));
        assert.isTrue(exit._tag === "Failure");
        assert.match(String(exit), /composer was not ready/);
        // A failed turn leaves the thread usable.
        const retry = yield* adapter.sendTurn({ threadId, input: "hello" });
        assert.isDefined(retry.turnId);
      }),
    ),
  );

  it.effect("starts a new chat when the saved one is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter, readLog } = yield* makeAdapter;
        const threadId = ThreadId.make("chat-agents-lost");
        yield* adapter.startSession({
          threadId,
          runtimeMode,
          resumeCursor: { schemaVersion: 1, conversationId: MISSING_CONVERSATION },
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
        assert.deepStrictEqual(turn.resumeCursor, {
          schemaVersion: 1,
          conversationId: CONVERSATION,
        });
        const requests = yield* readLog;
        assert.deepStrictEqual(
          requests.map((entry) => entry.request.conversation_id),
          [MISSING_CONVERSATION, null],
        );
      }),
    ),
  );

  it.effect("stops a running turn when it is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* makeAdapter;
        const threadId = ThreadId.make("chat-agents-interrupt");
        yield* adapter.startSession({ threadId, runtimeMode });
        const events: Array<ProviderRuntimeEvent> = [];
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped,
        );
        const turn = yield* Effect.forkScoped(adapter.sendTurn({ threadId, input: "slow work" }));
        // The turn is registered as soon as it starts; wait for that, not for a delay.
        yield* Effect.gen(function* () {
          while (!events.some((event) => event.type === "turn.started")) {
            yield* Effect.yieldNow;
          }
        }).pipe(Effect.timeout("10 seconds"));
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turn);
        const completed = events.find((event) => event.type === "turn.completed");
        assert.strictEqual(
          completed?.type === "turn.completed" ? completed.payload.state : undefined,
          "cancelled",
        );
      }),
    ),
  );

  it.effect("refuses attachments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { adapter } = yield* makeAdapter;
        const threadId = ThreadId.make("chat-agents-attachments");
        yield* adapter.startSession({ threadId, runtimeMode });
        const exit = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "hello",
            attachments: [
              { type: "image", id: "a-1", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
            ],
          }),
        );
        assert.isTrue(exit._tag === "Failure");
      }),
    ),
  );
});

it("reads the last JSON line of the worker's output", () => {
  const parsed = parseWorkerOutput(
    [
      "some log noise",
      '{"status":"success","conversation_id":"abc","response_text":"hi"}',
      "",
    ].join("\n"),
  );
  assert.strictEqual(parsed?.status, "success");
  assert.strictEqual(parsed?.responseText, "hi");
  assert.strictEqual(parseWorkerOutput(""), undefined);
  assert.strictEqual(parseWorkerOutput("not json")?.status, "error");
});
