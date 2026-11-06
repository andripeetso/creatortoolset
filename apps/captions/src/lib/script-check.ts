import type { Word } from "./types";

/**
 * Script check, client side. The creator can give the script they filmed
 * from; after transcription the server's AI pass (api/lib/script-check.ts)
 * reads the transcript against it and returns vetted edits for words the
 * engine mis-heard. This file applies those edits to the timed words.
 */

/** Longest script the project stores and the check reads. */
export const MAX_SCRIPT_CHARS = 40_000;

/** Transcript words [from, to] (inclusive) were said as `text`. */
export interface ScriptEdit {
  from: number;
  to: number;
  text: string;
}

/** One applied fix, for review: the new words' ids and what was heard. */
export interface ScriptFix {
  ids: number[];
  before: string;
  after: string;
  /** Placed by apply-master from a master fix, not from the script. */
  from?: "master";
}

/**
 * Apply script edits to a transcript's caption groups (one Word[] per
 * caption, or [words] for an ungrouped transcript). A run replaced by
 * the same number of words keeps each word's timing; a run that becomes
 * more or fewer words spreads its time over them by length. Fixed words
 * get fresh ids, so undo brings back the old words unhighlighted. The new
 * words sit in the caption of the run's first word; a caption left empty
 * is dropped.
 */
export function applyScriptEdits(
  groups: Word[][],
  edits: ScriptEdit[],
  nextId: () => number,
): { groups: Word[][]; fixes: ScriptFix[] } {
  const count = groups.reduce((n, g) => n + g.length, 0);
  const flat = groups.flat();
  const byFrom = new Map<number, ScriptEdit>();
  let lastTo = -1;
  for (const e of [...edits].sort((a, b) => a.from - b.from)) {
    if (e.from <= lastTo || e.from > e.to || e.to >= count) continue;
    const tokens = e.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    byFrom.set(e.from, { ...e, text: tokens.join(" ") });
    lastTo = e.to;
  }

  const fixes: ScriptFix[] = [];
  const out: Word[][] = [];
  let i = 0;
  let skipTo = -1;
  for (const group of groups) {
    const next: Word[] = [];
    for (let k = 0; k < group.length; k++, i++) {
      if (i <= skipTo) continue;
      const edit = byFrom.get(i);
      if (!edit) {
        next.push(group[k]);
        continue;
      }
      const old = flat.slice(edit.from, edit.to + 1);
      const fixed = fixedWords(old, edit.text.split(" "), nextId);
      next.push(...fixed);
      fixes.push({
        ids: fixed.map((w) => w.id),
        before: old.map((w) => w.text).join(" "),
        after: edit.text,
      });
      skipTo = edit.to;
    }
    if (next.length) out.push(next);
  }
  return { groups: out, fixes };
}

function fixedWords(old: Word[], tokens: string[], nextId: () => number): Word[] {
  const first = old[0];
  // the engine's confidence was in the words it heard, not in the fix
  const base = (w: Word): Word => {
    const copy = { ...w };
    delete copy.confidence;
    return copy;
  };
  if (tokens.length === old.length) {
    return tokens.map((text, k) => ({ ...base(old[k]), id: nextId(), text }));
  }
  const start = first.start;
  const end = Math.max(old[old.length - 1].end, start + 0.05 * tokens.length);
  const weight = tokens.map((t) => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, "").length));
  const total = weight.reduce((a, b) => a + b, 0);
  let at = start;
  return tokens.map((text, k) => {
    const from = at;
    at = k === tokens.length - 1 ? end : at + ((end - start) * weight[k]) / total;
    const w: Word = { ...base(first), id: nextId(), text, start: from, end: at };
    // later words continue the first word's thought
    if (k > 0 && first.cut !== undefined) w.cut = 0;
    return w;
  });
}
