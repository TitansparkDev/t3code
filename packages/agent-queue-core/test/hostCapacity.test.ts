import { describe, expect, it } from "vite-plus/test";
import {
  effectiveCgroupMemory,
  effectiveMemorySnapshot,
  parseCgroupMemoryValue,
  admitWorker,
  type HostSnapshot,
} from "../src/hostCapacity.ts";

const host: HostSnapshot = {
  totalMb: 25_430,
  availableMb: 8_000,
  swapUsedMb: 7_500,
  swapTotalMb: 8_000,
  cpus: 16,
  load1: 1,
};

describe("effective cgroup memory", () => {
  it("parses byte values and treats max, missing and invalid controllers as unbounded", () => {
    expect(parseCgroupMemoryValue("16777216\n")).toBe(16 * 1024 * 1024);
    expect(parseCgroupMemoryValue("max")).toBeUndefined();
    expect(parseCgroupMemoryValue("")).toBeUndefined();
    expect(parseCgroupMemoryValue("not bytes")).toBeUndefined();
  });

  it("uses the tightest nested limit and available headroom", () => {
    const levels = [
      { max: "max", current: "9000000" },
      { max: "16000000000", current: "4000000000" },
      { max: "12000000000", current: "5000000000" },
    ];
    expect(effectiveCgroupMemory(levels)).toEqual({
      limitBytes: 12_000_000_000,
      availableBytes: 7_000_000_000,
    });
    expect(effectiveMemorySnapshot({ totalMb: 25_430, availableMb: 20_000 }, levels)).toEqual({
      totalMb: 11_444,
      availableMb: 6_675,
    });
  });

  it("counts a budget's inactive file cache as headroom, since the kernel reclaims it first", () => {
    const levels = [
      {
        max: "16000000000",
        current: "4000000000",
        stat: "anon 600000000\nfile 3400000000\ninactive_file 3000000000\n",
      },
    ];
    expect(effectiveCgroupMemory(levels).availableBytes).toBe(15_000_000_000);
  });

  it("keeps host capacity when the memory controller is absent", () => {
    expect(
      effectiveMemorySnapshot({ totalMb: 25_430, availableMb: 20_000 }, [
        { max: "max", current: "1000" },
        { max: "", current: "" },
      ]),
    ).toEqual({ totalMb: 25_430, availableMb: 20_000 });
  });

  it("does not bypass a critical budget for the first worker or block on historical swap alone", () => {
    expect(
      admitWorker({ snapshot: host, reserveMb: 3_072, footprintMb: 1_200, running: 0 }).ok,
    ).toBe(true);
    expect(
      admitWorker({ snapshot: { ...host, availableMb: 4_000 }, reserveMb: 3_072, running: 0 }).ok,
    ).toBe(false);
  });

  it("waits during sustained memory and swap pressure until both clear", () => {
    expect(admitWorker({ snapshot: { ...host, memoryPressure: 12 }, running: 2 }).ok).toBe(false);
    expect(admitWorker({ snapshot: { ...host, swapPressure: true }, running: 2 }).ok).toBe(false);
    expect(admitWorker({ snapshot: host, running: 2 }).ok).toBe(true);
  });
});
