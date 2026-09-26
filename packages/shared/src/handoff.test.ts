import { EventId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  HANDOFF_ACTIVITY_KIND,
  buildHandoffActivity,
  buildHandoffDocument,
  buildHandoffPrompt,
  decodeHandoffActivityPayload,
  resolveHandoffLineage,
} from "./handoff.ts";

const thread = {
  id: ThreadId.make("source-thread"),
  projectId: ProjectId.make("project-1"),
  title: "Fix remote handoff",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "feature/handoff",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-28T10:00:00.000Z",
  updatedAt: "2026-08-28T10:02:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  pinOrderKey: null,
  titleRegeneration: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text: "Make the handoff deterministic.",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-28T10:01:00.000Z",
      updatedAt: "2026-08-28T10:01:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  pullRequests: [],
};

describe("handoff", () => {
  it("builds stable markdown from persisted thread data", () => {
    const document = buildHandoffDocument({
      thread,
      project: {
        id: ProjectId.make("project-1"),
        title: "OmniCode",
        workspaceRoot: "/workspace/app",
      },
    });

    expect(document).toContain("# T3 Code handoff");
    expect(document).toContain("Read `HANDOFF.md` from the current checkout");
    expect(document).toContain("Make the handoff deterministic.");
    expect(document.endsWith("\n")).toBe(true);
    expect(
      buildHandoffDocument({
        thread,
        project: {
          id: ProjectId.make("project-1"),
          title: "OmniCode",
          workspaceRoot: "/workspace/app",
        },
      }),
    ).toBe(document);
  });

  it("builds a reviewable unsent prompt and typed lineage activities", () => {
    const document = "# Handoff\n\nDo the next thing.\n";
    const prompt = buildHandoffPrompt(document);
    expect(prompt).toContain("This is an unsent handoff draft");
    expect(prompt).toContain("Do the next thing.");

    const payload = {
      sourceThreadId: ThreadId.make("source-thread"),
      targetThreadId: ThreadId.make("target-thread"),
      sourceTitle: "Source",
      targetTitle: "Target",
      artifactPath: "HANDOFF.md",
    };
    const activity = buildHandoffActivity({
      activityId: EventId.make("activity-1"),
      createdAt: "2026-08-28T10:03:00.000Z",
      lineage: payload,
      direction: "source",
    });

    expect(activity.kind).toBe(HANDOFF_ACTIVITY_KIND);
    expect(activity.summary).toContain("Target");
    expect(decodeHandoffActivityPayload(activity.payload)).toEqual(payload);
    expect(resolveHandoffLineage(payload.sourceThreadId, [activity])).toEqual({
      direction: "source",
      relatedThreadId: payload.targetThreadId,
      relatedTitle: payload.targetTitle,
    });

    const targetActivity = buildHandoffActivity({
      activityId: EventId.make("activity-2"),
      createdAt: "2026-08-28T10:03:01.000Z",
      lineage: payload,
      direction: "target",
    });
    expect(resolveHandoffLineage(payload.targetThreadId, [targetActivity])).toEqual({
      direction: "target",
      relatedThreadId: payload.sourceThreadId,
      relatedTitle: payload.sourceTitle,
    });
  });
});
