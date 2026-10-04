import { describe, expect, it } from "vite-plus/test";

import { agentFootprints, estimateAgentCapacity } from "./agentCapacity";

const GIB = 1024 ** 3;
const row = (
  pid: number,
  category: "provider-root" | "server-child",
  residentBytes: number,
  childPids: number[] = [],
) => ({ identity: { pid }, category, residentBytes, childPids }) as never;

describe("agent capacity", () => {
  it("adds an agent's child processes to its footprint", () => {
    const footprints = agentFootprints([
      row(10, "provider-root", 1 * GIB, [11]),
      row(11, "server-child", 2 * GIB),
      row(20, "provider-root", 1 * GIB),
      row(30, "server-child", 5 * GIB),
    ]);
    expect(footprints).toEqual([3 * GIB, 1 * GIB]);
  });

  it("does not loop on a cyclic process table", () => {
    const footprints = agentFootprints([
      row(10, "provider-root", GIB, [11]),
      row(11, "server-child", GIB, [10]),
    ]);
    expect(footprints).toEqual([2 * GIB]);
  });

  it("counts free slots from measured agents and keeps a reserve", () => {
    const capacity = estimateAgentCapacity(
      { totalMemoryBytes: 30 * GIB, availableMemoryBytes: 14 * GIB },
      [2 * GIB, 2 * GIB, 2 * GIB],
    );
    expect(capacity).toMatchObject({ usedBytes: 16 * GIB, agentCount: 3, perAgentMeasured: true });
    // 14 GiB free minus the 3 GiB reserve, at 2 GiB each.
    expect(capacity.slots).toBe(5);
  });

  it("assumes 1 GiB per agent before any agent runs and never goes negative", () => {
    expect(
      estimateAgentCapacity({ totalMemoryBytes: 30 * GIB, availableMemoryBytes: 20 * GIB }, [])
        .slots,
    ).toBe(17);
    expect(
      estimateAgentCapacity({ totalMemoryBytes: 30 * GIB, availableMemoryBytes: GIB }, []).slots,
    ).toBe(0);
  });
});
