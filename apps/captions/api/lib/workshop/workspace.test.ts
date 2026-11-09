import { describe, expect, it } from "vitest";
import { inProject } from "./workspace";

describe("inProject", () => {
  it("shows everything when no current project is set", () => {
    expect(inProject({}, null)).toBe(true);
    expect(inProject({ projectId: "a" })).toBe(true);
  });

  it("keeps unassigned records visible in every project", () => {
    expect(inProject({}, "puppy")).toBe(true);
    expect(inProject({ projectId: undefined }, "puppy")).toBe(true);
  });

  it("hides records stamped with a different project", () => {
    expect(inProject({ projectId: "puppy" }, "puppy")).toBe(true);
    expect(inProject({ projectId: "other" }, "puppy")).toBe(false);
  });
});
