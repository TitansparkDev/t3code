import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ChatAgentsSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkChatAgentsProviderStatus } from "./ChatAgentsProvider.ts";

const decodeSettings = Schema.decodeSync(ChatAgentsSettings);

it.layer(Layer.merge(NodeServices.layer, NodeHttpClient.layerUndici))(
  "checkChatAgentsProviderStatus",
  (it) => {
    it.effect("is off until it is switched on, with W's paths already filled in", () =>
      Effect.gen(function* () {
        const settings = decodeSettings({});
        assert.isFalse(settings.enabled);
        assert.strictEqual(
          settings.workerPath,
          "/srv/chatagents-w/deploy/current/desktop/chatgpt_worker_w.py",
        );
        const snapshot = yield* checkChatAgentsProviderStatus(settings);
        assert.strictEqual(snapshot.status, "disabled");
        assert.strictEqual(snapshot.models[0]?.slug, "chatgpt-desktop");
      }),
    );

    it.effect("names the missing worker and Python instead of failing on the first turn", () =>
      Effect.gen(function* () {
        const snapshot = yield* checkChatAgentsProviderStatus(
          decodeSettings({
            enabled: true,
            workerPath: "/definitely/missing/worker.py",
            pythonPath: "/definitely/missing/python",
          }),
        );
        assert.strictEqual(snapshot.status, "error");
        assert.isFalse(snapshot.installed);
        assert.match(snapshot.message ?? "", /missing\/worker\.py/);
        assert.match(snapshot.message ?? "", /missing\/python/);
      }),
    );
  },
);
