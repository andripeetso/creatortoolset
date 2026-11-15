import { describe, expect, it } from "vitest";
import { frameAt, pathsInDrop, quickPrint } from "./onMac";

const file = (name: string, rel = "") => {
  const f = new File(["x"], name);
  if (rel) Object.defineProperty(f, "webkitRelativePath", { value: rel });
  return f;
};

describe("pathsInDrop", () => {
  it("joins a file inside a dropped folder to the folder's place, and finds loose files by name", () => {
    const inside = file("a.mp4", "FOOTAGE/day 1/a.mp4");
    const loose = file("b.mov");
    const twice = file("c.mp4", "Twice/c.mp4");
    const got = pathsInDrop([inside, loose, twice], [
      { path: "/Volumes/Tiny Drive/Tiny Acrobatics/FOOTAGE", folder: true },
      { path: "/Users/me/Desktop/b.mov", folder: false },
      { path: "/Volumes/A/Twice", folder: true },
      { path: "/Volumes/B/Twice", folder: true },
    ]);
    expect(got.get(inside)).toBe("/Volumes/Tiny Drive/Tiny Acrobatics/FOOTAGE/day 1/a.mp4");
    expect(got.get(loose)).toBe("/Users/me/Desktop/b.mov");
    expect(got.has(twice)).toBe(false);
  });
});

describe("quickPrint", () => {
  it("differs when the size or the ends differ", async () => {
    const a = await quickPrint(new Blob(["hello"]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await quickPrint(new Blob(["hello"]))).toBe(a);
    expect(await quickPrint(new Blob(["hellp"]))).not.toBe(a);
  });
});

it("frameAt takes the middle of each share, as the server's strip does", () => {
  expect(frameAt(0, 4, 40)).toBe(5);
  expect(frameAt(3, 4, 40)).toBe(35);
});
