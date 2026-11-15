import { describe, expect, it } from "vitest";
import { macPaths } from "./grid";

const file = (name: string, rel = "") => {
  const f = new File(["x"], name);
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
};

describe("where a Finder drop's files are on this Mac", () => {
  it("a loose file by its name, a file in a dropped folder by the folder's path; none when unsure", () => {
    const loose = file("Clip.mov");
    const inner = file("a.mp4", "Trip/day 1/a.mp4");
    const twice = file("Same.mp4");
    const stray = file("Other.mp4");
    const items = [
      { path: "/Users/tiny/Movies/Clip.mov", folder: false },
      { path: "/Volumes/Card/Trip", folder: true },
      { path: "/a/Same.mp4", folder: false },
      { path: "/b/Same.mp4", folder: false },
    ];
    const got = macPaths([loose, inner, twice, stray], items);
    expect(got.get(loose)).toBe("/Users/tiny/Movies/Clip.mov");
    expect(got.get(inner)).toBe("/Volumes/Card/Trip/day 1/a.mp4");
    expect(got.has(twice)).toBe(false); // two items of that name: it uploads
    expect(got.has(stray)).toBe(false);
  });

  it("matches accented names in either form", () => {
    const f = file("Õhtu.mp4".normalize("NFD"));
    expect(macPaths([f], [{ path: "/x/Õhtu.mp4".normalize("NFC"), folder: false }]).get(f)).toBe("/x/Õhtu.mp4".normalize("NFC"));
  });
});
