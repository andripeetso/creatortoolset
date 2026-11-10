import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultRoots, mediaKind, scanFolders } from "./folder-scan";

let root = "";
const touch = (rel: string, mtimeSec?: number) => {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, "x");
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return p;
};

beforeAll(() => {
  root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "folder-scan-"));
  touch("Movies/Trip/a.MOV", 1_700_000_000);
  touch("Movies/Trip/b.mp4", 1_700_000_000);
  touch("Music/Podcast/ep1.mp3", 1_750_000_000);
  touch("Music/Podcast/ep2.WAV", 1_750_000_000);
  touch("Desktop/notes/readme.txt");
  touch("Downloads/.hidden/clip.mp4");
  touch("Documents/Library/cache.mp4");
  touch("Documents/Edit.photoslibrary/original.mov");
  touch("Pictures/a/b/c/d/deep.mp4"); // level 4 below Pictures: past the default depth
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const roots = () => ["Movies", "Music", "Desktop", "Downloads", "Documents", "Pictures"].map((d) => path.join(root, d));

describe("scanFolders: which folders are listed", () => {
  it("lists the folders with video as footage and audio-only folders as music, newest first", async () => {
    const r = await scanFolders(roots());
    expect(r.folders.map((f) => [f.name, f.kind, f.files])).toEqual([
      ["Podcast", "music", 2],
      ["Trip", "footage", 2],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("skips hidden folders, library packages and the Library folder, and never lists a folder with no media", async () => {
    const names = (await scanFolders(roots())).folders.map((f) => f.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("Library");
    expect(names).not.toContain("Edit.photoslibrary");
    expect(names).not.toContain("notes");
  });

  it("stops at the depth cap: a clip four levels down is not found", async () => {
    expect((await scanFolders(roots(), { maxDepth: 3 })).folders.map((f) => f.name)).not.toContain("d");
    expect((await scanFolders(roots(), { maxDepth: 4 })).folders.map((f) => f.name)).toContain("d");
  });

  it("says the list may be incomplete when the folder cap stops the walk", async () => {
    const r = await scanFolders(roots(), { maxDirs: 2 });
    expect(r.truncated).toBe(true);
  });

  it("says so when the time cap stops the walk, and keeps what it found", async () => {
    let t = 0;
    const r = await scanFolders(roots(), { maxMs: 10, now: () => (t += 20) });
    expect(r.truncated).toBe(true);
  });

  it("stops listing at the found cap", async () => {
    const r = await scanFolders(roots(), { maxFound: 1 });
    expect(r.folders).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("reads a missing root as nothing, not an error", async () => {
    expect((await scanFolders([path.join(root, "nope")])).folders).toEqual([]);
  });
});

describe("mediaKind", () => {
  it("calls a folder footage when it has any video, whatever else is in it", () => {
    expect(mediaKind(["a.MP4", "b.wav", "c.txt"])).toEqual({ kind: "footage", files: 2 });
  });
  it("calls an audio-only folder music", () => {
    expect(mediaKind(["ep.m4a", "ep.mp3", "cover.jpg"])).toEqual({ kind: "music", files: 2 });
  });
  it("finds no media in a folder of documents", () => {
    expect(mediaKind(["a.pdf", "b.md"])).toBeNull();
  });
});

describe("defaultRoots", () => {
  it("looks in the common folders of the home folder, and in any extra roots given", () => {
    const r = defaultRoots("/home/me", ["/Volumes/Drive"]);
    expect(r).toEqual([
      "/home/me/Movies",
      "/home/me/Desktop",
      "/home/me/Documents",
      "/home/me/Downloads",
      "/home/me/Pictures",
      "/home/me/Music",
      "/Volumes/Drive",
    ]);
  });
});
