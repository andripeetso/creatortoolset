import { describe, expect, it } from "vitest";
import { byProject } from "./by-project";

describe("a list kept apart by project", () => {
  const items = [
    { id: "a", projectId: "first" },
    { id: "b", projectId: "second" },
    { id: "c", projectId: "first" },
    { id: "d", projectId: "third" },
    { id: "e", projectId: "first" },
    { id: "f" },
  ];
  it("what is in the project on hand, and how many each other project has, most first", () => {
    const { here, elsewhere } = byProject(items, "second");
    expect(here.map((i) => i.id)).toEqual(["b", "f"]);
    expect(elsewhere).toEqual([
      { projectId: "first", count: 3 },
      { projectId: "third", count: 1 },
    ]);
  });
  it("a project with nothing of its own: all of it is elsewhere, counted", () => {
    expect(byProject(items.filter((i) => i.projectId), "empty")).toEqual({
      here: [],
      elsewhere: [
        { projectId: "first", count: 3 },
        { projectId: "second", count: 1 },
        { projectId: "third", count: 1 },
      ],
    });
  });
  it("no project on hand: everything, nothing elsewhere", () => {
    expect(byProject(items, null)).toEqual({ here: items, elsewhere: [] });
  });
});
