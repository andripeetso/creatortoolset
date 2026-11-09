import { describe, expect, it, vi } from "vitest";
import { libraryFacets, pickedFor } from "./library-slots";

// Three facets from one test plug-in: the scope decides which page shows each (no scope = the Media Library only).
vi.mock("../plugins.gen", () => ({
  webPlugins: [
    {
      id: "scoped",
      library: {
        facets: [
          { key: "both", label: "Both", values: [{ value: "a", label: "a" }], scope: "both" },
          { key: "lib", label: "Library", values: [{ value: "b", label: "b" }], scope: "library" },
          { key: "dflt", label: "Default", values: [{ value: "c", label: "c" }] },
        ],
      },
    },
  ],
}));

const keys = (page: "library" | "finals") => libraryFacets(page).map((f) => f.key);

describe("library facet scope", () => {
  it("shows a library-scope and an unscoped facet on the Media Library only", () => {
    expect(keys("library")).toEqual(["both", "lib", "dflt"]);
    expect(keys("finals")).toEqual(["both"]);
  });

  it("keeps only the picks of the facets a page shows", () => {
    const picked = { both: ["a"], lib: ["b"], dflt: ["c"], unknown: ["z"] };
    expect(pickedFor(picked, "finals")).toEqual({ both: ["a"] });
    expect(pickedFor(picked, "library")).toEqual({ both: ["a"], lib: ["b"], dflt: ["c"] });
  });
});
