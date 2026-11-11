import { describe, expect, it } from "vitest";
import type { Collection } from "@contracts/library";
import { foldersAt, moveOptions, moveSteps, trailOf } from "./folders";

const f = (id: string, name: string, parentId: string | null = null, kind: Collection["kind"] = "manual"): Collection => ({ id, name, parentId, kind, createdBy: "admin" });
const all = [
  f("trip", "Trip"),
  f("beach", "Beach", "trip"),
  f("rain", "Rain", "beach"),
  f("sky", "B-roll sky"),
  f("smart", "Apples", null, "smart"),
  f("lost", "Lost parent", "gone"),
];
const names = (cs: { name: string }[]) => cs.map((c) => c.name);

describe("Media Library folders", () => {
  it("shows a level's own folders, folders before saved searches, A to Z; a folder whose parent is gone is at the top", () => {
    expect(names(foldersAt(all, null, ""))).toEqual(["B-roll sky", "Lost parent", "Trip", "Apples"]);
    expect(names(foldersAt(all, "trip", ""))).toEqual(["Beach"]);
    expect(names(foldersAt(all, "beach", ""))).toEqual(["Rain"]);
  });

  it("a search finds folders by name below the open one, at any depth", () => {
    expect(names(foldersAt(all, null, "ra"))).toEqual(["Rain"]);
    expect(names(foldersAt(all, "trip", "a"))).toEqual(["Beach", "Rain"]);
    expect(names(foldersAt(all, "beach", "beach"))).toEqual([]); // not the open one itself
  });

  it("a drop puts the clips in the folder and takes them out of the one open; the top level takes them out only", () => {
    expect(moveSteps(null, "trip")).toEqual({ add: "trip" });
    expect(moveSteps("trip", "beach")).toEqual({ add: "beach", remove: "trip" });
    expect(moveSteps("beach", null)).toEqual({ remove: "beach" });
    expect(moveSteps("trip", "trip")).toEqual({});
  });

  it("Move to lists the top from inside a folder and every plain folder under its parent, never a saved search or the one open", () => {
    expect(moveOptions(all, "beach")).toEqual([
      { id: null, name: "Top level", depth: 0 },
      { id: "trip", name: "Trip", depth: 0 },
      { id: "rain", name: "Rain", depth: 2 },
      { id: "sky", name: "B-roll sky", depth: 0 },
      { id: "lost", name: "Lost parent", depth: 0 },
    ]);
    expect(moveOptions(all, null).map((o) => o.id)).toEqual(["trip", "beach", "rain", "sky", "lost"]);
  });

  it("the trail runs from the top down to the open folder; the Trash is its own", () => {
    expect(names(trailOf(all, "rain", false))).toEqual(["Trip", "Beach", "Rain"]);
    expect(trailOf(all, null, false)).toEqual([]);
    expect(trailOf(all, null, true)).toEqual([{ id: "trash", name: "Trash" }]);
  });
});
