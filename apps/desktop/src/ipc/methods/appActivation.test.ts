import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import { setReady } from "./appActivation.ts";

describe("desktop app activation IPC", () => {
  it.effect("forwards the sender renderer id when it becomes ready", () => {
    const calls: Array<{ readonly ready: boolean; readonly rendererId: number | undefined }> = [];
    const layer = Layer.succeed(DesktopAppActivation.DesktopAppActivation, {
      start: Effect.die("unexpected start"),
      setRendererReady: (ready, rendererId) =>
        Effect.sync(() => {
          calls.push({ ready, rendererId });
        }),
      complete: () => Effect.void,
    } satisfies DesktopAppActivation.DesktopAppActivation["Service"]);

    return Effect.gen(function* () {
      yield* setReady.handler(true, { sender: { id: 42 } });

      assert.deepEqual(calls, [{ ready: true, rendererId: 42 }]);
    }).pipe(Effect.provide(layer));
  });
});
