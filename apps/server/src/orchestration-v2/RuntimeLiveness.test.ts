import { describe, expect, it } from "@effect/vitest";

import {
  assessRuntimeLiveness,
  deadlineFromStartedAt,
  OWNED_RUNTIME_DEADLINE_MS,
  OWNED_RUNTIME_SUSPICION_MS,
} from "./RuntimeLiveness.ts";

describe("RuntimeLiveness", () => {
  it("stops CPU-burning or vanished work at its owned absolute deadline", () => {
    const startedAt = 10_000;
    const state = { startedAt, lastProgressAt: startedAt, waitState: null, waitChangedAt: null };
    // CPU use and repeated liveness polls do not alter persisted progress time.
    expect(assessRuntimeLiveness(state, startedAt + OWNED_RUNTIME_DEADLINE_MS)).toBe("stop");
    expect(deadlineFromStartedAt(startedAt)).toBe(startedAt + OWNED_RUNTIME_DEADLINE_MS);
  });

  it("allows a valid bounded wait longer than an hour without polling extending it", () => {
    const startedAt = 0;
    const waitChangedAt = 1_000;
    const state = {
      startedAt,
      lastProgressAt: startedAt,
      waitState: "bounded" as const,
      waitChangedAt,
    };
    expect(assessRuntimeLiveness(state, waitChangedAt + 65 * 60_000)).toBe("healthy");
    expect(assessRuntimeLiveness(state, startedAt + OWNED_RUNTIME_DEADLINE_MS)).toBe("stop");
  });

  it("preserves approval and quota waits", () => {
    const startedAt = 0;
    for (const waitState of ["approval", "quota"] as const) {
      expect(
        assessRuntimeLiveness(
          { startedAt, lastProgressAt: startedAt, waitState, waitChangedAt: null },
          startedAt + OWNED_RUNTIME_DEADLINE_MS - 1,
        ),
      ).toBe("healthy");
    }
  });

  it("marks silence suspect before cleanup and permits bounded productive goal turns", () => {
    const startedAt = 0;
    const state = { startedAt, lastProgressAt: 0, waitState: null, waitChangedAt: null };
    expect(assessRuntimeLiveness(state, OWNED_RUNTIME_SUSPICION_MS)).toBe("suspect");

    // Goals make progress through separate bounded runs; each run has its own
    // durable start and progress timestamp rather than one unbounded session.
    const turns = Array.from({ length: 20 }, (_, index) => {
      const turnStartedAt = index * 60 * 60_000;
      return assessRuntimeLiveness(
        {
          startedAt: turnStartedAt,
          lastProgressAt: turnStartedAt + 60 * 60_000 - 1,
          waitState: null,
          waitChangedAt: null,
        },
        turnStartedAt + 60 * 60_000 - 1,
      );
    });
    expect(turns.every((decision) => decision === "healthy")).toBe(true);
  });

  it("keeps the original deadline after restart from persisted timestamps", () => {
    const state = {
      startedAt: 1234,
      lastProgressAt: 1234 + OWNED_RUNTIME_DEADLINE_MS / 2,
      waitState: null,
      waitChangedAt: null,
    };
    const restartedAt = state.startedAt + OWNED_RUNTIME_DEADLINE_MS / 2;
    expect(deadlineFromStartedAt(state.startedAt)).toBe(
      state.startedAt + OWNED_RUNTIME_DEADLINE_MS,
    );
    expect(assessRuntimeLiveness(state, restartedAt)).toBe("healthy");
    expect(assessRuntimeLiveness(state, state.startedAt + OWNED_RUNTIME_DEADLINE_MS)).toBe("stop");
  });
});
