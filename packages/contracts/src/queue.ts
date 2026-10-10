/**
 * AgentQueue shared domain schemas and contracts.
 *
 * Defines strongly typed entities for tasks, plans, claims, leases,
 * verification evidence, serialized merge landing, and event outbox.
 *
 * @module queue
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TaskId = Schema.String.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;

export const PlanId = Schema.String.pipe(Schema.brand("PlanId"));
export type PlanId = typeof PlanId.Type;

export const ClaimToken = Schema.String.pipe(Schema.brand("ClaimToken"));
export type ClaimToken = typeof ClaimToken.Type;

export const TaskStatus = Schema.Literals([
  "pending",
  "claimed",
  "running",
  "verifying",
  "completed",
  "failed",
  "blocked",
]);
export type TaskStatus = typeof TaskStatus.Type;

export const ScopeConflictMode = Schema.Literals(["exclusive", "shared"]);
export type ScopeConflictMode = typeof ScopeConflictMode.Type;

export const ScopeHint = Schema.Struct({
  patterns: Schema.Array(Schema.String),
  conflictMode: Schema.optional(ScopeConflictMode),
});
export type ScopeHint = typeof ScopeHint.Type;

export const VerificationReceipt = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  passed: Schema.Boolean,
  verifiedAt: IsoDateTime,
});
export type VerificationReceipt = typeof VerificationReceipt.Type;

export const MergeCandidate = Schema.Struct({
  taskId: TaskId,
  sourceBranch: TrimmedNonEmptyString,
  targetBranch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  headCommit: Schema.NullOr(Schema.String),
});
export type MergeCandidate = typeof MergeCandidate.Type;

export const LandingResult = Schema.Struct({
  taskId: TaskId,
  success: Schema.Boolean,
  commitHash: Schema.NullOr(Schema.String),
  landedAt: IsoDateTime,
  error: Schema.NullOr(Schema.String),
});
export type LandingResult = typeof LandingResult.Type;

export const Lease = Schema.Struct({
  taskId: TaskId,
  workerPid: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  leasedAt: IsoDateTime,
  heartbeatAt: IsoDateTime,
  expiresAt: IsoDateTime,
  releasedAt: Schema.NullOr(IsoDateTime),
});
export type Lease = typeof Lease.Type;

export const Task = Schema.Struct({
  id: TaskId,
  planId: Schema.NullOr(PlanId),
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  status: TaskStatus,
  priority: Schema.Number,
  version: Schema.Number,
  scopePatterns: Schema.Array(Schema.String),
  dependencies: Schema.Array(TaskId),
  verificationCommand: Schema.NullOr(Schema.String),
  maxRetries: Schema.Number,
  retryCount: Schema.Number,
  timeoutSeconds: Schema.Number,
  failureReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Task = typeof Task.Type;

export const Plan = Schema.Struct({
  id: PlanId,
  filePath: TrimmedNonEmptyString,
  checksum: Schema.String,
  title: TrimmedNonEmptyString,
  status: Schema.Literals(["active", "completed", "archived"]),
  registeredAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Plan = typeof Plan.Type;

export const QueueEventType = Schema.Literals([
  "task_created",
  "task_claimed",
  "task_heartbeat",
  "task_verification_started",
  "task_verification_passed",
  "task_verification_failed",
  "task_merge_queued",
  "task_landed",
  "task_failed",
  "task_recovered",
  "task_released",
]);
export type QueueEventType = typeof QueueEventType.Type;

export const QueueEvent = Schema.Struct({
  id: Schema.Number,
  taskId: TaskId,
  eventType: QueueEventType,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: IsoDateTime,
});
export type QueueEvent = typeof QueueEvent.Type;

export const EventCursor = Schema.Struct({
  lastEventId: Schema.Number,
  events: Schema.Array(QueueEvent),
});
export type EventCursor = typeof EventCursor.Type;

export const QueueSnapshot = Schema.Struct({
  pendingCount: Schema.Number,
  claimedCount: Schema.Number,
  runningCount: Schema.Number,
  verifyingCount: Schema.Number,
  completedCount: Schema.Number,
  failedCount: Schema.Number,
  blockedCount: Schema.Number,
  tasks: Schema.Array(Task),
  activeLeases: Schema.Array(Lease),
});
export type QueueSnapshot = typeof QueueSnapshot.Type;
