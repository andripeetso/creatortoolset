import { test } from "node:test";
import assert from "node:assert/strict";
import { copyName, DEFAULT_STATUS, inFolder, isSynced, readNote, safeVaultPath, SYNC_STATUSES, shouldWriteBack, statusList, ymd } from "./lib.ts";

const keys = { status: "selector.Status", media: "selector.Media" };

test("readNote takes the dotted keys and trims; empty values are missing", () => {
  const note = readNote({ "selector.Status": " ✅ Published ", "selector.Media": "", details: "needs book" }, keys);
  assert.deepEqual(note, { status: "✅ Published", media: undefined, details: "needs book" });
  assert.deepEqual(readNote(undefined, keys), { status: undefined, media: undefined, details: undefined });
});

test("inFolder matches the folder and its subfolders only", () => {
  const folder = "Tiny Acrobatics/Scripts";
  assert.equal(inFolder("Tiny Acrobatics/Scripts/10kPerDay.md", folder), true);
  assert.equal(inFolder("Tiny Acrobatics/Scripts/sub/a.md", folder), true);
  assert.equal(inFolder("Tiny Acrobatics/Scriptsx/a.md", folder), false);
  assert.equal(inFolder("Scripts/a.md", ""), false);
  assert.equal(inFolder("Scripts/a.md", "/Scripts/"), true);
});

test("isSynced: the synced statuses go, the rest only when linked", () => {
  assert.equal(isSynced("Filming", false), true);
  assert.equal(isSynced("Editing", false), true);
  assert.equal(isSynced("Ready", false), true);
  assert.equal(isSynced("Published", false), false);
  assert.equal(isSynced("Published", true), true);
  assert.equal(isSynced("Idea", false), false);
  assert.equal(isSynced("Idea", true), true);
  assert.equal(isSynced(undefined, false), false);
});

test("the default sync list is the site's generic labels; the vault's own labels come from the setting", () => {
  assert.deepEqual([...SYNC_STATUSES].sort(), ["Editing", "Filming", "Ready"]);
  assert.equal(isSynced("🎥 Filming", false), false);
  const own = statusList(" 🎥 Filming, ✂️ Editing ,, 👍 Ready ");
  assert.equal(isSynced("🎥 Filming", false, own), true);
  assert.equal(isSynced("✂️ Editing", false, own), true);
  assert.equal(isSynced("Filming", false, own), false);
});

test("a note with no status gets the generic Idea, the label the site reads as a draft", () => {
  assert.equal(DEFAULT_STATUS, "Idea");
});

test("statusList trims and drops empty items", () => {
  assert.deepEqual([...statusList("")], []);
  assert.deepEqual([...statusList("Filming,, Ready ,")], ["Filming", "Ready"]);
});

test("last change wins: the site's newer status comes back, an older one does not", () => {
  const note = { status: "🎥 Filming", mtime: 1000 };
  assert.equal(shouldWriteBack(note, { status: "✂️ Editing", statusAt: 2000 }), true);
  assert.equal(shouldWriteBack(note, { status: "✂️ Editing", statusAt: 500 }), false);
  assert.equal(shouldWriteBack(note, { status: "🎥 Filming", statusAt: 2000 }), false);
});

test("safeVaultPath keeps folders, adds .md, and refuses escapes and hidden folders", () => {
  assert.equal(safeVaultPath("Tiny Acrobatics/Scripts/Name"), "Tiny Acrobatics/Scripts/Name.md");
  assert.equal(safeVaultPath("A/b:c?.md"), "A/b-c-.md");
  assert.equal(safeVaultPath("../escape.md"), null);
  assert.equal(safeVaultPath("A\\..\\..\\x.md"), null);
  assert.equal(safeVaultPath("/abs/x.md"), "abs/x.md");
  assert.equal(safeVaultPath(".obsidian/plugins/x/main.js"), null);
  assert.equal(safeVaultPath(""), null);
});

test("copyName numbers a second copy before the extension", () => {
  assert.equal(copyName("Scripts/Name.md", 2), "Scripts/Name (2).md");
});

test("ymd is the local calendar day", () => {
  assert.equal(ymd(new Date(2026, 10, 6, 23, 30).getTime()), "2026-11-06");
});
