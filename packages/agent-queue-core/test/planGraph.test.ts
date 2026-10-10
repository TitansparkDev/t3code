// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import {
  parsePlanMarkdown,
  validatePlanDag,
  topologicalSort,
  getReadyTasks,
  DependencyCycleError,
  MissingDependencyError,
  computePlanChecksum,
} from "../src/planGraph.ts";

describe("AgentQueue Plan DAG & Markdown Parser (AQ-008)", () => {
  it("parses markdown checklists and headings with dependencies", () => {
    const markdown = `
# Project Plan

### AQ-001: Task One
Scope: apps/server/**
Verify: vp test apps/server

### AQ-002: Task Two
Depends on: AQ-001
Verify: vp test packages/contracts

### AQ-003: Task Three
Requires: AQ-001, AQ-002
Priority: 200
`;

    const parsed = parsePlanMarkdown(markdown);
    expect(parsed.title).toBe("Project Plan");
    expect(parsed.tasks).toHaveLength(3);

    const [t1, t2, t3] = parsed.tasks;
    expect(t1.id).toBe("AQ-001");
    expect(t1.scopePatterns).toContain("apps/server/**");
    expect(t1.verificationCommand).toBe("vp test apps/server");
    expect(t1.dependencies).toHaveLength(0);

    expect(t2.id).toBe("AQ-002");
    expect(t2.dependencies).toEqual(["AQ-001"]);

    expect(t3.id).toBe("AQ-003");
    expect(t3.dependencies).toEqual(["AQ-001", "AQ-002"]);
    expect(t3.priority).toBe(200);
  });

  it("computes topological sort order", () => {
    const tasks = [
      { id: "C", title: "C", dependencies: ["A", "B"] },
      { id: "A", title: "A", dependencies: [] },
      { id: "B", title: "B", dependencies: ["A"] },
    ];

    const order = topologicalSort(tasks);
    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B"));
    expect(order.indexOf("B")).toBeLessThan(order.indexOf("C"));
    expect(order).toEqual(["A", "B", "C"]);
  });

  it("detects and rejects circular dependencies", () => {
    const cyclicTasks = [
      { id: "X", title: "X", dependencies: ["Y"] },
      { id: "Y", title: "Y", dependencies: ["Z"] },
      { id: "Z", title: "Z", dependencies: ["X"] },
    ];

    expect(() => validatePlanDag(cyclicTasks)).toThrow(DependencyCycleError);
  });

  it("detects and rejects missing dependency references", () => {
    const tasks = [{ id: "A", title: "A", dependencies: ["NON_EXISTENT"] }];

    expect(() => validatePlanDag(tasks)).toThrow(MissingDependencyError);
  });

  it("computes ready-task sets respecting completion state and priority", () => {
    const tasks = [
      { id: "A", status: "completed", dependencies: [] },
      { id: "B", status: "pending", dependencies: ["A"], priority: 50 },
      { id: "C", status: "pending", dependencies: ["A"], priority: 150 },
      { id: "D", status: "pending", dependencies: ["B"] },
    ];

    const ready = getReadyTasks(tasks);
    // C has higher priority (150 > 50), D is blocked on B
    expect(ready).toEqual(["C", "B"]);
  });

  it("computes deterministic SHA-256 plan checksum", () => {
    const hash1 = computePlanChecksum("# Plan A");
    const hash2 = computePlanChecksum("# Plan A\n");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });
});
