import { describe, expect, it } from "vitest";
import { setupSteps, toolForPath } from "./setup";

describe("setup steps", () => {
  it("follows the answer to How do you want to use Creator Toolset?", () => {
    expect(setupSteps(["workshop"], "app")).toEqual(["how", "tools", "project", "ai", "left"]);
    expect(setupSteps(["workshop"], "chat")).toEqual(["how", "connect", "left"]);
    expect(setupSteps(["workshop"], "both")).toEqual(["how", "tools", "project", "ai", "connect", "left"]);
    expect(setupSteps([], "app")).toEqual(["how", "tools", "left"]);
  });

  it("asks for a first project only for the Workshop or the Analyzer", () => {
    expect(setupSteps(["instagram"], "app")).toContain("project");
    expect(setupSteps(["editor", "captions"], "app")).not.toContain("project");
  });

  it("asks about AI only when a ticked tool uses it", () => {
    expect(setupSteps(["enhance", "review", "clean", "stories"], "both")).toEqual(["how", "tools", "connect", "left"]);
    expect(setupSteps(["captions"], "app")).toEqual(["how", "tools", "ai", "left"]);
    expect(setupSteps(["notes"], "app")).toContain("ai");
  });

  it("never asks for an account on the first run", () => {
    for (const talk of ["app", "chat", "both"] as const) expect(setupSteps(["workshop"], talk)).not.toContain("account");
  });
});

it("knows each tool's pages", () => {
  expect(toolForPath("/analyzer/accounts/1")).toBe("instagram");
  expect(toolForPath("/library")).toBe("media");
  expect(toolForPath("/video-notes/abc")).toBe("notes");
  expect(toolForPath("/settings/setup")).toBeNull();
  expect(toolForPath("/")).toBeNull();
});
