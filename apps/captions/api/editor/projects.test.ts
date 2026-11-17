import { describe, expect, it } from "vitest";
import type { ToolFolders } from "../../contracts/folders";
import { groupEdits, videoName } from "./projects";

// One project per video on the Editor list: every edit of one video in that video's folder.
const edit = (id: string, name: string, at: number, more: Record<string, unknown> = {}) => ({ id, name, createdAt: at, projectId: "ws1", ...more });
const ids = () => {
  let n = 0;
  return () => `f${++n}`;
};

describe("which edits are one video", () => {
  it("the name without its version and its length", () => {
    expect(["Tiny Hard Edit", "Tiny Hard Edit 25s", "Tiny Hard Edit 25s v3", "Tiny Hard Edit 25s (V4)", "Tiny Hard Edit - 60 sec"].map(videoName))
      .toEqual(Array(5).fill("Tiny Hard Edit"));
    expect(videoName("v2")).toBe("v2");
  });
});

describe("filing loose edits into their video's folder", () => {
  it("edits of one video become one folder named by the video; another workspace and a lone edit stay loose; again changes nothing", () => {
    const d: ToolFolders = { folders: [], items: {} };
    const filed: Record<string, string> = {};
    const edits = [
      edit("e1", "Tiny Acrobatics Hard Edit", 1),
      edit("e2", "Tiny Acrobatics Hard Edit 25s", 2),
      edit("e3", "Tiny Acrobatics Hard Edit 25s", 3, { projectId: "ws2" }),
      edit("e4", "Tiny Acrobatics Hard Edit 25s v3", 4),
      edit("e6", "Tiny trailer", 6),
    ];
    expect(groupEdits(edits, d, filed, ids())).toBe(true);
    expect(d.folders).toEqual([expect.objectContaining({ id: "f1", name: "Tiny Acrobatics Hard Edit", parentId: null, workspace: "ws1" })]);
    expect(d.items).toEqual({ e1: "f1", e2: "f1", e4: "f1" });
    expect(filed).toEqual(d.items);
    expect(groupEdits(edits, d, filed, ids())).toBe(false);
  });

  it("an edit cut from the same footage joins the video under any name", () => {
    const d: ToolFolders = { folders: [], items: {} };
    groupEdits([edit("a", "Pool day", 1, { sources: ["ver_1", "ver_2"] }), edit("b", "Splash", 2, { sources: ["ver_2", "ver_1"] })], d, {}, ids());
    expect(d.items).toEqual({ a: "f1", b: "f1" });
  });

  it("a lone edit makes no folder", () => {
    const d: ToolFolders = { folders: [], items: {} };
    expect(groupEdits([edit("a", "Tiny one", 1)], d, {}, ids())).toBe(false);
    expect(d.folders).toEqual([]);
  });

  it("a new version goes into the folder its video is in, also one made and named by hand", () => {
    const d: ToolFolders = { folders: [{ id: "his", name: "Hard edits", parentId: null, createdAt: 0 }], items: { e1: "his" } };
    groupEdits([edit("e1", "Tiny Hard Edit", 1), edit("e2", "Tiny Hard Edit v2", 2)], d, {}, ids());
    expect(d.folders).toHaveLength(1);
    expect(d.items).toEqual({ e1: "his", e2: "his" });
  });

  it("never moves an edit out of a folder, nor one taken out of the folder it was filed in", () => {
    const d: ToolFolders = { folders: [{ id: "x", name: "Elsewhere", parentId: null, createdAt: 0 }], items: { e2: "x" } };
    const filed = { e1: "gone" };
    groupEdits([edit("e1", "Tiny Hard Edit", 1), edit("e2", "Tiny Hard Edit v2", 2), edit("e3", "Tiny Hard Edit v3", 3)], d, filed, ids());
    expect(d.items).toEqual({ e2: "x", e3: "x" });
    expect(d.folders).toHaveLength(1);
  });
});
