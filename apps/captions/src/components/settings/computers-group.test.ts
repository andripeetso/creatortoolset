import { describe, expect, it } from "vitest";
import { groupComputers, kindOf, type Listed } from "./computers-group";

const DAY = 86_400_000;
const NOW = 10 * DAY;

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
const pairing = (over: Partial<Listed> = {}): Listed => ({
  id: "p", owner: "andri", name: "Sam's Mac Studio (6)", createdAt: 0, online: false, lastSeen: NOW - 3 * DAY, ...over,
});

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

  it("folds this Mac's worker, its app record and its old pairing into one 'This Mac' group by the Mac app's names", () => {
    const worker = mac({ id: "w", owner: "workspace", name: "AI worker (the owner's Mac)", host: "sams.local", online: true });
    const old = pairing({ id: "p" });
    const other = mac({ id: "x", owner: "andri", name: "Office Mac mini", host: "office.local", lastSeen: NOW - 2 * DAY });
    const groups = groupComputers([other, worker, old], "andri", { computer: "Sam's Mac Studio", host: "sams.local" }, () => false, NOW);
    expect(groups.map((g) => [g.mine, g.records.map((r) => r.id).sort()])).toEqual([
      [true, ["p", "w"]],
      [false, ["x"]],
    ]);
    expect(groups[0]!.old).toBe(false);
  });

  it("without the Mac app's names an old pairing stays its own group, and an old one with no AI is folded", () => {
    const worker = mac({ id: "w", owner: "workspace", host: "sams.local", online: true });
    const old = pairing({ id: "p" });
    const withAi = pairing({ id: "q", name: "Lab Mac" });
    const groups = groupComputers([worker, old, withAi], "andri", {}, (id) => id === "q", NOW);
    expect(groups.map((g) => [g.mine, g.old, g.primary.id])).toEqual([
      [false, false, "w"],
      [false, true, "p"],
      [false, false, "q"],
    ]);
  });

  it("names what a record is: the team's worker or the Mac app", () => {
    expect(kindOf(mac({ owner: "workspace" }))).toBe("AI Editor worker");
    expect(kindOf(mac({ owner: "andri" }))).toBe("Mac app");
  });
});
