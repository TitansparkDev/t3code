import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_SERVERS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

/** Return the discovered servers owned by one thread's terminal sessions. */
export function useThreadDevServers(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const query = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : previewEnvironment.discoveredServers({
          environmentId: input.environmentId,
          input: {},
        }),
  );
  const servers = query.data?.servers ?? EMPTY_SERVERS;
  return useMemo(
    () =>
      input.threadId === null
        ? EMPTY_SERVERS
        : servers.filter((server) => server.terminal?.threadId === input.threadId),
    [input.threadId, servers],
  );
}
