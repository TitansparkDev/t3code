// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";

export interface PlanTaskDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null;
  readonly dependencies: ReadonlyArray<string>;
  readonly verificationCommand?: string | null;
  readonly scopePatterns?: ReadonlyArray<string>;
  readonly priority?: number;
  /** The plan's own checkbox was already ticked, so the work is done. */
  readonly checked?: boolean;
}

export interface ParsedPlan {
  readonly title: string;
  readonly tasks: ReadonlyArray<PlanTaskDefinition>;
  /** A command that must pass on the base branch after every task landed (`Final verification:`). */
  readonly finalVerification?: string | null;
}

export class DependencyCycleError extends Error {
  public readonly cycle: ReadonlyArray<string>;
  constructor(cycle: ReadonlyArray<string>) {
    super(`Circular dependency detected in plan DAG: ${cycle.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.cycle = cycle;
  }
}

export class MissingDependencyError extends Error {
  public readonly taskId: string;
  public readonly missingDependency: string;
  constructor(taskId: string, missingDependency: string) {
    super(`Task ${taskId} references non-existent dependency: ${missingDependency}`);
    this.name = "MissingDependencyError";
    this.taskId = taskId;
    this.missingDependency = missingDependency;
  }
}

/**
 * Computes a deterministic SHA-256 checksum of plan file content.
 */
export function computePlanChecksum(content: string): string {
  return NodeCrypto.createHash("sha256").update(content.trim()).digest("hex");
}

/**
 * Validates DAG for missing dependencies and cycles using Kahn's algorithm.
 */
export function validatePlanDag(tasks: ReadonlyArray<PlanTaskDefinition>): void {
  const taskMap = new Map<string, PlanTaskDefinition>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    taskMap.set(t.id, t);
    inDegree.set(t.id, 0);
    dependents.set(t.id, []);
  }

  for (const t of tasks) {
    for (const depId of t.dependencies) {
      if (!taskMap.has(depId)) {
        throw new MissingDependencyError(t.id, depId);
      }
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      dependents.get(depId)?.push(t.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  let visitedCount = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    visitedCount++;

    for (const next of dependents.get(current) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) {
        queue.push(next);
      }
    }
  }

  if (visitedCount < tasks.length) {
    // Find unvisited tasks to report cycle
    const cycleTasks = Array.from(inDegree.entries())
      .filter(([, deg]) => deg > 0)
      .map(([id]) => id);
    throw new DependencyCycleError(cycleTasks);
  }
}

/**
 * Computes topological ordering of task IDs in DAG.
 */
export function topologicalSort(tasks: ReadonlyArray<PlanTaskDefinition>): string[] {
  validatePlanDag(tasks);

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    inDegree.set(t.id, 0);
    dependents.set(t.id, []);
  }

  for (const t of tasks) {
    for (const depId of t.dependencies) {
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      dependents.get(depId)?.push(t.id);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id);
    }
  }

  const result: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    for (const next of dependents.get(current) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) {
        queue.push(next);
      }
    }
  }

  return result;
}

/**
 * Returns task IDs that are eligible to be claimed ('pending' status and all dependencies 'completed').
 */
export function getReadyTasks(
  tasks: ReadonlyArray<{
    id: string;
    status: string;
    dependencies: ReadonlyArray<string>;
    priority?: number;
  }>,
): string[] {
  const completedSet = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.id));

  const ready = tasks.filter((t) => {
    if (t.status !== "pending") return false;
    return t.dependencies.every((depId) => completedSet.has(depId));
  });

  // Sort by priority descending (higher first)
  ready.sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100));

  return ready.map((t) => t.id);
}

/** Words that appear after "Depends on:" but name no task. */
const DEPENDENCY_STOP_WORDS = new Set(["none", "n/a", "na", "and", "or", "nothing", "-", "the"]);

/** Splits a "Depends on:" value into task ids, ignoring prose and trailing punctuation. */
function parseDependencyList(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((d) => d.trim().replace(/^[`[(*]+|[`\]).,;:*]+$/g, ""))
    .filter((d) => d.length > 0 && !DEPENDENCY_STOP_WORDS.has(d.toLowerCase()));
}

/** A verification value is a command when it is a single code span, or the line is labelled as one. */
function commandFrom(label: string, value: string): string | null {
  const trimmed = value.trim().replace(/\.$/, "");
  const span = trimmed.match(/^`([^`]+)`$/);
  if (span) return span[1]!.trim();
  // Only explicit verification labels may carry an unquoted command; "Done:" and
  // "Acceptance:" are prose in most plans and must never be run as shell.
  if (/^(verification|verify|test)$/i.test(label)) return trimmed.replace(/^`|`$/g, "");
  return null;
}

/** First words of code spans that are test, lint or build runs a server may execute as a check. */
const CHECK_RUNNERS = new Set([
  "uv",
  "pytest",
  "python",
  "python3",
  "ruff",
  "mypy",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "vp",
  "vpr",
  "node",
  "tsc",
  "cargo",
  "go",
  "make",
  "gradle",
  "./gradlew",
]);

/**
 * "Done:" and "Acceptance:" are prose, but the code spans inside them are often the exact
 * checks ("from server/, uv run pytest a and uv run pytest -m b", each in code spans). Spans that start with
 * a known test runner become one chained command; a leading directory span becomes its
 * working directory. Anything else (curl against a deployment, a placeholder) is left to the
 * description and never executed by the server.
 */
function proseChecks(value: string): string | null {
  const spans = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
  let directory: string | null = null;
  const commands: string[] = [];
  for (const span of spans) {
    if (/^[\w./-]+\/$/.test(span) && commands.length === 0) {
      directory = span.replace(/\/$/, "");
      continue;
    }
    const first = span.split(/\s+/, 1)[0] ?? "";
    if (!CHECK_RUNNERS.has(first) || /<[A-Za-z]|\.\.\.|[;|]\s*(?:rm|curl|ssh)\b/.test(span))
      continue;
    commands.push(span);
  }
  if (commands.length === 0) return null;
  const chained = commands.join(" && ");
  return directory ? `cd ${JSON.stringify(directory)} && ${chained}` : chained;
}

/**
 * Parses markdown plan documents. Three task shapes are accepted:
 * ### [Status] TASK-ID: Title
 * - [ ] [TASK-ID] Title   (or "- [ ] TASK-ID: Title")
 * - [ ] **TASK-ID — Title**   (the shape `plan-work` plans use)
 * Indented or following lines may carry `Depends on:`, `Scope:`, `Verify:` (or `Done:` as a
 * single code span) and `Priority:`. A ticked checkbox marks the task already done.
 */
export function parsePlanMarkdown(markdown: string): ParsedPlan {
  const lines = markdown.split(/\r?\n/);
  let title = "Untitled Plan";
  const tasks: PlanTaskDefinition[] = [];

  interface Draft {
    id: string;
    title: string;
    checked: boolean;
    descriptionLines: string[];
    dependencies: string[];
    verificationCommand: string | null;
    scopePatterns: string[];
    priority: number;
  }
  let currentTask: Draft | null = null;
  let finalVerification: string | null = null;

  const startTask = (id: string, taskTitle: string, checked: boolean): Draft => ({
    id,
    title: taskTitle,
    checked,
    descriptionLines: [],
    dependencies: [],
    verificationCommand: null,
    scopePatterns: [],
    priority: 100,
  });

  const commitCurrentTask = () => {
    if (currentTask) {
      tasks.push({
        id: currentTask.id,
        title: currentTask.title,
        description: currentTask.descriptionLines.join("\n").trim() || null,
        dependencies: currentTask.dependencies,
        verificationCommand: currentTask.verificationCommand || null,
        scopePatterns: currentTask.scopePatterns,
        priority: currentTask.priority,
        ...(currentTask.checked ? { checked: true } : {}),
      });
      currentTask = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Plan-level check, written outside any task: Final verification: `cmd`
    const finalMatch = trimmed.match(
      /^(?:[-*]\s*)?(?:\*\*)?(?:Final|Plan|Goal) verification(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
    );
    if (finalMatch && !currentTask) {
      finalVerification = commandFrom("verification", finalMatch[1]!);
      continue;
    }

    // Plan Title (first level-1 header)
    if (trimmed.startsWith("# ") && title === "Untitled Plan") {
      title = trimmed.slice(2).trim();
      continue;
    }

    // Task header: ### [Status] TASK-ID: Title or ### TASK-ID: Title
    const headerMatch = trimmed.match(/^###\s*(?:\[.*?\])?\s*([A-Za-z0-9_-]+)\s*[:—-]\s*(.+)$/);
    if (headerMatch) {
      commitCurrentTask();
      currentTask = startTask(headerMatch[1]!.trim(), headerMatch[2]!.trim(), false);
      continue;
    }

    // Bold list task: - [ ] **TASK-ID — Title.**
    const boldMatch = line.match(
      /^-\s*\[([ xX])\]\s*\*\*([A-Za-z][A-Za-z0-9_]*(?:[-.][A-Za-z0-9_]+)*)\s*[:—–-]+\s*(.+?)\s*\*\*\s*$/,
    );
    if (boldMatch) {
      commitCurrentTask();
      currentTask = startTask(
        boldMatch[2]!,
        boldMatch[3]!.trim().replace(/\.$/, ""),
        boldMatch[1]!.toLowerCase() === "x",
      );
      continue;
    }

    // List task: - [ ] [TASK-ID] Title or - [ ] TASK-ID: Title
    const listMatch = trimmed.match(
      /^-\s*\[([ xX])\]\s*(?:\[([A-Za-z0-9_-]+)\]|([A-Za-z0-9_-]+)[:\s])\s*(.+)$/,
    );
    if (listMatch) {
      commitCurrentTask();
      const id = (listMatch[2] || listMatch[3])!.trim();
      currentTask = startTask(id, listMatch[4]!.trim(), listMatch[1]!.toLowerCase() === "x");
      continue;
    }

    // Any other heading ends the current task, so section prose is not its description.
    if (currentTask && /^#{1,6}\s/.test(trimmed)) {
      commitCurrentTask();
      continue;
    }

    if (currentTask) {
      const depMatch = trimmed.match(
        /^(?:[-*]\s*)?(?:\*\*)?(?:Dependencies|Depends on|Requires)(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
      );
      if (depMatch) {
        currentTask.dependencies.push(...parseDependencyList(depMatch[1]!));
        continue;
      }

      const verMatch = trimmed.match(
        /^(?:[-*]\s*)?(?:\*\*)?(Verification|Verify|Test|Done|Acceptance)(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
      );
      if (verMatch) {
        const label = verMatch[1]!;
        const command = commandFrom(label, verMatch[2]!);
        if (command) {
          currentTask.verificationCommand = command;
          continue;
        }
        // A prose Done line stays in the description for the worker and may also carry the checks.
        currentTask.descriptionLines.push(line);
        const prose = /^(done|acceptance)$/i.test(label) ? proseChecks(verMatch[2]!) : null;
        if (prose) {
          currentTask.verificationCommand = currentTask.verificationCommand
            ? `${currentTask.verificationCommand} && ${prose}`
            : prose;
        }
        continue;
      }

      const scopeMatch = trimmed.match(
        /^(?:[-*]\s*)?(?:\*\*)?(?:Scope|Scopes|Files)(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
      );
      if (scopeMatch) {
        const patterns = scopeMatch[1]!
          .split(/[,;\s]+/)
          .map((s) => s.trim().replace(/^`|`[.]?$|[.]$/g, ""))
          .filter(Boolean);
        currentTask.scopePatterns.push(...patterns);
        continue;
      }

      const prioMatch = trimmed.match(/^Priority\s*:\s*(\d+)$/i);
      if (prioMatch) {
        currentTask.priority = parseInt(prioMatch[1]!, 10);
        continue;
      }

      currentTask.descriptionLines.push(line);
    }
  }

  commitCurrentTask();

  return { title, tasks, finalVerification };
}

/**
 * Formats a structured plan back into human-readable Markdown.
 */
export function exportPlanMarkdown(plan: ParsedPlan): string {
  const lines: string[] = [`# ${plan.title}`, ""];

  for (const task of plan.tasks) {
    lines.push(`### ${task.id}: ${task.title}`, "");
    if (task.description) {
      lines.push(task.description, "");
    }
    if (task.dependencies && task.dependencies.length > 0) {
      lines.push(`- **Depends on:** ${task.dependencies.join(", ")}`);
    }
    if (task.scopePatterns && task.scopePatterns.length > 0) {
      lines.push(`- **Scope:** ${task.scopePatterns.join(", ")}`);
    }
    if (task.verificationCommand) {
      lines.push(`- **Verification:** \`${task.verificationCommand}\``);
    }
    lines.push("", "---", "");
  }

  return lines.join("\n").trimEnd() + "\n";
}
