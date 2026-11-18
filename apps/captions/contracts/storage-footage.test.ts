import { describe, expect, it } from "vitest";
import { editorDirsOf, notFootage } from "./storage";

describe("what a Media folder scan leaves out", () => {
  it("skips a half-written file and keeps the names that only look like one (decision 10)", () => {
    expect(notFootage("clip.part.mp4")).toBe(true);
    expect(notFootage("clip.tmp")).toBe(true);
    expect(notFootage("raw/clip.tmp.mov")).toBe(true);
    expect(notFootage("party.mp4")).toBe(false);
    expect(notFootage("clip.partial.mov")).toBe(false);
  });

  it("skips an AI Editor folder only when the same scan holds its drafts/ (a user's own _edit folder is footage)", () => {
    const rels = ["Hard Edit_edit/drafts/Hard Edit_V1A_D1.camera.mp4", "Hard Edit_edit/MG/flash.mov", "Summer_edit/clip.mp4", "raw/clip.mp4"];
    const dirs = editorDirsOf(rels);
    expect([...dirs]).toEqual(["Hard Edit_edit"]);
    expect(notFootage("Hard Edit_edit/MG/flash.mov", dirs)).toBe(true);
    expect(notFootage("Summer_edit/clip.mp4", dirs)).toBe(false);
    expect(notFootage("raw/clip.mp4", dirs)).toBe(false);
  });

  it("finds the editor folder at any depth, and not a drafts/ folder with nothing in it", () => {
    expect([...editorDirsOf(["Work/Shoot_edit/drafts/a.mp4"])]).toEqual(["Work/Shoot_edit"]);
    expect([...editorDirsOf(["Shoot_edit/drafts"])]).toEqual([]);
    expect(notFootage("Shoot_edit/clip.mp4")).toBe(false);
  });
});
