// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type ChatAttachmentId,
  type ChatFileAttachment,
  CommandId,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type ThreadId,
} from "@t3tools/contracts";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "./attachmentStore.ts";

export const FORK_TRANSCRIPT_FILE_NAME = "conversation-transcript.md";
export const FORK_TRANSCRIPT_MIME_TYPE = "text/markdown";
export const DEFAULT_FORK_MAX_CHARS = 200_000;
export const FORK_ATTACHMENT_EXTENSION = "md";

/**
 * Creates a deterministic attachment ID for the forked transcript based on the target thread ID.
 * Conforms to ATTACHMENT_ID_PATTERN in attachmentStore.ts.
 */
export function createForkAttachmentId(targetThreadId: string): string {
  const safeThreadSegment = toSafeThreadAttachmentSegment(targetThreadId) ?? "fork";
  const hash = NodeCrypto.createHash("sha256").update(targetThreadId).digest("hex");
  const uuid = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `8${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join("-");
  return `${safeThreadSegment}-${uuid}-${FORK_ATTACHMENT_EXTENSION}`;
}

export function createForkCreateCommandId(targetThreadId: string): CommandId {
  return CommandId.make(`fork-create:${targetThreadId}`);
}

export function createForkTurnCommandId(targetThreadId: string): CommandId {
  return CommandId.make(`fork-turn:${targetThreadId}`);
}

export function createForkMessageId(targetThreadId: string): MessageId {
  return MessageId.make(`fork-msg:${targetThreadId}`);
}

export function defaultForkTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  if (trimmed.endsWith("(fork)")) {
    return trimmed;
  }
  return `${trimmed} (fork)`;
}

export function buildForkHandoffPrompt(options?: { readonly sourceTitle?: string }): string {
  const sourceContext = options?.sourceTitle ? ` from "${options.sourceTitle.trim()}"` : "";
  return `I have forked this conversation${sourceContext}. Please read the attached \`${FORK_TRANSCRIPT_FILE_NAME}\` for context and background on previous work, then continue assisting with the project.`;
}

function cleanMessageText(text: string): string {
  // Exclude null bytes and raw binary artifacts while preserving markdown
  const cleaned = text
    .replace(/\0/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replaceAll("\r\n", "\n")
    .trim();
  return cleaned.length > 0 ? cleaned : "(empty)";
}

function formatMessageEntry(message: OrchestrationMessage): string {
  const roleLabel = message.role === "user" ? "User" : "Assistant";
  const attachments = (message.attachments ?? [])
    .map(
      (attachment) =>
        `- ${attachment.type}: ${cleanMessageText(attachment.name)} (${attachment.sizeBytes} bytes; binary content omitted)`,
    )
    .join("\n");
  return [
    `### ${roleLabel} (${message.createdAt})`,
    cleanMessageText(message.text),
    attachments.length > 0 ? `Attachments:\n${attachments}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

function isForkHandoffMessage(message: OrchestrationMessage): boolean {
  return (
    message.attachments?.some(
      (attachment) => attachment.type === "file" && attachment.name === FORK_TRANSCRIPT_FILE_NAME,
    ) ?? false
  );
}

export interface FormatTranscriptOptions {
  readonly inheritedTranscript?: string;
  readonly maxChars?: number;
}

/**
 * Generates a bounded markdown transcript from persisted user/assistant messages only.
 * Excludes system messages, hidden metadata, tool execution details, and raw binary bytes.
 * For a fork of a fork, reads the inherited transcript once and appends only the continuation after it.
 */
export function formatConversationTranscript(
  thread: OrchestrationThread,
  options?: FormatTranscriptOptions,
): string {
  const maxChars = options?.maxChars ?? DEFAULT_FORK_MAX_CHARS;

  const inheritedTranscript = options?.inheritedTranscript?.trim() || null;
  const handoffMessageIndex = thread.messages.findIndex(isForkHandoffMessage);
  const continuationStartIndex =
    inheritedTranscript === null || handoffMessageIndex < 0 ? 0 : handoffMessageIndex + 1;

  let fullTranscript: string;

  if (inheritedTranscript !== null) {
    const continuationMessages = thread.messages
      .slice(continuationStartIndex)
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.streaming);

    if (continuationMessages.length > 0) {
      const continuationText = continuationMessages.map(formatMessageEntry).join("\n\n");
      fullTranscript = `${inheritedTranscript}\n\n---\n\n## Continuation\n\n${continuationText}`;
    } else {
      fullTranscript = inheritedTranscript;
    }
  } else {
    const eligibleMessages = thread.messages.filter(
      (m) => (m.role === "user" || m.role === "assistant") && !m.streaming,
    );

    if (eligibleMessages.length === 0) {
      fullTranscript = "# Conversation transcript\n\nNo messages were recorded.";
    } else {
      const header = `# Conversation transcript: ${thread.title}\n\n`;
      const body = eligibleMessages.map(formatMessageEntry).join("\n\n");
      fullTranscript = `${header}${body}`;
    }
  }

  fullTranscript = fullTranscript.trim();

  if (fullTranscript.length > maxChars) {
    const truncatedPrefix = "[…earlier conversation transcript truncated…]\n\n";
    const availableChars = maxChars - truncatedPrefix.length;
    if (availableChars > 0) {
      fullTranscript = `${truncatedPrefix}${fullTranscript.slice(-availableChars).trim()}`;
    } else {
      fullTranscript = fullTranscript.slice(-maxChars);
    }
  }

  return fullTranscript;
}

export function writeForkTranscriptAttachment(input: {
  readonly attachmentsDir: string;
  readonly targetThreadId: string;
  readonly transcript: string;
}): { readonly attachment: ChatFileAttachment; readonly filePath: string } | null {
  const attachmentId = createForkAttachmentId(input.targetThreadId);
  const attachment: ChatFileAttachment = {
    type: "file",
    id: attachmentId as ChatAttachmentId,
    name: FORK_TRANSCRIPT_FILE_NAME,
    mimeType: FORK_TRANSCRIPT_MIME_TYPE,
    sizeBytes: Math.max(1, Buffer.byteLength(input.transcript, "utf-8")),
  };
  const filePath = resolveAttachmentPath({
    attachmentsDir: input.attachmentsDir,
    attachment,
  });
  if (filePath === null) {
    return null;
  }

  return { attachment, filePath };
}
