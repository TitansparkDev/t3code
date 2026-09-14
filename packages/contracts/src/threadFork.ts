import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

export const ThreadForkInput = Schema.Struct({
  projectId: ProjectId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  modelSelection: ModelSelection,
  title: Schema.optional(TrimmedNonEmptyString),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: Schema.optional(IsoDateTime),
});
export type ThreadForkInput = typeof ThreadForkInput.Type;

export const ThreadForkResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  turnId: Schema.optional(TurnId),
  messageId: Schema.optional(MessageId),
});
export type ThreadForkResult = typeof ThreadForkResult.Type;

export const ThreadForkErrorReason = Schema.Literals([
  "source_not_found",
  "source_busy",
  "target_conflict",
  "transcript_too_large",
  "provider_unavailable",
  "project_not_found",
  "invalid_request",
  "internal_error",
]);
export type ThreadForkErrorReason = typeof ThreadForkErrorReason.Type;

export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  message: Schema.String,
  reason: ThreadForkErrorReason,
  sourceThreadId: Schema.optional(ThreadId),
  targetThreadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  cause: Schema.optional(Schema.Defect()),
}) {}
