import { describe, expect, it } from "vitest";
import { applyEdits, blocksFromMarkdown, currentVersionId, docToMarkdown, keep, markEditsSeen, newDocument, revert, setVersionKept, snapshot, userEdit } from "./doc";

const make = () => {
  const doc = newDocument("d1", "s1", "reel", "Reel", { text: "Hook line", author: "ai", now: 1 });
  doc.blocks = [
    { id: "b1", text: "Hook line", author: "ai", at: 1 },
    { id: "b2", text: "Second beat", author: "ai", at: 1 },
    { id: "b3", text: "Third beat", author: "ai", at: 1 },
  ];
  doc.nextBlock = 4;
  return doc;
};

describe("blocks and markdown", () => {
  it("splits carousel and ads on blank lines", () => {
    expect(blocksFromMarkdown("# T\n\npara one\nstill one\n\n\n- a\n- b\n")).toEqual(["# T", "para one\nstill one", "- a\n- b"]);
    const doc = newDocument("d1", "s1", "carousel", "Cards", { text: "Hook line\n\nSecond beat\n\nThird beat", author: "ai", now: 1 });
    expect(doc.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
  });
  it("keeps notes and reels as one page", () => {
    const notes = newDocument("n1", "s1", "notes", "Notes", { text: "scrap one\n\nscrap two", author: "user", now: 1 });
    expect(notes.blocks.map((b) => b.text)).toEqual(["scrap one\n\nscrap two"]);
    snapshot(notes, "after");
    expect(notes.versions).toEqual([]);
    expect(notes.headVersion).toBeUndefined();
    expect(revert(notes, "v1")).toBe(false);
    const reel = newDocument("r1", "s1", "reel", "Reel", { text: "para one\n\npara two", author: "ai", now: 1 });
    expect(reel.blocks.map((b) => b.text)).toEqual(["para one\n\npara two"]);
    expect(docToMarkdown(reel)).toBe("para one\n\npara two\n");
  });
  it("joins a legacy multi-block reel with a blank line", () => {
    expect(docToMarkdown(make())).toBe("Hook line\n\nSecond beat\n\nThird beat\n");
  });
});

describe("applyEdits", () => {
  it("replaces, inserts, appends and deletes with new ids", () => {
    const doc = make();
    const r = applyEdits(
      doc,
      [
        { op: "replace", id: "b2", text: "Better beat" },
        { op: "insert_after", id: "b2", text: "New after" },
        { op: "insert_before", id: "b1", text: "New first" },
        { op: "append", text: "CTA" },
        { op: "delete", id: "b3" },
      ],
      { now: 5 },
    );
    expect(doc.blocks.map((b) => b.text)).toEqual(["New first", "Hook line", "Better beat", "New after", "CTA"]);
    expect(doc.blocks.map((b) => b.id)).toEqual(["b5", "b1", "b2", "b4", "b6"]);
    expect(r.blockIds).toEqual(["b2", "b4", "b5", "b6", "b3"]);
    expect(r.skipped).toEqual([]);
    expect(doc.blocks.every((b) => b.author === "ai")).toBe(true);
  });

  it("edits the author's blocks too, remembers their edit, and skips unknown ids", () => {
    const doc = make();
    userEdit(doc, [{ id: "b1", text: "My own hook" }, { id: "b2", text: "Second beat" }, { id: "b3", text: "Third beat" }], 2);
    expect(doc.blocks[0]).toMatchObject({ author: "user", text: "My own hook" });
    expect(doc.userEdits).toEqual([{ blockId: "b1", from: "Hook line", fromAuthor: "ai", to: "My own hook", at: 2 }]);
    const r = applyEdits(doc, [{ op: "replace", id: "b1", text: "AI hook" }, { op: "replace", id: "b9", text: "x" }, { op: "append", text: "   " }]);
    expect(doc.blocks[0]).toMatchObject({ author: "ai", text: "AI hook" });
    expect(r.skipped.map((s) => s.reason)).toEqual(["missing", "empty"]);
  });
});

describe("versions", () => {
  it("snapshots, tracks the head, and restores without piling up versions", () => {
    const doc = make();
    const v1 = snapshot(doc, "first draft", 3);
    expect(v1.id).toBe("v1");
    expect(doc.headVersion).toBe("v1");
    applyEdits(doc, [{ op: "replace", id: "b1", text: "Changed hook" }]);
    expect(doc.headVersion).toBeUndefined();
    snapshot(doc, "after: tighter hook", 4);
    expect(currentVersionId(doc)).toBe("v2");
    expect(revert(doc, "v1", 5)).toBe(true);
    expect(doc.blocks[0]!.text).toBe("Hook line");
    expect(doc.headVersion).toBe("v1");
    expect(doc.versions.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(revert(doc, "v1", 6)).toBe(true);
    expect(doc.versions).toHaveLength(2);
    userEdit(doc, [{ id: "b1", text: "Hand-written hook" }, { id: "b2", text: "Second beat" }, { id: "b3", text: "Third beat" }], 7);
    expect(revert(doc, "v2", 8)).toBe(true);
    expect(doc.versions.map((v) => v.label)).toEqual(["first draft", "after: tighter hook", "your edits before restoring v2"]);
    expect(doc.blocks[0]!.text).toBe("Changed hook");
    expect(revert(doc, "v99")).toBe(false);
  });

  it("keeps a named snapshot through the auto cap", () => {
    const doc = make();
    snapshot(doc, "first draft", 2);
    expect(keep(doc, "this was good", 3)?.kept).toBe(true);
    expect(doc.versions[0]).toMatchObject({ id: "v1", label: "this was good", kept: true });
    userEdit(doc, [{ id: "b1", text: "New hook" }, { id: "b2", text: "Second beat" }, { id: "b3", text: "Third beat" }], 4);
    const v = keep(doc, "good caption", 5);
    expect(v).toMatchObject({ id: "v2", label: "good caption", kept: true });
    expect(doc.headVersion).toBe("v2");
    for (let i = 0; i < 40; i++) snapshot(doc, `s${i}`);
    expect(doc.versions.some((x) => x.label === "this was good" && x.kept)).toBe(true);
    expect(doc.versions.some((x) => x.label === "good caption" && x.kept)).toBe(true);
    expect(doc.versions.filter((x) => !x.kept)).toHaveLength(30);
    expect(setVersionKept(doc, "v1", false)).toBe(true);
    expect(doc.versions.find((x) => x.id === "v1")?.kept).toBeUndefined();
  });

  it("caps versions", () => {
    const doc = make();
    for (let i = 0; i < 40; i++) snapshot(doc, `s${i}`);
    expect(doc.versions).toHaveLength(30);
    expect(doc.versions[0]!.label).toBe("s10");
  });
});

describe("userEdit", () => {
  it("marks changed and new blocks as the author's and drops removed ones", () => {
    const doc = make();
    const changed = userEdit(doc, [{ id: "b1", text: "Hook line" }, { id: "b2", text: "Edited" }, { text: "Brand new" }], 9);
    expect(changed).toEqual(["b2", "b4", "b3"]);
    expect(doc.blocks.map((b) => [b.id, b.author])).toEqual([["b1", "ai"], ["b2", "user"], ["b4", "user"]]);
    expect(doc.dirty).toBe(true);
    expect(doc.userEdits).toEqual([
      { blockId: "b2", from: "Second beat", fromAuthor: "ai", to: "Edited", at: 9 },
      { blockId: "b4", to: "Brand new", at: 9 },
      { blockId: "b3", from: "Third beat", fromAuthor: "ai", at: 9 },
    ]);
    expect(userEdit(doc, doc.blocks.map((b) => ({ id: b.id, text: b.text })))).toEqual([]);
    // Keystrokes arrive as many saves: one edit per block, the original "from" kept.
    userEdit(doc, [{ id: "b1", text: "Hook line" }, { id: "b2", text: "Edited more" }, { id: "b4", text: "Brand new" }], 10);
    expect(doc.userEdits![0]).toEqual({ blockId: "b2", from: "Second beat", fromAuthor: "ai", to: "Edited more", at: 10 });
    markEditsSeen(doc);
    expect(doc.userEdits!.every((e) => e.seen)).toBe(true);
  });

  it("persists a reorder of unchanged blocks", () => {
    const doc = make();
    const shuffled = [
      { id: "b3", text: "Third beat" },
      { id: "b1", text: "Hook line" },
      { id: "b2", text: "Second beat" },
    ];
    expect(userEdit(doc, shuffled, 8)).toEqual([]);
    expect(doc.blocks.map((b) => b.id)).toEqual(["b3", "b1", "b2"]);
    expect(doc.dirty).toBe(true);
  });
});

describe("companions", () => {
  it("sets, snapshots, restores and exports the description and the pinned comment", () => {
    const doc = make();
    const r = applyEdits(doc, [{ op: "set_caption", text: "The caption." }, { op: "set_pinned", text: "Pinned: the objection, answered." }], { now: 3 });
    expect(r.blockIds).toEqual(["caption", "pinned"]);
    expect(doc.caption).toEqual({ text: "The caption.", author: "ai", at: 3 });
    snapshot(doc, "with companions", 4);
    applyEdits(doc, [{ op: "set_pinned", text: "" }], { now: 5 });
    expect(doc.pinned).toBeUndefined();
    expect(revert(doc, "v1", 6)).toBe(true);
    expect(doc.pinned?.text).toBe("Pinned: the objection, answered.");
    userEdit(doc, doc.blocks.map((b) => ({ id: b.id, text: b.text })), 7, { caption: "My caption" });
    expect(doc.caption).toEqual({ text: "My caption", author: "user", at: 7 });
    expect(doc.userEdits?.at(-1)).toEqual({ blockId: "caption", from: "The caption.", fromAuthor: "ai", to: "My caption", at: 7 });
    expect(docToMarkdown(doc)).toBe("Hook line\n\nSecond beat\n\nThird beat\n\n## Post description\n\nMy caption\n\n## Pinned comment\n\nPinned: the objection, answered.\n");
  });

  it("adds, replaces, deletes and exports reel hook variations", () => {
    const doc = make();
    const r = applyEdits(doc, [{ op: "add_hook", text: "Closing her mouth" }, { op: "add_hook", text: "Wait for it" }], { now: 3 });
    expect(r.blockIds).toEqual(["h1", "h2"]);
    expect(doc.hooks?.map((h) => h.text)).toEqual(["Closing her mouth", "Wait for it"]);
    applyEdits(doc, [{ op: "replace", id: "h1", text: "Hand over her mouth" }], { now: 4 });
    expect(doc.hooks?.[0]).toMatchObject({ text: "Hand over her mouth", author: "ai" });
    userEdit(doc, doc.blocks.map((b) => ({ id: b.id, text: b.text })), 5, { hooks: [{ id: "h1", text: "My open" }, { text: "Third take" }] });
    expect(doc.hooks?.map((h) => [h.id, h.text, h.author])).toEqual([["h1", "My open", "user"], ["h3", "Third take", "user"]]);
    snapshot(doc, "with hooks", 6);
    applyEdits(doc, [{ op: "delete", id: "h1" }], { now: 7 });
    expect(doc.hooks?.map((h) => h.id)).toEqual(["h3"]);
    expect(revert(doc, "v1", 8)).toBe(true);
    expect(doc.hooks?.map((h) => h.text)).toEqual(["My open", "Third take"]);
    expect(docToMarkdown(doc)).toContain("=== === === === ===\n\n//HOOK1: My open");
  });
});
