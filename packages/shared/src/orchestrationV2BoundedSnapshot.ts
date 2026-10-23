import type {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";

const CACHED_THREAD_ITEM_LIMIT = 75;
const CACHED_THREAD_BYTE_LIMIT = 1024 * 1024;
const CACHED_TOOL_OUTPUT_LIMIT = 16 * 1024;

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function compactCachedTurnItem(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" && item.type !== "dynamic_tool") return item;
  const output = item.output;
  if (output === undefined) return item;
  let bytes: number;
  try {
    bytes = new TextEncoder().encode(
      typeof output === "string" ? output : (JSON.stringify(output) ?? ""),
    ).byteLength;
  } catch {
    bytes = CACHED_TOOL_OUTPUT_LIMIT + 1;
  }
  return bytes <= CACHED_TOOL_OUTPUT_LIMIT
    ? item
    : { ...item, output: undefined, outputOmitted: true };
}

function isLocalTimelineRow(
  projection: Pick<OrchestrationV2ThreadProjection, "thread">,
  row: OrchestrationV2ProjectedTurnItem,
): boolean {
  return row.visibility === "local" || row.sourceThreadId === projection.thread.id;
}

export function omitLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection | null {
  let omitted = 0;
  for (const row of projection.visibleTurnItems) {
    if (!isLocalTimelineRow(projection, row)) continue;
    // Same object, not merely the same id: restoring from the row must
    // reproduce the original entry exactly.
    if (projection.turnItems[omitted] !== row.item) return null;
    omitted += 1;
  }
  if (omitted === 0) return null;
  return { ...projection, turnItems: projection.turnItems.slice(omitted) };
}

/**
 * Client half: call on a decoded snapshot that carries the
 * `turnItemsOmitLocalVisible` marker, before reducers or caches see it.
 */
export function restoreLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const local = projection.visibleTurnItems
    .filter((row) => isLocalTimelineRow(projection, row))
    .map((row) => row.item);
  if (local.length === 0) return projection;
  return { ...projection, turnItems: [...local, ...projection.turnItems] };
}

export function boundedSnapshotProjection(snapshot: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly turnItemsOmitLocalVisible?: true | undefined;
}): OrchestrationV2ThreadProjection {
  return snapshot.turnItemsOmitLocalVisible === true
    ? restoreLocalVisibleTurnItems(snapshot.projection)
    : snapshot.projection;
}

/** Builds a display-only cache window; its old paging cursor cannot describe the trimmed rows. */
export function boundedCachedThreadSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
):
  | OrchestrationV2ThreadDetailSnapshot
  | (OrchestrationV2ThreadDetailSnapshot & { readonly requiresSnapshot: true })
  | null {
  const { projection } = snapshot;
  const visible = projection.visibleTurnItems;
  const initialStart = Math.max(0, visible.length - CACHED_THREAD_ITEM_LIMIT);
  const latestRunId = projection.runs.at(-1)?.id;

  for (let start = initialStart; start <= visible.length; start += 1) {
    const rows = visible.slice(start).map((row, position) => ({
      ...row,
      position,
      item: compactCachedTurnItem(row.item),
    }));
    const runIds = new Set<string>([
      ...rows.flatMap((row) => (row.item.runId === null ? [] : [row.item.runId])),
      ...projection.runs
        .filter(
          (run) =>
            run.status === "preparing" || run.status === "starting" || run.status === "running",
        )
        .map((run) => run.id),
      ...(latestRunId === undefined ? [] : [latestRunId]),
    ]);
    const runs = projection.runs.filter((run) => runIds.has(run.id));
    for (const run of runs) runIds.add(run.id);
    const attempts = projection.attempts.filter((attempt) => runIds.has(attempt.runId));
    const nodeIds = new Set<string>([
      ...rows.flatMap((row) => (row.item.nodeId === null ? [] : [row.item.nodeId])),
      ...attempts.map((attempt) => attempt.rootNodeId),
    ]);
    const nodes = projection.nodes.filter(
      (node) => runIds.has(node.runId ?? "") || nodeIds.has(node.id),
    );
    for (const node of nodes) nodeIds.add(node.id);
    const providerThreadIds = new Set<string>(
      [
        ...rows.map((row) => row.item.providerThreadId),
        ...runs.map((run) => run.providerThreadId),
        ...attempts.map((attempt) => attempt.providerThreadId),
        ...nodes.map((node) => node.providerThreadId),
      ].filter(isPresent),
    );
    const providerTurnIds = new Set<string>([
      ...rows.flatMap((row) => (row.item.providerTurnId === null ? [] : [row.item.providerTurnId])),
      ...attempts.flatMap((attempt) =>
        attempt.providerTurnId === null ? [] : [attempt.providerTurnId],
      ),
      ...nodes.flatMap((node) => (node.providerTurnId === null ? [] : [node.providerTurnId])),
    ]);
    const runtimeRequests = projection.runtimeRequests.filter(
      (request) => request.status === "pending" || nodeIds.has(request.nodeId),
    );
    const messageIds = new Set<string>([
      ...rows.flatMap((row) =>
        row.item.type === "user_message" || row.item.type === "assistant_message"
          ? [row.item.messageId]
          : [],
      ),
      ...runs.map((run) => run.userMessageId),
    ]);
    const checkpointIds = new Set<string>([
      ...runs.flatMap((run) => (run.checkpointId === null ? [] : [run.checkpointId])),
      ...rows.flatMap((row) => (row.item.type === "checkpoint" ? [row.item.checkpointId] : [])),
    ]);
    const planIds = new Set<string>([
      ...rows.flatMap((row) =>
        row.item.type === "proposed_plan" || row.item.type === "todo_list" ? [row.item.planId] : [],
      ),
      ...runs.flatMap((run) => (run.sourcePlanRef === undefined ? [] : [run.sourcePlanRef.planId])),
    ]);
    const contextHandoffIds = new Set<string>([
      ...runs.flatMap((run) => (run.contextHandoffId === null ? [] : [run.contextHandoffId])),
      ...rows.flatMap((row) => (row.item.type === "handoff" ? [row.item.contextHandoffId] : [])),
    ]);
    const rowItems = new Set(rows.map((row) => row.item.id));
    const compactItems = new Map(rows.map((row) => [row.item.id, row.item]));
    const turnItems = projection.turnItems.flatMap((item) => {
      const compact = compactItems.get(item.id);
      return rowItems.has(item.id) && compact !== undefined ? [compact] : [];
    });
    const nextProjection = {
      ...projection,
      runs,
      attempts,
      nodes,
      subagents: projection.subagents.filter((subagent) => nodeIds.has(subagent.id)),
      providerThreads: projection.providerThreads.filter((thread) =>
        providerThreadIds.has(thread.id),
      ),
      providerTurns: projection.providerTurns.filter((turn) => providerTurnIds.has(turn.id)),
      runtimeRequests,
      messages: projection.messages.filter((message) => messageIds.has(message.id)),
      plans: projection.plans.filter((plan) => planIds.has(plan.id)),
      turnItems,
      checkpointScopes: projection.checkpointScopes.filter((scope) =>
        nodes.some((node) => node.checkpointScopeId === scope.id),
      ),
      checkpoints: projection.checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id)),
      contextHandoffs: projection.contextHandoffs.filter((handoff) =>
        contextHandoffIds.has(handoff.id),
      ),
      visibleTurnItems: rows,
    };
    const trimmed =
      start > 0 ||
      rows.some(
        (row, index) =>
          row.position !== visible[index]?.position || row.item !== visible[index]?.item,
      ) ||
      runs.length !== projection.runs.length ||
      attempts.length !== projection.attempts.length ||
      nodes.length !== projection.nodes.length ||
      nextProjection.subagents.length !== projection.subagents.length ||
      nextProjection.providerThreads.length !== projection.providerThreads.length ||
      nextProjection.providerTurns.length !== projection.providerTurns.length ||
      runtimeRequests.length !== projection.runtimeRequests.length ||
      nextProjection.messages.length !== projection.messages.length ||
      nextProjection.plans.length !== projection.plans.length ||
      turnItems.length !== projection.turnItems.length ||
      nextProjection.checkpointScopes.length !== projection.checkpointScopes.length ||
      nextProjection.checkpoints.length !== projection.checkpoints.length ||
      nextProjection.contextHandoffs.length !== projection.contextHandoffs.length;
    const result = trimmed
      ? {
          snapshotSequence: snapshot.snapshotSequence,
          projection: nextProjection,
          requiresSnapshot: true as const,
        }
      : snapshot;
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= CACHED_THREAD_BYTE_LIMIT) {
      return result;
    }
  }

  return null;
}
