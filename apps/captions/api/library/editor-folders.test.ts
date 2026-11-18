import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An AI Editor folder named by a later page of a listing is known to the earlier pages' clips too (decision 4).
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "editor-folders-"));
process.env.APP_SECRET = "editor-folders-test-secret";

const { editorDirsSeen } = await import("./report");
const { notFootage } = await import("../../contracts/storage");

describe("an AI Editor folder across the pages of one listing (decision 4)", () => {
  it("a page with the folder's drafts makes the earlier page's files under it not footage", () => {
    const key = "dev|folder|scan-1";
    // page 1: the folder's MG file, no drafts/ file yet; a user's own Summer_edit folder is footage
    const p1 = editorDirsSeen(key, "scan-1", ["Shoot_edit/MG/flash.mov", "Summer_edit/clip.mov"]);
    expect(p1.fresh).toEqual([]);
    expect(notFootage("Shoot_edit/MG/flash.mov", p1.dirs)).toBe(false);
    // page 2 names the folder: the earlier file is not footage from now on, and the fresh folder is reported for the sweep
    const p2 = editorDirsSeen(key, "scan-1", ["Shoot_edit/drafts/x.mp4"]);
    expect(p2.fresh).toEqual(["Shoot_edit"]);
    expect(notFootage("Shoot_edit/MG/flash.mov", p2.dirs)).toBe(true);
    expect(notFootage("Summer_edit/clip.mov", p2.dirs)).toBe(false);
  });

  it("a page without a scan id is judged on its own", () => {
    const alone = editorDirsSeen("dev|folder|", undefined, ["Shoot_edit/drafts/x.mp4"]);
    expect(alone.fresh).toEqual(["Shoot_edit"]);
    expect(editorDirsSeen("dev|folder|", undefined, []).dirs.size).toBe(0);
  });
});
