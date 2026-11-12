import { describe, expect, it } from "vitest";
import { droppedFiles, EMPTY_DRAFT, filesPending } from "./draft";

const file = (name: string) => ({ isFile: true, isDirectory: false, name, file: (ok: (f: File) => void) => ok(new File(["x"], name)) });
// a folder whose reader hands its entries over in batches of two, then an empty one
const dir = (name: string, inside: unknown[]) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let i = 0;
    return { readEntries: (ok: (b: unknown[]) => void) => ok(inside.slice(i, (i += 2))) };
  },
});
const drop = (entries: unknown[], files: File[] = []) => ({ items: entries.map((e) => ({ webkitGetAsEntry: () => e })), files }) as unknown as DataTransfer;

describe("droppedFiles", () => {
  it("opens a dropped folder and its folders into their files, in name order, skipping hidden ones", async () => {
    const got = await droppedFiles(drop([dir("Shoot", [file("clip 10.mov"), file(".DS_Store"), file("clip 2.mov"), dir("More", [file("clip 1.mp4")])])]));
    expect(got.folder).toBe(true);
    expect(got.files.map((f) => f.name)).toEqual(["clip 1.mp4", "clip 2.mov", "clip 10.mov"]);
  });

  it("keeps plain files as the drop gave them", async () => {
    const f = new File(["x"], "a.mov");
    expect(await droppedFiles(drop([file("a.mov")], [f]))).toEqual({ files: [f], folder: false, folders: [] });
  });

  it("in the Mac app a folder comes as its path and is not read; the loose files beside it still are", async () => {
    const got = await droppedFiles(drop([dir("Shoot", [file("clip.mov")]), file("notes.mov")]), async () => ["/Users/you/Movies/Shoot"]);
    expect(got).toMatchObject({ folder: false, folders: ["/Users/you/Movies/Shoot"] });
    expect(got.files.map((f) => f.name)).toEqual(["notes.mov"]);
  });
});

describe("filesPending", () => {
  const withFile = (f: Record<string, unknown>) => ({ ...EMPTY_DRAFT, files: [{ key: "k", name: "a.mov", size: 1, pct: 10, ...f }] });
  it("lets a message go once its video's upload is made, before the video is all in", () => {
    expect(filesPending(withFile({}))).toBe(true);
    expect(filesPending(withFile({ id: "u1" }))).toBe(false);
    expect(filesPending(withFile({ id: "u1", error: "Network" }))).toBe(true);
  });
});
