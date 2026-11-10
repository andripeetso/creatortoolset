import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
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
  touch("Music/Sound Effects/whoosh.wav", 1_760_000_000); // a sound-effect pack: not offered as music
  touch("Desktop/notes/readme.txt");
  touch("Downloads/.hidden/clip.mp4");
  touch("Documents/Library/cache.mp4");
  touch("Documents/Edit.photoslibrary/original.mov");
  touch("Pictures/a/b/c/d/deep.mp4"); // level 4 below Pictures: past the default depth
  touch("Movies/Creator Toolset/Footage/took.mp4"); // the app's own Library: skipped
  symlinkSync(path.join(root, "Movies/Trip"), path.join(root, "Desktop/linked")); // the same folder through a link
  mkdirSync(path.join(root, "Locked"));
  touch("Locked/clip.mp4");
});
afterAll(() => {
  chmodSync(path.join(root, "Locked"), 0o755);
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
  });

  it("says the list is cut short when a folder sits below the depth cap (the clip four levels down)", async () => {
    const r = await scanFolders(roots());
    expect(r.truncated).toBe(true);
    expect(r.folders.map((f) => f.name)).not.toContain("d");
    expect((await scanFolders(roots(), { maxDepth: 4 })).folders.map((f) => f.name)).toContain("d");
  });

  it("skips hidden folders, library packages and the Library folder, and never lists a folder with no media", async () => {
    const names = (await scanFolders(roots())).folders.map((f) => f.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("Library");
    expect(names).not.toContain("Edit.photoslibrary");
    expect(names).not.toContain("Creator Toolset");
    expect(names).not.toContain("notes");
  });

  it("lists a folder reached through a link once, even when it is also under a root", async () => {
    const r = await scanFolders(roots());
    expect(r.folders.filter((f) => f.name === "Trip" || f.name === "linked")).toHaveLength(1);
  });

  it("never offers sound-effect audio as music", async () => {
    expect((await scanFolders(roots())).folders.map((f) => f.name)).not.toContain("Sound Effects");
  });

  it("does not enter the folders it is told to exclude (the app's own data)", async () => {
    const r = await scanFolders([path.join(root, "Movies")], { exclude: [path.join(root, "Movies/Trip")] });
    expect(r.folders.map((f) => f.name)).not.toContain("Trip");
  });

  it("says so when the folder cap stops the walk, and keeps what it found", async () => {
    expect((await scanFolders(roots(), { maxDirs: 2 })).truncated).toBe(true);
  });

  it("says so when the time cap stops the walk", async () => {
    let t = 0;
    expect((await scanFolders(roots(), { maxMs: 10, now: () => (t += 20) })).truncated).toBe(true);
  });

  it("stops listing at the found cap", async () => {
    const r = await scanFolders(roots(), { maxFound: 1 });
    expect(r.folders).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("reads a missing root as nothing, not an error, and reports the roots it could look in", async () => {
    const r = await scanFolders([path.join(root, "nope"), path.join(root, "Movies")]);
    expect(r.blocked).toEqual([]);
    expect(r.looked).toEqual([path.join(root, "Movies")]);
  });

  it.skipIf(process.getuid?.() === 0)("reports a folder the system would not let it read as blocked, not as no folders", async () => {
    chmodSync(path.join(root, "Locked"), 0);
    const r = await scanFolders([path.join(root, "Locked")]);
    expect(r.blocked).toEqual([path.join(root, "Locked")]);
    expect(r.folders).toEqual([]);
  });
});

describe("mediaKind", () => {
  it("calls a folder footage when it has any video, whatever else is in it", () => {
    expect(mediaKind(["a.MP4", "b.wav", "c.txt"])).toEqual({ kind: "footage", files: 2 });
  });
  it("counts cinema RAW video as footage", () => {
    expect(mediaKind(["A001.BRAW", "A002.r3d"])).toEqual({ kind: "footage", files: 2 });
  });
  it("calls an audio-only folder music", () => {
    expect(mediaKind(["ep.m4a", "ep.mp3", "cover.jpg"])).toEqual({ kind: "music", files: 2 });
  });
  it("finds no media in a folder of documents", () => {
    expect(mediaKind(["a.pdf", "b.md"])).toBeNull();
  });
});

describe("defaultRoots", () => {
  it("looks in the common folders of the home folder, and in any extra roots given, not in Downloads", () => {
    const r = defaultRoots("/home/me", ["/Volumes/Drive"]);
    expect(r).toEqual(["/home/me/Movies", "/home/me/Desktop", "/home/me/Documents", "/home/me/Pictures", "/home/me/Music", "/Volumes/Drive"]);
  });
});
