import { describe, expect, it } from "vitest";
import type { MemberView } from "@contracts/workspaces";
import { budgetFrom, memberLine } from "./WorkspaceSection";

const member = (over: Partial<MemberView>): MemberView => ({
  username: "alex",
  role: "member",
  ai: "budget",
  budgetUsd: 25,
  joinedAt: 0,
  spentUsd: 14.2,
  lastActiveAt: 0,
  off: [],
  ...over,
});

describe("budgetFrom (the AI dialog's budget field)", () => {
  it("reads dollars, with $ and commas allowed, to the cent", () => {
    expect(budgetFrom("25")).toEqual({ ok: true, usd: 25 });
    expect(budgetFrom("$1,250.505")).toEqual({ ok: true, usd: 1250.51 });
  });

  it("refuses an empty, zero, tiny, huge or non-number budget", () => {
    for (const bad of ["", "  ", "0", "0.5", "10001", "ten"]) {
      expect(budgetFrom(bad)).toMatchObject({ ok: false });
    }
  });
});

describe("memberLine (the owner's row subtitle)", () => {
  it("shows the budget's spend and the cap on a budget member", () => {
    expect(memberLine(member({}), false, true)).toMatch(/^API budget \$14\.20 of \$25 this month · not signed in yet$/);
  });

  it("shows own AI for an owner's view, and nothing for another member's row", () => {
    expect(memberLine(member({ ai: "own" }), false, true)).toBe("Own AI · not signed in yet");
    expect(memberLine(member({}), false, false)).toBe("");
  });
});
