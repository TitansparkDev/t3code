import {
  EventId,
  OrchestrationThreadActivity,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const HANDOFF_FILE_NAME = "HANDOFF.md";
export const HANDOFF_ACTIVITY_KIND = "thread.handoff";
export const HANDOFF_ACTIVITY_TONE = "info" as const;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TRANSCRIPT_MESSAGES = 80;

export const HandoffActivityPayload = Schema.Struct({
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourceTitle: Schema.String,
  targetTitle: Schema.String,
  artifactPath: Schema.String,
});
export type HandoffActivityPayload = typeof HandoffActivityPayload.Type;
const decodeHandoffActivityPayloadOption = Schema.decodeUnknownOption(HandoffActivityPayload);
const decodeHandoffActivityPayloadSync = Schema.decodeUnknownSync(HandoffActivityPayload);

export interface HandoffProjectContext {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function boundedText(value: string, maxChars = MAX_MESSAGE_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n\n[…truncated…]`;
}

function markdownText(value: string): string {
  return boundedText(value).replaceAll("\r\n", "\n").trim();
}

function formatMessageRole(role: OrchestrationThread["messages"][number]["role"]): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    default:
      return String(role);
  }
}

/**
 * Builds the cross-provider transfer brief without calling a provider or
 * depending on network state. Ordering follows the persisted thread arrays so
 * identical source data always produces identical handoff text.
 */
export function buildHandoffDocument(input: {
  readonly thread: OrchestrationThread;
  readonly project: HandoffProjectContext;
  readonly artifactPath?: string;
}): string {
  const { thread, project } = input;
  const artifactPath = input.artifactPath ?? HANDOFF_FILE_NAME;
  const transcript = thread.messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const plans = thread.proposedPlans;
  const latestPlan = plans.at(-1)?.planMarkdown;
  const lines = [
    "# T3 Code handoff",
    "",
    "This brief was generated deterministically from a T3 Code thread. It contains no provider-generated summary.",
    "",
    "## Source",
    "",
    `- Thread: ${thread.title}`,
    `- Thread ID: \`${thread.id}\``,
    `- Project: ${project.title}`,
    `- Project ID: \`${project.id}\``,
    `- Checkout: \`${thread.worktreePath ?? project.workspaceRoot}\``,
    `- Branch: ${thread.branch ?? "(current checkout)"}`,
    `- Model: \`${thread.modelSelection.instanceId}/${thread.modelSelection.model}\``,
    `- Handoff artifact: \`${artifactPath}\``,
    "",
    "## Next-agent instructions",
    "",
    `Read \`${artifactPath}\` from the current checkout before changing files. Continue the work described below, preserving useful context while verifying assumptions against the repository.`,
    "",
  ];

  if (latestPlan) {
    lines.push("## Latest proposed plan", "", markdownText(latestPlan), "");
  }

  lines.push("## Conversation transcript", "");
  if (transcript.length === 0) {
    lines.push("No messages were recorded.", "");
  } else {
    for (const message of transcript) {
      lines.push(
        `### ${formatMessageRole(message.role)} — ${message.createdAt}`,
        "",
        markdownText(message.text) || "(empty)",
        "",
      );
    }
  }

  if (thread.activities.length > 0) {
    lines.push("## Recent activity", "");
    for (const activity of thread.activities.slice(-40)) {
      lines.push(`- ${activity.createdAt} — ${activity.kind}: ${activity.summary}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function buildHandoffPrompt(document: string): string {
  return `${document.trimEnd()}\n\n## Start here\n\nThis is an unsent handoff draft. Review it, adjust anything that has changed, then send it when you are ready to continue.`;
}

export function buildHandoffActivity(input: {
  readonly activityId: EventId;
  readonly createdAt: string;
  readonly lineage: HandoffActivityPayload;
  readonly direction: "source" | "target";
}): OrchestrationThreadActivity {
  const summary =
    input.direction === "source"
      ? `Forked to “${input.lineage.targetTitle}”`
      : `Forked from “${input.lineage.sourceTitle}”`;
  return {
    id: input.activityId,
    tone: HANDOFF_ACTIVITY_TONE,
    kind: HANDOFF_ACTIVITY_KIND,
    summary,
    payload: input.lineage,
    turnId: null,
    createdAt: input.createdAt,
  };
}

export function decodeHandoffActivityPayload(value: unknown): HandoffActivityPayload | null {
  return decodeHandoffActivityPayloadOption(value)._tag === "Some"
    ? decodeHandoffActivityPayloadSync(value)
    : null;
}

export interface HandoffLineage {
  readonly direction: "source" | "target";
  readonly relatedThreadId: ThreadId;
  readonly relatedTitle: string;
}

export function resolveHandoffLineage(
  threadId: ThreadId,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): HandoffLineage | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== HANDOFF_ACTIVITY_KIND) {
      continue;
    }
    const payload = decodeHandoffActivityPayload(activity.payload);
    if (!payload) {
      continue;
    }
    if (payload.sourceThreadId === threadId) {
      return {
        direction: "source",
        relatedThreadId: payload.targetThreadId,
        relatedTitle: payload.targetTitle,
      };
    }
    if (payload.targetThreadId === threadId) {
      return {
        direction: "target",
        relatedThreadId: payload.sourceThreadId,
        relatedTitle: payload.sourceTitle,
      };
    }
  }
  return null;
}
