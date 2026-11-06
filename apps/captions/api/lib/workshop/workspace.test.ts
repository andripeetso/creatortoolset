import { describe, expect, it } from "vitest";
import { inProject } from "./workspace";

describe("inProject", () => {
  it("shows everything when no current project is set", () => {
    expect(inProject({}, null)).toBe(true);
    expect(inProject({ projectId: "a" })).toBe(true);
  });

  it("keeps unassigned records visible in every project", () => {
    expect(inProject({}, "baby")).toBe(true);
    expect(inProject({ projectId: undefined }, "baby")).toBe(true);
  });

  it("hides records stamped with a different project", () => {
    expect(inProject({ projectId: "baby" }, "baby")).toBe(true);
    expect(inProject({ projectId: "other" }, "baby")).toBe(false);
  });
});
