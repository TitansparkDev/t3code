// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Is this plan something small coding agents can finish on their own, in this repository, on this
 * machine? A plan that cannot be finished wastes every worker that meets its wall, so each of these
 * is found before a Goal starts, from the plan and from the repository itself:
 *
 *  - work only a person, a device or elapsed time can do (owner checks, soak runs, store reviews);
 *  - live or production changes outside the one final release task;
 *  - decisions left to the worker (TBD, "if possible", "choose between");
 *  - a scope that leaves out files the task cannot work without (the Room database a sync change
 *    depends on, a protected file, a path that does not exist);
 *  - checks that cannot run here (missing tool, no GPU), that are too broad for the task, or that
 *    already fail on the branch the workers start from;
 *  - dependencies nothing requires, overlapping scopes, and instructions that contradict each other.
 *
 * Findings are `error` (the plan cannot run as written) or `warning` (probably wrong, say why if not).
 * Nothing here changes the plan or the repository.
 *
 * @module planLint
 */
import * as NodeChildProcess from "node:child_process";
import { toolAvailable, matchesAny, pathMatches, type RepoContract } from "./contract.ts";
import { loadResourceConfig, normalizeResource } from "./resourceBroker.ts";
import { inferResources } from "./resourceRunner.ts";
import { scopesIntersect } from "./scopeManager.ts";
import type { PlanTaskDefinition } from "./planGraph.ts";

export type FindingLevel = "error" | "warning";

export interface PlanFinding {
  readonly level: FindingLevel;
  /** Stable name of the rule, so a finding can be referred to and tested. */
  readonly code: string;
  readonly taskId: string | null;
  readonly message: string;
  /** What to change in the plan. */
  readonly fix?: string;
}

export interface PlanLintInput {
  /** Tasks already done in the plan: they may be depended on but are not linted. */
  readonly doneTaskIds?: ReadonlyArray<string>;
  readonly repoRoot: string;
  /** The branch workers start from; files, imports and tools are read as they are there. */
  readonly ref: string;
  readonly tasks: ReadonlyArray<PlanTaskDefinition>;
  readonly contract: RepoContract;
  /** Whether a named capability's probe passes on this machine. */
  readonly capabilityAvailable?: (name: string) => boolean;
}

function git(repoRoot: string, args: ReadonlyArray<string>): string {
  const out = NodeChildProcess.spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.status === 0 ? (out.stdout ?? "") : "";
}

const sentencesOf = (text: string): string[] =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.;!?])\s+(?=[A-Z`(\-*])|(?<=:)\s+(?=[A-Z])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const NEGATION =
  /\b(no|not|never|without|avoid|avoids|excluding|exclude|excludes|nor|neither|cannot|can't|don't|doesn't|do not|does not|must not|may not|instead of|rather than|forbid|forbidden|prohibited|out of scope)\b/i;

/** A rule's pattern matched in a sentence that is not forbidding that very thing. */
function affirmed(sentence: string, pattern: RegExp): boolean {
  const match = pattern.exec(sentence);
  if (!match) return false;
  return !NEGATION.test(sentence.slice(0, match.index + match[0].length));
}

interface TextRule {
  readonly code: string;
  readonly pattern: RegExp;
  readonly message: string;
  readonly fix: string;
}

/** Work that cannot be finished by an agent alone. */
const HUMAN_RULES: ReadonlyArray<TextRule> = [
  {
    code: "physical-device",
    pattern:
      /\b(physical|real) (phone|device|handset|hardware|tablet)\b|\bphone cable\b|\bon[- ]device (test|check|verif)|\btest(ed|ing)? on (a |the )?(real |physical )?(phone|device)\b/i,
    message: "needs a physical device or hardware an agent does not have.",
    fix: "Replace it with an emulator or fixture check and state in the plan's limits (outside the tasks) that real-device behaviour is not proven.",
  },
  {
    code: "long-wait",
    pattern:
      /\bsoak\b|\b(24|48|72)[- ]?(h|hr|hrs|hours?)\b|\bovernight\b|\bfor (several |multiple |a few )?days\b|\bwait(ing)? (for )?\d+ ?(hours?|days?|weeks?)\b|\blong[- ]running (monitor|observ)/i,
    message: "depends on elapsed real time (a soak, an overnight run, days of monitoring).",
    fix: "Use a bounded automated substitute (a time-compressed test with a fake clock) and move the real-time claim out of the executable tasks.",
  },
  {
    code: "human-in-the-loop",
    pattern:
      /\bowner (check|acceptance|test|verification|review|sign[- ]?off|walk[- ]?through)\b|\bacceptance checklist\b|\bmanual(ly)? (test|check|observ|verif|inspect)\w*|\brecord(ing)? (a |your |new )?(real )?(voice|speech|audio)\b|\breal[- ]person\b|\bhuman (review|approval|tester|verification)\b|\buser acceptance\b/i,
    message: "needs a person (owner acceptance, a manual observation, a real recording).",
    fix: "Delete the step or replace it with an automated check; say what it would have proved in the plan's limits, outside the tasks.",
  },
  {
    code: "interactive-auth",
    pattern:
      /\bmfa\b|\b2fa\b|two[- ]factor|interactive (login|sign[- ]?in)|\blog ?in (as|with|to) |\bsign in with\b|\boauth consent\b|\bnew consent\b|\bcaptcha\b/i,
    message: "needs an interactive login, MFA or consent only an account owner can give.",
    fix: "Use credentials that are already provisioned for agents, or drop the step; do not plan work that waits for an account owner.",
  },
  {
    code: "store-review",
    pattern:
      /\bapp[- ]?store (review|approval|submission)\b|\bplay store (review|approval|submission)\b|\bgoogle play (review|approval)\b|\btestflight review\b|\bstore review\b/i,
    message: "waits for an app-store review or other external approval.",
    fix: "Stop at the signed, uploaded-ready artifact; a store review is not a worker task.",
  },
  {
    code: "billing",
    pattern:
      /\b(make a purchase|purchase (an? |the |new )?(license|licence|subscription|plan|domain|hardware|device|credits)|invoice|subscription payment|pay for|upgrade (the )?(subscription|plan)|billing (account|setup|information|profile))\b/i,
    message: "involves a purchase or billing action.",
    fix: "Remove it; agents may not buy or bill.",
  },
  {
    code: "waits-for-person",
    pattern:
      /\bwait(s|ing)? (for|on) (the |an? )?(owner|person|human|reviewer|approval|third[- ]party|maintainer)\b/i,
    message: "makes a worker wait for a person or an outside party.",
    fix: "Remove the dependency on them; if the work truly needs them, leave it out of the task graph and document it.",
  },
];

/** Decisions left to the worker. */
const UNDECIDED_RULES: ReadonlyArray<TextRule> = [
  {
    code: "undecided",
    pattern:
      /\bTBD\b|\bTODO\b|\bto be decided\b|\bdecide (later|whether|which|if|how)\b|\bconfirm with\b|\bask the owner\b|\bowner (decides|to decide|to confirm)\b|\bif possible\b|\bas appropriate\b|\bwhichever (is )?(easier|better|simpler|simplest)\b|\bor similar\b|\bchoose (between|one of)\b|\buse your (best )?judg(e)?ment\b/i,
    message: "leaves a decision to the worker or an owner.",
    fix: "Decide it in the plan (ask the owner at the end of drafting if you must) and state the chosen value; workers are never asked to decide.",
  },
];

/** Changes to live systems. Only the final release task may make them. */
const PRODUCTION_RULES: ReadonlyArray<RegExp> = [
  /\b(remove|delete|purge|clean ?up|wipe|retire|drop|truncate)\b[^.;]{0,60}\b(production|live|prod)\b/i,
  /\b(production|live|prod)\b[^.;]{0,60}\b(apply|write|delete|remove|deploy|restart|rotate|migrat|cleanup|mutat|update|publish|reset)\b/i,
  /\b(apply|run|execute|deploy|restart|rotate)\b[^.;]{0,50}\b(against|on|to|in|at) (the )?(live|production|prod)\b/i,
  /--apply\b/,
  /\bproduction[- ]write\b/i,
];

const SAFE_PRODUCTION_CONTEXT =
  /\b(isolated|clone|copy|restored|fixture|dry[- ]run|read[- ]only|read production|investigate|observe|inspect|sanitized|test (database|identity)|synthetic)\b/i;

const RELEASE_WORDS = /\b(release|publish|deploy|ship|tag|rollout|roll out)\b/i;

/** Commands a check must never run: they act on live systems or other hosts. */
const UNSAFE_CHECK =
  /\b(kubectl|terraform apply|ssh|scp|rsync [^|]*:|docker (push|login)|npm publish|git push|gh release|twine upload)\b|--apply\b|\bcurl\b[^|]*-X ?(POST|PUT|DELETE)/i;

export const BROAD_CHECKS: ReadonlyArray<RegExp> = [
  /^(uv run )?pytest( -q| -x| -v)*$/,
  /^(uv run )?(ruff|mypy) [^\s]+ ?\.?$/,
  /^(\.\/)?gradlew (check|build|test|assemble)(\s+--[\w-]+)*$/,
  /^(vp|pnpm|npm|yarn|bun)( run)? (test|check|lint|build|typecheck)$/,
  /^node --test( --[\w-]+(=\S+)?)*$/,
  /^vp test run$/,
  /^cargo (test|build|check)$/,
  /^go test \.\/\.\.\.$/,
  /^make( test| check| all)?$/,
];

function tokensOf(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((word) => !STOP.has(word));
}

const STOP = new Set(
  "the and for with that this from into only must not are was were has have had its their there then than also each any all can will should would could may might use used using make made task tasks code file files test tests run runs when what which who how why where while after before over under between both other same such via per out one two new old more less most least own".split(
    " ",
  ),
);

/** Pairs of opposite instructions that, about the same things, cannot both hold. */
const CONTRADICTIONS: ReadonlyArray<{
  readonly a: RegExp;
  readonly b: RegExp;
  readonly what: string;
}> = [
  {
    a: /\bread[- ]only\b|\bimmutable\b|\bkeep[^.;]{0,40}\bunchanged\b/i,
    b: /\bwritable\b|\bwrite(s)? (there|to|into)\b|\brotat\w+\b|\bpersist\w*\b[^.;]{0,30}\bstate\b|\bmutable\b/i,
    what: "read-only against writable",
  },
  {
    a: /\b(do not|never|must not|without) (open|expose|add|introduce|publish)\b/i,
    b: /\b(open|expose|add|introduce|publish) (an? |the )?(port|network|endpoint|route|egress|ingress|service)\b/i,
    what: "do not open/expose against open/expose",
  },
  {
    a: /\b(do not|never|must not) (remove|delete|drop|disable|weaken)\b/i,
    b: /\b(remove|delete|drop|disable|weaken|relax)\b/i,
    what: "do not remove/disable against remove/disable",
  },
  {
    a: /\bno (new )?(credentials?|account login|consent|secrets?)\b|\bwithout (credentials?|an account login)\b/i,
    b: /\b(authenticate|log ?in|sign in|use (the )?(real )?credentials?|live (gmail|account))\b/i,
    what: "no credentials against authenticated work",
  },
];

const LAYER_TEXT =
  /\b(sync\w*|persist\w*|durab\w*|outbox|offline|mirror|process death|record(s|ed|ing)? (the )?(stage|state|outcome|result)|track(s|ed|ing)? (every|each|the)|restart)\b/i;

interface PersistenceLayer {
  readonly kind: "room" | "alembic";
  readonly root: string;
  readonly packageName: string | null;
  readonly schemas: string | null;
}

export function lintPlan(input: PlanLintInput): PlanFinding[] {
  const findings: PlanFinding[] = [];
  const add = (finding: PlanFinding) => findings.push(finding);
  const { contract, tasks, repoRoot, ref } = input;
  const index = git(repoRoot, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
  const indexSet = new Set(index);
  const config = loadResourceConfig();
  const ids = new Set([...tasks.map((task) => task.id), ...(input.doneTaskIds ?? [])]);

  // The final release task: the only one allowed to publish or touch live systems.
  const releaseTasks = tasks.filter((task) => RELEASE_WORDS.test(task.title));
  const finalTask = tasks.at(-1);
  const isRelease = (task: PlanTaskDefinition) =>
    releaseTasks.includes(task) &&
    task === finalTask &&
    task.dependencies.length >= Math.max(1, Math.floor((tasks.length - 1) * 0.6));

  // Persistence layers, found from the code itself.
  const layers: PersistenceLayer[] = [];
  const roomFiles = git(repoRoot, ["grep", "-l", "-E", "@Database\\(", ref, "--", "*.kt", "*.java"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(`${ref}:`, ""));
  for (const file of roomFiles) {
    const root = file.includes("/src/")
      ? file.slice(0, file.indexOf("/src/"))
      : file.slice(0, file.lastIndexOf("/"));
    const source = git(repoRoot, ["show", `${ref}:${file}`]);
    const packageName = /^\s*package\s+([\w.]+)/m.exec(source)?.[1] ?? null;
    const schemas = index.some((entry) => entry.startsWith(`${root}/schemas/`))
      ? `${root}/schemas/`
      : null;
    layers.push({ kind: "room", root, packageName, schemas });
  }
  for (const file of index.filter((entry) => /(^|\/)alembic\.ini$/.test(entry))) {
    const root = file.slice(0, file.lastIndexOf("/"));
    const migrations = index.find((entry) =>
      entry.startsWith(`${root ? `${root}/` : ""}migrations/versions/`),
    );
    if (migrations)
      layers.push({
        kind: "alembic",
        root: migrations.slice(0, migrations.indexOf("versions/") + "versions".length),
        packageName: null,
        schemas: null,
      });
  }

  for (const task of tasks) {
    const text = [task.title, task.description ?? ""].join("\n");
    const sentences = sentencesOf(text);
    const scope = task.scopePatterns ?? [];
    const checks = task.verification?.checks ?? [];
    const release = isRelease(task);

    // 1. Agents cannot do it.
    for (const rule of [...HUMAN_RULES, ...UNDECIDED_RULES]) {
      const hit = sentences.find((sentence) => affirmed(sentence, rule.pattern));
      if (hit) {
        add({
          level: "error",
          code: rule.code,
          taskId: task.id,
          message: `${task.id} ${rule.message} "${hit.slice(0, 160)}"`,
          fix: rule.fix,
        });
      }
    }

    // 2. Live changes outside the final release task.
    if (!release) {
      const hit = sentences.find(
        (sentence) =>
          !SAFE_PRODUCTION_CONTEXT.test(sentence) &&
          PRODUCTION_RULES.some((rule) => rule.test(sentence)) &&
          !NEGATION.test(sentence.split(/\b(production|live|prod)\b/i)[0] ?? ""),
      );
      const titleHit = PRODUCTION_RULES.some((rule) => rule.test(task.title));
      if (hit ?? (titleHit ? task.title : undefined)) {
        add({
          level: "error",
          code: "production-change",
          taskId: task.id,
          message: `${task.id} changes live or production state ("${(hit ?? task.title).slice(0, 160)}"), which no ordinary task may do.`,
          fix: "Keep the task to what an isolated clone or fixture proves (a script, a migration, a dry run); only the final release task, through the repository's release process, touches production.",
        });
      }
      // A production capability the contract names and this machine does not grant.
      for (const name of Object.keys(contract.capabilities)) {
        if (!/production|live|prod/i.test(name)) continue;
        const available = input.capabilityAvailable?.(name) ?? false;
        if (
          !available &&
          (hit !== undefined || titleHit || new RegExp(`\\[${name}\\]`, "i").test(task.title))
        ) {
          add({
            level: "error",
            code: "capability-unavailable",
            taskId: task.id,
            message: `${task.id} needs the capability "${name}", which is not provisioned on this machine (${contract.capabilities[name]?.description ?? "no description"}).`,
            fix: "Remove the live step from the executable graph; keep a prepared, tested script and document that it still has to be applied.",
          });
        }
      }
    }
    for (const tag of task.title.matchAll(/\[([a-z][\w-]*)\]/gi)) {
      const name = tag[1]!.toLowerCase();
      const capability = contract.capabilities[name];
      if (capability && input.capabilityAvailable && !input.capabilityAvailable(name)) {
        add({
          level: "error",
          code: "capability-unavailable",
          taskId: task.id,
          message: `${task.id} is tagged [${name}] but that capability fails its probe on this machine (${capability.description ?? name}).`,
          fix: "Provision the capability first, or take the work out of the executable graph.",
        });
      }
    }

    // 3. Ordinary tasks do not publish.
    if (
      !release &&
      RELEASE_WORDS.test(task.title) &&
      /\b(release|publish|deploy)\b/i.test(task.title)
    ) {
      add({
        level: "error",
        code: "release-not-final",
        taskId: task.id,
        message: `${task.id} publishes or deploys but is not the final task depending on the rest.`,
        fix: "Make it the last task, depending on the tasks and gates that must pass first; it is the only task allowed to publish.",
      });
    }

    // 4. Scope against the repository.
    const scopeFiles = index.filter((file) => matchesAny(file, scope));
    for (const pattern of scope) {
      const exists = index.some((file) => pathMatches(file, pattern) || pathMatches(pattern, file));
      const trimmed = pattern.replace(/\/(\*\*?)?$/, "");
      const parent = trimmed.includes("/") ? trimmed.replace(/\/[^/]*$/, "") : "";
      const parentExists = parent === "" || index.some((file) => file.startsWith(`${parent}/`));
      if (!exists && !parentExists) {
        add({
          level: "error",
          code: "scope-path-missing",
          taskId: task.id,
          message: `${task.id}'s scope "${pattern}" is not in ${ref}, nor is its folder.`,
          fix: "Fix the path or name an existing parent folder.",
        });
      }
      if (
        matchesAny(pattern, contract.protectedPaths) ||
        contract.protectedPaths.some((protectedPath) => scopesIntersect([pattern], [protectedPath]))
      ) {
        add({
          level: "error",
          code: "scope-protected",
          taskId: task.id,
          message: `${task.id}'s scope "${pattern}" is protected by the repository's contract; workers are not allowed to change it.`,
          fix: "Take the file out of the scope, or make the change part of repository setup outside the plan.",
        });
      }
      if (
        /(^|\/)(\.env(\.(?!example$|sample$)[\w.]+)?|secrets?|credentials?)(\/|$)/i.test(pattern)
      ) {
        add({
          level: "error",
          code: "scope-secrets",
          taskId: task.id,
          message: `${task.id}'s scope "${pattern}" is a secrets location.`,
          fix: "Agents do not edit credentials; read them from provisioned configuration.",
        });
      }
    }
    if (scope.length === 0 && !release) {
      add({
        level: "warning",
        code: "scope-missing",
        taskId: task.id,
        message: `${task.id} declares no scope, so nothing keeps it apart from other tasks.`,
        fix: "List the files and folders it changes, including the models, migrations, schemas and tests it cannot work without.",
      });
    }
    if (scopeFiles.length > 400) {
      add({
        level: "warning",
        code: "task-too-wide",
        taskId: task.id,
        message: `${task.id} covers ${scopeFiles.length} files; one agent cannot hold that in mind.`,
        fix: "Split along a real seam, or narrow the scope.",
      });
    }

    // 5. Scope that leaves out the layer the code depends on.
    for (const layer of layers) {
      const owns = scope.some(
        (pattern) =>
          pathMatches(layer.root, pattern) ||
          pathMatches(pattern, layer.root) ||
          scopesIntersect([pattern], [`${layer.root}/`]),
      );
      if (owns) continue;
      if (layer.kind === "room" && layer.packageName) {
        const dirs = scope.map((pattern) => pattern.replace(/\/\*\*?$/, "")).filter(Boolean);
        const importers = dirs.length
          ? git(repoRoot, ["grep", "-l", "-F", `import ${layer.packageName}`, ref, "--", ...dirs])
              .split("\n")
              .filter((file) => file && !/\/(androidTest|test|testFixtures|debug)\//.test(file))
          : [];
        if (importers.length > 0) {
          const persists = LAYER_TEXT.test(text);
          add({
            level: persists ? "error" : "warning",
            code: "scope-missing-database",
            taskId: task.id,
            message: `${task.id}'s code uses the Room database (${layer.packageName}, e.g. ${importers[0]!.replace(`${ref}:`, "")}) but its scope leaves out ${layer.root}/${layer.schemas ? ` and ${layer.schemas}` : ""}. ${persists ? "The task records or syncs state, so it will need an entity/DAO change, an exported schema and a migration." : "If it never changes stored state this is fine; say so."}`,
            fix: `Add ${layer.root}/ (entities, DAOs, migrations${layer.schemas ? `, ${layer.schemas}` : ""}) and a migration test to the scope.`,
          });
        }
      }
      if (
        layer.kind === "alembic" &&
        /\b((add|new|change|alter|drop|rename|create)\s+(a\s+|an\s+|the\s+)?(\w+\s+)?(column|table|index|constraint)|migrations?)\b/i.test(
          text,
        ) &&
        !scope.some((pattern) => pathMatches(`${layer.root}/x`, pattern))
      ) {
        add({
          level: "warning",
          code: "scope-missing-migration",
          taskId: task.id,
          message: `${task.id} talks about changing the database schema but its scope leaves out ${layer.root}/.`,
          fix: `Add ${layer.root}/ so the migration can be part of the task.`,
        });
      }
    }

    // 6. Checks.
    if (
      task.verification?.source === "none" ||
      (checks.length === 0 && task.verification?.source !== "exempt")
    ) {
      add({
        level: "error",
        code: "no-verification",
        taskId: task.id,
        message: `${task.id} has no executable check and no stated exemption.`,
        fix: "Add a Checks: list (command, cwd, timeout) or `Verify: none — <reason>`.",
      });
    }
    for (const rejected of task.verification?.rejected ?? []) {
      add({
        level: "error",
        code: "check-rejected",
        taskId: task.id,
        message: `${task.id}'s check \`${rejected.run}\` cannot be run by the server: ${rejected.reason}.`,
        fix: "Use a plain test, lint or build command.",
      });
    }
    for (const check of checks) {
      const head = check.run.trim().split(/\s+/)[0] ?? "";
      if (
        head &&
        !head.startsWith("./") &&
        !head.includes("/") &&
        !toolAvailable({ name: head, probe: null, optional: false, install: null }, repoRoot)
      ) {
        add({
          level: "error",
          code: "tool-missing",
          taskId: task.id,
          message: `${task.id}'s check \`${check.run}\` needs "${head}", which is not installed here.`,
          fix: "Use an installed runner or add the tool to the repository contract's install list.",
        });
      }
      if (UNSAFE_CHECK.test(check.run)) {
        add({
          level: "error",
          code: "unsafe-check",
          taskId: task.id,
          message: `${task.id}'s check \`${check.run}\` acts on a live system or another host.`,
          fix: "A check proves behaviour in the worktree; deployment is the final release task's job.",
        });
      }
      const needs = new Set([
        ...check.requires.map(normalizeResource),
        ...inferResources(check.run, contract.resources),
      ]);
      for (const name of needs) {
        const capacity = config.resources[name]?.capacity;
        if (capacity === 0) {
          add({
            level: "error",
            code: "resource-unavailable",
            taskId: task.id,
            message: `${task.id}'s check \`${check.run}\` needs ${name}, which this machine does not have (${config.resources[name]?.description ?? "capacity 0"}).`,
            fix: `Use a fake or a CPU path for the automated check and document that ${name} behaviour is not proven here.`,
          });
        }
      }
      if (!release && BROAD_CHECKS.some((pattern) => pattern.test(check.run.trim()))) {
        add({
          level: "warning",
          code: "broad-check",
          taskId: task.id,
          message: `${task.id}'s check \`${check.run}\` runs a whole suite; every unrelated failure in the repository would block this task.`,
          fix: "Run the files the task touches (name them); keep whole-suite runs for the final integration task.",
        });
      }
      for (const file of check.run.match(
        /(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.(?:py|ts|tsx|js|mjs|kt|java|rs|go|sh))(?=\s|$|::)/g,
      ) ?? []) {
        const path = file.trim();
        const planned = scopeFiles.length > 0 || matchesAny(path, scope);
        if (
          !indexSet.has(path) &&
          !(check.cwd && indexSet.has(`${check.cwd}/${path}`)) &&
          !planned
        ) {
          add({
            level: "warning",
            code: "check-file-missing",
            taskId: task.id,
            message: `${task.id}'s check names ${path}, which does not exist and is not in the task's scope.`,
            fix: "Put the file in the scope (the task creates it) or correct the path.",
          });
        }
      }
    }

    // 7. Dependencies.
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        add({
          level: "error",
          code: "dependency-missing",
          taskId: task.id,
          message: `${task.id} depends on ${dependency}, which is not in the plan.`,
          fix: "Fix the id or remove the dependency.",
        });
        continue;
      }
      const other = tasks.find((candidate) => candidate.id === dependency);
      if (!other) continue;
      const otherScope = other.scopePatterns ?? [];
      const related = scopesIntersect(scope, otherScope);
      const explained = new RegExp(
        `${dependency}[^.;]{0,120}\\b(because|needs?|requires?|uses?|reads?|consumes?|imports?|after)\\b|\\b(because|needs?|requires?|uses?|consumes?|imports?)\\b[^.;]{0,120}${dependency}`,
        "i",
      ).test(text);
      if (!related && !explained && !release) {
        add({
          level: "warning",
          code: "needless-dependency",
          taskId: task.id,
          message: `${task.id} depends on ${dependency}, but their scopes do not overlap and the task does not say what it needs from it.`,
          fix: "Drop it (the default is no dependencies) or add one clause naming the output it consumes.",
        });
      }
    }

    // 8. Instructions that cannot all be followed.
    const body = sentencesOf(task.description ?? "");
    if (
      /\bread[- ]only\b/i.test(task.description ?? "") &&
      /\b(writable|writes? (there|to)|rotat\w+|persist\w*)\b/i.test(task.description ?? "") &&
      /\b(mount|volume|secrets?|credentials?|keys?|permissions?)\b/i.test(task.description ?? "")
    ) {
      add({
        level: "warning",
        code: "conflicting-constraints",
        taskId: task.id,
        message: `${task.id} asks for read-only and writable access around the same secrets or mounts, and does not say which is which.`,
        fix: "Name each mount or key and its mode (for example: signing inputs read-only on the server mount; password and TLS state writable on a separate admin mount) so no worker has to guess.",
      });
    }
    for (const rule of CONTRADICTIONS) {
      for (const first of body.filter((sentence) => rule.a.test(sentence))) {
        const partner = body.find((sentence) => {
          if (sentence === first || !rule.b.test(sentence)) return false;
          const shared = tokensOf(first).filter((word) => tokensOf(sentence).includes(word));
          return shared.length >= 2;
        });
        if (partner) {
          add({
            level: "warning",
            code: "conflicting-constraints",
            taskId: task.id,
            message: `${task.id} may contradict itself (${rule.what}): "${first.slice(0, 110)}" and "${partner.slice(0, 110)}".`,
            fix: "Say exactly how both hold (for example which mount stays read-only and which one is writable) so no worker has to choose.",
          });
          break;
        }
      }
    }
  }

  // Overlapping scopes between tasks with no order: they will serialise or collide.
  const reach = new Map<string, Set<string>>();
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    if (reach.has(id)) return reach.get(id)!;
    for (const dependency of tasks.find((task) => task.id === id)?.dependencies ?? []) {
      seen.add(dependency);
      for (const upstream of ancestors(dependency)) seen.add(upstream);
    }
    reach.set(id, seen);
    return seen;
  };
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      if (!(a.scopePatterns?.length && b.scopePatterns?.length)) continue;
      if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
      if (scopesIntersect(a.scopePatterns, b.scopePatterns)) {
        add({
          level: "warning",
          code: "scope-overlap",
          taskId: a.id,
          message: `${a.id} and ${b.id} overlap in scope with no order between them; one will wait for the other.`,
          fix: "Bundle them if they are one change, or narrow a scope, or accept one real dependency.",
        });
      }
    }
  }

  // Tests that bind a fixed port or name a fixed container make parallel workers collide: the
  // queue hands each task its own AGENTQUEUE_PORT_BASE / AGENTQUEUE_DB_NAME, and tests must use them.
  const testsTouched = tasks.some((task) =>
    (task.scopePatterns ?? []).some((pattern) =>
      /(^|\/)(tests?|__tests__|spec)(\/|$)|\.test\./.test(pattern),
    ),
  );
  if (testsTouched) {
    const fixed = git(repoRoot, [
      "grep",
      "-l",
      "-E",
      "(docker[\"', ]+(run|rm|exec)[^\\n]*(--name|-f)[\"', ]+[a-z][a-z0-9_-]{5,}|(PORT|port)[A-Za-z_]*[ =:(\"',]+(5432|5433|5443|6379|8080|9000)\\b)",
      ref,
      "--",
      "**/test_*.py",
      "**/*_test.py",
      "**/conftest.py",
      "**/*.test.ts",
      "**/*Test.kt",
    ])
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(`${ref}:`, ""));
    const aware = git(repoRoot, ["grep", "-l", "AGENTQUEUE_", ref, "--", "*test*", "conftest.py"])
      .split("\n")
      .filter(Boolean);
    if (fixed.length > 0 && aware.length === 0) {
      add({
        level: "warning",
        code: "fixed-test-infrastructure",
        taskId: null,
        message: `${fixed.length} test file(s) bind a fixed port or name a fixed container (e.g. ${fixed.slice(0, 3).join(", ")}) and none read AGENTQUEUE_PORT_BASE or AGENTQUEUE_DB_NAME. Parallel workers and the server's check runs will collide on them and fail with errors that are not about the task.`,
        fix: "Add a first task that derives the port, database name and container name from AGENTQUEUE_PORT_BASE / AGENTQUEUE_DB_NAME / AGENTQUEUE_TASK_ID (falling back to today's values), and make test-running tasks depend on it.",
      });
    }
  }
  return findings;
}

/** Findings as a readable report. */
export function formatFindings(findings: ReadonlyArray<PlanFinding>): string {
  if (findings.length === 0) return "No problems found.";
  return findings
    .map(
      (finding) =>
        `${finding.level.toUpperCase()} ${finding.code}${finding.taskId ? ` [${finding.taskId}]` : ""}: ${finding.message}${finding.fix ? `\n    fix: ${finding.fix}` : ""}`,
    )
    .join("\n");
}

/** Whether a check command runs a whole suite rather than the files a task touches. */
export const isBroadCheck = (command: string): boolean =>
  BROAD_CHECKS.some((pattern) => pattern.test(command.trim()));
