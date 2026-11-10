import { describe, expect, it } from "vitest";
import { groupComputers, type Listed } from "./computers-group";

const mac = (over: Partial<Listed> & { host?: string; memGb?: number } = {}): Listed => {
  const { host = "studio.local", memGb = 32, ...rest } = over;
  return {
    id: rest.id ?? Math.random().toString(36).slice(2),
    owner: "andri",
    name: "Andri's Mac Studio",
    createdAt: 0,
    online: false,
    report: { at: 0, drivers: [], homes: [], machine: { cpus: 12, memGb, cpu: "Apple M2 Max", host } },
    ...rest,
  };
};

describe("groupComputers", () => {
  it("shows one Mac once when the app and the worker report it, across owners", () => {
    const app = mac({ id: "a", owner: "andri", online: false });
    const worker = mac({ id: "w", owner: "workspace", name: "AI worker (the owner's Mac)", online: true });
    const [g] = groupComputers([app, worker], "andri");
    expect(g!.records.map((r) => r.id)).toEqual(["a", "w"]);
    expect(g!.primary.id).toBe("w");
  });

  it("keeps two different Macs apart, and a record with no report alone", () => {
    const a = mac({ id: "a", host: "one.local" });
    const b = mac({ id: "b", host: "two.local" });
    const bigger = mac({ id: "c", host: "one.local", memGb: 64 });
    const noReport = { ...mac({ id: "d" }), report: undefined };
    expect(groupComputers([a, b, bigger, noReport], "andri").map((g) => g.records.length)).toEqual([1, 1, 1, 1]);
  });

  it("speaks for the group with its own record when nothing is online", () => {
    const team = mac({ id: "t", owner: "workspace", lastSeen: 5 });
    const own = mac({ id: "o", owner: "andri", lastSeen: 1 });
    expect(groupComputers([team, own], "andri")[0]!.primary.id).toBe("o");
  });
});
