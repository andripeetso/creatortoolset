import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SORT_IDS, orderWords, sortOf, splitSort, type SortBy } from "./SortControls";

// Sort by + its order button (11-19 sign-off C4) write the one stored sort, so a value stored before still loads.
describe("Sort by and its order", () => {
  it("every stored value splits into a key and a way and comes back as itself; the default is Date filmed, newest first", () => {
    expect(SORT_IDS[0]).toBe("filmed");
    expect(splitSort("filmed")).toEqual({ by: "filmed", first: true });
    for (const s of SORT_IDS) {
      const { by, first } = splitSort(s);
      expect(sortOf(by, first)).toBe(s);
    }
    // the ones stored before the split
    expect(splitSort("new")).toEqual({ by: "added", first: true });
    expect(splitSort("old")).toEqual({ by: "added", first: false });
    expect(splitSort("longest")).toEqual({ by: "length", first: true });
    expect(splitSort("name")).toEqual({ by: "name", first: true });
  });

  it("the order's words follow the key", () => {
    const words = (by: SortBy) => [orderWords(by, true), orderWords(by, false)];
    expect(words("filmed")).toEqual(["Newest first", "Oldest first"]);
    expect(words("added")).toEqual(["Newest first", "Oldest first"]);
    expect(words("name")).toEqual(["A → Z", "Z → A"]);
    expect(words("length")).toEqual(["Longest first", "Shortest first"]);
  });
});

// A1: the workspace colour is the Library's one accent (violet-* follows <html data-tint>); no var(--tint) fallback
describe("the Library's colour", () => {
  it("no Library file reads --tint", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [join(dir, n)] : []));
    const lib = join(__dirname);
    const hits = [...files(lib), join(lib, "../LibraryPage.tsx")].filter((f) => readFileSync(f, "utf8").includes("--tint"));
    expect(hits).toEqual([]);
  });
});
