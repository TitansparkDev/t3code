import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { GoalEscalationError } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as GoalService from "../../../goals/GoalService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { EscalationToolkit } from "./tools.ts";

/** Escalation errors are the caller's to fix (wrong id, closed, not held), so they are invalid requests. */
const failure = (error: GoalEscalationError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const handlers = {
  t3_escalation_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      const escalations = yield* goals.listEscalations(input);
      return { escalations: [...escalations] };
    }),
  ),
  t3_escalation_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      return yield* goals.readEscalation(input.id).pipe(Effect.mapError(failure));
    }),
  ),
  t3_escalation_reply: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      return yield* goals
        .replyEscalation(input.id, input.message, "overseer")
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_escalation_resolve: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      yield* goals
        .resolveEscalation(
          input.id,
          {
            action: input.action,
            note: input.note,
            ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
            ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          },
          "overseer",
        )
        .pipe(Effect.mapError(failure));
      return { id: input.id };
    }),
  ),
  t3_escalation_open: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      return yield* goals
        .openEscalation(input.goalId, input.threadId, input.note)
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_escalation_cancel: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      yield* goals.cancelEscalation(input.id, "overseer").pipe(Effect.mapError(failure));
      return { id: input.id };
    }),
  ),
};

export const layer = McpToolAccess.toLayer(EscalationToolkit, handlers);
