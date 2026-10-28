import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-background"
  | "application-active-probe"
  | "application-active-reconnect"
  | "native-wake"
  | "application-active-long"
  | "credentials-changed"
  | "network-changed";

function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect" ||
    reason === "application-active-long"
  );
}

export function resetsRetryBackoff(reason: ConnectionWakeup): boolean {
  return (
    isApplicationActiveWakeup(reason) || reason === "native-wake" || reason === "network-changed"
  );
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-long" ||
    reason === "native-wake"
  );
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
