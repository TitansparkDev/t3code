// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ClineSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import type { ClineAdapterShape } from "../Services/ClineAdapter.ts";
import { makeClineAdapter } from "./ClineAdapter.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);
const PROVIDER = ProviderDriverKind.make("cline");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");

/** Test-local tag so each test can build an adapter over its own mock CLI. */
class ClineAdapter extends Context.Service<ClineAdapter, ClineAdapterShape>()(
  "t3/provider/Layers/ClineAdapter.test/ClineAdapter",
) {}

/**
 * A stand-in for the Cline CLI: `--version` prints a version and exits, and
 * `--acp` execs the mock ACP agent so the session answers like Cline's.
 */
const writeFakeClineCli = (input?: {
  readonly env?: Record<string, string>;
  readonly version?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cline-adapter-" });
    return writeFakeCli({
      directory,
      name: "cline",
      env: { T3_ACP_CLINE: "1", ...input?.env },
      source: [
        'if (process.argv[2] === "--version") {',
        `  process.stdout.write("cline ${input?.version ?? "3.0.65"}\\n");`,
        "  process.exit(0);",
        "}",
        'if (process.argv[2] !== "--acp") process.exit(1);',
        execScriptSource({ scriptPath: mockAgentPath, expectedArgs: ["--acp"] }),
        "",
      ].join("\n"),
    });
  });

const decodeRequestLogLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Ordered `method` / config-write summary of the mock agent's raw JSON-RPC log. */
const readAcpRequestSequence = (filePath: string) =>
  Effect.gen(function* () {
    const raw = yield* readFileIfPresent(filePath);
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const entry = decodeRequestLogLine(line) as {
          readonly method?: unknown;
          readonly params?: { readonly configId?: unknown; readonly value?: unknown };
        };
        if (typeof entry.params?.configId === "string") {
          return `config:${entry.params.configId}=${String(entry.params.value)}`;
        }
        return typeof entry.method === "string" ? entry.method : "";
      });
  });

const readFileIfPresent = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.exists(filePath)) ? yield* fs.readFileString(filePath) : "";
  });

const scopedTempPath = (prefix: string, fileName: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix });
    return NodePath.join(directory, fileName);
  });

// Tests swap `providers.cline.binaryPath` mid-flight, so each session has to
// read the latest settings rather than the value captured at construction.
const makeResolveClineSettings = Effect.map(ServerSettingsService, (serverSettings) =>
  serverSettings.getSettings.pipe(
    Effect.map((snapshot) => snapshot.providers.cline),
    Effect.orDie,
  ),
);

const clineAdapterTestLayer = it.layer(
  Layer.effect(
    ClineAdapter,
    Effect.gen(function* () {
      const resolveSettings = yield* makeResolveClineSettings;
      return yield* makeClineAdapter(decodeClineSettings({}), { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cline-adapter-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

clineAdapterTestLayer("ClineAdapterLive", (it) => {
  it.effect("starts a session and streams a prompt to T3 runtime events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-happy-path");
        const requestLogPath = yield* scopedTempPath("t3code-cline-req-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, T3_ACP_EMIT_TOOL_CALLS: "1" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });

        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId,
          provider: PROVIDER,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        assert.isTrue(yield* adapter.hasSession(threadId));
        assert.deepStrictEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "mock-session-1",
        });

        yield* adapter.sendTurn({ threadId, input: "hello from T3", attachments: [] });
        events.push(...(yield* Fiber.join(collector)));
        yield* adapter.stopSession(threadId);

        const types = events.map((event) => event.type);
        assert.includeMembers(types, [
          "session.started",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "turn.completed",
        ] as const);
        // The completed turn clears the session's active turn.
        const completed = events.find((event) => event.type === "turn.completed");
        assert.strictEqual(
          completed?.type === "turn.completed" ? completed.payload.state : null,
          "completed",
        );
        assert.isFalse(yield* adapter.hasSession(threadId));

        const logged = yield* readFileIfPresent(requestLogPath);
        assert.isTrue(logged.includes('"session/new"'));
        assert.isTrue(logged.includes('"session/prompt"'));
        // Never negotiate auth: Cline's `authenticate` opens a browser.
        assert.isFalse(logged.includes('"authenticate"'));
        // A text-only prompt, since Cline discards every non-text block.
        assert.isFalse(logged.includes('"image"'));
      }),
    ),
  );

  it.effect("selects the model Cline advertises and refuses one it does not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-model-selection");
        const requestLogPath = yield* scopedTempPath("t3code-cline-model-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });

        const session = yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("cline"),
            model: "qwen/qwen3.8-max-prime",
          },
        });
        assert.strictEqual(session.model, "qwen/qwen3.8-max-prime");
        yield* adapter.stopSession(threadId);

        const logged = yield* readFileIfPresent(requestLogPath);
        assert.isTrue(logged.includes('"qwen/qwen3.8-max-prime"'));
        // The provider picker is tagged `category: "model"` too, so a naive
        // lookup would have written the account instead of the model.
        assert.isFalse(logged.includes('"configId":"provider"'));

        const secondThread = ThreadId.make("cline-model-rejected");
        const error = yield* adapter
          .startSession({
            threadId: secondThread,
            cwd: process.cwd(),
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: ProviderInstanceId.make("cline"),
              model: "retired/model",
            },
          })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ProviderAdapterValidationError");
        assert.isFalse(yield* adapter.hasSession(secondThread));
      }),
    ),
  );

  it.effect("refuses an empty model catalog before opening a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-empty-catalog");
        const requestLogPath = yield* scopedTempPath("t3code-cline-empty-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: {
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            T3_ACP_EMPTY_MODEL_CATALOG: "1",
          },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        const error = yield* adapter
          .startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ProviderAdapterValidationError");
        assert.match(
          error._tag === "ProviderAdapterValidationError" ? error.issue : "",
          /did not advertise any usable models/,
        );
        // Nothing was registered, so no session can be resumed or stopped.
        assert.isFalse(yield* adapter.hasSession(threadId));
        const logged = yield* readFileIfPresent(requestLogPath);
        assert.isFalse(logged.includes('"session/prompt"'));
      }),
    ),
  );

  it.effect("refuses access modes its single approval switch cannot enforce", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const binaryPath = yield* writeFakeClineCli();
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        // `auto-accept-edits` and `auto` both promise a per-tool policy Cline
        // does not have, so accepting them would grant more than the user chose.
        for (const runtimeMode of ["auto-accept-edits", "auto"] as const) {
          const threadId = ThreadId.make(`cline-mode-${runtimeMode}`);
          const error = yield* adapter
            .startSession({ threadId, cwd: process.cwd(), runtimeMode })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "ProviderAdapterValidationError");
          assert.match(
            error._tag === "ProviderAdapterValidationError" ? error.issue : "",
            /Supervised and Full access/,
          );
          assert.isFalse(yield* adapter.hasSession(threadId));
        }
      }),
    ),
  );

  it.effect("surfaces a permission request and accepts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-permission-accept");
        const requestLogPath = yield* scopedTempPath("t3code-cline-perm-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, T3_ACP_EMIT_TOOL_CALLS: "1" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });

        // Subscribe before the send: the request is published on the adapter's
        // canonical stream, and an unbounded PubSub does not replay.
        const opened = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "request.opened"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        const send = yield* adapter
          .sendTurn({ threadId, input: "run something", attachments: [] })
          .pipe(Effect.forkChild);
        const [request] = yield* Fiber.join(opened);
        assert.isDefined(request);
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(
            (request as Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }>)
              .requestId ?? "unknown",
          ),
          "accept",
        );
        yield* Fiber.join(send);
        yield* adapter.stopSession(threadId);
        const logged = yield* readFileIfPresent(requestLogPath);
        assert.isTrue(logged.includes("allow_once"));
      }).pipe(TestClock.withLive),
    ),
  );

  it.effect("auto-approves in Full access without prompting the user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-permission-auto");
        const requestLogPath = yield* scopedTempPath("t3code-cline-auto-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, T3_ACP_EMIT_TOOL_CALLS: "1" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const opened = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({ threadId, input: "run something", attachments: [] });
        const events = yield* Fiber.join(opened);
        // Full access answers the tool itself; the user is never asked.
        assert.isFalse(events.some((event) => event.type === "request.opened"));
        yield* adapter.stopSession(threadId);
        const logged = yield* readFileIfPresent(requestLogPath);
        // Full access answers with Cline's always-allow option, not a prompt.
        assert.isTrue(logged.includes("allow_always"));
      }),
    ),
  );

  it.effect("rejects attachments and Plan mode before touching turn state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-rejects-input");
        const requestLogPath = yield* scopedTempPath("t3code-cline-reject-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        // Collected per event: `runCollect` returns nothing when interrupted,
        // which is exactly the state this test inspects.
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild,
        );
        // Subscribed before the session starts, so the collector sees it come up.
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const attachmentError = yield* adapter
          .sendTurn({
            threadId,
            input: "look at this",
            attachments: [
              {
                id: "att-1",
                type: "image",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 10,
              },
            ],
          })
          .pipe(Effect.flip);
        assert.strictEqual(attachmentError._tag, "ProviderAdapterValidationError");
        assert.match(
          attachmentError._tag === "ProviderAdapterValidationError" ? attachmentError.issue : "",
          /cannot accept attachments/,
        );

        const planError = yield* adapter
          .sendTurn({ threadId, input: "plan this", attachments: [], interactionMode: "plan" })
          .pipe(Effect.flip);
        assert.strictEqual(planError._tag, "ProviderAdapterValidationError");
        assert.match(
          planError._tag === "ProviderAdapterValidationError" ? planError.issue : "",
          /Plan mode cannot be honored/,
        );

        // A rejected turn must not have prompted the agent at all.
        const logged = yield* readFileIfPresent(requestLogPath);
        assert.isFalse(logged.includes('"session/prompt"'));
        // No turn was reserved, so the session is still idle.
        assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
        // And no terminal event names a turn that never started. Ingestion
        // accepts a named completion for a turn it never saw start, so one here
        // would persist a phantom failed turn on top of the failure activity
        // the command reactor already appends.
        yield* Effect.sleep(200).pipe(TestClock.withLive);
        yield* Fiber.interrupt(collector);
        // Guard against a vacuous pass: the collector must have seen the
        // session come up, or "no terminal event" proves nothing.
        assert.isTrue(
          events.some((event) => event.type === "session.started"),
          events.map((event) => event.type).join(","),
        );
        assert.isFalse(
          events.some((event) => event.type === "turn.completed" || event.type === "turn.aborted"),
          events.map((event) => event.type).join(","),
        );
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("honours a Stop that lands before the prompt is sent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-cancel-preprompt");
        const requestLogPath = yield* scopedTempPath("t3code-cline-preprompt-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: {
            T3_ACP_REQUEST_LOG_PATH: requestLogPath,
            // Stalls the model/mode configuration sendTurn does before
            // prompting, which is the window `session/cancel` cannot reach.
            T3_ACP_HANG_SET_CONFIG_OPTION: "1",
          },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        // Collected per event rather than with `runCollect`: a collector that
        // only returns at stream end has nothing to show after an interrupt.
        const events: ProviderRuntimeEvent[] = [];
        const collector = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkChild,
        );
        // Subscribed before the session starts: the event stream is live, not
        // replayed, so a later subscriber misses `session.started`.
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const turn = yield* adapter
          .sendTurn({
            threadId,
            input: "never dispatched",
            attachments: [],
            // A model the session is not already on, so sendTurn really does send
            // `session/set_config_option` and stalls inside the window.
            modelSelection: {
              instanceId: ProviderInstanceId.make("cline"),
              model: "qwen/qwen3.8-max-prime",
            },
          })
          .pipe(Effect.forkChild);
        // Let the stalled configuration RPC start before cancelling.
        yield* Effect.sleep(300).pipe(TestClock.withLive);
        const interrupted = yield* adapter.interruptTurn(threadId).pipe(TestClock.withLive);
        yield* Effect.sleep(300).pipe(TestClock.withLive);
        // The turn gives up rather than prompting after the user stopped it.
        yield* Fiber.interrupt(turn).pipe(TestClock.withLive);
        yield* Effect.sleep(200).pipe(TestClock.withLive);
        yield* Fiber.interrupt(collector);
        assert.isUndefined(interrupted);
        // Guard against a vacuous pass: the collector must have seen the session
        // come up, or "no terminal event" proves nothing.
        assert.isTrue(
          events.some((event) => event.type === "session.started"),
          events.map((event) => event.type).join(","),
        );

        // The prompt never reached the agent, which is the whole point.
        const logged = yield* readFileIfPresent(requestLogPath);
        assert.isTrue(logged.includes('"session/set_config_option"'));
        assert.isFalse(logged.includes('"session/prompt"'));
        // No turn was ever started, so nothing claims one completed.
        assert.deepStrictEqual(yield* adapter.readThread(threadId), { threadId, turns: [] });
        assert.isFalse(
          events.some((event) => event.type === "turn.completed" || event.type === "turn.aborted"),
          events.map((event) => event.type).join(","),
        );
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("cancels a running turn without touching a later prompt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-cancel");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_PROMPT_DELAY_MS: "5000" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const first = yield* adapter
          .sendTurn({ threadId, input: "long task", attachments: [] })
          .pipe(Effect.forkChild);
        yield* adapter.interruptTurn(threadId).pipe(TestClock.withLive);
        yield* Fiber.join(first).pipe(TestClock.withLive);
        // The cancelled turn still terminates and the session stays usable.
        const second = yield* adapter
          .sendTurn({ threadId, input: "next task", attachments: [] })
          .pipe(TestClock.withLive);
        assert.strictEqual(second.threadId, threadId);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("keeps concurrent turns on their own model selection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-concurrent");
        const requestLogPath = yield* scopedTempPath("t3code-cline-conc-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, T3_ACP_PROMPT_DELAY_MS: "300" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        const instanceId = ProviderInstanceId.make("cline");
        yield* Effect.all(
          [
            adapter.sendTurn({
              threadId,
              input: "first",
              attachments: [],
              modelSelection: { instanceId, model: "qwen/qwen3.8-max-prime" },
            }),
            adapter.sendTurn({
              threadId,
              input: "second",
              attachments: [],
              modelSelection: { instanceId, model: "aion-labs/aion-3.5" },
            }),
          ],
          { concurrency: 2 },
        ).pipe(TestClock.withLive);
        yield* adapter.stopSession(threadId);

        // Each selection is written immediately before its own prompt, so the
        // two cannot cross over: the model write and the prompt it belongs to
        // are never separated by the other turn's write.
        const sequence = yield* readAcpRequestSequence(requestLogPath);
        // Ignoring the mode negotiation, every model write is immediately
        // followed by its own prompt: the other turn's write never slips
        // between them, which is what the per-session permit guarantees.
        assert.deepStrictEqual(
          sequence.filter(
            (entry) => entry === "session/prompt" || entry.startsWith("config:model="),
          ),
          [
            "config:model=qwen/qwen3.8-max-prime",
            "session/prompt",
            "config:model=aion-labs/aion-3.5",
            "session/prompt",
          ],
        );
      }),
    ),
  );

  it.effect("resumes the exact Cline session through session/load", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const requestLogPath = yield* scopedTempPath("t3code-cline-load-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath, T3_ACP_EMIT_LOAD_REPLAY: "1" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });

        const firstThread = ThreadId.make("cline-resume-origin");
        const first = yield* adapter.startSession({
          threadId: firstThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId: firstThread, input: "remember", attachments: [] });
        yield* adapter.stopSession(firstThread);

        const resumedThread = ThreadId.make("cline-resume-target");
        const resumed = yield* adapter.startSession({
          threadId: resumedThread,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: first.resumeCursor,
        });
        assert.deepStrictEqual(resumed.resumeCursor, first.resumeCursor);
        yield* adapter.stopSession(resumedThread);

        const logged = yield* readFileIfPresent(requestLogPath);
        // Cline implements `session/load` only; `session/resume` is -32601.
        assert.isTrue(logged.includes('"session/load"'));
      }),
    ),
  );

  it.effect("retires a session when the Cline process dies mid-session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-connection-lost");
        const binaryPath = yield* writeFakeClineCli({
          // Kills the child the first time the adapter configures the model,
          // i.e. after the session is up and a turn is in flight.
          env: { T3_ACP_EXIT_ON_SET_CONFIG_OPTION: "1" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        assert.isTrue(yield* adapter.hasSession(threadId));

        const instanceId = ProviderInstanceId.make("cline");
        const failed = yield* adapter
          .sendTurn({
            threadId,
            input: "dies before the prompt",
            attachments: [],
            modelSelection: { instanceId, model: "qwen/qwen3.8-max-prime" },
          })
          .pipe(Effect.flip, TestClock.withLive);
        assert.isDefined(failed);

        // A dead connection must not keep reporting a ready session: every later
        // turn would be sent to a process that is gone. Retiring it runs on the
        // notification fiber, so poll rather than assume it has landed.
        let stillRegistered = true;
        for (let attempt = 0; attempt < 50 && stillRegistered; attempt += 1) {
          yield* Effect.sleep(100).pipe(TestClock.withLive);
          stillRegistered = yield* adapter.hasSession(threadId);
        }
        assert.isFalse(stillRegistered);
        assert.deepStrictEqual(yield* adapter.listSessions(), []);
      }),
    ),
  );

  it.effect("closes the Cline child process when a session stops", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const exitLogPath = yield* scopedTempPath("t3code-cline-stop-", "exit.log");
        const binaryPath = yield* writeFakeClineCli({ env: { T3_ACP_EXIT_LOG_PATH: exitLogPath } });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        const threadId = ThreadId.make("cline-stop");
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        yield* adapter.stopSession(threadId);
        assert.isFalse(yield* adapter.hasSession(threadId));
        assert.match(yield* readFileIfPresent(exitLogPath), /SIGTERM|exit:/);
      }),
    ),
  );

  it.effect("does not leave a Cline process running when a startup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const exitLogPath = yield* scopedTempPath("t3code-cline-failstart-", "exit.log");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_EXIT_LOG_PATH: exitLogPath, T3_ACP_EMPTY_MODEL_CATALOG: "1" },
        });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        const threadId = ThreadId.make("cline-fail-start");
        // The catalog check fails after the process is already running, so this
        // is the path that would leak a Cline child if the scope were
        // transferred too early.
        yield* adapter
          .startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" })
          .pipe(Effect.ignore);
        assert.isFalse(yield* adapter.hasSession(threadId));
        assert.match(yield* readFileIfPresent(exitLogPath), /SIGTERM|exit:/);
      }),
    ),
  );

  it.effect("reports a spawn failure without pretending a session exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({
          providers: { cline: { binaryPath: "/definitely/missing/cline" } },
        });
        const threadId = ThreadId.make("cline-missing-binary");
        const error = yield* adapter
          .startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" })
          .pipe(Effect.flip);
        assert.isTrue(
          error._tag === "ProviderAdapterProcessError" ||
            error._tag === "ProviderAdapterRequestError",
        );
        assert.isFalse(yield* adapter.hasSession(threadId));
      }),
    ),
  );

  it.effect("answers only the first response to a pending approval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-double-approval");
        const binaryPath = yield* writeFakeClineCli({ env: { T3_ACP_EMIT_TOOL_CALLS: "1" } });
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        });
        const opened = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "request.opened"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        const send = yield* adapter
          .sendTurn({ threadId, input: "run something", attachments: [] })
          .pipe(Effect.forkChild);
        const [request] = yield* Fiber.join(opened);
        assert.isDefined(request);
        const requestId = ApprovalRequestId.make(
          (request as Extract<ProviderRuntimeEvent, { readonly type: "request.opened" }>)
            .requestId ?? "unknown",
        );
        yield* adapter.respondToRequest(threadId, requestId, "accept");
        const second = yield* adapter
          .respondToRequest(threadId, requestId, "decline")
          .pipe(Effect.flip);
        assert.strictEqual(second._tag, "ProviderAdapterRequestError");
        yield* Fiber.join(send);
        yield* adapter.stopSession(threadId);
      }).pipe(TestClock.withLive),
    ),
  );

  it.effect("reports rollback and structured user input as unsupported", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-unsupported-ops");
        const binaryPath = yield* writeFakeClineCli();
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });

        assert.isFalse(adapter.capabilities.supportsConversationRollback);
        const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
        assert.strictEqual(rollback._tag, "ProviderAdapterRequestError");
        const invalid = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.flip);
        assert.strictEqual(invalid._tag, "ProviderAdapterValidationError");

        const userInput = yield* adapter
          .respondToUserInput(threadId, ApprovalRequestId.make("req-1"), {})
          .pipe(Effect.flip);
        assert.strictEqual(userInput._tag, "ProviderAdapterRequestError");
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("does not retain prompt bodies in the adapter thread snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* ClineAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cline-snapshot");
        const binaryPath = yield* writeFakeClineCli();
        yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
        yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
        const marker = "PRIVATE-MARKER".repeat(5_000);
        yield* adapter.sendTurn({ threadId, input: marker, attachments: [] });
        // Cline owns the durable conversation, so the adapter keeps only turn
        // identity rather than duplicating unbounded history in memory.
        const snapshot = yield* adapter.readThread(threadId);
        assert.isNotEmpty(snapshot.turns);
        assert.deepStrictEqual(
          snapshot.turns.flatMap((turn) => turn.items),
          [],
        );
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("stops every session when the adapter shuts down", () =>
    Effect.gen(function* () {
      const exitLogPath = yield* scopedTempPath("t3code-cline-stopall-", "exit.log");
      const binaryPath = yield* writeFakeClineCli({ env: { T3_ACP_EXIT_LOG_PATH: exitLogPath } });
      const settings = yield* ServerSettingsService;
      yield* settings.updateSettings({ providers: { cline: { binaryPath } } });
      const resolveSettings = yield* makeResolveClineSettings;
      // Scoped here rather than taken from the shared test layer: the claim
      // under test is what happens when the adapter's scope closes, and the
      // layer's scope outlives the test body.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeClineAdapter(decodeClineSettings({}), { resolveSettings });
          const first = ThreadId.make("cline-stopall-a");
          const second = ThreadId.make("cline-stopall-b");
          yield* adapter.startSession({
            threadId: first,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          yield* adapter.startSession({
            threadId: second,
            cwd: process.cwd(),
            runtimeMode: "full-access",
          });
          const active = new Set(
            (yield* adapter.listSessions()).map((session) => session.threadId),
          );
          assert.isTrue(active.has(first));
          assert.isTrue(active.has(second));
        }),
      );
      // Closing that scope is the server shutdown path: both Cline children have
      // to go with it, or each surviving one shows up as a missing exit.
      const exitLog = yield* readFileIfPresent(exitLogPath);
      assert.strictEqual(exitLog.split("exit:").length - 1, 2, exitLog);
    }),
  );
});
