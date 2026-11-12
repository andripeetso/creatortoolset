import { afterEach, describe, expect, it, vi } from "vitest";
import { addVideo, cancelUpload, droppedByPath, droppedFiles, EMPTY_DRAFT, filesPending } from "./draft";

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
    expect(await droppedFiles(drop([file("a.mov")], [f]))).toEqual({ files: [f], folder: false, folders: [], paths: new Map() });
  });

  it("in the Mac app a loose file carries its path, matched by a name only one dropped item has", async () => {
    const [a, b] = [new File(["x"], "walkthru-1.mp4"), new File(["x"], "take.mov")];
    const got = await droppedFiles(drop([file("walkthru-1.mp4"), file("take.mov")], [a, b]), async () => [
      { path: "/Users/you/Movies/walkthru-1.mp4", folder: false },
      { path: "/Users/you/A/take.mov", folder: false },
      { path: "/Users/you/B/take.mov", folder: false },
    ]);
    expect(got.paths.get(a)).toBe("/Users/you/Movies/walkthru-1.mp4");
    expect(got.paths.has(b)).toBe(false);
  });

  it("in the Mac app a folder comes as its path and is not read; the loose files beside it still are", async () => {
    const got = await droppedFiles(drop([dir("Shoot", [file("clip.mov")]), file("notes.mov")]), async () => [{ path: "/Users/you/Movies/Shoot", folder: true }, { path: "/Users/you/Movies/notes.mov", folder: false }]);
    expect(got).toMatchObject({ folder: false, folders: ["/Users/you/Movies/Shoot"] });
    expect(got.files.map((f) => f.name)).toEqual(["notes.mov"]);
    expect([...got.paths.values()]).toEqual(["/Users/you/Movies/notes.mov"]);
  });
});

describe("filesPending", () => {
  const withFile = (f: Record<string, unknown>) => ({ ...EMPTY_DRAFT, files: [{ key: "k", name: "a.mov", size: 1, pct: 10, ...f }] });
  it("lets a message go once its video's upload is made, before the video is all in", () => {
    expect(filesPending(withFile({}))).toBe(true);
    expect(filesPending(withFile({ id: "u1" }))).toBe(false);
    expect(filesPending(withFile({ id: "u1", error: "Network" }))).toBe(true);
    // dropped in the Mac app: its path is all it needs
    expect(filesPending(withFile({ path: "/Users/you/a.mov", done: true }))).toBe(false);
  });
});

describe("a video in the box", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dropped in the Mac app is kept by its path and sends nothing", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const f = new File(["x"], "walkthru-1.mp4");
    const patch = vi.fn();
    expect(addVideo(f, "/Users/you/Movies/walkthru-1.mp4", patch)).toBeNull();
    expect(patch).toHaveBeenCalledWith({ path: "/Users/you/Movies/walkthru-1.mp4", pct: 100, done: true });
    expect(droppedByPath.get("/Users/you/Movies/walkthru-1.mp4")).toBe(f);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("its X aborts the upload and deletes the server copy", () => {
    const fetch = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetch);
    const u = { ctl: new AbortController(), id: "0b6a2f4e-1d2c-4e5f-8a9b-0c1d2e3f4a5b" };
    cancelUpload(u);
    expect(u.ctl.signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/assistant/files/0b6a2f4e-1d2c-4e5f-8a9b-0c1d2e3f4a5b", { method: "DELETE" });
  });
});
