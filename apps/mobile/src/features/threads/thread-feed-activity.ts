import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export function isThreadFeedActivityCurrent(status: EnvironmentThreadStatus | undefined): boolean {
  return status === undefined || status === "live";
}
