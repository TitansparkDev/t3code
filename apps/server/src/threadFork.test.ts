import type { OrchestrationMessage, OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildForkHandoffPrompt,
  createForkAttachmentId,
  defaultForkTitle,
  formatConversationTranscript,
  FORK_TRANSCRIPT_FILE_NAME,
} from "./threadFork.ts";

const TIMESTAMP = "2026-09-14T00:00:00.000Z";

function makeThread(messages: ReadonlyArray<OrchestrationMessage>): OrchestrationThread {
  return {
    id: "thread-source" as OrchestrationThread["id"],
    projectId: "project-one" as OrchestrationThread["projectId"],
    title: "Source conversation",
    modelSelection: {
      instanceId: "codex-default" as OrchestrationThread["modelSelection"]["instanceId"],
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function message(
  role: OrchestrationMessage["role"],
  text: string,
  options?: Partial<OrchestrationMessage>,
): OrchestrationMessage {
  return {
    id: `${role}-${text.slice(0, 8)}` as OrchestrationMessage["id"],
    role,
    text,
    attachments: [],
    turnId: null,
    streaming: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...options,
  };
}

describe("conversation fork transcript", () => {
  it("keeps only persisted user and assistant messages", () => {
    const transcript = formatConversationTranscript(
      makeThread([
        message("system", "do not expose provider state"),
        message("user", "Please fix the parser"),
        message("assistant", "I will inspect the parser", {
          attachments: [
            {
              type: "image",
              id: "image-attachment",
              name: "parser-screenshot.png",
              mimeType: "image/png",
              sizeBytes: 42,
            },
          ],
        }),
        message("assistant", "streaming partial", { streaming: true }),
      ]),
    );

    expect(transcript).toContain("Please fix the parser");
    expect(transcript).toContain("I will inspect the parser");
    expect(transcript).not.toContain("do not expose provider state");
    expect(transcript).not.toContain("streaming partial");
    expect(transcript).toContain("parser-screenshot.png");
    expect(transcript).toContain("binary content omitted");
  });

  it("includes inherited fork context once and only appends continuation", () => {
    const transcript = formatConversationTranscript(
      makeThread([
        message("user", "Read the attached transcript", {
          attachments: [
            {
              type: "file",
              id: "fork-attachment",
              name: FORK_TRANSCRIPT_FILE_NAME,
              mimeType: "text/markdown",
              sizeBytes: 10,
            },
          ],
        }),
        message("assistant", "Handoff received"),
        message("user", "Continue with the failing test"),
      ]),
      { inheritedTranscript: "# Previous context\n\nUSER: fix the parser" },
    );

    expect(transcript.match(/Previous context/g)).toHaveLength(1);
    expect(transcript).toContain("Continue with the failing test");
    expect(transcript).not.toContain("Read the attached transcript");
  });

  it("bounds large transcripts", () => {
    const transcript = formatConversationTranscript(
      makeThread([message("user", "x".repeat(500))]),
      { maxChars: 120 },
    );

    expect(transcript.length).toBeLessThanOrEqual(120);
    expect(transcript).toContain("earlier conversation transcript truncated");
  });

  it("creates safe deterministic attachment IDs and handoff prompts", () => {
    expect(createForkAttachmentId("Thread/Target")).toMatch(/^thread-target-[0-9a-f-]+-md$/);
    expect(createForkAttachmentId("Thread/Target")).toBe(createForkAttachmentId("Thread/Target"));
    expect(defaultForkTitle("Source")).toBe("Source (fork)");
    expect(defaultForkTitle("Source (fork)")).toBe("Source (fork)");
    expect(buildForkHandoffPrompt({ sourceTitle: "Source" })).toContain(FORK_TRANSCRIPT_FILE_NAME);
  });
});
