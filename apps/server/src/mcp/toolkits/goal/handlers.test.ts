import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { GoalId, type Goal, type GoalSettings } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as GoalService from "../../../goals/GoalService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as GoalHandlers from "./handlers.ts";
import { GoalToolkit } from "./tools.ts";

const projectId = ProjectId.make("project-goals");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };

const draftGoal = (id: string): Goal =>
  ({
    id: GoalId.make(id),
    name: `Goal ${id}`,
    projectId,
    agents: [{ modelSelection, count: 2 }],
    concurrency: 3,
    maxChats: 50,
    runtimeMode: "full-access",
    autoResume: true,
    standardRules: true,
    status: "draft",
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    chats: [],
  }) as unknown as Goal;

/** A client approved for `access`; read-only clients are refused every write. */
const clientLayer = (access: "read-only" | "auto-accept-edits" | "full-access") => {
  const created: Array<{ readonly settings: GoalSettings; readonly draft: boolean }> = [];
  const stored: Array<Goal> = [];
  const goals = GoalService.GoalService.of({
    list: Effect.sync(() => [...stored]),
    create: (settings, options) =>
      Effect.sync(() => {
        created.push({ settings, draft: options?.draft ?? false });
        stored.unshift(draftGoal(`goal-${created.length}`));
        return [...stored];
      }),
    update: () => Effect.die("unused"),
    stop: () => Effect.die("unused"),
    restart: () => Effect.die("unused"),
    previewPlan: () => Effect.die("unused"),
    addAgents: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    listEscalations: () => Effect.die("unused"),
    readEscalation: () => Effect.die("unused"),
    replyEscalation: () => Effect.die("unused"),
    resolveEscalation: () => Effect.die("unused"),
    openEscalation: () => Effect.die("unused"),
    cancelEscalation: () => Effect.die("unused"),
    loop: Effect.void,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-goals"),
      requestNamespace: "session",
      thread: undefined,
      client: { sessionId: "client-goals", label: "ChatGPT", access },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.succeed(GoalService.GoalService, goals),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
  );
  return { created, stored, dependencies };
};

type Dependencies = ReturnType<typeof clientLayer>["dependencies"];

const handled = (dependencies: Dependencies) =>
  GoalToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(GoalHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );

const lastResult = <A>(items: ReadonlyArray<{ readonly result: A }>) => items.at(-1)?.result;

it.effect("lists goals for a read-only client", () =>
  Effect.gen(function* () {
    const { dependencies, stored } = clientLayer("read-only");
    stored.push(draftGoal("goal-existing"));
    const toolkit = yield* handled(dependencies);
    const result = lastResult(
      yield* toolkit
        .handle("t3_goal_list", {})
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
    );
    expect(result).toMatchObject({
      goals: [{ id: "goal-existing", status: "draft", chats: {}, concurrency: 3 }],
    });
  }),
);

it.effect("refuses to create a goal for a read-only client", () =>
  Effect.gen(function* () {
    const { dependencies, created } = clientLayer("read-only");
    const toolkit = yield* handled(dependencies);
    const result = lastResult(
      yield* toolkit
        .handle("t3_goal_create", {
          name: "Refused",
          projectId,
          agents: [{ modelSelection, count: 1 }],
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
    );
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(created).toHaveLength(0);
  }),
);

it.effect("creates a draft with defaults and returns the same goal for a repeated request", () =>
  Effect.gen(function* () {
    const { dependencies, created } = clientLayer("full-access");
    const input = {
      name: "Ship the plan",
      projectId,
      agents: [{ modelSelection, count: 2 }],
      clientRequestId: "req-goal-draft-1",
    };
    const toolkit = yield* handled(dependencies);
    const create = (params: typeof input) =>
      toolkit
        .handle("t3_goal_create", params)
        .pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.provide(dependencies),
          Effect.map(lastResult),
        );
    const first = yield* create(input);
    expect(first).toMatchObject({ id: "goal-1", status: "draft" });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      draft: true,
      settings: {
        concurrency: 3,
        maxChats: 50,
        autoResume: true,
        standardRules: true,
        queueMode: "auto",
        runtimeMode: "full-access",
      },
    });

    const repeated = yield* create(input);
    expect(repeated).toMatchObject({ id: "goal-1" });
    expect(created).toHaveLength(1);
  }),
);

it.effect("clamps a goal's runtime mode to the caller's access", () =>
  Effect.gen(function* () {
    const { dependencies, created } = clientLayer("auto-accept-edits");
    const toolkit = yield* handled(dependencies);
    yield* toolkit
      .handle("t3_goal_create", {
        name: "Narrow",
        projectId,
        agents: [{ modelSelection, count: 1 }],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(created[0]?.settings.runtimeMode).toBe("auto-accept-edits");
  }),
);
