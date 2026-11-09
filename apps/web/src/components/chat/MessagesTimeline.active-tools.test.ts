import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { WorkLogEntry } from "../../session-logic";
import { deriveMessagesTimelineRows, liveWorkEntryLabel } from "./MessagesTimeline.logic";

describe("long active tool groups", () => {
  it.each([false, true])(
    "preserves chronological order and the latest activity, expanded=%s",
    (expanded) => {
      const runId = RunId.make("long-active-run");
      const createdAt = "2026-10-12T00:00:00Z";
      const timelineEntries = Array.from({ length: 1_000 }, (_, index) => ({
        id: `work-entry-${index}`,
        kind: "work" as const,
        createdAt,
        entry: {
          id: `work-${index}`,
          createdAt,
          runId,
          label: `Tool ${index}`,
          tone: index % 2 === 0 ? ("thinking" as const) : ("tool" as const),
          itemType: index % 2 === 0 ? ("reasoning" as const) : ("command_execution" as const),
          ...(index % 2 === 0 ? { detail: `Thought ${index}` } : {}),
          toolLifecycleStatus: index === 999 ? ("inProgress" as const) : ("completed" as const),
        },
      }));
      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: true,
        runningRunId: runId,
        activeTurnStartedAt: createdAt,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
        expandedWorkGroupIds: new Set(expanded ? ["work-group:work-entry-0"] : []),
      });
      const live = rows.find((row) => row.kind === "work-live");
      expect(live).toBeDefined();
      expect(live?.entry.id).toBe("work-999");
      expect(live && liveWorkEntryLabel(live.entry, undefined, live.active)).toContain("999");
      expect(live?.thought?.id).toBe("work-998");
      expect(live?.groupedEntries.map(({ id }) => id)).toEqual(
        timelineEntries.map(({ entry }) => entry.id),
      );
      expect(live?.groupId).toBe("work-group:work-entry-0");
      const details = rows.filter((row) => row.kind === "work");
      expect(details).toHaveLength(expanded ? 1 : 0);
      if (expanded) {
        expect(details[0]?.groupedEntries).toEqual(live?.groupedEntries);
      }
    },
  );
});

describe("activity history beside a live tail", () => {
  const runId = RunId.make("history-run");
  const createdAt = "2026-10-12T00:00:00Z";
  const work = (id: string, entry: Partial<WorkLogEntry>): WorkLogEntry => ({
    id,
    createdAt,
    runId,
    label: id,
    tone: "tool",
    toolLifecycleStatus: "completed",
    ...entry,
  });
  const history = [
    work("thought-1", { tone: "thinking", itemType: "reasoning", detail: "Looking around" }),
    work("view-1", { itemType: "dynamic_tool", toolTitle: "View file", label: "View file" }),
    work("cmd-1", { itemType: "command_execution", command: "ls", label: "Ran ls" }),
    work("sub-1", { itemType: "subagent", label: "Subagent batch" }),
    work("cmd-err", {
      itemType: "command_execution",
      command: "false",
      label: "Ran false",
      toolLifecycleStatus: "failed",
    }),
  ];
  const timelineOf = (entries: ReadonlyArray<WorkLogEntry>) =>
    entries.map((entry) => ({ id: `${entry.id}-entry`, kind: "work" as const, createdAt, entry }));
  const derive = (input: {
    readonly entries: ReadonlyArray<WorkLogEntry>;
    readonly working: boolean;
    readonly expandedRunIds?: ReadonlySet<RunId>;
    readonly expandedWorkGroupIds?: ReadonlySet<string>;
  }) =>
    deriveMessagesTimelineRows({
      timelineEntries: timelineOf(input.entries),
      isWorking: input.working,
      runningRunId: input.working ? runId : null,
      latestRun: {
        runId,
        status: input.working ? "running" : "completed",
        startedAt: createdAt,
        completedAt: input.working ? null : createdAt,
      },
      activeTurnStartedAt: createdAt,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      ...(input.expandedRunIds ? { expandedRunIds: input.expandedRunIds } : {}),
      ...(input.expandedWorkGroupIds ? { expandedWorkGroupIds: input.expandedWorkGroupIds } : {}),
    });

  it("labels a finished latest tool in past tense while the turn keeps running", () => {
    const entries = [
      ...history,
      work("cmd-2", { itemType: "command_execution", command: "pwd", label: "Ran pwd" }),
    ];
    const live = derive({ entries, working: true }).find((row) => row.kind === "work-live");
    expect(live).toMatchObject({ active: true, groupedEntries: entries.map((entry) => entry) });
    expect(
      live?.kind === "work-live" && liveWorkEntryLabel(live.entry, undefined, live.active),
    ).toBe("Ran pwd");

    const running = entries.map((entry) =>
      entry.id === "cmd-2" ? { ...entry, toolLifecycleStatus: "inProgress" as const } : entry,
    );
    const runningLive = derive({ entries: running, working: true }).find(
      (row) => row.kind === "work-live",
    );
    expect(
      runningLive?.kind === "work-live" && liveWorkEntryLabel(runningLive.entry, undefined, true),
    ).toBe("Running pwd");
  });

  it("keeps every settled entry reachable through a counted, expandable group", () => {
    const settled = [
      ...history,
      work("cmd-2", { itemType: "command_execution", command: "pwd", label: "Ran pwd" }),
    ];
    const collapsed = derive({ entries: settled, working: false });
    const turnFold = collapsed.find((row) => row.kind === "turn-fold");
    expect(turnFold).toMatchObject({ expanded: false });
    expect(collapsed.some((row) => row.kind === "work-toggle")).toBe(false);

    const expandedRows = derive({
      entries: settled,
      working: false,
      expandedRunIds: new Set([runId]),
    });
    const toggle = expandedRows.find((row) => row.kind === "work-toggle");
    // The group reports the latest tool's failure only; the earlier failed command stays in its count.
    expect(toggle).toMatchObject({
      expanded: false,
      hasFailure: false,
      hiddenCount: settled.length,
      summary: "Used 2 tools and ran 3 commands",
    });
    const groupId = toggle?.kind === "work-toggle" ? toggle.groupId : "";

    const openGroup = derive({
      entries: settled,
      working: false,
      expandedRunIds: new Set([runId]),
      expandedWorkGroupIds: new Set([groupId]),
    });
    const details = openGroup.find((row) => row.kind === "work" && row.isExpandedToolGroup);
    expect(details?.kind === "work" && details.groupedEntries.map((entry) => entry.id)).toEqual(
      settled.map((entry) => entry.id),
    );
  });
});
