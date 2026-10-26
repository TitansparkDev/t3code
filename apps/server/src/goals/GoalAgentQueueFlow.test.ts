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
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, it as liveIt } from "@effect/vitest";
import {
  defaultGoalSetup,
  goalSetupToSettings,
} from "../../../../packages/client-runtime/src/goalSetup.ts";
import {
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
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
import {
  openBroker,
  openQueueDatabase,
  releaseClaim,
} from "../../../../packages/agent-queue-core/src/index.ts";
import {
  createTestGitRepo,
  execCommand,
} from "../../../../packages/agent-queue-core/test/harness/gitHarness.ts";

import * as ServerConfig from "../config.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import {
  layerFromLegacyHarness,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "./GoalThreads.testkit.ts";
import {
  AgentQueueError,
  AgentQueueService,
  AgentQueueServiceLive,
} from "../queue/AgentQueueService.ts";
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
const longAgo = () => new Date("2026-10-04T06:00:00.000Z");

const PASS = 'node -e "process.exit(0)"';

/** A plan in the shape plan-work plans use. `ready` tasks have no dependencies. */
const planWith = (
  tasks: ReadonlyArray<{ id: string; deps?: string[]; verify?: string; scope?: string }>,
) =>
  [
    "# Flow plan",
    "",
    "## Tasks",
    "",
    ...tasks.flatMap((task) => [
      `- [ ] **${task.id} — Task ${task.id}.**`,
      `  - Depends on: ${task.deps && task.deps.length > 0 ? task.deps.join(", ") : "none"}.`,
      ...(task.scope ? [`  - Scope: ${task.scope}.`] : []),
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
  /** A model turn is running (a worker woken by its own background job). */
  busy?: boolean;
  /** Whether the last turn's checkpoint is saved; unset means the thread reports none at all. */
  checkpoint?: "saved" | "pending";
  /** When the thread says its latest turn was requested / completed (for stale-turn cases). */
  turn?: { requestedAt?: string; completedAt?: string };
  livenessReadFails?: boolean;
}

const makeFlow = (
  plan: string,
  options: {
    readonly extraFiles?: Record<string, string>;
    readonly spacingMillis?: number;
    readonly queueFaults?: {
      claims?: boolean;
      release?: boolean;
      locked?: boolean;
      submitLocked?: boolean;
    };
    /** How many workspace binds fail before the engine accepts one. */
    readonly bindFailures?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const repo = yield* Effect.promise(() => createTestGitRepo("goal-flow-"));
    yield* Effect.addFinalizer(() => Effect.promise(() => repo.cleanup()));
    yield* Effect.promise(async () => {
      await NodeFSP.writeFile(NodePath.join(repo.rootDir, "PLAN.md"), plan);
      for (const [name, content] of Object.entries(options.extraFiles ?? {})) {
        await NodeFSP.mkdir(NodePath.dirname(NodePath.join(repo.rootDir, name)), {
          recursive: true,
        });
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
    /** Background work the registry reports per thread (tests, watchers, subagents). */
    const liveness = new Map<string, "working" | "monitoring">();
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
        latestTurn: { state: state.turnState, turnId: "turn-1", ...state.turn },
        messages: state.reply === "" ? [] : [{ role: "assistant", text: state.reply }],
        activities: state.progress ? [{}] : [],
        ...(state.checkpoint
          ? {
              checkpoints:
                state.checkpoint === "saved" ? [{ turnId: "turn-1", status: "ready" }] : [],
            }
          : {}),
        session: state.lastError
          ? { lastError: state.lastError, status: "error" }
          : state.busy
            ? { activeTurnId: "turn-2", status: "running" }
            : null,
        modelSelection: selections.get(id) ?? CODEX,
      } as unknown as OrchestrationThread;
    };

    const queueLayer = Layer.effect(
      AgentQueueService,
      Effect.map(AgentQueueService, (live) => {
        // A locked queue database fails every operation alike, as it did under load.
        const base = Object.fromEntries(
          Object.entries(live).map(([name, operation]) => [
            name,
            typeof operation === "function"
              ? (...args: Array<unknown>) =>
                  options.queueFaults?.locked ||
                  (name === "submit" && options.queueFaults?.submitLocked)
                    ? Effect.fail(
                        new AgentQueueError({ operation: name, message: "database is locked" }),
                      )
                    : (operation as (...input: Array<unknown>) => unknown)(...args)
              : operation,
          ]),
        ) as typeof live;
        return AgentQueueService.of({
          ...base,
          // Flow tests exercise task scheduling; host admission has its own deterministic tests.
          admit: () => Effect.succeed({ ok: true, reason: null }),
          activeClaims: (binding) =>
            options.queueFaults?.claims
              ? Effect.fail(
                  new AgentQueueError({
                    operation: "activeClaims",
                    message: "test queue outage",
                  }),
                )
              : base.activeClaims(binding),
          release: (...args) =>
            options.queueFaults?.release
              ? Effect.fail(
                  new AgentQueueError({ operation: "release", message: "test release outage" }),
                )
              : base.release(...args),
        });
      }),
    ).pipe(Layer.provide(AgentQueueServiceLive));
    let bindFailuresLeft = options.bindFailures ?? 0;
    let bindAttempts = 0;
    const depsLayer = Layer.mergeAll(
      GoalStore.layer,
      queueLayer,
      Layer.succeed(GoalService.StartSpacingMillis, options.spacingMillis ?? 0),
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
      layerFromLegacyHarness({
        dispatch: (command) => {
          if (command.type === "thread.create")
            selections.set(command.threadId, command.modelSelection);
          return Queue.offer(commands, command);
        },
        events: subscription,
        detail: (threadId) => Effect.succeed(Option.some(thread(threadId))),
        shell: (threadId) =>
          script(threadId).livenessReadFails
            ? Effect.die("liveness unavailable")
            : Effect.succeed(
                liveness.has(threadId)
                  ? Option.some({ backgroundLiveness: liveness.get(threadId) })
                  : Option.none(),
              ),
        projectRoot: (projectId) => (projectId === PROJECT ? repo.rootDir : undefined),
        failBind: () => {
          bindAttempts += 1;
          if (bindFailuresLeft <= 0) return false;
          bindFailuresLeft -= 1;
          return true;
        },
      }),
      Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
    ).pipe(
      Layer.provideMerge(
        Layer.fresh(ServerConfig.layerTest(repo.rootDir, { prefix: "t3code-goals-flow-" })),
      ),
    );

    /** Build the dependencies once; each "server" is a new GoalService over the same store. */
    const deps = yield* Layer.build(depsLayer);
    const startServer = Effect.provideContext(GoalService.make, deps);
    const goalStore = yield* GoalStore.GoalStore.pipe(Effect.provideContext(deps));

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

    /**
     * Re-reads `read` after each committed goal change, so the wait ends on the change that makes
     * `done` true. The subscription opens before the first read, so no change is missed.
     */
    const eventually = Effect.fn("eventually")(function* <A>(
      read: Effect.Effect<A>,
      done: (value: A) => boolean,
      _what: string,
    ) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* goalStore.subscribeChanges;
          let value = yield* read;
          while (!done(value)) {
            yield* PubSub.take(changes);
            value = yield* read;
          }
          return value;
        }),
      );
    });

    /** The next orchestration command that matches, once it has been logged or arrives. */
    const awaitCommand = Effect.fn("awaitCommand")(function* (
      match: (command: OrchestrationCommand) => boolean,
    ) {
      const seen = (yield* drain).find(match);
      if (seen) return seen;
      while (true) {
        const next = yield* Queue.take(commands);
        log.push(next);
        if (match(next)) return next;
      }
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
      change: {
        file?: string;
        content?: string;
        reply?: string;
        commit?: boolean;
        checkpoint?: "saved" | "pending";
      } = {},
    ) {
      const created = createdFor(taskId);
      if (!created?.worktreePath) return yield* Effect.die(new Error(`no worktree for ${taskId}`));
      const cwd = created.worktreePath;
      if (change.commit !== false) {
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(
            NodePath.dirname(NodePath.join(cwd, change.file ?? `${taskId}.txt`)),
            {
              recursive: true,
            },
          );
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
        ...(change.checkpoint ? { checkpoint: change.checkpoint } : {}),
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
      liveness,
      providers,
      startServer,
      goalStore,
      deps,
      drain,
      commandsOf,
      waitFor,
      awaitCommand,
      eventually,
      sessionEvent,
      work,
      createdFor,
      taskRow,
      landings,
      goalOf,
      depsLayer,
      bindAttempts: () => bindAttempts,
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
          expect(text).not.toContain("plan-work select --plan PLAN.md");
          expect(text).toContain("You own task");
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
          (g) =>
            g.queueProgress?.phase === "waiting-publication" &&
            g.queueProgress.note?.includes("shared.txt") === true,
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
          (g) =>
            g.queueProgress?.phase === "waiting-publication" && g.queueProgress.note !== undefined,
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

  it.effect(
    "a merge conflict goes back to the same conversation, with the merge prepared in its worktree",
    () =>
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

        // The conflict does NOT start another worker: T2's own conversation is continued, in its own
        // worktree, with the merge already started and only the real conflict left.
        const t2 = flow.createdFor("T2")!;
        const turns = yield* flow.waitFor("thread.turn.start", 3);
        const resume = turns.at(-1);
        expect(resume?.type === "thread.turn.start" && resume.threadId).toBe(t2.threadId);
        const text = resume?.type === "thread.turn.start" ? resume.message.text : "";
        expect(text).toContain("shared.txt");
        expect(text).toContain("merge");
        // The conversation is durably bound to its task worktree before the prompt is sent.
        const bind = flow.log.findIndex(
          (c) => c.type === "thread.workspace.bind" && c.threadId === t2.threadId,
        );
        const bound = flow.log[bind];
        expect(bound).toMatchObject({
          type: "thread.workspace.bind",
          branch: t2.branch,
          worktreePath: t2.worktreePath,
        });
        expect(bind).toBeLessThan(flow.log.indexOf(resume!));
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
        expect(yield* flow.taskRow("T2")).toMatchObject({
          status: "claimed",
          integration_state: "repairing",
        });
        const cwd = t2.worktreePath!;
        const status = yield* Effect.promise(
          async () => (await execCommand("git", ["status", "--porcelain"], cwd)).stdout,
        );
        expect(status).toContain("UU shared.txt");

        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(cwd, "shared.txt"), "from T1 and T2\n");
          await execCommand("git", ["add", "shared.txt"], cwd);
          await execCommand("git", ["commit", "-qm", "resolve"], cwd);
        });
        yield* flow.sessionEvent(t2.threadId, { status: "running", activeTurnId: "r" });
        yield* flow.sessionEvent(t2.threadId, { status: "ready", activeTurnId: null });
        const done = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "complete",
          "the goal to complete",
        );
        expect(done.chats.every((chat) => chat.status !== "running")).toBe(true);
        // One conversation per task all the way: two chats, one resumed once.
        expect(done.chats).toHaveLength(2);
        expect(done.chats.find((chat) => chat.taskId === "T2")?.resumes).toBe(1);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(flow.repo.rootDir, "shared.txt"), "utf8"),
          ),
        ).toBe("from T1 and T2\n");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a failed workspace bind sends nothing, keeps the task out of new chats, and the retry sends exactly one resume",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]), {
          extraFiles: { "shared.txt": "base\n" },
          bindFailures: 1,
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

        // The bind failed: no resume turn was sent to T2 and no chat opened in the root.
        const t2 = flow.createdFor("T2")!;
        yield* flow.eventually(
          Effect.sync(() => flow.bindAttempts()),
          (attempts) => attempts >= 1,
          "the first bind attempt",
        );
        // The claim is released back to the repair queue (a conflict awaiting its owner), with no
        // retry spent on the failed bind.
        yield* flow.eventually(
          flow.taskRow("T2"),
          (row) => row.status === "verifying" && row.integration_state === "conflict",
          "T2 to wait for its owner after the failed bind",
        );
        expect((yield* flow.taskRow("T2")).retry_count).toBe(0);
        const sentBefore = (yield* flow.commandsOf("thread.turn.start")).filter(
          (c) => c.threadId === t2.threadId,
        );
        expect(sentBefore).toHaveLength(1);
        expect(flow.log.filter((c) => c.type === "thread.workspace.bind")).toHaveLength(0);
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);

        // The owner wait expires and the scheduler hands the task back to its owner: the bind now
        // succeeds and exactly one resume is sent.
        yield* TestClock.adjust(Duration.seconds(25));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* flow.waitFor("thread.workspace.bind", 1);
        const turns = yield* flow.waitFor("thread.turn.start", 3);
        const resumes = turns.filter((c) => c.threadId === t2.threadId);
        expect(resumes).toHaveLength(2);
        expect(
          resumes.at(-1)?.type === "thread.turn.start" && resumes.at(-1)!.message.text,
        ).toContain("merge");
        expect(flow.log.filter((c) => c.type === "thread.workspace.bind")).toHaveLength(1);
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a check that keeps failing holds the worker for the overseer, and give-up hands its task back",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([
            {
              id: "T1",
              verify: "node -e \"process.exit(require('fs').existsSync('T1.txt') ? 3 : 0)\"",
            },
          ]),
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor({ overseer: true }));
        yield* flow.waitFor("thread.create", 1);
        const threadId = yield* flow.work("T1");
        yield* flow.waitFor("thread.turn.start", 2);
        yield* flow.work("T1", { content: "second\n" });
        yield* flow.waitFor("thread.turn.start", 3);
        yield* flow.work("T1", { content: "third\n" });
        // Two retries are spent; the third failure goes to an overseer instead of giving up.
        yield* flow.waitFor("thread.create", 2);
        const [held] = yield* service.list;
        const escalation = held?.escalations?.[0];
        expect(escalation).toMatchObject({
          kind: "repeated-failure",
          taskId: "T1",
          threadId,
        });
        expect(held?.chats.find((chat) => chat.threadId === threadId)).toMatchObject({
          status: "running",
          escalationId: escalation?.id,
        });
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");

        yield* service.resolveEscalation(
          escalation!.id,
          { action: "give-up", note: "Stop here." },
          "person",
        );
        const [after] = yield* service.list;
        expect(after?.escalations?.[0]).toMatchObject({
          status: "resolved",
          resolution: { action: "give-up", by: "person" },
        });
        // The original hand-back: the claim is given back, the task is no longer held.
        expect((yield* flow.taskRow("T1")).status).not.toBe("claimed");
        expect(after?.chats.find((chat) => chat.threadId === threadId)).toMatchObject({
          status: "failed",
          taskOutcome: "retry",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("a failing check sends the worker back with the failure, not a generic nudge", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(
        planWith([
          {
            id: "T1",
            verify: "node -e \"process.exit(require('fs').existsSync('T1.txt') ? 3 : 0)\"",
          },
        ]),
      );
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 1);
      yield* flow.work("T1");
      const turns = yield* flow.waitFor("thread.turn.start", 2);
      const text = turns[1]?.type === "thread.turn.start" ? turns[1].message.text : "";
      expect(text).toContain("check on your commit and it failed");
      expect(text).toContain("exited 3");
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

  /** Let the scheduler's slow tick run once (queue events every second, reconcile every five). */
  const tickOnce = Effect.gen(function* () {
    yield* TestClock.adjust(Duration.seconds(5));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(1));
    yield* Effect.yieldNow;
  });

  it.effect(
    "a turn that ends while a background test still runs is not finished: nothing is submitted, settled or removed until the test ends and the model is idle",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const worktree = flow.createdFor("T1")!.worktreePath!;
        const threadId = flow.createdFor("T1")!.threadId;

        // "I'll wait for the integration suite": the turn ends, the suite is still running.
        flow.liveness.set(threadId, "monitoring");
        yield* flow.work("T1", { reply: "The full suite is still running; I'll wait for it." });
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.settle")).toHaveLength(0);
        expect(flow.log.filter((c) => c.type === "thread.session.stop")).toHaveLength(0);
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        expect((yield* flow.goalOf(service)).chats[0]?.status).toBe("running");
        expect(NodeFS.existsSync(worktree)).toBe(true);

        // Safety review of the October 14 stall: neither a slow-pass deadline nor elapsed
        // background-work time permits the scheduler to terminate a real command.
        yield* TestClock.adjust(Duration.hours(4));
        yield* flow.drain;
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        expect(
          flow.log.filter((c) => c.type === "thread.settle" || c.type === "thread.session.stop"),
        ).toHaveLength(0);

        // A failed liveness read is unknown activity, never evidence that it is safe to settle.
        flow.liveness.delete(threadId);
        flow.scripts.set(threadId, { ...flow.scripts.get(threadId)!, livenessReadFails: true });
        yield* tickOnce;
        yield* flow.drain;
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        flow.scripts.set(threadId, { ...flow.scripts.get(threadId)!, livenessReadFails: false });

        // The suite ends but the worker was woken by it and is writing again: still not done.
        flow.liveness.delete(threadId);
        flow.scripts.set(threadId, { ...flow.scripts.get(threadId)!, busy: true });
        yield* tickOnce;
        yield* flow.drain;
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        expect(flow.log.filter((c) => c.type === "thread.settle")).toHaveLength(0);

        // Genuinely finished: no turn, no background job. Now it is checked, merged and settled.
        flow.scripts.set(threadId, { ...flow.scripts.get(threadId)!, busy: false });
        yield* tickOnce;
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge once it is really finished",
        );
        yield* flow.waitFor("thread.settle", 1);
        expect(yield* flow.landings("T1")).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a usage limit cannot release or salvage files while background work runs, and a failed release keeps them intact",
    () =>
      Effect.gen(function* () {
        const faults = { release: false };
        const flow = yield* makeFlow(planWith([{ id: "T1" }]), { queueFaults: faults });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor({ autoResume: false }));
        yield* flow.waitFor("thread.create", 1);
        const created = flow.createdFor("T1")!;
        flow.liveness.set(created.threadId, "working");
        yield* flow.work("T1");
        NodeFS.writeFileSync(
          NodePath.join(created.worktreePath!, "still-working.txt"),
          "preserve me",
        );
        yield* flow.sessionEvent(created.threadId, {
          status: "error",
          activeTurnId: null,
          lastErrorClass: "usage_limit",
        });
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.drain;
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        expect(
          flow.log.filter(
            (c) =>
              c.type === "thread.delete" ||
              c.type === "thread.settle" ||
              c.type === "thread.session.stop",
          ),
        ).toHaveLength(0);
        faults.release = true;
        flow.liveness.delete(created.threadId);
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats[0]?.taskOutcome === "returned",
          "the deferred usage limit to be processed",
        );
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        expect(NodeFS.existsSync(created.worktreePath!)).toBe(true);
        const status = yield* Effect.promise(() =>
          execCommand("git", ["status", "--porcelain"], created.worktreePath!),
        );
        expect(status.code).toBe(0);
        expect(status.stdout).toContain("?? still-working.txt");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a replaced claim cannot authorize stopping an earlier active writer on the same worktree",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const goal = yield* flow.goalOf(service);
        const original = goal.chats[0]!;
        const earlierId = ThreadId.make("earlier-active-writer");
        flow.scripts.set(original.threadId, {
          reply: "Waiting",
          turnState: "completed",
          progress: false,
          lastError: null,
        });
        flow.scripts.set(earlierId, {
          reply: "Still working",
          turnState: "running",
          progress: true,
          lastError: null,
          busy: true,
        });
        yield* flow.goalStore.update(goal.id, (current) => ({
          ...current,
          chats: [
            {
              ...original,
              threadId: earlierId,
              taskId: "OLDER",
              claimToken: "released-earlier-token",
            },
            { ...original, status: "completed", taskOutcome: "returned" },
          ],
        }));
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        try {
          releaseClaim(db, { ownerToken: original.claimToken!, finalStatus: "pending" });
        } finally {
          db.close();
        }
        yield* service.addAgents(goal.id, 1);
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.session.stop")).toHaveLength(0);
        expect(flow.log.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
        expect(NodeFS.existsSync(original.worktreePath!)).toBe(true);
        expect((yield* flow.taskRow("T1")).status).toBe("pending");
      }).pipe(Effect.scoped),
  );

  it.effect("the queue teardown boundary refuses to touch any claimed worktree", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1" }]));
      const service = yield* flow.startServer;
      yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 1);
      const created = flow.createdFor("T1")!;
      const goal = yield* flow.goalOf(service);
      const queue = yield* AgentQueueService.pipe(Effect.provide(AgentQueueServiceLive));
      NodeFS.writeFileSync(NodePath.join(created.worktreePath!, "owned.txt"), "active edits");
      for (const landed of [false, true]) {
        const outcome = yield* queue.teardown(
          goal.agentQueue!,
          created.worktreePath!,
          goal.chats[0]!.branch!,
          landed,
        );
        expect(outcome.preserved).toBe(true);
      }
      expect(NodeFS.existsSync(created.worktreePath!)).toBe(true);
      expect((yield* flow.taskRow("T1")).status).toBe("claimed");
      const status = yield* Effect.promise(() =>
        execCommand("git", ["status", "--porcelain"], created.worktreePath!),
      );
      expect(status.code).toBe(0);
      expect(status.stdout).toContain("?? owned.txt");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a worktree stays while the last turn's checkpoint is unsaved, then is removed once, with no worker left behind",
    () =>
      Effect.gen(function* () {
        const faults = { claims: false };
        const flow = yield* makeFlow(planWith([{ id: "T1" }]), { queueFaults: faults });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const created = flow.createdFor("T1")!;
        yield* flow.work("T1", { checkpoint: "pending" });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        yield* tickOnce;
        expect(NodeFS.existsSync(created.worktreePath!)).toBe(true);

        faults.claims = true;
        flow.scripts.set(created.threadId, {
          ...flow.scripts.get(created.threadId)!,
          checkpoint: "saved",
        });
        yield* tickOnce;
        expect(NodeFS.existsSync(created.worktreePath!)).toBe(true);
        faults.claims = false;
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.eventually(
          Effect.sync(() => NodeFS.existsSync(created.worktreePath!)),
          (exists) => !exists,
          "the worktree to be removed after its checkpoint was saved",
        );
        const goal = yield* flow.goalOf(service);
        expect(goal.chats[0]?.worktreeRetired).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a committed worker that ends with NEEDS ATTENTION keeps its verified work and parks the request as its own task",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1", {
          reply:
            "Implemented and tested.\n\nNEEDS ATTENTION: deploying this needs an owner decision about the tunnel.",
        });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "the committed work to merge",
        );
        expect(yield* flow.landings("T1")).toBe(1);
        const followUp = yield* flow.taskRow("T1-FU1");
        expect(followUp.status).toBe("blocked");
        // Parked work is open work: the plan is not reported as done.
        yield* tickOnce;
        expect((yield* flow.goalOf(service)).status).not.toBe("complete");
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        const note = db.prepare("SELECT description FROM tasks WHERE id = 'T1-FU1'").get() as {
          description: string;
        };
        db.close();
        expect(note.description).toContain("owner decision about the tunnel");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "NEEDS ATTENTION with nothing committed parks the task for a person instead of retrying it",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1", { commit: false, reply: "NEEDS ATTENTION: I need a login." });
        const goal = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats[0]?.status === "attention",
          "the worker to be recorded as needing a person",
        );
        expect(goal.chats[0]?.taskOutcome).toBe("attention");
        expect((yield* flow.taskRow("T1")).status).toBe("blocked");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "prose Done lines with several commands become one real check whose exact failure is kept",
    () =>
      Effect.gen(function* () {
        const plan = [
          "# Flow plan",
          "",
          "- [ ] **T1 — Task T1.**",
          "  - Depends on: none.",
          '  - Done: run `node -e "process.exit(0)"` first and then `node scripts/check5.js`; record the result.',
          "",
        ].join("\n");
        const flow = yield* makeFlow(plan, {
          extraFiles: {
            "package.json": '{"type":"commonjs"}\n',
            "scripts/check5.js": "process.exit(require('fs').existsSync('T1.txt') ? 5 : 0);\n",
          },
        });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1");
        const turns = yield* flow.waitFor("thread.turn.start", 2);
        const text = turns[1]?.type === "thread.turn.start" ? turns[1].message.text : "";
        expect(text).toContain("exited 5");
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        const event = db
          .prepare(
            "SELECT payload_json FROM task_events WHERE task_id = 'T1' AND event_type = 'task_verification_failed'",
          )
          .get() as { payload_json: string };
        db.close();
        const payload = JSON.parse(event.payload_json) as {
          state: string;
          source: string;
          checks: Array<{ exitCode: number; passed: boolean }>;
        };
        expect(payload).toMatchObject({ state: "failed", source: "derived" });
        expect(payload.checks.map((check) => [check.exitCode, check.passed])).toEqual([
          [0, true],
          [5, false],
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a restart between a worker finishing and its submission still checks, merges and settles it",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        // The first server never consumes the worker's events: it is gone before it sees them.
        const first = yield* flow.startServer;
        yield* first.create(settingsFor());
        const created = (yield* flow.waitFor("thread.create", 1))[0]!;
        yield* Effect.promise(async () => {
          const cwd = created.worktreePath!;
          await NodeFSP.writeFile(NodePath.join(cwd, "T1.txt"), "T1\n");
          await execCommand("git", ["add", "-A"], cwd);
          await execCommand("git", ["commit", "-m", "T1: implement"], cwd);
        });
        flow.scripts.set(created.threadId, {
          reply: "Done.",
          turnState: "completed",
          progress: true,
          lastError: null,
        });
        const second = yield* flow.startServer;
        yield* Effect.forkScoped(second.loop);
        yield* Effect.yieldNow;
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge after the restart",
        );
        expect(yield* flow.landings("T1")).toBe(1);
        yield* flow.waitFor("thread.settle", 1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a standard goal waits for a worker's background job too, then finishes it normally",
    () =>
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
        flow.liveness.set(first!.threadId, "working");
        flow.scripts.set(first!.threadId, {
          reply: "Tests are still running.",
          turnState: "completed",
          progress: true,
          lastError: null,
        });
        yield* flow.sessionEvent(first!.threadId, { status: "running", activeTurnId: "t" });
        yield* flow.sessionEvent(first!.threadId, { status: "ready", activeTurnId: null });
        for (let round = 0; round < 2; round++) yield* tickOnce;
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(1);
        expect((yield* flow.goalOf(service)).chats[0]?.status).toBe("running");

        flow.liveness.delete(first!.threadId);
        yield* tickOnce;
        // Finished for real: the lane frees and the next worker starts.
        yield* flow.waitFor("thread.create", 2);
        expect((yield* flow.goalOf(service)).chats[0]?.status).toBe("completed");
      }).pipe(Effect.scoped),
  );

  it.effect("a finished goal still gets its landed worktrees removed", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(planWith([{ id: "T1" }]));
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 1);
      const worktree = flow.createdFor("T1")!.worktreePath!;
      yield* flow.work("T1", { checkpoint: "pending" });
      yield* flow.eventually(
        flow.goalOf(service),
        (g) => g.status === "complete",
        "the goal to complete",
      );
      expect(NodeFS.existsSync(worktree)).toBe(true);
      flow.scripts.set(flow.createdFor("T1")!.threadId, {
        ...flow.scripts.get(flow.createdFor("T1")!.threadId)!,
        checkpoint: "saved",
      });
      yield* tickOnce;
      yield* flow.eventually(
        Effect.sync(() => NodeFS.existsSync(worktree)),
        (exists) => !exists,
        "the worktree to be removed after the goal finished",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "without declared checks a NEEDS ATTENTION request blocks everything that waited on the task",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([
            { id: "T1", verify: "" },
            { id: "T2", deps: ["T1"] },
          ]),
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1", {
          reply: "Mostly done.\n\nNEEDS ATTENTION: the migration is not written yet.",
        });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        expect((yield* flow.taskRow("T1-FU1")).status).toBe("blocked");
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        const deps = () =>
          (
            db.prepare("SELECT dependencies FROM tasks WHERE id = 'T2'").get() as {
              dependencies: string;
            }
          ).dependencies;
        expect(JSON.parse(deps())).toEqual(["T1", "T1-FU1"]);
        db.close();
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.drain;
        // T2 must not start on top of an unfinished requirement, and the goal is not done.
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(1);
        const goal = yield* flow.goalOf(service);
        expect(goal.status).not.toBe("complete");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "with declared checks that passed, the follow-up is optional: dependants still start",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2", deps: ["T1"] }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1", {
          reply: "Done.\n\nNEEDS ATTENTION: consider a nicer error message.",
        });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        expect((yield* flow.taskRow("T1-FU1")).status).toBe("blocked");
        const creates = yield* flow.waitFor("thread.create", 2);
        expect(creates[1]?.title).toContain("T2");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a task merged with no check and no exemption is reported, and the goal does not claim completion",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1", verify: "" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1");
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        for (let round = 0; round < 3; round++) yield* tickOnce;
        const goal = yield* flow.goalOf(service);
        expect(goal.status).not.toBe("complete");
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        const receipt = db.prepare("SELECT receipt_json FROM tasks WHERE id = 'T1'").get() as {
          receipt_json: string;
        };
        db.close();
        expect(JSON.parse(receipt.receipt_json)).toMatchObject({ state: "unverified" });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a repair waits for its owner while the owner is still running a turn, instead of putting a second writer in the worktree",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]), {
          extraFiles: { "shared.txt": "base\n" },
          spacingMillis: 5_000,
        });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* tickOnce;
        yield* flow.waitFor("thread.create", 2);
        yield* flow.work("T1", { file: "shared.txt", content: "from T1\n" });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        yield* flow.work("T2", { file: "shared.txt", content: "from T2\n" });
        yield* flow.eventually(
          flow.taskRow("T2"),
          (row) => row.integration_state === "conflict",
          "T2 to conflict",
        );
        // The T2 worker is woken by a background job just as the repair is about to start.
        const first = flow.createdFor("T2")!.threadId;
        flow.scripts.set(first, { ...flow.scripts.get(first)!, busy: true });
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.drain;
        // Nothing new is started and the busy worker is not stopped: it is the one that will repair.
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
        expect(flow.log.filter((c) => c.type === "thread.session.stop")).toHaveLength(0);
        // Once it is quiet, the same conversation is asked to finish the merge.
        flow.scripts.set(first, { ...flow.scripts.get(first)!, busy: false });
        yield* tickOnce;
        const resumed = yield* flow.awaitCommand(
          (c) =>
            c.type === "thread.turn.start" &&
            c.threadId === first &&
            c.message.text.includes("shared.txt"),
        );
        expect(resumed).toBeDefined();
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
      }).pipe(Effect.scoped),
  );

  const GUARD = [
    'import { execFileSync } from "node:child_process";',
    'const branch = execFileSync("git", ["branch", "--show-current"]).toString().trim();',
    'if (!branch.startsWith("agent/") && !branch.startsWith("agent-plan/")) {',
    '  console.error("ERROR: refusing to work outside an isolated agent branch; current branch is " + branch);',
    "  process.exit(1);",
    "}",
    "",
  ].join("\n");
  const GUARDED = {
    "tools/guard.mjs": GUARD,
    "AGENTS.md":
      "Every automated worker must run `node tools/guard.mjs` (the checkout guard) before its first repository write.\n",
  };

  it.effect(
    "a repository whose guard rejects the default branch convention: the worker starts on an accepted branch and is told the repository's own commands",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]), { extraFiles: GUARDED });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        const [created] = yield* flow.waitFor("thread.create", 1);
        expect(created?.branch).toMatch(/^agent\//);
        const prompt = turnsOf(flow.log)
          .map((t) => (t.type === "thread.turn.start" ? t.message.text : ""))
          .join("\n");
        expect(prompt).toContain("node tools/guard.mjs");
        expect(prompt).toContain("AGENTQUEUE_DB_NAME");
        yield* flow.work("T1");
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge",
        );
        expect(yield* flow.landings("T1")).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a retried task whose branch already holds commits that pass its check is submitted without starting another worker",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const created = flow.createdFor("T1")!;
        // The worker finished the implementation, then its turn broke before it could say so.
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(created.worktreePath!, "T1.txt"), "done\n");
          await execCommand("git", ["add", "-A"], created.worktreePath!);
          await execCommand("git", ["commit", "-m", "T1: implement"], created.worktreePath!);
        });
        flow.scripts.set(created.threadId, {
          reply: "",
          turnState: "error",
          progress: true,
          lastError: null,
        });
        yield* flow.sessionEvent(created.threadId, { status: "running", activeTurnId: "turn-1" });
        yield* flow.sessionEvent(created.threadId, { status: "ready", activeTurnId: null });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "the kept commits to be checked and merged",
        );
        expect(yield* flow.landings("T1")).toBe(1);
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a missing prerequisite holds the task without a worker or a failure, and the goal resumes by itself once it exists",
    () =>
      Effect.gen(function* () {
        const flagDir = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/goal-flow-tool-"));
        const flag = NodePath.join(flagDir, "installed");
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]), {
          extraFiles: {
            ".agentqueue/contract.json": JSON.stringify({
              tools: [{ name: "needed-tool", probe: `test -f ${flag}` }],
            }),
          },
        });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(0);
        expect((yield* flow.taskRow("T1")).status).toBe("blocked");
        const waiting = yield* flow.goalOf(service);
        expect(waiting.status).toBe("running");
        expect(waiting.detail).toContain("Waiting for the environment");
        expect(waiting.chats).toHaveLength(0);

        yield* Effect.promise(() => NodeFSP.writeFile(flag, "ok"));
        yield* tickOnce;
        yield* flow.waitFor("thread.create", 2);
        expect((yield* flow.taskRow("T1")).retry_count).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a worker that explains a problem and ends with a bare NEEDS ATTENTION keeps its explanation on the parked task",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        yield* flow.work("T1", {
          reply:
            "Implemented it. The live apply needs the recovery key and a reviewed plan hash from a person with production access.\n\nNEEDS ATTENTION",
        });
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "the committed work to merge",
        );
        const db = openQueueDatabase({ gitCommonDir: flow.repo.gitCommonDir });
        const note = db
          .prepare("SELECT description, failure_class, status FROM tasks WHERE id = 'T1-FU1'")
          .get() as { description: string; failure_class: string | null; status: string };
        db.close();
        expect(note.description).toContain("recovery key");
        // Production access is something the environment must provide, not a retry or an overseer.
        expect(note.failure_class).toBe("external");
        expect(note.status).toBe("blocked");
      }).pipe(Effect.scoped),
  );
  liveIt.live(
    "a worker that queued a command for a busy resource is parked without using a lane, and its own conversation gets the result",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2" }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        // One lane: if the parked worker kept it, T2 could never start.
        yield* service.create(
          settingsFor({
            concurrency: 1,
            agents: settingsFor().agents.map((a) => ({ ...a, count: 1 })),
          }),
        );
        yield* flow.waitFor("thread.create", 1);
        const first = flow.createdFor("T1") ?? flow.createdFor("T2")!;
        const firstTask = flow.createdFor("T1") ? "T1" : "T2";

        // Something else holds the emulator; the worker's `agentq run` stored its command as a job.
        const broker = openBroker();
        const hints = { "test-emulator": { capacity: 1 } };
        broker.enqueue({
          resources: [{ name: "test-emulator" }],
          pid: process.pid,
          label: "someone else",
          hints,
        });
        broker.pump();
        const holder = broker.status().resources.find((r) => r.name === "test-emulator")!
          .holders[0]!.ticket;
        const job = broker.enqueue({
          resources: [{ name: "test-emulator" }],
          ownerRef: firstTask,
          repo: flow.repo.gitCommonDir,
          label: "connected tests",
          hints,
          job: { command: "echo emulator-tests-passed", cwd: flow.repo.rootDir },
        });
        yield* flow.work(firstTask, { reply: "Queued the emulator run.\nWAITING FOR " + job.id });

        // Parked: not submitted, not failed, not holding the lane, claim kept.
        const parked = yield* flow.eventually(
          flow.goalOf(service),
          (g) =>
            g.chats.some((chat) => chat.taskId === firstTask && chat.taskOutcome === "waiting"),
          "the worker to be parked on its stored job",
        );
        expect(parked.chats.find((chat) => chat.taskId === firstTask)?.resourceJobs).toEqual([
          job.id,
        ]);
        expect((yield* flow.taskRow(firstTask)).status).toBe("claimed");
        // The freed lane starts the other task; no extra chat for the parked one.
        const creates = yield* flow.waitFor("thread.create", 2);
        expect(creates).toHaveLength(2);

        // The emulator frees up: the server runs the stored command and tells the SAME conversation.
        broker.finish(holder, { outcome: "ok" });
        broker.close();
        const resumed = yield* flow.awaitCommand(
          (turn) =>
            turn.type === "thread.turn.start" &&
            turn.threadId === first.threadId &&
            turn.message.text.includes("emulator-tests-passed"),
        );
        expect(resumed).toBeDefined();
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);

        // The worker finishes after the result: now the work is submitted and merged.
        yield* flow.sessionEvent(first.threadId, { status: "running", activeTurnId: "turn-2" });
        yield* flow.sessionEvent(first.threadId, { status: "ready", activeTurnId: null });
        yield* flow.eventually(
          flow.taskRow(firstTask),
          (row) => row.status === "completed",
          "the resumed worker's task to merge",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "a task that needs a file another running task holds is parked, and continues in its own conversation when the file is free",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([
            { id: "T1", scope: "src/a/" },
            { id: "T2", scope: "src/b/" },
          ]),
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 2);
        // T1 needs a file that belongs to T2's area while T2 is still working.
        yield* flow.work("T1", { file: "src/a/one.ts", content: "1\n" });
        yield* Effect.promise(async () => {
          const cwd = flow.createdFor("T1")!.worktreePath!;
          await NodeFSP.mkdir(NodePath.join(cwd, "src/b"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(cwd, "src/b/shared.ts"), "needed by T1\n");
          await execCommand("git", ["add", "-A"], cwd);
          await execCommand("git", ["commit", "-qm", "T1 touches T2's file"], cwd);
        });
        yield* flow.sessionEvent(flow.createdFor("T1")!.threadId, {
          status: "running",
          activeTurnId: "x",
        });
        yield* flow.sessionEvent(flow.createdFor("T1")!.threadId, {
          status: "ready",
          activeTurnId: null,
        });
        const parked = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats.find((chat) => chat.taskId === "T1")?.taskOutcome === "returned",
          "T1 to be parked for the file",
        );
        expect(parked.chats.find((chat) => chat.taskId === "T1")?.status).toBe("completed");
        expect((yield* flow.taskRow("T1")).status).toBe("pending");
        expect(parked.status).toBe("running");

        // T2 finishes and lands; T1 is continued in its own conversation, not a new one.
        yield* flow.work("T2", { file: "src/b/two.ts", content: "2\n" });
        const turns = yield* flow.waitFor("thread.turn.start", 3);
        const again = turns.at(-1);
        expect(again?.type === "thread.turn.start" && again.threadId).toBe(
          flow.createdFor("T1")!.threadId,
        );
        expect(again?.type === "thread.turn.start" && again.message.text).toContain("free now");
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);
        yield* flow.sessionEvent(flow.createdFor("T1")!.threadId, {
          status: "running",
          activeTurnId: "y",
        });
        yield* flow.sessionEvent(flow.createdFor("T1")!.threadId, {
          status: "ready",
          activeTurnId: null,
        });
        const done = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "complete",
          "the goal to complete",
        );
        expect(done.chats).toHaveLength(2);
      }).pipe(Effect.scoped),
  );
  liveIt.live(
    "a restart while a worker waits on a stored job parks it, runs the job, and tells the same conversation",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }]));
        const first = yield* flow.startServer;
        yield* first.create(settingsFor());
        const created = (yield* flow.waitFor("thread.create", 1))[0]!;
        const broker = openBroker();
        const hints = { "restart-emulator": { capacity: 1 } };
        broker.enqueue({
          resources: [{ name: "restart-emulator" }],
          pid: process.pid,
          label: "someone else",
          hints,
        });
        broker.pump();
        const holder = broker.status().resources.find((r) => r.name === "restart-emulator")!
          .holders[0]!.ticket;
        const job = broker.enqueue({
          resources: [{ name: "restart-emulator" }],
          ownerRef: "T1",
          repo: flow.repo.gitCommonDir,
          hints,
          job: { command: "echo survived-the-restart", cwd: flow.repo.rootDir },
        });
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(created.worktreePath!, "T1.txt"), "T1\n");
          await execCommand("git", ["add", "-A"], created.worktreePath!);
          await execCommand("git", ["commit", "-m", "T1: implement"], created.worktreePath!);
        });
        // The worker's turn ended with its command queued while the server was down.
        flow.scripts.set(created.threadId, {
          reply: "Queued.\nWAITING FOR " + job.id,
          turnState: "completed",
          progress: true,
          lastError: null,
        });
        const second = yield* flow.startServer;
        yield* Effect.forkScoped(second.loop);
        yield* Effect.yieldNow;
        yield* flow.eventually(
          flow.goalOf(second),
          (g) => g.chats[0]?.taskOutcome === "waiting",
          "the recovered worker to be parked on its job",
        );
        expect((yield* flow.taskRow("T1")).status).toBe("claimed");
        broker.finish(holder, { outcome: "ok" });
        broker.close();
        const delivered = yield* flow.awaitCommand(
          (c) =>
            c.type === "thread.turn.start" &&
            c.threadId === created.threadId &&
            c.message.text.includes("survived-the-restart"),
        );
        expect(delivered).toBeDefined();
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  // ───────────── a stalled queue: stale chats, missed events, blocked tasks ─────────────

  /** A check that fails with a named failing item until `open` exists in the folder. */
  const gatedCheck = (dir: string) => ({
    fileName: "gate.cjs",
    command: "node gate.cjs",
    source: `const fs=require('fs');const path=require('path');if(!fs.existsSync(path.join(${JSON.stringify(dir)},'open'))){console.log('FAILED gate_check');process.exit(1)}\n`,
  });

  it.effect(
    "a conversation that went quiet without its end being seen cannot hold files forever: independent tasks keep running, the held one is finished, and the goal says what blocked it",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([
            { id: "T1", scope: "shared/" },
            { id: "T2", scope: "shared/" },
            { id: "T3", scope: "other/" },
          ]),
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        const [created] = yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 2);

        // T1 and T3 run; T2 is ready but waits for T1's files. The goal says so, with who holds them.
        expect(created!.chats.map((chat) => chat.taskId).sort()).toEqual(["T1", "T3"]);
        const blocked = yield* flow.goalOf(service);
        expect(blocked.queueProgress?.ready).toBe(1);
        expect(blocked.queueProgress?.stall).toMatchObject({ taskIds: ["T2"] });
        expect(blocked.queueProgress?.stall?.summary).toContain("T2 waiting for files held by T1");
        // Clicking "+3 agents" with room but nothing startable starts nothing and still says why.
        const afterClick = yield* service.addAgents(blocked.id, 3);
        expect(afterClick[0]?.queueProgress?.stall?.summary).toContain("held by T1");
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);

        // T1's worker finishes, but the notification is lost: the thread is idle, the chat still "running".
        // T3's worker is genuinely still working.
        const t1 = flow.createdFor("T1")!;
        const t3 = flow.createdFor("T3")!;
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(t1.worktreePath!, "shared"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(t1.worktreePath!, "shared/one.txt"), "1\n");
          await execCommand("git", ["add", "-A"], t1.worktreePath!);
          await execCommand("git", ["commit", "-qm", "T1: implement"], t1.worktreePath!);
        });
        flow.scripts.set(t3.threadId, {
          reply: "",
          turnState: "running",
          progress: true,
          lastError: null,
          busy: true,
        });

        // Not yet: it only just stopped, and a lost event is not assumed on a hunch.
        yield* TestClock.adjust(Duration.seconds(30));
        yield* flow.drain;
        expect(flow.log.filter((c) => c.type === "thread.create")).toHaveLength(2);

        // The scheduler stops waiting for an event that is not coming, finishes the chat from the
        // thread's own state, lands T1, frees its files, and T2 starts. T3 is never touched.
        for (let round = 0; round < 40; round++) yield* tickOnce;
        yield* flow.awaitCommand((c) => c.type === "thread.create" && c.title.includes("T2"));
        const creates = flow.log.filter((c) => c.type === "thread.create");
        expect(creates).toHaveLength(3);
        expect(creates.some((c) => c.type === "thread.create" && c.title.includes("T2"))).toBe(
          true,
        );
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to finish integration after releasing its scope",
        );
        const after = yield* flow.goalOf(service);
        expect(after.chats.find((chat) => chat.taskId === "T1")?.status).toBe("completed");
        expect(after.chats.find((chat) => chat.taskId === "T3")?.status).toBe("running");
        // Nothing is blocked any more, and the goal stops saying so.
        yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.queueProgress?.stall === undefined,
          "the stall note to clear",
        );
        expect(flow.log.filter((c) => c.type === "thread.session.stop")).toHaveLength(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a repair follow-up whose owner finds nothing to fix completes without a commit, and the work waiting on it continues",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goal-fu-"));
        const check = gatedCheck(dir);
        const flow = yield* makeFlow(
          planWith([
            { id: "T1", scope: "s/", verify: check.command },
            { id: "T2", scope: "other/" },
            { id: "T3", deps: ["T1"], scope: "t/" },
          ]),
          { extraFiles: { [check.fileName]: check.source } },
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 2);

        // T1 is submitted while its check fails the same way on the integration branch: the failure
        // is tracked as its own blocking follow-up, and T1's own conversation is asked to look at it.
        yield* flow.work("T1", { file: "s/one.txt", content: "1\n" });
        const t1 = flow.createdFor("T1")!;
        const resumed = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.chats.find((chat) => chat.taskId === "T1-FU1") !== undefined,
          "T1's conversation to be sent the follow-up",
        );
        expect(resumed.chats.find((chat) => chat.threadId === t1.threadId)?.taskId).toBe("T1-FU1");
        expect((yield* flow.taskRow("T1-FU1")).status).toBe("claimed");

        // The follow-up's owner reruns the check, finds it passing (the gate has opened since) and has
        // nothing to commit. Its turn ends. Even if the thread reports the turn as older than the resume.
        NodeFS.writeFileSync(NodePath.join(dir, "open"), "yes\n");
        flow.scripts.set(t1.threadId, {
          reply: "I reran the check and it passes; there is nothing to change.",
          turnState: "completed",
          progress: true,
          lastError: null,
          turn: { requestedAt: "1969-12-31T00:00:00.000Z" },
        });
        yield* flow.sessionEvent(t1.threadId, { status: "running", activeTurnId: "again" });
        yield* flow.sessionEvent(t1.threadId, { status: "ready", activeTurnId: null });

        yield* flow.eventually(
          flow.taskRow("T1-FU1"),
          (row) => row.status === "completed",
          "the follow-up to be resolved by the server's own check",
        );
        // No fake commit was demanded of the owner or made for it.
        const turnTexts = flow.log
          .filter((c) => c.type === "thread.turn.start")
          .map((c) => (c.type === "thread.turn.start" ? c.message.text : ""));
        expect(turnTexts.some((text) => text.includes("found no commit"))).toBe(false);
        // The dependant that waited on the follow-up starts, in a new conversation, and nothing else is spawned for it.
        yield* flow.waitFor("thread.create", 3);
        expect(flow.createdFor("T3")).toBeDefined();
        const done = yield* flow.goalOf(service);
        expect(done.chats.filter((chat) => chat.taskId === "T1-FU1")).toHaveLength(1);
        expect(done.chats.find((chat) => chat.threadId === t1.threadId)?.status).toBe("completed");
      }).pipe(Effect.scoped),
  );

  it.effect("clicking +N agents with several ready tasks and room starts them all at once", () =>
    Effect.gen(function* () {
      const flow = yield* makeFlow(
        planWith([{ id: "T1" }, { id: "T2" }, { id: "T3" }, { id: "T4" }]),
      );
      const service = yield* flow.startServer;
      const [goal] = yield* service.create(settingsFor({ concurrency: 1, maxChats: null }));
      expect(goal?.chats).toHaveLength(1);
      const after = yield* service.addAgents(goal!.id, 3);
      expect(after[0]?.chats).toHaveLength(4);
      expect(after[0]?.concurrency).toBe(4);
      expect(after[0]?.queueProgress?.stall).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a transient queue error loses no work: scheduling resumes by itself once the queue is readable again",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2", deps: ["T1"] }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const dbFile = NodePath.join(flow.repo.gitCommonDir, "agentqueue", "queue.sqlite");
        const hidden = `${dbFile}.away`;
        // The queue database is unreadable for a moment (a disk hiccup, a restore in progress).
        NodeFS.renameSync(dbFile, hidden);
        NodeFS.mkdirSync(dbFile);
        yield* tickOnce;
        yield* tickOnce;
        NodeFS.rmdirSync(dbFile);
        NodeFS.renameSync(hidden, dbFile);
        const goal = yield* flow.goalOf(service);
        expect(goal.status).toBe("running");
        // Work carries on and finishes as if nothing happened.
        yield* flow.work("T1");
        yield* flow.waitFor("thread.create", 2);
        yield* flow.work("T2");
        const done = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "complete",
          "the goal to complete after the queue came back",
        );
        expect(done.queueErrors ?? 0).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a queue database that stays locked under load waits instead of stopping the goal",
    () =>
      Effect.gen(function* () {
        const faults = { locked: false };
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2", deps: ["T1"] }]), {
          queueFaults: faults,
        });
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        faults.locked = true;
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.eventually(
          flow.goalOf(service),
          (g) => (g.queueErrors ?? 0) >= 3,
          "the locked queue to be observed several times",
        );
        yield* TestClock.adjust(Duration.minutes(10));
        for (let round = 0; round < 6; round++) yield* tickOnce;
        const goal = yield* flow.eventually(
          flow.goalOf(service),
          (g) => (g.queueErrors ?? 0) >= 4,
          "another locked tick after the outage window",
        );
        expect(goal.status).toBe("running");
        expect(goal.detail).toContain("database is locked");
        faults.locked = false;
      }).pipe(Effect.scoped),
  );

  it.effect("a submission that meets a locked queue database is sent again, not failed", () =>
    Effect.gen(function* () {
      const faults = { submitLocked: false };
      const flow = yield* makeFlow(planWith([{ id: "T1" }]), { queueFaults: faults });
      const service = yield* flow.startServer;
      yield* Effect.forkScoped(service.loop);
      yield* Effect.yieldNow;
      yield* service.create(settingsFor());
      yield* flow.waitFor("thread.create", 1);
      faults.submitLocked = true;
      yield* flow.work("T1");
      yield* flow.eventually(
        flow.goalOf(service),
        (g) => (g.queueErrors ?? 0) >= 1,
        "the submission to meet the locked database",
      );
      const held = (yield* flow.goalOf(service)).chats[0]!;
      expect(held.status).not.toBe("failed");
      expect(held.taskOutcome).toBeUndefined();
      faults.submitLocked = false;
      yield* tickOnce;
      yield* flow.eventually(
        flow.goalOf(service),
        (g) => g.status === "complete",
        "the goal to complete once the queue answers",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an outage that really lasts still stops the goal, with the reason, rather than looping forever",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(planWith([{ id: "T1" }, { id: "T2", deps: ["T1"] }]));
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor());
        yield* flow.waitFor("thread.create", 1);
        const dbFile = NodePath.join(flow.repo.gitCommonDir, "agentqueue", "queue.sqlite");
        NodeFS.renameSync(dbFile, `${dbFile}.away`);
        NodeFS.mkdirSync(dbFile);
        for (let round = 0; round < 3; round++) yield* tickOnce;
        yield* flow.eventually(
          flow.goalOf(service),
          (g) => (g.queueErrors ?? 0) > 0,
          "the outage to be observed before advancing its duration",
        );
        yield* TestClock.adjust(Duration.minutes(4));
        for (let round = 0; round < 6; round++) yield* tickOnce;
        const goal = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "failed",
          "the sustained outage to stop the goal",
        );
        expect(goal.status).toBe("failed");
        expect(goal.detail).toContain("kept failing");
        NodeFS.rmdirSync(dbFile);
        NodeFS.renameSync(`${dbFile}.away`, dbFile);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "after a restart, a conversation that is already quiet no longer holds its files: its work is merged and the task that waited starts",
    () =>
      Effect.gen(function* () {
        const flow = yield* makeFlow(
          planWith([
            { id: "T1", scope: "shared/" },
            { id: "T2", scope: "shared/" },
          ]),
        );
        // The first server never sees the worker's end; it is gone before it could.
        const first = yield* flow.startServer;
        yield* first.create(settingsFor());
        const created = (yield* flow.waitFor("thread.create", 1))[0]!;
        yield* Effect.promise(async () => {
          const cwd = created.worktreePath!;
          await NodeFSP.mkdir(NodePath.join(cwd, "shared"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(cwd, "shared/one.txt"), "1\n");
          await execCommand("git", ["add", "-A"], cwd);
          await execCommand("git", ["commit", "-qm", "T1: implement"], cwd);
        });
        const second = yield* flow.startServer;
        yield* Effect.forkScoped(second.loop);
        yield* Effect.yieldNow;
        yield* flow.eventually(
          flow.taskRow("T1"),
          (row) => row.status === "completed",
          "T1 to merge after the restart",
        );
        yield* flow.waitFor("thread.create", 2);
        expect(flow.createdFor("T2")).toBeDefined();
      }).pipe(Effect.scoped),
  );
  it.effect(
    "a realistic multi-worker goal: independent tasks keep launching and merging while one task's follow-up is repaired, and everything finishes",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goal-real-"));
        const check = gatedCheck(dir);
        const flow = yield* makeFlow(
          planWith([
            { id: "N2", scope: "db/", verify: check.command },
            { id: "N1", scope: "db/" },
            { id: "N3", scope: "audio/" },
            { id: "N4", scope: "server/" },
            { id: "N8", deps: ["N1", "N2", "N3", "N4"] },
          ]),
          { extraFiles: { [check.fileName]: check.source } },
        );
        const service = yield* flow.startServer;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settingsFor({ concurrency: 4 }));

        // N2, N3, N4 run side by side; N1 shares N2's files, and the goal says exactly that.
        yield* flow.waitFor("thread.create", 3);
        const first = yield* flow.goalOf(service);
        expect(first.chats.map((chat) => chat.taskId).sort()).toEqual(["N2", "N3", "N4"]);
        expect(first.queueProgress?.stall?.summary).toContain("N1 waiting for files held by N2");

        // N2 finishes first. Its check fails the same way on the integration branch: the failure is
        // tracked as a follow-up and N2's own conversation looks at it, holding db/ meanwhile.
        yield* flow.work("N2", { file: "db/schema.txt", content: "n2\n" });
        yield* flow.eventually(
          flow.taskRow("N2-FU1"),
          (row) => (row as { status?: string } | undefined)?.status === "claimed",
          "the follow-up to be handed to N2's conversation",
        );
        yield* flow.eventually(
          flow.taskRow("N2"),
          (row) => row.status === "completed",
          "N2 to merge",
        );
        const blocked = yield* flow.eventually(
          flow.goalOf(service),
          (g) =>
            g.queueProgress?.stall?.summary.includes("N1 waiting for files held by N2-FU1") ===
            true,
          "the goal to name the follow-up as what holds N1",
        );
        expect(blocked.status).toBe("running");

        // While that is being repaired, the independent tasks finish and merge: nothing waits for it.
        yield* flow.work("N3", { file: "audio/a.txt", content: "n3\n" });
        yield* flow.work("N4", { file: "server/s.txt", content: "n4\n" });
        yield* flow.eventually(
          flow.taskRow("N3"),
          (row) => row.status === "completed",
          "N3 to merge while the follow-up is open",
        );
        yield* flow.eventually(
          flow.taskRow("N4"),
          (row) => row.status === "completed",
          "N4 to merge while the follow-up is open",
        );
        expect((yield* flow.taskRow("N2-FU1")).status).toBe("claimed");
        expect(flow.createdFor("N1")).toBeUndefined();

        // The follow-up's owner finds the check passing and has nothing to commit.
        NodeFS.writeFileSync(NodePath.join(dir, "open"), "yes\n");
        const n2 = flow.createdFor("N2")!.threadId;
        flow.scripts.set(n2, {
          reply: "Checked again: it passes, nothing to change.",
          turnState: "completed",
          progress: true,
          lastError: null,
        });
        yield* flow.sessionEvent(n2, { status: "running", activeTurnId: "fu" });
        yield* flow.sessionEvent(n2, { status: "ready", activeTurnId: null });

        // N1 starts by itself the moment the files are free, then N8 once everything it needs is done.
        yield* flow.waitFor("thread.create", 4);
        expect(flow.createdFor("N1")).toBeDefined();
        yield* flow.work("N1", { file: "db/n1.txt", content: "n1\n" });
        yield* flow.waitFor("thread.create", 5);
        yield* flow.work("N8");
        const done = yield* flow.eventually(
          flow.goalOf(service),
          (g) => g.status === "complete",
          "the goal to complete",
        );
        // One conversation per task, the follow-up never got a worker of its own, nobody was asked
        // for a commit that does not exist, and every task is merged exactly once.
        expect(done.chats).toHaveLength(5);
        const texts = flow.log
          .filter((c) => c.type === "thread.turn.start")
          .map((c) => (c.type === "thread.turn.start" ? c.message.text : ""));
        expect(texts.some((text) => text.includes("found no commit"))).toBe(false);
        for (const id of ["N1", "N2", "N3", "N4", "N8"]) {
          expect(yield* flow.taskRow(id)).toMatchObject({ status: "completed" });
          expect(yield* flow.landings(id)).toBe(1);
        }
        expect(yield* flow.taskRow("N2-FU1")).toMatchObject({ status: "completed" });
      }).pipe(Effect.scoped),
  );
});
