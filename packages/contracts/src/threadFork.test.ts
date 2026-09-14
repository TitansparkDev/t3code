import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectId,
  ProviderInstanceId,
  ThreadForkError,
  ThreadForkErrorReason,
  ThreadForkInput,
  ThreadForkResult,
  ThreadId,
} from "./index.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";

const decodeInput = Schema.decodeUnknownSync(ThreadForkInput);
const decodeResult = Schema.decodeUnknownSync(ThreadForkResult);
const decodeError = Schema.decodeUnknownSync(ThreadForkError);
const decodeCapabilities = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);

describe("ThreadFork contracts", () => {
  it("decodes valid ThreadForkInput", () => {
    const input = decodeInput({
      projectId: "project-1",
      sourceThreadId: "thread-src",
      targetThreadId: "thread-tgt",
      modelSelection: {
        instanceId: "anthropic-default",
        model: "claude-3-5-sonnet-20241022",
      },
      title: "Forked conversation",
      runtimeMode: "auto",
      interactionMode: "default",
      branch: "feat/fork",
      worktreePath: "/tmp/worktree",
    });

    expect(input.projectId).toBe(ProjectId.make("project-1"));
    expect(input.sourceThreadId).toBe(ThreadId.make("thread-src"));
    expect(input.targetThreadId).toBe(ThreadId.make("thread-tgt"));
    expect(input.modelSelection.instanceId).toBe(ProviderInstanceId.make("anthropic-default"));
    expect(input.title).toBe("Forked conversation");
  });

  it("decodes valid ThreadForkResult", () => {
    const result = decodeResult({
      threadId: "thread-tgt",
      projectId: "project-1",
    });

    expect(result.threadId).toBe(ThreadId.make("thread-tgt"));
    expect(result.projectId).toBe(ProjectId.make("project-1"));
  });

  it("covers all error schema reasons", () => {
    const expectedReasons: ReadonlyArray<typeof ThreadForkErrorReason.Type> = [
      "source_not_found",
      "source_busy",
      "target_conflict",
      "transcript_too_large",
      "provider_unavailable",
      "project_not_found",
      "invalid_request",
      "internal_error",
    ];

    for (const reason of expectedReasons) {
      const err = decodeError({
        _tag: "ThreadForkError",
        message: `Error due to ${reason}`,
        reason,
        sourceThreadId: "thread-src",
        targetThreadId: "thread-tgt",
        projectId: "project-1",
      });

      expect(err._tag).toBe("ThreadForkError");
      expect(err.reason).toBe(reason);
      expect(err.message).toBe(`Error due to ${reason}`);
    }
  });

  it("rejects invalid error reason", () => {
    expect(() =>
      decodeError({
        _tag: "ThreadForkError",
        message: "Bad reason",
        reason: "unsupported_reason",
      }),
    ).toThrow();
  });

  it("supports threadForking capability on ExecutionEnvironmentCapabilities", () => {
    const capabilities = decodeCapabilities({
      repositoryIdentity: true,
      threadForking: true,
    });

    expect(capabilities.threadForking).toBe(true);
  });
});
