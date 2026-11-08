import { describe, expect, it } from "vitest";
import { setupSteps, toolForPath, toolsFor } from "./setup";
import { TOOLS } from "@contracts/tools";

describe("setup steps", () => {
  it("follows the answer to How do you want to use Creator Toolset?", () => {
    expect(setupSteps(["workshop"], "app")).toEqual(["how", "make", "tools", "project", "ai", "left"]);
    expect(setupSteps(["workshop"], "chat")).toEqual(["how", "connect", "left"]);
    expect(setupSteps(["workshop"], "both")).toEqual(["how", "make", "tools", "project", "ai", "connect", "left"]);
    expect(setupSteps([], "app")).toEqual(["how", "make", "tools", "left"]);
  });

  it("asks for a first project only for the Workshop or the Analyzer", () => {
    expect(setupSteps(["instagram"], "app")).toContain("project");
    expect(setupSteps(["editor", "captions"], "app")).not.toContain("project");
  });

  it("asks about AI only when a ticked tool uses it", () => {
    expect(setupSteps(["enhance", "review", "clean", "stories"], "both")).toEqual(["how", "make", "tools", "connect", "left"]);
    expect(setupSteps(["captions"], "app")).toEqual(["how", "make", "tools", "ai", "left"]);
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

it("ticks the tools for what they make", () => {
  expect(toolsFor(["newsletter", "article"], TOOLS)).toEqual(["workshop"]);
  expect(toolsFor(["thread"], TOOLS)).toEqual(["instagram", "workshop"]);
  expect(toolsFor(["reel"], TOOLS)).toContain("editor");
  expect(toolsFor(["reel"], ["workshop", "review"])).toEqual(["workshop", "review"]);
});

it("asks for a Media Library only when they make video or pictures", () => {
  for (const m of ["newsletter", "article", "thread", "podcast", "course", "recording", "other"] as const) expect(toolsFor([m], TOOLS)).not.toContain("media");
  for (const m of ["reel", "youtube", "carousel", "ad"] as const) expect(toolsFor([m], TOOLS)).toContain("media");
});
