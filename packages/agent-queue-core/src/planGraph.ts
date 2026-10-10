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
}

export interface ParsedPlan {
  readonly title: string;
  readonly tasks: ReadonlyArray<PlanTaskDefinition>;
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

/**
 * Parses markdown plan documents supporting headings or list items:
 * ### [Status] TASK-ID: Title
 * or
 * - [ ] [TASK-ID] Title
 */
export function parsePlanMarkdown(markdown: string): ParsedPlan {
  const lines = markdown.split(/\r?\n/);
  let title = "Untitled Plan";
  const tasks: PlanTaskDefinition[] = [];

  let currentTask: {
    id: string;
    title: string;
    descriptionLines: string[];
    dependencies: string[];
    verificationCommand?: string | null;
    scopePatterns: string[];
    priority?: number;
  } | null = null;

  const commitCurrentTask = () => {
    if (currentTask) {
      tasks.push({
        id: currentTask.id,
        title: currentTask.title,
        description: currentTask.descriptionLines.join("\n").trim() || null,
        dependencies: currentTask.dependencies,
        verificationCommand: currentTask.verificationCommand || null,
        scopePatterns: currentTask.scopePatterns,
        priority: currentTask.priority ?? 100,
      });
      currentTask = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Plan Title (first level-1 header)
    if (trimmed.startsWith("# ") && title === "Untitled Plan") {
      title = trimmed.slice(2).trim();
      continue;
    }

    // Task header: ### [Status] TASK-ID: Title or ### TASK-ID: Title
    const headerMatch = trimmed.match(/^###\s*(?:\[.*?\])?\s*([A-Za-z0-9_-]+)\s*[:—-]\s*(.+)$/);
    if (headerMatch) {
      commitCurrentTask();
      currentTask = {
        id: headerMatch[1]!.trim(),
        title: headerMatch[2]!.trim(),
        descriptionLines: [],
        dependencies: [],
        verificationCommand: null,
        scopePatterns: [],
        priority: 100,
      };
      continue;
    }

    // List task: - [ ] [TASK-ID] Title or - [ ] TASK-ID: Title
    const listMatch = trimmed.match(
      /^-\s*\[[ xX]\]\s*(?:\[([A-Za-z0-9_-]+)\]|([A-Za-z0-9_-]+)[:\s])\s*(.+)$/,
    );
    if (listMatch) {
      commitCurrentTask();
      const id = (listMatch[1] || listMatch[2])!.trim();
      currentTask = {
        id,
        title: listMatch[3]!.trim(),
        descriptionLines: [],
        dependencies: [],
        verificationCommand: null,
        scopePatterns: [],
        priority: 100,
      };
      continue;
    }

    if (currentTask) {
      // Check for Dependencies metadata
      const depMatch = trimmed.match(
        /^(?:[-*]\s*)?(?:\*\*)?(?:Dependencies|Depends on|Requires)(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
      );
      if (depMatch) {
        const deps = depMatch[1]!
          .split(/[,;\s]+/)
          .map((d) => d.trim().replace(/^[`[]|[`\]]$/g, ""))
          .filter((d) => d.length > 0 && d !== "none");
        currentTask.dependencies.push(...deps);
        continue;
      }

      // Check for Verification metadata
      const verMatch = trimmed.match(
        /^(?:[-*]\s*)?(?:\*\*)?(?:Verification|Verify|Test|Done|Acceptance)(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
      );
      if (verMatch) {
        currentTask.verificationCommand = verMatch[1]!.trim().replace(/^`|`$/g, "");
        continue;
      }

      // Check for Scope metadata
      const scopeMatch = trimmed.match(
        /^(?:[-*]\s*)?(?:\*\*)?(?:Scope|Scopes|Files)(?:\*\*)?:(?:\*\*)?\s*(.+)$/i,
      );
      if (scopeMatch) {
        const patterns = scopeMatch[1]!
          .split(/[,;\s]+/)
          .map((s) => s.trim().replace(/^`|`$/g, ""))
          .filter(Boolean);
        currentTask.scopePatterns.push(...patterns);
        continue;
      }

      // Check for Priority metadata
      const prioMatch = trimmed.match(/^Priority\s*:\s*(\d+)$/i);
      if (prioMatch) {
        currentTask.priority = parseInt(prioMatch[1]!, 10);
        continue;
      }

      currentTask.descriptionLines.push(line);
    }
  }

  commitCurrentTask();

  return { title, tasks };
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
