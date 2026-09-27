// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ClineSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { buildInitialClineProviderSnapshot, checkClineProviderStatus } from "./ClineProvider.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");

/**
 * A stand-in for the Cline CLI: `--version` prints a version and exits, and
 * `--acp` execs the mock ACP agent so session setup answers like Cline's.
 */
const writeFakeClineCli = (input?: {
  readonly env?: Record<string, string>;
  readonly version?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-cline-probe-" });
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

/**
 * Whether a pid is still running. Signal 0 performs the permission and
 * existence check without delivering anything, so a child that is gone reports
 * ESRCH instead of being probed.
 */
const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

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

const checkLayer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cline-provider-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);

checkLayer("checkClineProviderStatus", (it) => {
  it.effect("reports a disabled provider without touching the CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkClineProviderStatus(
        decodeClineSettings({ enabled: false, binaryPath: "/definitely/missing/cline" }),
        {},
      );
      assert.strictEqual(snapshot.enabled, false);
      assert.isFalse(snapshot.installed);
      assert.strictEqual(snapshot.message, "Cline is disabled in T3 Code settings.");
    }),
  );

  it.effect("reports a missing custom binary without stock install advice", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkClineProviderStatus(
        decodeClineSettings({ enabled: true, binaryPath: "/definitely/missing/cline" }),
        {},
      );
      assert.isFalse(snapshot.installed);
      assert.strictEqual(snapshot.status, "error");
      const message = snapshot.message ?? "";
      assert.match(message, /not installed or not on PATH/);
      // The configured path is what is missing, so `npm install -g cline` would
      // send the user after a package they never configured.
      assert.match(message, /definitely\/missing\/cline/);
      assert.notMatch(message, /npm install -g cline/);
    }),
  );

  it.effect("tells an unauthenticated custom binary to authenticate that binary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUIRE_AUTHENTICATION: "1" },
        });
        const snapshot = yield* checkClineProviderStatus(
          decodeClineSettings({ enabled: true, binaryPath }),
          {},
        );
        assert.strictEqual(snapshot.status, "warning");
        // The instruction has to name the command the user configured.
        assert.strictEqual(
          snapshot.message,
          `Cline CLI is installed but not signed in. Run \`${binaryPath} auth\`.`,
        );
      }),
    ),
  );

  it.effect("detects the installed CLI, its version and its model catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeClineCli();
        const snapshot = yield* checkClineProviderStatus(
          decodeClineSettings({ enabled: true, binaryPath }),
          {},
        );
        assert.isTrue(snapshot.installed);
        assert.strictEqual(snapshot.version, "3.0.65");
        assert.strictEqual(snapshot.status, "ready");
        assert.deepStrictEqual(snapshot.auth, { status: "authenticated" });
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          ["anthropic/claude-sonnet-5", "qwen/qwen3.8-max-prime", "aion-labs/aion-3.5"],
        );
        // The session's current selection is what the model picker marks default.
        assert.isTrue(snapshot.models.some((model) => model.isDefault === true));
      }),
    ),
  );

  it.effect("surfaces an unauthenticated CLI with a `cline auth` instruction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUIRE_AUTHENTICATION: "1" },
        });
        const snapshot = yield* checkClineProviderStatus(
          decodeClineSettings({ enabled: true, binaryPath }),
          {},
        );
        assert.isTrue(snapshot.installed);
        assert.strictEqual(snapshot.status, "warning");
        assert.deepStrictEqual(snapshot.auth, { status: "unauthenticated" });
        // No configured path, so the stock command is the one to authenticate.
        assert.match(snapshot.message ?? "", /not signed in\. Run `.*cline auth`\./);
        // An unauthenticated CLI has no usable catalog, so no model is invented.
        assert.deepStrictEqual(snapshot.models, []);
      }),
    ),
  );

  it.effect("reports an empty model catalog instead of inventing models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* writeFakeClineCli({ env: { T3_ACP_EMPTY_MODEL_CATALOG: "1" } });
        const snapshot = yield* checkClineProviderStatus(
          decodeClineSettings({ enabled: true, binaryPath }),
          {},
        );
        assert.strictEqual(snapshot.status, "error");
        assert.deepStrictEqual(snapshot.auth, { status: "authenticated" });
        assert.match(snapshot.message ?? "", /did not advertise any usable models/);
        assert.deepStrictEqual(snapshot.models, []);
      }),
    ),
  );

  // Live clock: the startup deadline is wall-clock, and a test clock would
  // never advance it.
  it.effect("gives up on a hung ACP startup and force-kills the probe child", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitLogPath = yield* scopedTempPath("t3code-cline-probe-hang-", "exit.log");
        const binaryPath = yield* writeFakeClineCli({
          env: {
            T3_ACP_HANG_INITIALIZE_FOREVER: "1",
            T3_ACP_IGNORE_SIGTERM: "1",
            T3_ACP_EXIT_LOG_PATH: exitLogPath,
          },
        });
        const snapshot = yield* checkClineProviderStatus(
          decodeClineSettings({ enabled: true, binaryPath }),
          {},
        );
        assert.strictEqual(snapshot.status, "error");
        // A startup deadline is not a sign-in problem, so Settings must not
        // send the user to `cline auth`.
        assert.deepStrictEqual(snapshot.auth, { status: "unknown" });
        assert.match(snapshot.message ?? "", /ACP startup/);
        assert.deepStrictEqual(snapshot.models, []);
        // The child this probe owned was terminated rather than left running.
        // The mock ignores SIGTERM and a SIGKILL cannot be logged from inside
        // the process, so the log proves only that the grace path was tried;
        // the pid proves the escalation actually removed the child.
        const exitLog = yield* readFileIfPresent(exitLogPath);
        assert.match(exitLog, /SIGTERM/);
        const pid = Number(/pid:(\d+)/.exec(exitLog)?.[1]);
        assert.isTrue(Number.isInteger(pid), exitLog);
        assert.isFalse(isProcessAlive(pid), `probe child ${pid} survived the force-kill`);
      }),
    ).pipe(TestClock.withLive),
  );

  it.effect("never sends an authenticate request, so no OAuth flow can start", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestLogPath = yield* scopedTempPath("t3code-cline-probe-log-", "requests.ndjson");
        const binaryPath = yield* writeFakeClineCli({
          env: { T3_ACP_REQUEST_LOG_PATH: requestLogPath },
        });
        yield* checkClineProviderStatus(decodeClineSettings({ enabled: true, binaryPath }), {});
        const logged = yield* readFileIfPresent(requestLogPath);
        // `cline --acp`'s authenticate prints a device-code URL to stderr and
        // blocks forever; on a T3 server that browser opens on the wrong machine.
        assert.isFalse(logged.includes('"authenticate"'));
        assert.isTrue(logged.includes('"session/new"'));
      }),
    ),
  );

  it.effect("does not leak an ACP process when the probe finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitLogPath = yield* scopedTempPath("t3code-cline-probe-exit-", "exit.log");
        const binaryPath = yield* writeFakeClineCli({ env: { T3_ACP_EXIT_LOG_PATH: exitLogPath } });
        yield* checkClineProviderStatus(decodeClineSettings({ enabled: true, binaryPath }), {});
        const exitLog = yield* readFileIfPresent(exitLogPath);
        // The probe owns the child in a scope that closes with the check.
        assert.isNotEmpty(exitLog);
        assert.match(exitLog, /SIGTERM|exit:/);
      }),
    ),
  );
});

const initialSnapshotLayer = it.layer(NodeServices.layer);

initialSnapshotLayer("buildInitialClineProviderSnapshot", (it) => {
  it.effect("starts in a checking state with no models", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialClineProviderSnapshot(
        decodeClineSettings({ enabled: true }),
      );
      assert.strictEqual(snapshot.status, "warning");
      assert.isTrue(snapshot.installed);
      assert.deepStrictEqual(snapshot.models, []);
      assert.strictEqual(snapshot.message, "Checking Cline CLI availability...");
    }),
  );

  it.effect("advertises the capability limits the Cline ACP build imposes", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialClineProviderSnapshot(
        decodeClineSettings({ enabled: true }),
      );
      // Clients gate the access-mode picker and the attachment picker on these,
      // so a mismatch here is what makes the UI offer what the agent cannot do.
      assert.deepStrictEqual(snapshot.supportedRuntimeModes, ["approval-required", "full-access"]);
      assert.strictEqual(snapshot.supportsImageAttachments, false);
      assert.strictEqual(snapshot.showInteractionModeToggle, false);
      assert.strictEqual(snapshot.supportsTextGeneration, false);
    }),
  );
});
