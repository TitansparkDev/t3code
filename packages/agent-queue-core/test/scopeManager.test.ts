// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
import { describe, expect, it } from "vite-plus/test";
import {
  patternsOverlap,
  scopesIntersect,
  hasScopeConflict,
  hasResourceConflict,
} from "../src/scopeManager.ts";

describe("AgentQueue Scope & Resource Conflict Manager (AQ-009)", () => {
  it("detects overlapping file and directory glob patterns", () => {
    expect(patternsOverlap("apps/server/**", "apps/server/src/goals.ts")).toBe(true);
    expect(patternsOverlap("apps/server/src/**", "apps/server/**")).toBe(true);
    expect(
      patternsOverlap("packages/contracts/src/queue.ts", "packages/contracts/src/queue.ts"),
    ).toBe(true);

    expect(patternsOverlap("apps/server/**", "apps/web/**")).toBe(false);
    expect(patternsOverlap("packages/contracts/**", "packages/shared/**")).toBe(false);
  });

  it("evaluates scope intersection across pattern arrays", () => {
    const scopeA = ["apps/server/**", "packages/contracts/**"];
    const scopeB = ["apps/web/**"];
    const scopeC = ["packages/contracts/src/queue.ts"];

    expect(scopesIntersect(scopeA, scopeB)).toBe(false);
    expect(scopesIntersect(scopeA, scopeC)).toBe(true);
  });

  it("prevents concurrent execution of exclusive tasks with overlapping scopes", () => {
    const activeTasks = [
      {
        taskId: "TASK-1",
        patterns: ["apps/server/**"],
        conflictMode: "exclusive" as const,
      },
    ];

    const conflictingCandidate = {
      taskId: "TASK-2",
      patterns: ["apps/server/src/queue/**"],
      conflictMode: "exclusive" as const,
    };

    const nonConflictingCandidate = {
      taskId: "TASK-3",
      patterns: ["apps/web/**"],
      conflictMode: "exclusive" as const,
    };

    expect(hasScopeConflict(conflictingCandidate, activeTasks)).toBe(true);
    expect(hasScopeConflict(nonConflictingCandidate, activeTasks)).toBe(false);
  });

  it("allows concurrent execution when both tasks declare shared conflict mode", () => {
    const activeTasks = [
      {
        taskId: "READ-1",
        patterns: ["docs/**"],
        conflictMode: "shared" as const,
      },
    ];

    const sharedCandidate = {
      taskId: "READ-2",
      patterns: ["docs/agentqueue/**"],
      conflictMode: "shared" as const,
    };

    const exclusiveCandidate = {
      taskId: "WRITE-1",
      patterns: ["docs/agentqueue/**"],
      conflictMode: "exclusive" as const,
    };

    expect(hasScopeConflict(sharedCandidate, activeTasks)).toBe(false);
    expect(hasScopeConflict(exclusiveCandidate, activeTasks)).toBe(true);
  });

  it("enforces resource class limits", () => {
    const activeWithHeavyBuild = [{ resourceClass: "heavy_build" }, { resourceClass: "browser" }];

    // heavy_build default limit is 1 -> rejected
    expect(hasResourceConflict("heavy_build", activeWithHeavyBuild)).toBe(true);

    // browser default limit is 2 -> allowed (currently 1 active)
    expect(hasResourceConflict("browser", activeWithHeavyBuild)).toBe(false);

    // codegen default limit is 2 -> allowed (currently 0 active)
    expect(hasResourceConflict("codegen", activeWithHeavyBuild)).toBe(false);

    // Tasks without resource class are never blocked by resource limits
    expect(hasResourceConflict(null, activeWithHeavyBuild)).toBe(false);
  });
});
