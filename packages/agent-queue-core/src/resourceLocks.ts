// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Exclusive access to named shared resources (a GPU, an emulator, a fixed database name,
 * a package install). This is now a thin door onto the machine-wide broker (resourceBroker.ts),
 * so the server's own checks, a worker's `agentq run` and a deferred job all wait in the same
 * fair queue, under the same memory admission, over the same lock files.
 *
 * @module resourceLocks
 */
import { withBrokerResources } from "./resourceRunner.ts";

/** Runs `body` while holding every named resource. `lockDir` is accepted for older callers and ignored. */
export async function withResources<A>(
  resources: ReadonlyArray<string>,
  body: () => Promise<A>,
  _lockDir?: string,
  waitMs = 3 * 3600_000,
  context: { readonly label?: string; readonly ownerRef?: string; readonly repo?: string } = {},
): Promise<A> {
  return withBrokerResources(resources, () => body(), { waitMs, ...context });
}
