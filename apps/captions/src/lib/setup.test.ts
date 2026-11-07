import { describe, expect, it } from "vitest";
import { setupSteps, toolForPath } from "./setup";

describe("setup steps", () => {
  it("asks about the account only in the Mac app", () => {
    expect(setupSteps([], { account: true })).toEqual(["account", "tools", "left"]);
    expect(setupSteps([], { account: false })).toEqual(["tools", "left"]);
  });

  it("asks for a first project only for the Workshop or the Analyzer", () => {
    expect(setupSteps(["workshop"], { account: false })).toEqual(["tools", "project", "ai", "left"]);
    expect(setupSteps(["instagram"], { account: false })).toContain("project");
    expect(setupSteps(["editor", "captions"], { account: false })).not.toContain("project");
  });

  it("asks about AI only when a ticked tool uses it", () => {
    expect(setupSteps(["enhance", "review", "clean", "stories"], { account: true })).toEqual(["account", "tools", "left"]);
    expect(setupSteps(["captions"], { account: false })).toEqual(["tools", "ai", "left"]);
    expect(setupSteps(["notes"], { account: false })).toContain("ai");
  });
});

it("knows each tool's pages", () => {
  expect(toolForPath("/analyzer/accounts/1")).toBe("instagram");
  expect(toolForPath("/library")).toBe("media");
  expect(toolForPath("/video-notes/abc")).toBe("notes");
  expect(toolForPath("/settings/setup")).toBeNull();
  expect(toolForPath("/")).toBeNull();
});
