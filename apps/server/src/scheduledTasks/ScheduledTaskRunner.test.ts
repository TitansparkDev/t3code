import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts/scheduledTasks";
import type { AccountQuotaSnapshot } from "@t3tools/contracts/quota";
import * as Effect from "effect/Effect";

import { dispatchScheduledTaskTarget, scheduledTargetQuota } from "./ScheduledTaskRunner.ts";

describe("scheduled window evidence", () => {
  const snapshot: AccountQuotaSnapshot = {
    providerInstanceId: ProviderInstanceId.make("antigravity-1"),
    source: "antigravity-quota-summary",
    observedAt: "2026-09-27T05:01:00.000Z",
    groups: [
      {
        key: "gemini",
        displayName: "Gemini",
        windows: [
          {
            kind: "short",
            usedPercent: 1,
            resetsAt: "2026-09-27T10:00:00.000Z",
          },
        ],
      },
      {
        key: "claude-gpt",
        displayName: "Claude & GPT",
        windows: [
          {
            kind: "short",
            usedPercent: 70,
            resetsAt: "2026-09-27T07:00:00.000Z",
          },
        ],
      },
    ],
  };

  it("reports the Gemini window for a Gemini turn, not the more-used Claude pool", () => {
    expect(scheduledTargetQuota(snapshot, "antigravity", "gemini-2.5-pro")?.resetsAt).toBe(
      "2026-09-27T10:00:00.000Z",
    );
    expect(scheduledTargetQuota(snapshot, "antigravity", "antigravity-default")).toBeUndefined();
  });

  it("does not claim a window from an observation made before the run finished", () => {
    expect(
      scheduledTargetQuota(snapshot, "antigravity", "gemini-2.5-pro", "2026-09-27T05:02:00.000Z"),
    ).toBeUndefined();
  });
});

describe("dispatchScheduledTaskTarget", () => {
  it.effect("creates the hidden thread before starting its provider turn", () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      const lifecycle: string[] = [];
      const createdAt = "2026-09-03T12:00:00.000Z";
      const task: ScheduledTask = {
        id: ScheduledTaskId.make("task-1"),
        name: "Morning check",
        prompt: "Say hi",
        projectId: ProjectId.make("project-1"),
        targets: [
          {
            instanceId: ProviderInstanceId.make("codex-2"),
            model: "gpt-5.6-luna",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        ],
        schedule: { timeOfDay: "05:00", daysOfWeek: [] },
        enabled: true,
        runtimeMode: "full-access",
        createdAt,
        updatedAt: createdAt,
      };

      yield* dispatchScheduledTaskTarget({
        dispatch: (command) => {
          commands.push(command);
          lifecycle.push(command.type);
          return Effect.succeed({ sequence: commands.length });
        },
        task,
        projectId: ProjectId.make("project-1"),
        target: task.targets[0]!,
        threadId: ThreadId.make("thread-1"),
        createCommandId: CommandId.make("create-1"),
        turnCommandId: CommandId.make("turn-1"),
        messageId: MessageId.make("message-1"),
        createdAt,
        afterThreadCreated: Effect.sync(() => lifecycle.push("registered")),
      });

      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        threadId: "thread-1",
        projectId: "project-1",
        modelSelection: {
          instanceId: "codex-2",
          model: "gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      expect(commands[1]).toMatchObject({
        type: "thread.turn.start",
        threadId: "thread-1",
        message: { text: "Say hi" },
        modelSelection: { instanceId: "codex-2", model: "gpt-5.6-luna" },
      });
      expect("bootstrap" in commands[1]!).toBe(false);
      expect(lifecycle).toEqual(["thread.create", "registered", "thread.turn.start"]);
    }),
  );
});
