import type { Document } from "./types";

/**
 * The author's rewrites of the AI's text, kept for good. A document only
 * remembers its last few edits; this keeps every pair (what the AI wrote → what
 * the author made it) across sessions, so the next writer sees how the author rewrites: the
 * joins, the brackets, the emoji headers, what the author cuts. Evidence, not rules.
 */

export interface EditPair {
  /** docId:blockId:start of the AI text: a later save of the same rewrite replaces it. */
  key: string;
  kind: "description" | "pinned" | "hook" | "slide" | "script";
  docKind: Document["kind"];
  docTitle: string;
  from: string;
  to: string;
  at: number;
  /** the Workshop project it was written in; missing on pairs from before projects were kept apart */
  projectId?: string;
}

export const EDIT_LOG_MAX = 300;

/** What the author's version is when the author cut the AI's text out. */
const CUT = "(cut)";

const kindOf = (blockId: string, docKind: Document["kind"]): EditPair["kind"] =>
  blockId === "caption" ? "description" : blockId === "pinned" ? "pinned" : /^h\d/.test(blockId) ? "hook" : docKind === "reel" ? "script" : "slide";

/**
 * The document's rewrites of AI text as pairs; tiny touch-ups (a letter or two) aren't worth keeping.
 * A pure cut of AI text is a pair with an empty `to` (shown as "(cut)"); the author's own removed text is not kept.
 */
export function pairsOf(doc: Pick<Document, "id" | "kind" | "title" | "userEdits">): EditPair[] {
  return (doc.userEdits ?? [])
    .filter((e) => e.fromAuthor === "ai" && e.from?.trim() && e.from.trim() !== (e.to ?? "").trim())
    .filter((e) => Math.abs((e.to ?? "").length - e.from!.length) + diffChars(e.from!, e.to ?? "") >= 8)
    .map((e) => ({
      key: `${doc.id}:${e.blockId}:${e.from!.trim().slice(0, 60)}`,
      kind: kindOf(e.blockId, doc.kind),
      docKind: doc.kind,
      docTitle: doc.title,
      from: e.from!.trim(),
      to: (e.to ?? "").trim(),
      at: e.at,
    }));
}

/** Rough count of characters that differ (prefix/suffix trimmed): enough to skip a typo fix. */
function diffChars(a: string, b: string): number {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return Math.max(a.length - s - e, b.length - s - e);
}

/** Upsert the pairs into the log (a later save of the same rewrite replaces it), newest last, capped. */
export function mergeLog(log: EditPair[], pairs: EditPair[]): EditPair[] {
  if (!pairs.length) return log;
  const keys = new Set(pairs.map((p) => p.key));
  return [...log.filter((p) => !keys.has(p.key)), ...pairs].slice(-EDIT_LOG_MAX);
}

/** For the writer: the author's rewrites of this kind closest to the piece (closest.ts), AI draft then the author's version. */
export function renderPairs(pairs: EditPair[], what: string): string {
  if (!pairs.length) return "";
  return `How the author rewrote the AI's ${what} (the ones closest to this piece first): study what they changed, then write the way they did.\n${pairs
    .map((p) => `--- AI wrote:\n${p.from}\n--- The author made it:\n${p.to || CUT}`)
    .join("\n\n")}\n---`;
}

/** my-edits/INDEX.md in the Mac folder: every rewrite, newest first. */
export function editsFile(log: EditPair[]): string {
  const label: Record<EditPair["kind"], string> = { description: "Post description", pinned: "Pinned comment", hook: "Hook", slide: "Slide", script: "Script" };
  return [
    `# How the author rewrote the AI's text (${log.length}), newest first`,
    "",
    "Each one is what the AI wrote and what the author turned it into. Their version is how they want it said.",
    "",
    ...[...log].reverse().map((p) => `## ${label[p.kind]} · ${p.docTitle} · ${new Date(p.at).toISOString().slice(0, 10)}\n\nAI wrote:\n\n${p.from}\n\nThe author made it:\n\n${p.to || CUT}\n`),
  ].join("\n");
}
