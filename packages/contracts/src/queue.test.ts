import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  TaskId,
  PlanId,
  ClaimToken,
  Task,
  Plan,
  Lease,
  MergeCandidate,
  LandingResult,
  VerificationReceipt,
  QueueSnapshot,
  QueueEvent,
} from "./queue.ts";

describe("AgentQueue Contracts Serialization", () => {
  it("encodes and decodes Task schema", () => {
    const rawTask = {
      id: "AQ-001",
      planId: "plan-main",
      title: "Trace source to running service",
      description: "Verify systemd unit and runtime executable",
      status: "completed" as const,
      priority: 10,
      version: 1,
      scopePatterns: ["apps/server/**", "packages/**"],
      dependencies: [],
      verificationCommand: "vp test packages/contracts",
      maxRetries: 3,
      retryCount: 0,
      timeoutSeconds: 1800,
      failureReason: null,
      createdAt: "2026-10-10T01:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
    };

    const decoded = Schema.decodeSync(Task)(rawTask);
    expect(decoded.id).toBe("AQ-001");
    expect(decoded.status).toBe("completed");
    expect(decoded.scopePatterns).toHaveLength(2);

    const encoded = Schema.encodeSync(Task)(decoded);
    expect(encoded).toEqual(rawTask);
  });

  it("encodes and decodes Plan and Lease schemas", () => {
    const rawPlan = {
      id: "plan-agentqueue",
      filePath: "docs/agentqueue/PLAN.md",
      checksum: "abc123hash",
      title: "AgentQueue Implementation Plan",
      status: "active" as const,
      registeredAt: "2026-10-10T01:00:00.000Z",
      updatedAt: "2026-10-10T01:00:00.000Z",
    };

    const decodedPlan = Schema.decodeSync(Plan)(rawPlan);
    expect(decodedPlan.title).toBe("AgentQueue Implementation Plan");

    const rawLease = {
      taskId: "AQ-002",
      workerPid: 12345,
      sessionId: "session-xyz",
      worktreePath: "/tmp/wt-002",
      branch: "aq/aq-002",
      leasedAt: "2026-10-10T01:00:00.000Z",
      heartbeatAt: "2026-10-10T01:00:00.000Z",
      expiresAt: "2026-10-10T01:02:00.000Z",
      releasedAt: null,
    };

    const decodedLease = Schema.decodeSync(Lease)(rawLease);
    expect(decodedLease.workerPid).toBe(12345);
    expect(decodedLease).not.toHaveProperty("token");
  });

  it("encodes and decodes MergeCandidate and LandingResult", () => {
    const candidate = {
      taskId: "AQ-003",
      sourceBranch: "aq/aq-003",
      targetBranch: "omni/main",
      worktreePath: "/tmp/wt-003",
      headCommit: "deadbeef",
    };
    const decodedCandidate = Schema.decodeSync(MergeCandidate)(candidate);
    expect(decodedCandidate.sourceBranch).toBe("aq/aq-003");

    const landing = {
      taskId: "AQ-003",
      success: true,
      commitHash: "cafebabe",
      landedAt: "2026-10-10T01:00:00.000Z",
      error: null,
    };
    const decodedLanding = Schema.decodeSync(LandingResult)(landing);
    expect(decodedLanding.success).toBe(true);
  });

  it("encodes and decodes QueueSnapshot", () => {
    const snapshot = {
      pendingCount: 5,
      claimedCount: 2,
      runningCount: 2,
      verifyingCount: 0,
      completedCount: 10,
      failedCount: 1,
      blockedCount: 0,
      tasks: [],
      activeLeases: [],
    };
    const decoded = Schema.decodeSync(QueueSnapshot)(snapshot);
    expect(decoded.completedCount).toBe(10);
    expect(decoded.pendingCount).toBe(5);
  });
});
