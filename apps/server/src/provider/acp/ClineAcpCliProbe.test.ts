/**
 * Opt-in probe against the real Cline CLI.
 *
 * Skipped unless `T3_CLINE_ACP_PROBE=1`. Two things to know before enabling it:
 *
 * - `cline --acp` needs credentials before `session/new`. Sign in with
 *   `cline auth` first, or export `CLINE_API_KEY`. T3 Code deliberately never
 *   calls ACP `authenticate` itself, because Cline's implementation starts a
 *   device-code OAuth flow, prints the URL to stderr and then blocks — on a
 *   server that browser opens on the wrong machine.
 * - The probe reads the advertised model catalog and switches to a model that
 *   is already current, so it costs nothing and changes no account state.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClineSettings, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  applyClineAcpModelSelection,
  clineModelsFromSessionSetup,
  clineSupportsRuntimeMode,
  currentClineModelIdFromSessionSetup,
  findClineModelConfigOption,
  makeClineAcpRuntime,
} from "./ClineAcpSupport.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);
const enabled = process.env.T3_CLINE_ACP_PROBE === "1";
const runtimeMode: RuntimeMode = "full-access";

const probeLayer = it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3code-cline-probe-test-" }).pipe(
    Layer.provideMerge(NodeServices.layer),
  ),
);

const makeProbeRuntime = Effect.fn("makeProbeRuntime")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeClineAcpRuntime({
    clineSettings: decodeClineSettings({ enabled: true }),
    childProcessSpawner: spawner,
    cwd: process.cwd(),
    environment: process.env,
    clientInfo: { name: "t3-code-cline-probe", version: "0.0.0" },
  });
});

describe.runIf(enabled)("Cline ACP CLI probe", () => {
  probeLayer((it) => {
    it.effect("initializes and creates a session against the real cline --acp", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const acp = yield* makeProbeRuntime();
          const started = yield* acp.start();
          assert.isString(started.sessionId);
          assert.strictEqual(started.initializeResult.agentInfo?.name, "cline");
          assert.isTrue(started.initializeResult.agentCapabilities?.loadSession === true);
          // Cline advertises OAuth-only auth methods, none of them usable
          // headlessly; T3 must not be selecting one.
          assert.deepStrictEqual(
            (started.initializeResult.authMethods ?? []).map((method) => method.id),
            ["cline", "cline-pass", "openai-codex"],
          );
        }),
      ),
    );

    it.effect("advertises an ACP model catalog and a model config option", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const acp = yield* makeProbeRuntime();
          const started = yield* acp.start();
          const models = clineModelsFromSessionSetup(started.sessionSetupResult);
          assert.isAbove(models.length, 0, "Cline advertised no models; is the CLI signed in?");
          // The provider picker is tagged `category: "model"` too, so the
          // literal `model` id is the only safe lookup.
          const option = findClineModelConfigOption(started.sessionSetupResult.configOptions);
          assert.strictEqual(option?.id, "model");
          const current = currentClineModelIdFromSessionSetup(started.sessionSetupResult);
          assert.isDefined(current, "Cline advertised no current model");
        }),
      ),
    );

    it.effect("succeeds on a no-op model selection against the live catalog", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const acp = yield* makeProbeRuntime();
          const started = yield* acp.start();
          const requested = currentClineModelIdFromSessionSetup(started.sessionSetupResult);
          assert.isDefined(requested);
          yield* applyClineAcpModelSelection({
            runtime: acp,
            requestedModelId: requested,
            mapError: (cause) =>
              new ProviderAdapterRequestError({
                provider: "cline" as never,
                method: "session/set_config_option",
                detail: cause.message,
              }),
          });
        }),
      ),
    );

    it.effect("refuses an access mode Cline's approval switch cannot enforce", () =>
      Effect.gen(function* () {
        // Cheap, credential-free invariant: it holds whether or not a CLI is
        // installed, so it needs no opt-in to be worth checking live.
        assert.isFalse(clineSupportsRuntimeMode("auto"));
        assert.isFalse(clineSupportsRuntimeMode("auto-accept-edits"));
        assert.isTrue(clineSupportsRuntimeMode("approval-required"));
        assert.isTrue(clineSupportsRuntimeMode("full-access"));
        const fs = yield* FileSystem.FileSystem;
        assert.isTrue(yield* fs.exists(process.cwd()));
        assert.strictEqual(runtimeMode, "full-access");
      }),
    );
  });
});
