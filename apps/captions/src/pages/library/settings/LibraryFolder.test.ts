import { describe, expect, it } from "vitest";
import { foundFolder } from "@contracts/storage";
import { layoutIn, missingIn } from "./LibraryFolder";

// The Library folder's subfolders, found by their usual names in any case (11-19: Moo's FOOTAGE, PROJECTS, EXPORTS).

describe("foundFolder", () => {
  it("finds each use by its names, in any case, and keeps the folder's own name", () => {
    expect(foundFolder(["FOOTAGE", "PROJECTS", "EXPORTS"], "footage")).toBe("FOOTAGE");
    expect(foundFolder(["media"], "footage")).toBe("media");
    expect(foundFolder(["Source Media", "Footage"], "footage")).toBe("Source Media"); // the first name in the list wins
    expect(foundFolder(["projects"], "projects")).toBe("projects");
    expect(foundFolder(["Finals"], "library")).toBe("Finals");
    expect(foundFolder(["Final exports"], "library")).toBe("Final exports");
    expect(foundFolder(["Footage 2024", "Exported"], "footage")).toBeUndefined(); // whole names only
    expect(foundFolder(undefined, "projects")).toBeUndefined();
  });
});

describe("layoutIn and missingIn", () => {
  it("uses found folders as they are and names the missing ones; nothing known means all three are made", () => {
    expect(layoutIn("/Volumes/Tiny/MOO CLASSIC/", ["FOOTAGE", "EXPORTS", "Notes"])).toEqual([
      { use: "footage", path: "/Volumes/Tiny/MOO CLASSIC/FOOTAGE", found: true },
      { use: "projects", path: "/Volumes/Tiny/MOO CLASSIC/Project files", found: false },
      { use: "library", path: "/Volumes/Tiny/MOO CLASSIC/EXPORTS", found: true },
    ]);
    expect(missingIn(["FOOTAGE", "EXPORTS"])).toEqual(["Project files"]);
    expect(missingIn(undefined)).toEqual(["Source media", "Project files", "Final exports"]);
    expect(missingIn(["media", "projects", "finals"])).toEqual([]);
  });
});
