import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { GoalEscalationError, GoalId } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GoalService from "../../../goals/GoalService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as EscalationHandlers from "./handlers.ts";
import { EscalationToolkit } from "./tools.ts";

const GOAL = GoalId.make("goal-1");

const dependencies = (access: "read-only" | "full-access") =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: { sessionId: "session-1", label: "Test client", access },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(GoalService.GoalService)({
      listEscalations: () => Effect.succeed([]),
      cancelEscalation: () => Effect.fail(new GoalEscalationError({ reason: "not-found" })),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  );

const callTool = <Name extends "t3_escalation_list" | "t3_escalation_cancel">(
  access: "read-only" | "full-access",
  name: Name,
  params: Record<string, unknown>,
) => {
  const layer = dependencies(access);
  return Effect.gen(function* () {
    const toolkit = yield* EscalationToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EscalationHandlers.layer).pipe(Layer.provide(layer)),
      ),
    );
    return yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layer));
  });
};

it.effect("a read-only client can list escalations", () =>
  Effect.gen(function* () {
    const result = yield* callTool("read-only", "t3_escalation_list", { goalId: GOAL });
    expect(result.at(-1)?.result).toEqual({ escalations: [] });
  }),
);

it.effect("a read-only client is refused the escalation write tools", () =>
  Effect.gen(function* () {
    const result = yield* callTool("read-only", "t3_escalation_cancel", { id: "escalation-1" });
    expect(result.at(-1)).toMatchObject({
      isFailure: true,
      result: { code: "capability_denied" },
    });
  }),
);
