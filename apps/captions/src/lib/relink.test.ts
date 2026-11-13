import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/local-files", async (real) => ({
  ...(await real<typeof import("@/lib/local-files")>()),
  askMediaFolder: vi.fn(async () => ["/Users/tiny/Moved"]),
}));

import { askMediaFolder } from "@/lib/local-files";
import { candidates, findOriginals, relink } from "./relink";

// A Tiny Acrobatics shoot as the timeline names it, and the same files on another computer.
const OLD = "/Volumes/Tiny Drive/Süvi lõik";
const on = (files: string[]) => {
  const asked: string[] = [];
  const exists = vi.fn(async (p: string) => (asked.push(p), files.includes(p)));
  return { exists, asked };
};

describe("finding a timeline's files in another folder", () => {
  it("tries the end of the path under the picked folder, longest first", () => {
    expect(candidates(`${OLD}/cam/a.mov`, "/Users/tiny/Moved/")).toEqual([
      "/Users/tiny/Moved/Volumes/Tiny Drive/Süvi lõik/cam/a.mov",
      "/Users/tiny/Moved/Tiny Drive/Süvi lõik/cam/a.mov",
      "/Users/tiny/Moved/Süvi lõik/cam/a.mov",
      "/Users/tiny/Moved/cam/a.mov",
      "/Users/tiny/Moved/a.mov",
    ]);
  });

  it("the first file found gives the folder change for the rest: one look each", async () => {
    const NEW = "/Users/tiny/Moved";
    const { exists, asked } = on([`${NEW}/cam/a.mov`, `${NEW}/cam/b.mov`, `${NEW}/sound/vo 1.wav`]);
    const found = await relink([`${OLD}/cam/a.mov`, `${OLD}/cam/b.mov`, `${OLD}/sound/vo 1.wav`, `${OLD}/gone.mov`], NEW, exists);
    expect(found).toEqual({
      [`${OLD}/cam/a.mov`]: `${NEW}/cam/a.mov`,
      [`${OLD}/cam/b.mov`]: `${NEW}/cam/b.mov`,
      [`${OLD}/sound/vo 1.wav`]: `${NEW}/sound/vo 1.wav`,
    });
    // b and vo 1 were found on the first try, with a's folder change
    expect(asked.filter((p) => p.endsWith("b.mov"))).toEqual([`${NEW}/cam/b.mov`]);
    expect(asked.filter((p) => p.endsWith("vo 1.wav"))).toEqual([`${NEW}/sound/vo 1.wav`]);
  });

  it("finds files dropped loose in one folder by their names", async () => {
    const { exists } = on(["/Users/tiny/All/a.mov", "/Users/tiny/All/vo.wav"]);
    expect(await relink([`${OLD}/cam/a.mov`, `${OLD}/sound/vo.wav`], "/Users/tiny/All", exists)).toEqual({
      [`${OLD}/cam/a.mov`]: "/Users/tiny/All/a.mov",
      [`${OLD}/sound/vo.wav`]: "/Users/tiny/All/vo.wav",
    });
  });

  it("Find the original files: what is where the timeline says stays, the rest is looked for in the folder picked", async () => {
    const { exists } = on([`${OLD}/a.mov`, "/Users/tiny/Moved/b.mov"]);
    const before = { paths: { s1: `${OLD}/a.mov`, s2: `${OLD}/b.mov`, s3: `${OLD}/c.mov` }, found: {}, folders: [OLD], tried: false };
    const o = await findOriginals(before, "a1.1", exists);
    expect(askMediaFolder).toHaveBeenCalledWith(OLD);
    // the Mac app's answer is every folder allowed, the timeline's own (a decomposed ü) not among them
    expect(o).toMatchObject({ found: { s2: "/Users/tiny/Moved/b.mov" }, folders: ["/Users/tiny/Moved"], tried: true });
    vi.mocked(askMediaFolder).mockResolvedValueOnce([OLD.normalize("NFD"), "/Users/tiny/Moved"]);
    expect((await findOriginals(before, "a1.1", exists)).found).toEqual({ s1: `${OLD}/a.mov`, s2: "/Users/tiny/Moved/b.mov" });
    // cancelled: nothing changes
    vi.mocked(askMediaFolder).mockResolvedValueOnce([]);
    expect(await findOriginals(before, "a1.1", exists)).toBe(before);
  });
});
