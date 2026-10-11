// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
/**
 * AgentQueue goals, end to end through the real GoalService: goals are created the way the
 * setup pages create them, tasks come from a real plan in a real git repository, workers
 * are simulated by committing in the worktree the server gave them, and the queue,
 * integration and completion are the real ones. Only the orchestration engine (threads and
 * providers) is replaced by a recorder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  defaultGoalSetup,
  goalSetupToSettings,
} from "../../../../packages/client-runtime/src/goalSetup.ts";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import type { Goal, GoalSettings } from "@t3tools/contracts/goals";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import {
  openQueueDatabase,
  releaseClaim,
} from "../../../../packages/agent-queue-core/src/index.ts";
import {
  createTestGitRepo,
  execCommand,
} from "../../../../packages/agent-queue-core/test/harness/gitHarness.ts";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { AgentQueueServiceLive } from "../queue/AgentQueueService.ts";
import { GoalBeads } from "./GoalBeads.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";

const PROJECT = ProjectId.make("project-flow");
const CODEX = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };

const provider = (instanceId: string): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }) as unknown as ServerProvider;

/** A time hours in the past, for edits that have clearly been abandoned. */
const longAgo = () => new Date(Date.now() - 6 * 3600_000);

const PASS = 'node -e "process.exit(0)"';

/** A plan in the shape plan-work plans use. `ready` tasks have no dependencies. */
const planWith = (tasks: ReadonlyArray<{ id: string; deps?: string[]; verify?: string }>) =>
  [
    "# Flow plan",
    "",
    "## Tasks",
    "",
    ...tasks.flatMap((task) => [
      `- [ ] **${task.id} — Task ${task.id}.**`,
      `  - Depends on: ${task.deps && task.deps.length > 0 ? task.deps.join(", ") : "none"}.`,
      ...(task.verify === "" ? [] : [`  - Verify: \`${task.verify ?? PASS}\``]),
      "",
    ]),
  ].join("\n");

/** The settings the web and mobile setup pages send for a project, with a few fields chosen. */
const settingsFor = (overrides: Partial<GoalSettings> = {}): GoalSettings => {
  const form = defaultGoalSetup({
    projectId: PROJECT,
    agent: { instanceId: CODEX.instanceId, model: CODEX.model },
    runtimeMode: "full-access",
  });
  const base = goalSetupToSettings({
    ...form,
    name: "Complete the plan",
    concurrency: 10,
    agents: [{ ...form.agents[0]!, count: 10 }],
    maxChats: null,
    overseer: false,
  });
  if (!base) throw new Error("the default setup must be startable");
  return { ...base, ...overrides };
};

interface ThreadScript {
  reply: string;
  turnState: string;
  progress: boolean;
  lastError: string | null;
}

const makeFlow = (plan: string, options: { readonly extraFiles?: Record<string, string> } = {}) =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() => createTestGitRepo("goal-flow-"));
    yield* Effect.addFinalizer(() => Effect.promise(() => repo.cleanup()));
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
      for (const [name, content] of Object.entries(options.extraFiles ?? {})) {
        await NodeFSP.writeFile(NodePath.join(repo.rootDir, name), content);
      }
      await execCommand("git", ["add", "."], repo.rootDir);
      await execCommand("git", ["commit", "-m", "plan"], repo.rootDir);
    });

    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const log: OrchestrationCommand[] = [];
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const subscription = yield* PubSub.subscribe(events);
    let eventCount = 0;
    const scripts = new Map<string, ThreadScript>();
    /** The model each thread was created with, as the engine would report it. */
    const selections = new Map<string, unknown>();
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider("codex")]);
    const script = (threadId: string): ThreadScript =>
      scripts.get(threadId) ?? {
        reply: "Done.",
        turnState: "completed",
        progress: true,
        lastError: null,
      };

    const thread = (id: string) => {
      const state = script(id);
      return {
        latestTurn: { state: state.turnState },
        messages: state.reply === "" ? [] : [{ role: "assistant", text: state.reply }],
        activities: state.progress ? [{}] : [],
        session: state.lastError ? { lastError: state.lastError, status: "error" } : null,
        modelSelection: selections.get(id) ?? CODEX,
      } as unknown as OrchestrationThread;
    };

    const depsLayer = Layer.mergeAll(
      GoalStore.layer,
      AgentQueueServiceLive,
      Layer.succeed(GoalService.StartSpacingMillis, 0),
      Layer.succeed(
        GoalBeads,
        GoalBeads.of({
          available: () => Effect.succeed(false),
          snapshot: () => Effect.die("historical only"),
          repoContext: () => Effect.succeed(""),
          describe: () => Effect.succeed({ blocked: [], claimed: [] }),
          statusOf: () => Effect.succeed("closed"),
          release: () => Effect.void,
        }),
      ),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) => {
          if (command.type === "thread.create")
            selections.set(command.threadId, command.modelSelection);
          return Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 }));
        },
        streamDomainEvents: Stream.fromSubscription(subscription),
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShells: (ids) =>
          Effect.succeed(
            (ids ?? []).includes(PROJECT)
              ? [{ id: PROJECT, workspaceRoot: repo.rootDir } as never]
              : [],
          ),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: (threadId) => Effect.succeed(Option.some(thread(threadId))),
      }),
    ).pipe(
      Layer.provideMerge(
        Layer.fresh(ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-flow-" })),
      ),
    );

    /** Build the dependencies once; each "server" is a new GoalService over the same store. */
    const deps = yield* Layer.build(depsLayer);
    const startServer = Effect.provideContext(GoalService.make, deps);

    const drain = Effect.gen(function* () {
      log.push(...(yield* Queue.clear(commands)));
      return log;
    });
    const commandsOf = <T extends OrchestrationCommand["type"]>(type: T) =>
      drain.pipe(
        Effect.map((all) =>
          all.filter((c): c is Extract<OrchestrationCommand, { type: T }> => c.type === type),
        ),
      );
    const waitFor = Effect.fn("waitFor")(function* <T extends OrchestrationCommand["type"]>(
      type: T,
      count: number,
    ) {
      while ((yield* commandsOf(type)).length < count) {
        log.push(yield* Queue.take(commands));
      }
      return yield* commandsOf(type);
    });

    /** Poll something the server does in the background (git work), without a fixed sleep. */
    const eventually = Effect.fn("eventually")(function* <A>(
      read: Effect.Effect<A>,
      done: (value: A) => boolean,
      what: string,
    ) {
      for (let attempt = 0; attempt < 400; attempt++) {
        const value = yield* read;
        if (done(value)) return value;
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
      }
      yield* Effect.logError(
        "LASTSTATE",
        what,
        JSON.stringify(
          ((v: any) =>
            v && v.chats
              ? {
                  s: v.status,
                  d: v.detail,
                  q: v.queueProgress,
                  c: v.chats.map((c: any) => [c.taskId, c.status, c.taskOutcome]),
                }
              : v)(yield* read),
        ),
      );
      return yield* Effect.die(new Error(`Timed out waiting for ${what}`));
    });

    const sessionEvent = (threadId: string, session: Record<string, unknown>) =>
      PubSub.publish(events, {
        sequence: 2,
        eventId: EventId.make(`e-${threadId}-${++eventCount}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-10-04T12:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            providerName: "Codex",
            runtimeMode: "full-access",
            lastError: null,
            updatedAt: "2026-10-04T12:00:00.000Z",
            ...session,
          },
        },
      } as unknown as OrchestrationEvent);

    const createdFor = (taskId: string) =>
      log.find(
        (c): c is Extract<OrchestrationCommand, { type: "thread.create" }> =>
          c.type === "thread.create" && c.title.includes(taskId),
      );

    /** The worker commits a file in the worktree the server assigned, then its turn ends. */
    const work = Effect.fn("work")(function* (
      taskId: string,
      change: { file?: string; content?: string; reply?: string; commit?: boolean } = {},
    ) {
      const created = createdFor(taskId);
      if (!created?.worktreePath) return yield* Effect.die(new Error(`no worktree for ${taskId}`));
      const cwd = created.worktreePath;
      if (change.commit !== false) {
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(
            NodePath.join(cwd, change.file ?? `${taskId}.txt`),
            change.content ?? `${taskId}\n`,
          );
          await execCommand("git", ["add", "-A"], cwd);
          await execCommand("git", ["commit", "-m", `${taskId}: implement`], cwd);
        });
      }
      scripts.set(created.threadId, {
        reply: change.reply ?? "Done.",
        turnState: "completed",
        progress: true,
        lastError: null,
      });
      yield* sessionEvent(created.threadId, { status: "running", activeTurnId: "turn-1" });
      yield* sessionEvent(created.threadId, { status: "ready", activeTurnId: null });
      return created.threadId;
    });

    const queueDb = () => openQueueDatabase({ gitCommonDir: repo.gitCommonDir });
    const taskRow = (id: string) =>
      Effect.sync(() => {
        const db = queueDb();
        try {
          return db
            .prepare(
              "SELECT status, integration_state, retry_count, integration_error FROM tasks WHERE id = ?",
            )
            .get(id) as {
            status: string;
            integration_state: string | null;
            retry_count: number;
            integration_error: string | null;
          };
        } finally {
          db.close();
        }
      });
    const landings = (id: string) =>
      Effect.sync(() => {
        const db = queueDb();
        try {
          return (
            db
              .prepare(
                "SELECT count(*) AS n FROM landing_queue WHERE task_id = ? AND status = 'landed'",
              )
              .get(id) as { n: number }
          ).n;
        } finally {
          db.close();
        }
      });
    const goalOf = (service: GoalService.GoalService["Service"]) =>
      service.list.pipe(Effect.map((goals) => goals[0] as Goal));

    return {
      repo,
      log,
      scripts,
      providers,
      startServer,
      deps,
      drain,
      commandsOf,
      waitFor,
      eventually,
      sessionEvent,
      work,
      createdFor,
      taskRow,
      landings,
      goalOf,
      depsLayer,
    };
  });

const turnsOf = (log: ReadonlyArray<OrchestrationCommand>) =>
  log.filter((c) => c.type === "thread.turn.start");

it.layer(NodeServices.layer)("AgentQueue goals", (it) => {
  it.effect(
    "ten slots, two ready tasks: reserves before launching, so exactly two workers start",
    () =>
      Effect.gen(function* () {
        const plan = planWith([
          { id: "T1" },
          { id: "T2" },
          ...Array.from({ length: 8 }, (_, i) => ({ id: `D${i + 1}`, deps: ["T1", "T2"] })),
        ]);
        const flow = yield* makeFlow(plan);
        const service = yield* flow.startServer;
        // Created from the settings the setup pages send (queueMode "auto"), nothing injected.
        const [goal] = yield* service.create(settingsFor());
        expect(goal?.agentQueue).toMatchObject({ planPath: "PLAN.md", baseBranch: "main" });
        expect(goal?.chats).toHaveLength(2);

        const creates = yield* flow.waitFor("thread.create", 2);
        const turns = turnsOf(flow.log);
        expect(creates.map((c) => c.worktreePath !== null && c.branch !== null)).toEqual([
          true,
          true,
        ]);
        const texts = turns.map((t) => (t.type === "thread.turn.start" ? t.message.text : ""));
        for (const text of texts) {
          expect(text).not.toContain("plan-work");
          expect(text).toContain("already reserved");
        }
        expect(texts.some((t) => t.includes("T1"))).toBe(true);
        expect(texts.some((t) => t.includes("T2"))).toBe(true);

        // Asking again with eight free slots starts nothing and spends no model turn.
        yield* service.addAgents(goal!.id, 3);
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
        expect(turnsOf(flow.log)).toHaveLength(2);
        const status = yield* flow.taskRow("D1");
        expect(status.status).toBe("pending");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "settles each worker, merges its work, unlocks dependants, and finishes only when the whole plan is merged",
    () =>
      Effect.gen(function* () {
        const plan = planWith([{ id: "T1" }, { id: "T2" }, { id: "T3", deps: ["T1", "T2"] }]);
        const flow = yield* makeFlow(plan);
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        const [goal] = yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 2);

        // T1 finishes first. It claims the whole goal is done, which means nothing.
        const t1 = yield* flow.work("T1", {
          reply: "T1 is merged.\n\nGOAL COMPLETE — there is no unfinished work left at all.",
        });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        const settles = yield* flow.waitFor("thread.settle", 1);
        expect(settles[0]?.threadId).toBe(t1);
        const afterFirst = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats.find((chat) => chat.threadId === t1)?.taskOutcome === "integrated",
          "the worker to be recorded as merged",
        );
        expect(afterFirst.status).toBe("running");
        expect(afterFirst.chats.find((chat) => chat.threadId === t1)?.status).toBe("completed");

        // T3 still waits for T2: no third worker, no nudge, no extra model turn.
        yield* service.addAgents(goal!.id, 1);
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
        expect(turnsOf(flow.log)).toHaveLength(2);

        // T2 finishes: the dependant starts by itself.
        yield* flow.work("T2");
        yield* flow.waitFor("thread.create", 3);
        expect((yield* flow.goalOf(service)).status).toBe("running");
        yield* flow.work("T3");

        const done = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "complete",
          "the goal to complete",
        );
        expect(done.detail).toContain("verified");
        for (const id of ["T1", "T2", "T3"]) {
          expect(yield* flow.taskRow(id)).toMatchObject({
            status: "completed",
            integration_state: null,
          });
          expect(yield* flow.landings(id)).toBe(1);
        }
        const files = yield* Effect.promise(() =>
          execCommand("git", ["ls-tree", "-r", "--name-only", "main"], flow.repo.rootDir),
        );
        expect(files.stdout).toContain("T1.txt");
        expect(files.stdout).toContain("T3.txt");
        // Three workers, three settles, and not one nudge or completion question.
        yield* flow.drain;
        expect(turnsOf(flow.log)).toHaveLength(3);
        expect(flow.log.filter((c) => c.type === "thread.settle")).toHaveLength(3);
        expect(
          turnsOf(flow.log).some(
            (t) => t.type === "thread.turn.start" && t.message.text.includes("stuck or blocked"),
          ),
        ).toBe(false);
        expect(done.chats.every((chat) => chat.status !== "running")).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "two workers finishing together merge once each and unlock a dependant exactly once",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([{ id: "T1" }, { id: "T2" }, { id: "T3", deps: ["T1", "T2"] }]),
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 2);
        yield* Effect.all([flow.work("T1"), flow.work("T2")], { concurrency: 2 });
        yield* flow.waitFor("thread.create", 3);
        yield* flow.eventually(
          Effect.all([flow.taskRow("T1"), flow.taskRow("T2")]),
          (rows) => rows.every((row) => row.status === "completed"),
          "both tasks to merge",
        );
        expect(yield* flow.landings("T1")).toBe(1);
        expect(yield* flow.landings("T2")).toBe(1);
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(3);
        expect(flow.log.filter((c) => c.type === "thread.settle")).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a dirty shared checkout does not stop the plan: tasks integrate, publication waits, then reconciles abandoned edits",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([{ id: "T1" }, { id: "T2", deps: ["T1"] }, { id: "T3", deps: ["T2"] }]),
          { extraFiles: { "shared.txt": "line1\nline2\nline3\nline4\nline5\n" } },
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        const [goal] = yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);

        // An older uncommitted edit sits in the shared checkout, on a file T1 also changes,
        // and stays there for the whole run.
        const shared = NodePath.join(flow.repo.rootDir, "shared.txt");
        const edited = "line1\nline2\nline3\nline4\nEDITED\n";
        yield* Effect.promise(() => NodeFSP.writeFile(shared, edited));

        yield* flow.work("T1", {
          file: "shared.txt",
          content: "TASK\nline2\nline3\nline4\nline5\n",
        });
        // T1 is integrated and its worker settled, so the dependant starts right away.
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to integrate",
        );
        yield* flow.waitFor("thread.create", 2);
        yield* flow.work("T2");
        yield* flow.waitFor("thread.create", 3);
        // T3's worktree already contains T1 and T2, although main does not.
        const t3 = flow.createdFor("T3")!;
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(t3.worktreePath!, "T2.txt"), "utf8"),
          ),
        ).toBe("T2\n");
        yield* flow.work("T3");

        // Every task is done; the goal is waiting to publish, not finished, and holds no live worker.
        const waiting = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.queueProgress?.phase === "waiting-publication",
          "publication to wait",
        );
        expect(waiting.status).toBe("running");
        expect(waiting.chats.filter((chat) => chat.status === "running")).toHaveLength(0);
        expect(waiting.queueProgress?.note).toContain("shared.txt");
        expect(yield* Effect.promise(() => NodeFSP.readFile(shared, "utf8"))).toBe(edited);
        const mainBefore = yield* Effect.promise(() =>
          execCommand("git", ["rev-parse", "main"], flow.repo.rootDir),
        );

        // The edit is now provably abandoned (idle for hours); the next pass preserves and reconciles it.
        const old = longAgo();
        yield* Effect.sync(() => NodeFS.utimesSync(shared, old, old));
        yield* service.addAgents(goal!.id, 1);
        const done = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "complete",
          "the goal to complete after publishing",
        );
        expect(done.detail).toContain("published");
        const mainAfter = yield* Effect.promise(() =>
          execCommand("git", ["rev-parse", "main"], flow.repo.rootDir),
        );
        expect(mainAfter.stdout).not.toBe(mainBefore.stdout);
        // Their edit survived, on top of the task's change, and a snapshot was kept.
        expect(yield* Effect.promise(() => NodeFSP.readFile(shared, "utf8"))).toBe(
          "TASK\nline2\nline3\nline4\nEDITED\n",
        );
        const snapshots = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(flow.repo.gitCommonDir, "agentqueue", "snapshots")),
        );
        expect(snapshots).toHaveLength(1);
        // Nobody re-implemented anything.
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(3);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a live owner of the checkout keeps publication pending without lying, and a restart keeps it pending until the owner leaves",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]), {
          extraFiles: { "shared.txt": "line1\nline2\nline3\nline4\nline5\n" },
        });
        const owner = NodeChildProcess.spawn("sleep", ["300"], {
          cwd: flow.repo.rootDir,
          stdio: "ignore",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => void owner.kill()));
        const first = yield* flow.startServer;
        yield* Effect.forkScoped(first.loop);
        yield* Effect.yieldNow;
        yield* first.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const shared = NodePath.join(flow.repo.rootDir, "shared.txt");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(shared, "line1\nline2\nline3\nline4\nEDITED\n"),
        );
        yield* flow.work("T1", {
          file: "shared.txt",
          content: "TASK\nline2\nline3\nline4\nline5\n",
        });

        const waiting = yield* flow.eventually(
          flow.goalOf(first),
          (g) => g.queueProgress?.phase === "waiting-publication",
          "publication to wait",
        );
        expect(waiting.status).toBe("running");
        expect(waiting.queueProgress?.note).toContain("sleep");

        // The server restarts: the verified result and the pending publication are still there.
        const second = yield* flow.startServer;
        yield* Effect.forkScoped(second.loop);
        yield* Effect.yieldNow;
        const again = yield* second.addAgents((yield* flow.goalOf(second)).id, 1);
        expect(again[0]?.status).toBe("running");
        expect((yield* flow.taskRow("T1")).status).toBe("completed");
        expect(yield* Effect.promise(() => NodeFSP.readFile(shared, "utf8"))).toBe(
          "line1\nline2\nline3\nline4\nEDITED\n",
        );

        // The owner goes away and the edit is old: the goal publishes and completes.
        owner.kill();
        yield* Effect.promise(() => new Promise((resolve) => owner.once("exit", resolve)));
        const old = longAgo();
        yield* Effect.sync(() => NodeFS.utimesSync(shared, old, old));
        yield* second.addAgents((yield* flow.goalOf(second)).id, 1);
        yield* flow.eventually(
          flow.goalOf(second),
          (g) => g.status === "complete",
          "the goal to complete",
        );
        expect(yield* flow.landings("T1")).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a crash after the target moved but before publication was recorded is recognised",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]), {
          extraFiles: { "shared.txt": "line1\nline2\nline3\nline4\nline5\n" },
        });
        const owner = NodeChildProcess.spawn("sleep", ["300"], {
          cwd: flow.repo.rootDir,
          stdio: "ignore",
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => void owner.kill()));
        const first = yield* flow.startServer;
        yield* Effect.forkScoped(first.loop);
        yield* Effect.yieldNow;
        yield* first.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const shared = NodePath.join(flow.repo.rootDir, "shared.txt");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(shared, "line1\nline2\nline3\nline4\nEDITED\n"),
        );
        yield* flow.work("T1", {
          file: "shared.txt",
          content: "TASK\nline2\nline3\nline4\nline5\n",
        });
        yield* flow.eventually(
          flow.goalOf(first),
          (g) => g.queueProgress?.phase === "waiting-publication",
          "publication to wait",
        );
        // The publisher got as far as moving the target (here: someone else fast-forwarded it
        // to the same commit) and died before writing that down.
        owner.kill();
        yield* Effect.promise(() => new Promise((resolve) => owner.once("exit", resolve)));
        yield* Effect.promise(async () => {
          const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
          const goalBranch = (
            db.prepare("SELECT integration_branch AS b FROM plans").get() as { b: string }
          ).b;
          db.close();
          await execCommand("git", ["stash", "push", "--", "shared.txt"], flow.repo.rootDir);
          await execCommand("git", ["merge", "--ff-only", goalBranch], flow.repo.rootDir);
          await execCommand("git", ["stash", "pop"], flow.repo.rootDir).catch(() => undefined);
        });
        const second = yield* flow.startServer;
        yield* Effect.forkScoped(second.loop);
        yield* Effect.yieldNow;
        yield* second.addAgents((yield* flow.goalOf(second)).id, 1);
        yield* flow.eventually(
          flow.goalOf(second),
          (g) => g.status === "complete",
          "the goal to complete",
        );
        expect(yield* flow.landings("T1")).toBe(1);
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "database and git evidence beat a worker that says NEEDS ATTENTION after its work merged",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 2);
        const t1 = yield* flow.work("T1", { reply: "Merged. NEEDS ATTENTION\n\nNEEDS ATTENTION" });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        const goal = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats.find((chat) => chat.threadId === t1)?.taskOutcome === "integrated",
          "the chat to be recorded as merged",
        );
        expect(goal.chats.find((chat) => chat.threadId === t1)?.status).toBe("completed");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a provider failure before any work returns the task untouched and spends no retry",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        const [created] = yield* flow.waitFor("thread.create", 1);
        flow.scripts.set(created!.threadId, {
          reply: "",
          turnState: "error",
          progress: false,
          lastError:
            "the ChatGPT app is on its loading splash because the desktop login keyring is locked (APP_SHELL_NOT_LOADED)",
        });
        yield* flow.sessionEvent(created!.threadId, {
          status: "error",
          activeTurnId: null,
          lastError: "APP_SHELL_NOT_LOADED",
        });
        const goal = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats[0]?.status === "stopped",
          "the worker to be recorded as stopped",
        );
        expect(goal.status).toBe("running");
        expect(goal.chats[0]?.taskOutcome).toBe("returned");
        expect(goal.pauses?.some((pause) => pause.reason === "errors")).toBe(true);
        const row = yield* flow.taskRow("T1");
        expect(row).toMatchObject({ status: "pending", retry_count: 0 });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "auto mode falls back to standard with a stated reason; explicit AgentQueue refuses",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow("# Notes\n\nNo tasks here.\n");
        const service = yield* flow.startServer;
        const refused = yield* service
          .create(settingsFor({ queueMode: "agentqueue" }))
          .pipe(Effect.flip);
        expect(refused.message).toContain("AgentQueue cannot start");
        expect(yield* service.list).toEqual([]);

        const [goal] = yield* service.create(
          settingsFor({
            queueMode: "auto",
            concurrency: 1,
            agents: [{ modelSelection: CODEX, count: 1 }],
          }),
        );
        expect(goal?.agentQueue).toBeUndefined();
        expect(goal?.queueReason).toContain("Standard mode");
        const [create] = yield* flow.waitFor("thread.create", 1);
        expect(create?.worktreePath).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect("never takes over tasks a legacy plan-work worker still owns", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]));
      yield* Effect.promise(async () => {
        const dir = NodePath.join(flow.repo.gitCommonDir, "plan-work-owners", "plan");
        await NodeFSP.mkdir(dir, { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(dir, "t1.json"),
          JSON.stringify({ task_id: "T1", owner_token: "x" }),
        );
      });
      const service = yield* flow.startServer;
      const refused = yield* service
        .create(settingsFor({ queueMode: "agentqueue" }))
        .pipe(Effect.flip);
      expect(refused.message).toContain("T1");
      const preview = yield* service.previewPlan({ projectId: PROJECT, queueMode: "auto" });
      expect(preview).toMatchObject({
        readiness: "legacy-active",
        effectiveMode: "standard",
        blocked: false,
      });
      expect(preview.legacyOwnedTaskIds).toEqual(["T1"]);
      const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
      const imported = db.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number };
      db.close();
      expect(imported.n).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("a standard plan-work goal ignores GOAL COMPLETE while the plan still has tasks", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]));
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      yield* service.create(
        settingsFor({
          queueMode: "standard",
          concurrency: 1,
          agents: [{ modelSelection: CODEX, count: 1 }],
        }),
      );
      const [first] = yield* flow.waitFor("thread.create", 1);
      flow.scripts.set(first!.threadId, {
        reply: "Landed my chunk.\n\nGOAL COMPLETE — there is no unfinished work left at all.",
        turnState: "completed",
        progress: true,
        lastError: null,
      });
      yield* flow.sessionEvent(first!.threadId, { status: "running", activeTurnId: "t" });
      yield* flow.sessionEvent(first!.threadId, { status: "ready", activeTurnId: null });
      // The goal is not over: another worker starts.
      yield* flow.waitFor("thread.create", 2);
      expect((yield* flow.goalOf(service)).status).toBe("running");
    }).pipe(Effect.scoped),
  );

  it.effect("dispatches by itself when another writer unlocks a dependency (queue events)", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2", deps: ["T1"] }]));
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      const [goal] = yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 1);
      const token = goal!.chats[0]!.claimToken!;
      // Something else (a person, another tool) completes T1 in the queue.
      yield* Effect.sync(() => {
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        releaseClaim(db, { ownerToken: token, finalStatus: "completed" });
        db.close();
      });
      // The scheduler's wakeup, not a worker, notices and starts T2.
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      const creates = yield* flow.waitFor("thread.create", 2);
      expect(creates[1]?.title).toContain("T2");
    }).pipe(Effect.scoped),
  );

  it.effect("a merge conflict is repaired by a repair worker on the existing commits", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]), {
        extraFiles: { "shared.txt": "base\n" },
      });
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 2);
      yield* flow.work("T1", { file: "shared.txt", content: "from T1\n" });
      yield* flow.eventually(
        flow.taskRow("T1"),
        (row) => row.status === "completed",
        "T1 to merge",
      );
      yield* flow.work("T2", { file: "shared.txt", content: "from T2\n" });

      // The conflict starts a repair worker; nothing is re-implemented and nothing needs a person.
      const creates = yield* flow.waitFor("thread.create", 3);
      const repair = creates[2]!;
      expect(repair.title).toContain("Repair: T2");
      expect(repair.worktreePath).toBe(flow.createdFor("T2")!.worktreePath);
      const repairTurns = yield* flow.waitFor("thread.turn.start", 3);
      const repairTurn = repairTurns.at(-1);
      const text = repairTurn?.type === "thread.turn.start" ? repairTurn.message.text : "";
      expect(text).toContain("merge repair");
      expect(text).toContain("shared.txt");
      expect(yield* flow.taskRow("T2")).toMatchObject({
        status: "claimed",
        integration_state: "repairing",
      });

      yield* Effect.promise(async () => {
        const cwd = repair.worktreePath!;
        await execCommand("git", ["rebase", "agentqueue/goal/PLAN"], cwd);
        await NodeFSP.writeFile(NodePath.join(cwd, "shared.txt"), "from T1 and T2\n");
        await execCommand("git", ["add", "shared.txt"], cwd);
        await execCommand("git", ["-c", "core.editor=true", "rebase", "--continue"], cwd);
      });
      yield* flow.sessionEvent(repair.threadId, { status: "running", activeTurnId: "r" });
      yield* flow.sessionEvent(repair.threadId, { status: "ready", activeTurnId: null });
      const done = yield* flow.eventually(
        flow.goalOf(service),
        (g) => g.status === "complete",
        "the goal to complete",
      );
      expect(done.chats.every((chat) => chat.status !== "running")).toBe(true);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(flow.repo.rootDir, "shared.txt"), "utf8"),
        ),
      ).toBe("from T1 and T2\n");
    }).pipe(Effect.scoped),
  );

  it.effect("a failing check sends the worker back with the failure, not a generic nudge", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1", verify: "exit 3" }]));
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 1);
      yield* flow.work("T1");
      const turns = yield* flow.waitFor("thread.turn.start", 2);
      const text = turns[1]?.type === "thread.turn.start" ? turns[1].message.text : "";
      expect(text).toContain("check on your commit and it failed");
      expect(text).toContain("exit 3");
      expect(text).not.toContain("stuck or blocked");
      // The task is not merged and not marked done.
      expect((yield* flow.taskRow("T1")).status).toBe("claimed");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an overseer that cannot start on a locked-keyring provider is retried on a healthy one",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([
            { id: "T1", verify: "" },
            { id: "T2", deps: ["T1"] },
          ]),
        );
        yield* Ref.set(flow.providers, [
          provider("codex"),
          {
            ...provider("chatAgents"),
            models: [{ slug: "chat-model" }],
          } as unknown as ServerProvider,
        ]);
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor({ overseer: true }));
        yield* flow.waitFor("thread.create", 1);
        // T1's worker needs a person and nothing can verify it: T1 is parked, T2 can never start.
        yield* flow.work("T1", { commit: false, reply: "I cannot do this.\n\nNEEDS ATTENTION" });
        const overseers = yield* flow.waitFor("thread.create", 2);
        const first = overseers[1]!;
        expect(first.title).toBe("Goal overseer");
        expect(first.modelSelection.instanceId).toBe("chatAgents");

        flow.scripts.set(first.threadId, {
          reply: "",
          turnState: "error",
          progress: false,
          lastError:
            "the ChatGPT app is on its loading splash because the desktop login keyring is locked (APP_SHELL_NOT_LOADED)",
        });
        yield* flow.sessionEvent(first.threadId, {
          status: "error",
          activeTurnId: null,
          lastError: "APP_SHELL_NOT_LOADED",
        });
        const retried = yield* flow.waitFor("thread.create", 3);
        expect(retried[2]?.title).toBe("Goal overseer");
        expect(retried[2]?.modelSelection.instanceId).toBe("codex");
        const goal = yield* flow.goalOf(service);
        expect(goal.status).toBe("running");
        expect(goal.pauses?.some((pause) => pause.instanceId === "chatAgents")).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a worker that leaves no commit is asked once to commit, then the task is retried",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1", { commit: false });
        const turns = yield* flow.waitFor("thread.turn.start", 2);
        const text = turns[1]?.type === "thread.turn.start" ? turns[1].message.text : "";
        expect(text).toContain("no commit");
        expect(text).not.toContain("stuck or blocked");
      }).pipe(Effect.scoped),
  );
});
