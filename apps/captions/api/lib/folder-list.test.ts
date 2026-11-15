import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "folder-list-"));
const { FOLDER_LIST, folderHere, listing, matchWords, walkFolder } = await import("./folder-list");

const root = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "folder-list-walk-")));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});
const put = (p: string, bytes = 3) => {
  mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  writeFileSync(path.join(root, p), Buffer.alloc(bytes));
};
// a shoot of Tiny Acrobatics: the song two levels down, a hidden file, a package, and one folder six levels down
put("TINY SHOOT/take1.mp4", 10);
put("TINY SHOOT/script.md");
put("TINY SHOOT/FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a", 7);
put("TINY SHOOT/.DS_Store");
put("TINY SHOOT/Old.photoslibrary/inside.jpg");
put("TINY SHOOT/a/b/c/d/e/f/deep.mov");
const shoot = path.join(root, "TINY SHOOT");

describe("walking a folder", () => {
  it("sees every subfolder level by level, never hidden entries or inside a package", async () => {
    const walk = await walkFolder(shoot);
    const paths = walk.entries.map((e) => e.path);
    expect(paths).toContain("FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a");
    expect(paths).toContain("Old.photoslibrary");
    expect(paths.some((p) => p.includes(".DS_Store") || p.startsWith("Old.photoslibrary/"))).toBe(false);
    // the folder six levels down is listed, what is in it is not
    expect(paths).toContain("a/b/c/d/e/f");
    expect(paths).not.toContain("a/b/c/d/e/f/deep.mov");
    expect(walk.deeper).toBe(1);
    expect(walk.entries.find((e) => e.path === "take1.mp4")).toEqual({ path: "take1.mp4", size: 10 });
  });

  it("stops at the depth asked and says how many folders it did not look in", async () => {
    const walk = await walkFolder(shoot, 1);
    expect(walk.entries.map((e) => e.path).sort()).toEqual(["FOOTAGE", "Old.photoslibrary", "a", "script.md", "take1.mp4"]);
    expect(walk.deeper).toBe(2);
    expect(listing(shoot, walk).left_out).toContain("2 folders deeper");
  });
  it("says a folder it could not read is unreadable, never shows it as empty", async () => {
    const locked = path.join(root, "LOCKED");
    put("LOCKED/inner/clip.mp4");
    chmodSync(path.join(locked, "inner"), 0);
    try {
      const out = listing(locked, await walkFolder(locked));
      expect(out.left_out).toContain("1 folders that could not be read");
      chmodSync(locked, 0);
      await expect(walkFolder(locked)).rejects.toThrow("could not be read");
    } finally {
      chmodSync(locked, 0o755);
      chmodSync(path.join(locked, "inner"), 0o755);
    }
  });
});

describe("what the AI reads", () => {
  it("matches a name whose letters a drive wrote decomposed", () => {
    const out = listing("/x", { entries: [{ path: "LAUL/Ko\u0303ige.m4a", size: 1 }], deeper: 0 }, "kõige");
    expect(out.entries).toHaveLength(1);
  });

  it("finds the song by what it is, wherever it is named", async () => {
    const out = listing(shoot, await walkFolder(shoot), "the song");
    expect(out.entries).toEqual([{ path: "FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a", type: "file", kind: "audio", size: 7 }]);
    expect(out.matched).toBe(1);
    // every word must be there; a folder matches by its name
    expect(listing(shoot, await walkFolder(shoot), "music").entries.map((e) => e.path)).toEqual(["FOOTAGE/MUSIC", "FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a"]);
    expect(listing(shoot, await walkFolder(shoot), "song video").entries).toEqual([]);
    expect(matchWords("The intro SONG")).toEqual(["intro", "song"]);
  });

  it("says when nothing matches, how much it looked at", async () => {
    const out = listing(shoot, await walkFolder(shoot), "podcast");
    expect(out.entries).toEqual([]);
    expect(out.looked_at).toBeGreaterThan(5);
    expect(out.note).toMatch(/Nothing in its \d+ entries matches/);
  });

  it("hands back at most its cap and says what it left out", () => {
    const entries = Array.from({ length: FOLDER_LIST.entries + 5 }, (_, i) => ({ path: `clip${i}.mp4`, size: 1 }));
    const out = listing("/x", { entries, deeper: 0, stopped: true });
    expect(out.entries).toHaveLength(FOLDER_LIST.entries);
    expect(out.left_out).toContain("5 more entries");
    expect(out.left_out).toContain("the walk stopped");
  });

  it("gives a media file's length when the library knows it", () => {
    const out = listing("/x", { entries: [{ path: "a.mp4", size: 1 }, { path: "b.wav", size: 1 }], deeper: 0 }, "", { "a.mp4": 12.345 });
    expect(out.entries).toEqual([
      { path: "a.mp4", type: "file", kind: "video", size: 1, duration_s: 12.3 },
      { path: "b.wav", type: "file", kind: "audio", size: 1 },
    ]);
  });
});

describe("which folders are walked", () => {
  it("never a whole disk or the home folder", async () => {
    expect(await folderHere("/", true)).toEqual({ error: expect.stringContaining("whole disk or home folder") });
    expect(await folderHere(homedir(), true)).toEqual({ error: expect.stringContaining("whole disk or home folder") });
    expect(await folderHere(path.join(root, "nope"), false)).toEqual({ error: expect.stringContaining("No such folder") });
    expect(await folderHere(shoot, false)).toEqual({ real: shoot });
  });
});
