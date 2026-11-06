import { describe, expect, it } from "vitest";
import { accountOwnsPost, nextMineFlags, postInProject } from "./mine";

const a = (id: string, mine?: boolean) => ({ id, owner: "alex", mine });
const other = { id: "x", owner: "jordan", mine: true };

describe("nextMineFlags", () => {
  it("marks one account and clears the previous mine", () => {
    expect(nextMineFlags([a("1", true), a("2"), other], "alex", "2")).toEqual([
      { id: "1", mine: false },
      { id: "2", mine: true },
    ]);
  });

  it("unsets mine on that owner only", () => {
    expect(nextMineFlags([a("1", true), other], "alex", null)).toEqual([{ id: "1", mine: false }]);
  });

  it("is a no-op when the flag is already right", () => {
    expect(nextMineFlags([a("1", true), a("2")], "alex", "1")).toEqual([]);
  });
});

describe("postInProject", () => {
  const mine = { id: "mine", username: "TinyAcrobatics" };
  const own = { accountId: "mine", creator: { username: "tinyacrobatics" }, projectId: "other" };
  const competitor = { accountId: "comp", creator: { username: "coach" }, projectId: "baby" };

  it("keeps own posts visible in every project", () => {
    expect(postInProject(own, "baby", { mine })).toBe(true);
    expect(postInProject(own, "other", { mine })).toBe(true);
  });

  it("hides competitor posts from other projects", () => {
    expect(postInProject(competitor, "baby", { mine })).toBe(true);
    expect(postInProject(competitor, "other", { mine })).toBe(false);
  });

  it("when focusing mine, shows own posts regardless of stamp", () => {
    expect(postInProject(own, "baby", { focus: { ...mine, mine: true } })).toBe(true);
  });

  it("when focusing a competitor, stays project-scoped", () => {
    expect(postInProject(competitor, "other", { focus: { id: "comp", username: "coach" } })).toBe(false);
    expect(accountOwnsPost({ id: "comp", username: "coach" }, competitor)).toBe(true);
  });
});
