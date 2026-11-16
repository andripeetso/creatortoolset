import { describe, expect, it } from "vitest";
import type { WorkshopProject } from "@/lib/workshop";
import { ALL_WORKSPACES, inWorkspace, moveItems, shownWorkspace } from "./workspace-pick";

const ws = (id: string) => ({ id, name: id.toUpperCase() }) as WorkshopProject;
const two = [ws("a"), ws("b")];

describe("the Settings workspace selector", () => {
  it("a list page starts on all workspaces; a page of single values on the window's own", () => {
    expect(shownWorkspace("list", null, two, "b")).toMatchObject({ all: true, id: null, cacheKey: "*", many: true });
    expect(shownWorkspace("one", null, two, "b")).toMatchObject({ all: false, id: "b", cacheKey: undefined });
    // All picked on a list page, then a page of single values: the window's own
    expect(shownWorkspace("one", ALL_WORKSPACES, two, "b")).toMatchObject({ all: false, id: "b" });
  });

  it("a picked workspace is shown whatever the window is in, and kept apart in the saved copies", () => {
    expect(shownWorkspace("list", "a", two, "b")).toMatchObject({ all: false, id: "a", cacheKey: "a" });
    expect(shownWorkspace("one", "a", two, "b")).toMatchObject({ id: "a", cacheKey: "a" });
    // a workspace that is gone falls back
    expect(shownWorkspace("one", "gone", two, "b")).toMatchObject({ id: "b" });
  });

  it("with one workspace there is nothing to choose or to label", () => {
    expect(shownWorkspace("list", null, [ws("a")], "a")).toMatchObject({ all: false, id: "a", many: false, cacheKey: undefined });
    expect(shownWorkspace("list", null, [], null)).toMatchObject({ all: false, id: null, many: false });
  });

  it("a page limited to some workspaces shows one of those", () => {
    const three = [...two, ws("c")];
    expect(shownWorkspace("one", null, three, "a", ["b", "c"])).toMatchObject({ id: "b", many: true });
    expect(shownWorkspace("one", "a", three, "a", ["b"]).id).toBe("b");
  });

  it("names a row's workspace", () => {
    const w = shownWorkspace("list", null, two, "a");
    expect([w.name("a"), w.name(null), w.name("x")]).toEqual(["A", "Every workspace", "Another workspace"]);
  });

  it("a row moves to each other workspace, or to every workspace when it has one", () => {
    const labels = (current: string | null) => moveItems(two, current, () => {}).map((i) => i.label);
    expect(labels("a")).toEqual(["Move to B", "Use in every workspace"]);
    expect(labels(null)).toEqual(["Move to A", "Move to B"]);
    expect(moveItems([ws("a")], "a", () => {})).toEqual([]);
  });

  it("a request for the shown workspace names it", () => {
    expect(new Headers(inWorkspace("a", { method: "POST" })?.headers).get("X-CT-Workspace")).toBe("a");
    expect(inWorkspace(null)).toBeUndefined();
  });
});
