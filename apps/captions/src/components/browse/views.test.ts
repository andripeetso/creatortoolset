// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { BROWSE_TOOLS, BROWSE_VIEWS, byName, defaultView, matches, pageView, persistDefaultView, resetDefaultViews } from "./views";

// Which view a tool's list opens in: a pick made on its page, else Settings → Appearance, else ours.

beforeEach(() => localStorage.clear());

describe("browse views", () => {
  it("ours until anything is picked: cards for Review, rows for the AI Editor", () => {
    expect(pageView("review")).toBe("grid");
    expect(pageView("editor")).toBe("list");
    for (const t of BROWSE_TOOLS) expect(pageView(t)).toBe(BROWSE_VIEWS[t].view);
  });

  it("a pick on the page wins over Appearance, and Caption Studio keeps the key its pick always had", () => {
    localStorage.setItem("appearance:view:review", "list");
    expect(pageView("review")).toBe("list");
    localStorage.setItem("browse:view:review", "grid");
    expect(pageView("review")).toBe("grid");
    localStorage.setItem("cap-projects-view", "list");
    expect(pageView("captions")).toBe("list");
  });

  it("setting a default in Appearance drops the page's pick, so the change shows", () => {
    localStorage.setItem("browse:view:editor", "list");
    persistDefaultView("editor", "grid");
    expect(defaultView("editor")).toBe("grid");
    expect(pageView("editor")).toBe("grid");
    expect(localStorage.getItem("browse:view:editor")).toBeNull();
    // ours again: nothing kept
    persistDefaultView("editor", "list");
    expect(localStorage.getItem("appearance:view:editor")).toBeNull();
  });

  it("reset puts every tool back to ours, the pages' picks too", () => {
    persistDefaultView("review", "list");
    localStorage.setItem("browse:view:notes", "grid");
    localStorage.setItem("cap-projects-view", "list");
    resetDefaultViews();
    for (const t of BROWSE_TOOLS) expect(pageView(t)).toBe(BROWSE_VIEWS[t].view);
  });

  it("a value that is not a view is ignored", () => {
    localStorage.setItem("browse:view:review", "tiles");
    expect(pageView("review")).toBe("grid");
  });

  it("search and name order", () => {
    expect(matches("  bath ", "Bath time tips")).toBe(true);
    expect(matches("", "anything")).toBe(true);
    expect(matches("roll", "Bath", undefined)).toBe(false);
    expect(["Take 10", "take 2", "Take 1"].map((name) => ({ name })).sort(byName).map((x) => x.name)).toEqual(["Take 1", "take 2", "Take 10"]);
  });
});
