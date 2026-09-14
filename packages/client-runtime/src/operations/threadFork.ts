import { type ThreadForkInput, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  type EnvironmentRpcUnavailableError,
  request,
} from "../rpc/client.ts";

export type ForkThreadInput = ThreadForkInput;

type ForkThreadTag = typeof WS_METHODS.threadsFork;
export type ForkThreadEffect = Effect.Effect<
  EnvironmentRpcSuccess<ForkThreadTag>,
  EnvironmentRpcFailure<ForkThreadTag> | EnvironmentRpcUnavailableError,
  EnvironmentSupervisor
>;

export const forkThread: (input: ThreadForkInput) => ForkThreadEffect = Effect.fn(
  "EnvironmentOperations.forkThread",
)(function* (input) {
  return yield* request(WS_METHODS.threadsFork, input);
});
