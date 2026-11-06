import { pieceMarkdown } from "../../../src/lib/workshop-markdown";
import type { Block, Companion, DocKind, Document, UserEdit, Version } from "./types";

/**
 * The shared script document: blocks with an author, edit operations the
 * model returns, snapshots for revert, the author's edits (kept so the
 * model can learn from them), and markdown both ways. Pure.
 */

export const MAX_VERSIONS = 30; // auto snapshots; kept named ones are not dropped
export const MAX_BLOCKS = 400;
export const MAX_BLOCK_CHARS = 4000;
/** Notes and reel scripts are one freeform page, not a stack of beats. */
export const MAX_NOTES_CHARS = 200_000;
/** Author edits remembered for the model, newest last. */
export const MAX_USER_EDITS = 12;
/** Once a turn has seen the edits, only this many stay as a reminder. */
const KEEP_SEEN_EDITS = 4;

export type EditOp =
  | { op: "replace"; id: string; text: string }
  | { op: "insert_after"; id: string; text: string }
  | { op: "insert_before"; id: string; text: string }
  | { op: "append"; text: string }
  | { op: "delete"; id: string }
  /** The post description and the pinned comment; an empty text clears them. */
  | { op: "set_caption"; text: string }
  | { op: "set_pinned"; text: string }
  /** A reel hook variation. appends a new card. */
  | { op: "add_hook"; text: string };

export const COMPANION_KEYS = ["caption", "pinned"] as const;
export type CompanionKey = (typeof COMPANION_KEYS)[number];
/** Kept whole up to this; Instagram's own caption limit (2,200) is flagged, never cut. */
export const MAX_COMPANION_CHARS = 10_000;
export const INSTAGRAM_CAPTION_MAX = 2200;
export const MAX_HOOKS = 8;
export const MAX_HOOK_CHARS = 400;
export const HOOK_ID = /^h\d{1,5}$/;
export const isHookId = (id: string) => HOOK_ID.test(id);

function hookNum(id: string): number {
  return Number(/^h(\d+)$/.exec(id)?.[1] ?? 0);
}

function ensureNextHook(doc: Document) {
  if (doc.nextHook && doc.nextHook >= 1) return;
  doc.nextHook = 1 + Math.max(0, ...(doc.hooks ?? []).map((h) => hookNum(h.id)));
}

function allocHookId(doc: Document): string {
  ensureNextHook(doc);
  return `h${doc.nextHook!++}`;
}

const clip = (t: string, max = MAX_BLOCK_CHARS) => t.replace(/\r\n/g, "\n").trim().slice(0, max);
const isPageKind = (kind: DocKind) => kind === "notes" || kind === "reel";
const blockLimit = (kind: DocKind) => (isPageKind(kind) ? MAX_NOTES_CHARS : MAX_BLOCK_CHARS);

export function blocksFromMarkdown(md: string): string[] {
  return md
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function docToMarkdown(doc: Pick<Document, "kind" | "blocks" | "hooks" | "caption" | "pinned">): string {
  if (doc.kind === "notes") {
    return `${doc.blocks.map((b) => b.text.trim()).filter(Boolean).join("\n\n")}\n`;
  }
  return pieceMarkdown(doc, { frontmatter: false });
}

export function newDocument(
  id: string,
  sessionId: string,
  kind: DocKind,
  title: string,
  opts: { frameworkIds?: string[]; ruleIds?: string[]; text?: string; author?: Block["author"]; now?: number } = {},
): Document {
  const now = opts.now ?? Date.now();
  const doc: Document = {
    id,
    sessionId,
    kind,
    title,
    frameworkIds: opts.frameworkIds ?? [],
    ruleIds: opts.ruleIds,
    blocks: [],
    versions: [],
    nextBlock: 1,
    nextVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  if (isPageKind(kind)) {
    const text = clip(opts.text ?? "", blockLimit(kind));
    if (text) doc.blocks.push({ id: `b${doc.nextBlock++}`, text, author: opts.author ?? "user", at: now });
    return doc;
  }
  for (const text of blocksFromMarkdown(opts.text ?? "")) {
    doc.blocks.push({ id: `b${doc.nextBlock++}`, text: clip(text), author: opts.author ?? "user", at: now });
  }
  return doc;
}

/** The newest version's id. */
export function currentVersionId(doc: Document): string | undefined {
  return doc.versions[doc.versions.length - 1]?.id;
}

function pruneVersions(doc: Document) {
  let auto = 0;
  for (const v of doc.versions) if (!v.kept) auto++;
  if (auto <= MAX_VERSIONS) return;
  let extra = auto - MAX_VERSIONS;
  for (let i = 0; i < doc.versions.length && extra > 0; ) {
    if (doc.versions[i]!.kept) {
      i++;
      continue;
    }
    doc.versions.splice(i, 1);
    extra--;
  }
}

/** Record the current blocks as a version; it becomes the head. Notes has none. */
export function snapshot(doc: Document, label: string, now = Date.now()): Version {
  if (doc.kind === "notes") return { id: "", at: now, label: "", blocks: [] };
  const v: Version = {
    id: `v${doc.nextVersion++}`,
    at: now,
    label: label.slice(0, 120),
    blocks: doc.blocks.map((b) => ({ ...b })),
    ...(doc.hooks?.length ? { hooks: doc.hooks.map((h) => ({ ...h })) } : {}),
    ...(doc.caption ? { caption: { ...doc.caption } } : {}),
    ...(doc.pinned ? { pinned: { ...doc.pinned } } : {}),
  };
  doc.versions.push(v);
  pruneVersions(doc);
  doc.dirty = false;
  doc.headVersion = v.id;
  return v;
}

/**
 * Name the current text as a keep — a snapshot the author can come back to.
 * If the current text already is a version, that one is renamed and marked.
 */
export function keep(doc: Document, name: string, now = Date.now()): Version | undefined {
  if (doc.kind === "notes") return undefined;
  const label = name.replace(/\s+/g, " ").trim().slice(0, 120) || "Keep";
  if (doc.headVersion) {
    const v = doc.versions.find((x) => x.id === doc.headVersion);
    if (v) {
      v.label = label;
      v.kept = true;
      return v;
    }
  }
  const v = snapshot(doc, label, now);
  v.kept = true;
  return v;
}

/** Mark or unmark an existing version as a keep; optionally rename it. */
export function setVersionKept(doc: Document, versionId: string, kept: boolean, name?: string): boolean {
  const v = doc.versions.find((x) => x.id === versionId);
  if (!v) return false;
  if (kept) {
    v.kept = true;
    if (name) v.label = name.replace(/\s+/g, " ").trim().slice(0, 120) || v.label;
  } else {
    delete v.kept;
  }
  return true;
}

export interface ApplyResult {
  blockIds: string[];
  skipped: Array<{ op: EditOp; reason: "missing" | "empty" | "full" | "locked" }>;
}

/**
 * Apply the model's operations. Any block may change — the author's
 * wording is a signal the prompt carries, not a lock. Unknown ids are
 * skipped, not fatal.
 */
export function applyEdits(doc: Document, edits: EditOp[], opts: { now?: number } = {}): ApplyResult {
  const now = opts.now ?? Date.now();
  const touched: string[] = [];
  const skipped: ApplyResult["skipped"] = [];
  const take = (text: string) => clip(text, blockLimit(doc.kind));
  const takeHook = (text: string) => clip(text, MAX_HOOK_CHARS);
  const mk = (text: string): Block => ({ id: `b${doc.nextBlock++}`, text: take(text), author: "ai", at: now });
  const hookAt = (id: string) => (doc.hooks ?? []).findIndex((h) => h.id === id);
  for (const e of edits) {
    if (e.op === "set_caption" || e.op === "set_pinned") {
      const key: CompanionKey = e.op === "set_caption" ? "caption" : "pinned";
      const text = clip(e.text).slice(0, MAX_COMPANION_CHARS);
      if (text) doc[key] = { text, author: "ai", at: now };
      else delete doc[key];
      touched.push(key);
      continue;
    }
    if (e.op === "add_hook") {
      const text = takeHook(e.text);
      if (!text) {
        skipped.push({ op: e, reason: "empty" });
        continue;
      }
      if ((doc.hooks?.length ?? 0) >= MAX_HOOKS) {
        skipped.push({ op: e, reason: "full" });
        continue;
      }
      const h: Block = { id: allocHookId(doc), text, author: "ai", at: now };
      doc.hooks = [...(doc.hooks ?? []), h];
      touched.push(h.id);
      continue;
    }
    if ("id" in e && isHookId(e.id) && (e.op === "replace" || e.op === "delete")) {
      const at = hookAt(e.id);
      if (at < 0) {
        skipped.push({ op: e, reason: "missing" });
        continue;
      }
      const hooks = doc.hooks!;
      const target = hooks[at]!;
      if (e.op === "delete") {
        hooks.splice(at, 1);
        if (!hooks.length) delete doc.hooks;
        touched.push(target.id);
        continue;
      }
      const text = takeHook(e.text);
      if (!text) {
        skipped.push({ op: e, reason: "empty" });
        continue;
      }
      target.text = text;
      target.author = "ai";
      target.at = now;
      touched.push(target.id);
      continue;
    }
    if ("text" in e && !take(e.text)) {
      skipped.push({ op: e, reason: "empty" });
      continue;
    }
    if (e.op === "append") {
      if (doc.blocks.length >= MAX_BLOCKS) {
        skipped.push({ op: e, reason: "full" });
        continue;
      }
      const b = mk(e.text);
      doc.blocks.push(b);
      touched.push(b.id);
      continue;
    }
    const at = doc.blocks.findIndex((b) => b.id === e.id);
    if (at < 0) {
      skipped.push({ op: e, reason: "missing" });
      continue;
    }
    const target = doc.blocks[at]!;
    if ((e.op === "replace" || e.op === "delete") && doc.locked?.includes(target.id)) {
      skipped.push({ op: e, reason: "locked" });
      continue;
    }
    if (e.op === "replace") {
      target.text = take(e.text);
      target.author = "ai";
      target.at = now;
      touched.push(target.id);
    } else if (e.op === "delete") {
      doc.blocks.splice(at, 1);
      touched.push(target.id);
    } else {
      if (doc.blocks.length >= MAX_BLOCKS) {
        skipped.push({ op: e, reason: "full" });
        continue;
      }
      const b = mk(e.text);
      doc.blocks.splice(e.op === "insert_after" ? at + 1 : at, 0, b);
      touched.push(b.id);
    }
  }
  if (touched.length) {
    doc.updatedAt = now;
    delete doc.headVersion;
  }
  return { blockIds: touched, skipped };
}

/**
 * Make a version the current text. Nothing happens when it already is;
 * unsaved author edits are kept as a version first, so nothing is lost.
 */
export function revert(doc: Document, versionId: string, now = Date.now()): boolean {
  if (doc.kind === "notes" || !versionId) return false;
  const v = doc.versions.find((x) => x.id === versionId);
  if (!v) return false;
  if (doc.headVersion === versionId) return true;
  if (doc.dirty) snapshot(doc, `your edits before restoring ${versionId}`, now);
  doc.blocks = v.blocks.map((b) => ({ ...b }));
  if (v.hooks?.length) {
    doc.hooks = v.hooks.map((h) => ({ ...h }));
    ensureNextHook(doc);
  } else delete doc.hooks;
  if (v.caption) doc.caption = { ...v.caption };
  else delete doc.caption;
  if (v.pinned) doc.pinned = { ...v.pinned };
  else delete doc.pinned;
  doc.headVersion = versionId;
  doc.dirty = false;
  doc.updatedAt = now;
  return true;
}

export interface EditorBlock {
  id?: string;
  text: string;
}

function recordEdit(doc: Document, edit: UserEdit) {
  const edits = doc.userEdits ?? (doc.userEdits = []);
  const open = edits.find((e) => e.blockId === edit.blockId && !e.seen);
  if (open) {
    // Keystrokes arrive as a series of saves: keep the original "from", take the newest "to".
    open.to = edit.to;
    open.at = edit.at;
  } else {
    edits.push(edit);
  }
  if (edits.length > MAX_USER_EDITS) edits.splice(0, edits.length - MAX_USER_EDITS);
}

/**
 * The author's editor state replaces the block list. Changed or new text
 * becomes theirs; untouched blocks keep their author. Every change is
 * remembered (what it was, what it became) so the next turn can read why.
 */
export function userEdit(
  doc: Document,
  blocks: EditorBlock[],
  now = Date.now(),
  companions: Partial<Record<CompanionKey, string>> & { hooks?: EditorBlock[] } = {},
  /** "ai": an AI wrote it through a Full key, so it is the AI's text, never one of the author's edits. */
  by: "user" | "ai" = "user",
): string[] {
  const note = (edit: UserEdit) => by === "user" && recordEdit(doc, edit);
  const byId = new Map(doc.blocks.map((b) => [b.id, b]));
  const next: Block[] = [];
  const changed: string[] = [];
  let hooksDirty = false;
  for (const key of COMPANION_KEYS) {
    const incoming = companions[key];
    if (incoming === undefined) continue;
    const text = clip(incoming).slice(0, MAX_COMPANION_CHARS);
    const prev: Companion | undefined = doc[key];
    if ((prev?.text ?? "") === text) continue;
    if (text) doc[key] = { text, author: by, at: now };
    else delete doc[key];
    changed.push(key);
    note({ blockId: key, ...(prev ? { from: prev.text, fromAuthor: prev.author } : {}), ...(text ? { to: text } : {}), at: now });
  }
  if (companions.hooks) {
    const byHook = new Map((doc.hooks ?? []).map((h) => [h.id, h]));
    const nextHooks: Block[] = [];
    for (const incoming of companions.hooks.slice(0, MAX_HOOKS)) {
      const text = clip(incoming.text, MAX_HOOK_CHARS);
      const prev = incoming.id && isHookId(incoming.id) ? byHook.get(incoming.id) : undefined;
      if (prev) {
        if (prev.text !== text) {
          nextHooks.push({ ...prev, text, author: by, at: now });
          changed.push(prev.id);
          note({ blockId: prev.id, from: prev.text, fromAuthor: prev.author, to: text, at: now });
        } else {
          nextHooks.push(prev);
        }
      } else {
        const h: Block = { id: allocHookId(doc), text, author: by, at: now };
        nextHooks.push(h);
        changed.push(h.id);
        note({ blockId: h.id, to: text, at: now });
      }
    }
    const removedHooks = (doc.hooks ?? []).filter((h) => !nextHooks.some((n) => n.id === h.id));
    for (const h of removedHooks) note({ blockId: h.id, from: h.text, fromAuthor: h.author, at: now });
    const hookOrderChanged =
      nextHooks.length === (doc.hooks?.length ?? 0) && nextHooks.some((h, i) => h.id !== doc.hooks?.[i]?.id);
    hooksDirty =
      changed.some((id) => isHookId(id)) || removedHooks.length > 0 || hookOrderChanged || (doc.hooks?.length ?? 0) !== nextHooks.length;
    if (hooksDirty) {
      if (nextHooks.length) doc.hooks = nextHooks;
      else delete doc.hooks;
    }
    changed.push(...removedHooks.map((h) => h.id));
  }
  for (const incoming of blocks.slice(0, MAX_BLOCKS)) {
    const text = clip(incoming.text, blockLimit(doc.kind));
    const prev = incoming.id ? byId.get(incoming.id) : undefined;
    if (prev) {
      if (prev.text !== text) {
        next.push({ ...prev, text, author: by, at: now });
        changed.push(prev.id);
        note({ blockId: prev.id, from: prev.text, fromAuthor: prev.author, to: text, at: now });
      } else {
        next.push(prev);
      }
    } else if (text) {
      const b: Block = { id: `b${doc.nextBlock++}`, text, author: by, at: now };
      next.push(b);
      changed.push(b.id);
      note({ blockId: b.id, to: text, at: now });
    }
  }
  const removed = doc.blocks.filter((b) => !next.some((n) => n.id === b.id));
  for (const b of removed) note({ blockId: b.id, from: b.text, fromAuthor: b.author, at: now });
  const orderChanged = next.length === doc.blocks.length && next.some((b, i) => b.id !== doc.blocks[i]?.id);
  if (changed.length || removed.length || orderChanged || hooksDirty) {
    doc.blocks = next;
    doc.dirty = true;
    delete doc.headVersion;
    doc.updatedAt = now;
  }
  return [...changed, ...removed.map((b) => b.id)];
}

/** A turn has read the author's edits: keep a few as a reminder, mark them seen. */
export function markEditsSeen(doc: Document): void {
  if (!doc.userEdits?.length) return;
  for (const e of doc.userEdits) e.seen = true;
  doc.userEdits = doc.userEdits.slice(-KEEP_SEEN_EDITS);
}
