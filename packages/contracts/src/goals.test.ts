import { describe, expect, it } from "vite-plus/test";

import {
  goalInstructions,
  goalPrompt,
  problemStreak,
  replyReportsBlockedWork,
  goalSettingsProblem,
  goalTitle,
  parseOverseerReply,
  replyNeedsAttention,
  replyReportsGoalComplete,
} from "./goals.ts";

describe("goal completion", () => {
  it("counts only the marker on its own line", () => {
    expect(replyReportsGoalComplete("All merged.\n\nGOAL COMPLETE")).toBe(true);
    expect(replyReportsGoalComplete("  GOAL COMPLETE  ")).toBe(true);
    expect(replyReportsGoalComplete("I will say GOAL COMPLETE when done.")).toBe(false);
    expect(replyReportsGoalComplete(undefined)).toBe(false);
  });
});

describe("needs attention", () => {
  it("counts only the marker on its own line", () => {
    expect(replyNeedsAttention("Blocked on a login.\nNEEDS ATTENTION")).toBe(true);
    expect(replyNeedsAttention("This needs attention soon.")).toBe(false);
    expect(replyNeedsAttention(undefined)).toBe(false);
  });
});

describe("goalPrompt", () => {
  it("always tells the agent how to work alone and how to say nothing is left", () => {
    const prompt = goalPrompt({ name: "Finish PLAN.md.", concurrency: 3, standardRules: false });
    expect(prompt.startsWith("Finish PLAN.md.")).toBe(true);
    expect(prompt).toContain("up to 3 agents");
    expect(prompt).toContain("GOAL COMPLETE");
    expect(prompt).toContain("BLOCKED TASKS");
    expect(prompt).toContain("NEEDS ATTENTION");
    expect(prompt).not.toContain("git worktree");
  });

  it("adds the working rules only when asked", () => {
    const prompt = goalPrompt({ name: "Finish PLAN.md.", concurrency: 2, standardRules: true });
    expect(prompt).toContain("plan-work select --plan PLAN.md");
    expect(prompt).toContain("stable branch and worktree");
    expect(prompt).toContain("plan-work land --owner-token TOKEN");
  });
});

describe("goalTitle", () => {
  it("uses the first line and shortens a long one", () => {
    expect(goalTitle({ name: "Ship it\nand more detail" })).toBe("Ship it");
    expect(goalTitle({ name: "x".repeat(200) })).toHaveLength(80);
  });
});

describe("goalSettingsProblem", () => {
  const agent = { modelSelection: {} as never, count: 1 };
  it("accepts a ready setup, including one with no cap", () => {
    expect(
      goalSettingsProblem({ name: "Do it", agents: [agent], concurrency: 3, maxChats: 50 }),
    ).toBeUndefined();
    expect(
      goalSettingsProblem({ name: "Do it", agents: [agent], concurrency: 3, maxChats: null }),
    ).toBeUndefined();
  });

  it("explains what is missing", () => {
    expect(
      goalSettingsProblem({ name: "  ", agents: [agent], concurrency: 3, maxChats: null }),
    ).toContain("what the goal is");
    expect(
      goalSettingsProblem({ name: "Do it", agents: [], concurrency: 3, maxChats: null }),
    ).toContain("at least one model");
    expect(
      goalSettingsProblem({ name: "Do it", agents: [agent], concurrency: 5, maxChats: 3 }),
    ).toContain("at least as many");
  });
});

describe("goal instructions", () => {
  it("send the agent prompt, not the name, when there is one", () => {
    const goal = { name: "Ship v2", concurrency: 2, standardRules: false };
    expect(goalInstructions(goal)).toBe("Ship v2");
    expect(goalInstructions({ ...goal, prompt: "  " })).toBe("Ship v2");
    expect(goalPrompt({ ...goal, prompt: "Work PLAN.md" }).startsWith("Work PLAN.md")).toBe(true);
  });

  it("gives coding workers the plan-work lifecycle", () => {
    const prompt = goalPrompt({ name: "Ship v2", concurrency: 2, standardRules: true });
    expect(prompt).toContain("plan-work select --plan PLAN.md");
    expect(prompt).toContain("OWNER_TOKEN");
    expect(prompt).toContain("plan-work land --owner-token TOKEN");
    expect(prompt).toContain("normal non-Beads workflow");
    expect(prompt).not.toContain("bd ");
    expect(prompt).not.toContain("agent-work");
  });

  it("recognises blocked work on its own line", () => {
    expect(replyReportsBlockedWork("Waiting.\nBLOCKED TASKS")).toBe(true);
    expect(
      replyReportsBlockedWork(
        "All waiting.\nBLOCKED TASKS — unfinished work remains, but every piece waits on work that is not done yet.",
      ),
    ).toBe(true);
    expect(replyReportsBlockedWork("BLOCKED TASKS: dependency FX4.5 is still incomplete")).toBe(
      true,
    );
    expect(replyReportsBlockedWork("some BLOCKED TASKS here")).toBe(false);
  });
});

describe("problemStreak", () => {
  const chat = (status: string, minute: number, blockedWork = false) =>
    ({
      status,
      completedAt: `2026-10-04T12:0${minute}:00.000Z`,
      ...(blockedWork ? { blockedWork } : {}),
    }) as never;

  it("counts the latest chats in a row that did not finish their work", () => {
    expect(
      problemStreak([
        chat("completed", 1),
        chat("failed", 2),
        chat("attention", 3),
        chat("completed", 4, true),
      ]),
    ).toBe(3);
  });

  it("resets on a success and ignores chats still running", () => {
    expect(problemStreak([chat("failed", 1), chat("completed", 2), chat("failed", 3)])).toBe(1);
    expect(problemStreak([{ status: "running" } as never, chat("completed", 1)])).toBe(0);
  });

  it("does not count chats stopped by a usage limit or the person, in either direction", () => {
    expect(problemStreak([chat("failed", 1), chat("stopped", 2), chat("failed", 3)])).toBe(2);
    expect(problemStreak([chat("completed", 1), chat("stopped", 2), chat("failed", 3)])).toBe(1);
    expect(problemStreak([chat("stopped", 1), chat("stopped", 2)])).toBe(0);
  });
});

describe("overseer reply", () => {
  it("reads the verdict, released chunks and the note after GUIDANCE", () => {
    expect(
      parseOverseerReply(
        "Looked at it.\nOVERSEER: continue\nRELEASE: bd-1, bd-2\nGUIDANCE: Install first.\nThen test.",
      ),
    ).toEqual({
      verdict: "continue",
      release: ["bd-1", "bd-2"],
      guidance: "Install first.\nThen test.",
      chats: new Map(),
    });
  });

  it("treats a reply with no verdict as no answer", () => {
    expect(parseOverseerReply("I think maybe continue?")).toEqual({
      verdict: undefined,
      release: [],
      guidance: undefined,
      chats: new Map(),
    });
    expect(parseOverseerReply("OVERSEER: STOP").verdict).toBe("stop");
  });

  it("reads the prompt for each stuck chat, which may span lines", () => {
    const decision = parseOverseerReply(
      "OVERSEER: CONTINUE\nCHAT 2: Pick option A.\nThen merge.\nCHAT 1: Retry the push.\nGUIDANCE: All: pull first.",
    );
    expect(decision.chats.get(2)).toBe("Pick option A.\nThen merge.");
    expect(decision.chats.get(1)).toBe("Retry the push.");
    expect(decision.guidance).toBe("All: pull first.");
  });

  it("puts the overseer's note into worker prompts", () => {
    const prompt = goalPrompt({
      name: "x",
      concurrency: 1,
      standardRules: false,
      guidance: "Run install first.",
    });
    expect(prompt).toContain("Run install first.");
  });
});
