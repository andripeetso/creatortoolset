import { describe, expect, it } from "vitest";
import { editorDirsOf, importTarget, IMPORTS_DIR, notFootage, PHONE_UPLOADS_DIR, underFolder } from "./storage";

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

  it("skips an AI Editor worker's Phone uploads folder at any depth, and only that exact name", () => {
    expect(notFootage("Phone uploads/x 123/clip.mov")).toBe(true);
    expect(notFootage("Day 1/Phone uploads/x 123/clip.mov")).toBe(true);
    expect(notFootage("phone uploads/clip.mov")).toBe(false);
    expect(notFootage("Phone uploads.mov")).toBe(false);
  });

  it("finds the editor folder at any depth, and not a drafts/ folder with nothing in it", () => {
    expect([...editorDirsOf(["Work/Shoot_edit/drafts/a.mp4"])]).toEqual(["Work/Shoot_edit"]);
    expect([...editorDirsOf(["Shoot_edit/drafts"])]).toEqual([]);
    expect(notFootage("Shoot_edit/clip.mp4")).toBe(false);
  });
});

describe("the one import rule (importTarget)", () => {
  it("copies into the first Media folder's Imports/<edit or chat name>, the name made safe; none: the day", () => {
    const media = ["/Volumes/Tiny Footage/", "/Users/tiny/More"];
    expect(importTarget(media, "Summer reel: part 1/2")).toBe("/Volumes/Tiny Footage/Imports/Summer reel part 1 2");
    expect(importTarget(media, "  ", new Date("2026-11-19T10:00:00Z"))).toBe("/Volumes/Tiny Footage/Imports/2026-11-19");
    expect(importTarget([], "Summer reel")).toBeNull();
  });

  it("reads Imports/ as footage and keeps skipping Phone uploads/ (the editor's re-downloads)", () => {
    expect(notFootage(`${IMPORTS_DIR}/Summer reel/clip.mov`)).toBe(false);
    expect(notFootage(`${PHONE_UPLOADS_DIR}/Summer reel 1a2b3c4d/01 clip.mov`)).toBe(true);
  });

  it("knows a file inside a Media folder on a / boundary", () => {
    expect(underFolder("/Volumes/TEAM/a/b.mov", "/Volumes/TEAM/")).toBe(true);
    expect(underFolder("/Volumes/TEAM2/b.mov", "/Volumes/TEAM")).toBe(false);
    expect(underFolder("/Users/tiny/Downloads/b.mov", "/Volumes/TEAM")).toBe(false);
  });
});
