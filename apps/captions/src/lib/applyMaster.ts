import { norm } from "./align";
import { cuesFromBreaks } from "./captions";
import type { Cue, PosSegment, Word } from "./types";

/** Console diagnostics for stubborn apply-master cases:
 *  run `localStorage.setItem("debugMaster","1")` before applying. */
const DEBUG =
  typeof localStorage !== "undefined" &&
  localStorage.getItem("debugMaster") === "1";
function dbg(...args: unknown[]): void {
  if (DEBUG) console.log("[applyMaster]", ...args);
}

/**
 * Apply master = replay what the user CHANGED on the master, nothing more
 *. Clips are
 * variations: another take, another hook, other wording. The master's
 * edits are the diff of its stored engine transcript against its current
 * words (respellings, cut words, added words, split phrasing). An edit
 * lands on a target only where the target says the words the master's
 * engine heard there, with the same words on either side. Everywhere
 * else the target keeps its own words, timing and caption breaks: a
 * master word is never copied in just because the target lacks it.
 * Where the two clips share words, the master's caption breaks, cadence
 * marks and captions-layer sections land on them.
 *
 * Saves without a stored engine transcript have no known edits: then only
 * the breaks, cadence and layer transfer.
 */

/** Dice coefficient over character bigrams — fuzzy word equality. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hit++;
    }
  }
  return (2 * hit) / (a.length - 1 + (b.length - 1));
}

/** Fuzzy word equality: exact (normalized) or near-identical spelling. */
function wordEq(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // short words differ too easily by one letter ("a"/"I", "to"/"do")
  if (na.length < 4 || nb.length < 4) return false;
  return similarity(na, nb) >= 0.7;
}

/**
 * LCS alignment of two sequences under `eq`.
 * Returns for every b index the matching a index (or -1).
 */
function lcs(n: number, m: number, eq: (i: number, j: number) => boolean): Int32Array {
  const match = new Int32Array(m).fill(-1);
  if (!n || !m) return match;
  if ((n + 1) * (m + 1) > 4_000_000) return match; // too big — no transfer
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(i, j) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(i, j)) {
      match[j] = i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return match;
}

export interface MasterApplyResult {
  words: Word[];
  cues: Cue[];
  /**
   * The master's captions-layer edits mapped onto the target — null
   * when the master has no layer edits at all (target's layer, if any,
   * is left untouched then).
   */
  posSegments: PosSegment[] | null;
  /** Share of target words matched to the master (0-1). */
  coverage: number;
  /** How many words the master's edits added to the target. */
  inserted: number;
  /** How many target words the master's edits changed. */
  corrected: number;
  /**
   * Master fixes of names, acronyms and numbers that found no exact place
   * here, each with a few master words around it: the AI's script check
   * looks for where this take mis-heard them (store.ts applyMasterToAll).
   */
  missed: string[];
}

/** One user edit on the master: original words [o0, o1) became master words [m0, m1). */
interface MasterEdit {
  o0: number;
  o1: number;
  m0: number;
  m1: number;
}

/**
 * Diff the master's engine transcript against its current words: the
 * user's edits, plus which current word each untouched original word is.
 * Exact-normalized LCS (user edits are sparse); a word that only changed
 * punctuation or case is an anchor AND a one-word edit.
 */
function masterEdits(original: Word[], edited: Word[]) {
  const n = original.length;
  const tOfE = lcs(n, edited.length, (i, j) => norm(original[i].text) === norm(edited[j].text));
  const mOfO = new Int32Array(n).fill(-1); // original idx → master idx (-1 = edited away)
  for (let j = 0; j < tOfE.length; j++) if (tOfE[j] >= 0) mOfO[tOfE[j]] = j;
  const edits: MasterEdit[] = [];
  // what each original word reads as now, where the edit is 1:1 — lets a
  // target that already carries the fix (or a near spelling of it) align
  const alias: (string | null)[] = new Array(n).fill(null);
  let po = 0;
  let pm = 0;
  const gap = (o1: number, m1: number) => {
    if (o1 > po || m1 > pm) {
      edits.push({ o0: po, o1, m0: pm, m1 });
      if (o1 - po === m1 - pm) {
        for (let k = 0; k < o1 - po; k++) alias[po + k] = edited[pm + k].text;
      }
    }
  };
  for (let i = 0; i < n; i++) {
    const j = mOfO[i];
    if (j < 0) continue;
    gap(i, j);
    if (original[i].text !== edited[j].text) {
      edits.push({ o0: i, o1: i + 1, m0: j, m1: j + 1 });
      alias[i] = edited[j].text;
    }
    po = i + 1;
    pm = j + 1;
  }
  gap(n, edited.length);
  return { edits, mOfO, alias };
}

/** Gap needed per inserted word before borrowing time from the neighbours. */
const MIN_GAP_PER_WORD = 0.1;
/** Interval per word when borrowing across the neighbours (fast speech). */
const BORROW_PER_WORD = 0.12;

/**
 * Rebuild the captions layer for the target from the master's, by TIME:
 * matched word pairs give (master t → target t) anchors — piecewise, so
 * a longer hook shifts everything correctly — and each master section's
 * edges land at the interpolated target times. Sections are then widened
 * to fully cover every matched word of their master section (drift can
 * put a word just past an edge), and unmatched words are reconciled:
 * inside a mapped section they ride along (inheriting its position
 * override), inside a mapped cut they hide with it, and outside the
 * master's span (a different hook) they stay visible in default
 * sections. Because edges come from time rather than word presence, a
 * cut still lands when the target's transcription has a dead zone.
 */
function applyMasterToSegments(
  masterWords: Word[],
  masterSegments: PosSegment[],
  targetWords: Word[],
  match: Int32Array,
  nextPosId: () => number
): PosSegment[] {
  // anchors: master time → target time (word starts; LCS keeps them sorted)
  const anchors: { tm: number; tt: number }[] = [];
  for (let j = 0; j < targetWords.length; j++) {
    const mi = match[j];
    if (mi >= 0) anchors.push({ tm: masterWords[mi].start, tt: targetWords[j].start });
  }
  if (!anchors.length) return [];

  const mapTime = (t: number): number => {
    if (t <= anchors[0].tm) return anchors[0].tt + (t - anchors[0].tm);
    const last = anchors[anchors.length - 1];
    if (t >= last.tm) return last.tt + (t - last.tm);
    let lo = 0;
    let hi = anchors.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid].tm <= t) lo = mid;
      else hi = mid;
    }
    const a = anchors[lo];
    const b = anchors[hi];
    const f = (t - a.tm) / Math.max(1e-6, b.tm - a.tm);
    return a.tt + f * (b.tt - a.tt);
  };

  // mapped master sections (mi: source section index)
  const mapped: {
    mi: number;
    start: number;
    end: number;
    x: number | null;
    y: number | null;
  }[] = [];
  for (let si = 0; si < masterSegments.length; si++) {
    const s = masterSegments[si];
    const start = mapTime(s.start);
    const end = mapTime(s.end);
    if (end - start < 0.05) continue;
    mapped.push({ mi: si, start, end, x: s.x, y: s.y });
  }
  if (!mapped.length) return [];

  // widen each mapped section to cover every matched word of its master
  // section — an edge must never slice through a word that belongs inside
  for (const seg of mapped) {
    const s = masterSegments[seg.mi];
    for (let j = 0; j < targetWords.length; j++) {
      const mi = match[j];
      if (mi < 0) continue;
      const mid = (masterWords[mi].start + masterWords[mi].end) / 2;
      if (mid >= s.start && mid < s.end + 0.001) {
        seg.start = Math.min(seg.start, targetWords[j].start);
        seg.end = Math.max(seg.end, targetWords[j].end + 0.08);
      }
    }
  }
  // sections may have shifted out of order with the widening — re-sort
  // and clamp overlaps (the earlier section yields)
  mapped.sort((a, b) => a.start - b.start);
  for (let i = 0; i < mapped.length - 1; i++) {
    mapped[i].end = Math.min(mapped[i].end, mapped[i + 1].start - 0.001);
  }

  // unmatched words outside the master's span stay visible in default
  // sections (different hook); unmatched inside a mapped cut hide with it
  const spanStart = mapped[0].start;
  const spanEnd = mapped[mapped.length - 1].end;
  const inside = (t: number) => {
    for (const s of mapped) if (t >= s.start && t < s.end + 0.001) return true;
    return false;
  };
  const out: PosSegment[] = mapped.map((s) => ({
    id: nextPosId(),
    start: s.start,
    end: s.end,
    x: s.x,
    y: s.y,
  }));
  let runStart = -1;
  let runEnd = -1;
  const flushRun = () => {
    if (runStart >= 0) {
      out.push({ id: nextPosId(), start: runStart, end: runEnd, x: null, y: null });
      runStart = -1;
    }
  };
  for (let j = 0; j < targetWords.length; j++) {
    if (match[j] >= 0) continue;
    const mid = (targetWords[j].start + targetWords[j].end) / 2;
    if (mid < spanStart || mid >= spanEnd) {
      // outside the master's edited span — keep visible
      if (runStart < 0) runStart = targetWords[j].start;
      runEnd = targetWords[j].end + 0.08;
    } else if (inside(mid)) {
      continue; // inside a mapped section — already visible
    } else {
      flushRun(); // inside a mapped cut — hidden
    }
  }
  flushRun();

  out.sort((a, b) => a.start - b.start);
  const final = out.filter((s) => s.end - s.start >= 0.05);
  for (let i = 0; i < final.length - 1; i++) {
    final[i].end = Math.min(final[i].end, final[i + 1].start - 0.001);
  }
  return final;
}

/**
 * Replay the master's edits onto a target clip. `origMaster` is the
 * master's stored engine transcript (its current words when none is
 * stored: no known edits), `masterWords`/`masterCues` its current state,
 * `target`/`targetCues` the target's current words and captions (its own
 * breaks stay wherever the master has nothing to say).
 */
export function applyMasterToClip(
  origMaster: Word[],
  masterWords: Word[],
  masterCues: Cue[],
  masterSegments: PosSegment[],
  target: Word[],
  targetCues: Cue[],
  maxChars: number,
  maxLines: number,
  nextPosId: () => number,
  nextWordId: () => number
): MasterApplyResult | null {
  if (!origMaster.length || !masterWords.length || !target.length) return null;
  const n = origMaster.length;
  const { edits, mOfO, alias } = masterEdits(origMaster, masterWords);

  // engine against engine: which target word is which original word (a
  // target already carrying the master's 1:1 fix aligns too)
  const oOfT = lcs(n, target.length, (i, j) =>
    wordEq(origMaster[i].text, target[j].text) ||
    (alias[i] !== null && wordEq(alias[i]!, target[j].text))
  );
  const tOfO = new Int32Array(n).fill(-1);
  let matched = 0;
  for (let j = 0; j < target.length; j++) {
    if (oOfT[j] >= 0) {
      tOfO[oOfT[j]] = j;
      matched++;
    }
  }
  const coverage = matched / target.length;

  // an edit lands only where the target has the same original words, in
  // a row, with the same neighbours either side
  const place = (e: MasterEdit): [number, number] | null => {
    let t0: number;
    if (e.o1 > e.o0) {
      t0 = tOfO[e.o0];
      if (t0 < 0) return null;
      for (let k = e.o0 + 1; k < e.o1; k++) if (tOfO[k] !== t0 + (k - e.o0)) return null;
    } else {
      // an added word needs both neighbours to place it
      if (e.o0 === 0 || e.o0 >= n) return null;
      t0 = tOfO[e.o0];
      if (t0 < 0) return null;
    }
    const t1 = t0 + (e.o1 - e.o0);
    if (e.o0 > 0 && tOfO[e.o0 - 1] !== t0 - 1) return null;
    if (e.o1 < n && tOfO[e.o1] !== t1) return null;
    return [t0, t1];
  };
  // a name, acronym or number: capitals past a sentence start, digits, %
  // (sentence starts read from the engine's punctuation, which the user
  // may have stripped from the master)
  const isTerm = (e: MasterEdit) => {
    for (let k = e.m0; k < e.m1; k++) {
      const t = masterWords[k].text;
      if (/[0-9%$&]/.test(t) || /[A-Z].*[A-Z]/.test(t)) return true;
      const before = k === e.m0 ? origMaster[e.o0 - 1]?.text : masterWords[k - 1].text;
      const opens = before === undefined || /[.?!]$/.test(before);
      if (/^\W*[A-Z]/.test(t) && !opens && !/^I\b/.test(t)) return true;
    }
    return false;
  };
  const landed: { e: MasterEdit; t0: number; t1: number }[] = [];
  const missed: string[] = [];
  const span = (ws: Word[], a: number, b: number) =>
    ws.slice(a, b).map((w) => w.text).join(" ");
  for (const e of edits) {
    const at = place(e);
    if (at) {
      landed.push({ e, t0: at[0], t1: at[1] });
      continue;
    }
    // only names, acronyms and numbers go on to the AI: a common word's
    // fix belongs to its exact spot, and the rest of the master's wording
    // is never evidence (it holds engine errors the user didn't fix)
    if (
      isTerm(e) &&
      norm(span(masterWords, e.m0, e.m1)) !== norm(span(origMaster, e.o0, e.o1))
    ) {
      missed.push(span(masterWords, Math.max(0, e.m0 - 3), e.m1 + 3));
    }
  }

  const out: Word[] = [];
  const prov: number[] = []; // master index per output word (-1 = the target's own)
  const own: number[] = []; // target index per output word (-1 = came from the master)
  let corrected = 0;
  let inserted = 0;
  const emitTarget = (j: number) => {
    const oi = oOfT[j];
    out.push({ ...target[j] });
    prov.push(oi >= 0 ? mOfO[oi] : -1);
    own.push(j);
  };

  let t = 0;
  for (const { e, t0, t1 } of landed) {
    if (t0 < t) continue; // never overlaps — LCS keeps edits in order
    while (t < t0) emitTarget(t++);
    const span = t1 - t0;
    const count = e.m1 - e.m0;
    if (count === span) {
      // 1:1 — each word keeps the target's own timing
      for (let k = 0; k < span; k++) {
        const text = masterWords[e.m0 + k].text;
        if (norm(text) !== norm(target[t0 + k].text)) corrected++;
        out.push({ ...target[t0 + k], text });
        prov.push(e.m0 + k);
        own.push(t0 + k);
      }
    } else if (count > 0) {
      // reworded / added: the new words share the replaced words' time,
      // or the gap between the neighbours (borrowed across them if packed)
      let lo: number;
      let hi: number;
      if (span > 0) {
        lo = target[t0].start;
        hi = target[t1 - 1].end;
        corrected += span;
      } else {
        const left = target[t0 - 1];
        const right = target[t0];
        lo = left.end;
        hi = right.start;
        if (hi - lo < count * MIN_GAP_PER_WORD) {
          const mid = (lo + hi) / 2;
          const half = (count * BORROW_PER_WORD) / 2;
          lo = Math.max(left.start, mid - half);
          hi = Math.min(right.end, mid + half);
        }
        inserted += count;
      }
      const step = (hi - lo) / count;
      for (let k = 0; k < count; k++) {
        out.push({
          id: nextWordId(),
          text: masterWords[e.m0 + k].text,
          start: lo + k * step,
          end: lo + (k + 1) * step - Math.min(0.02, step * 0.15),
        });
        prov.push(e.m0 + k);
        own.push(-1);
      }
    } else {
      corrected += span; // the user cut these words
    }
    t = t1;
  }
  while (t < target.length) emitTarget(t++);

  dbg("replay:", {
    original: n,
    master: masterWords.length,
    target: target.length,
    coverage: +coverage.toFixed(3),
    edits: edits.length,
    landed: landed.map(({ e }) => [
      origMaster.slice(e.o0, e.o1).map((w) => w.text).join(" "),
      masterWords.slice(e.m0, e.m1).map((w) => w.text).join(" "),
    ]),
  });

  // the master's cadence marks travel with its words, so the shared
  // stretches lay out into the same thoughts at any box size
  for (let j = 0; j < out.length; j++) {
    const cut = prov[j] >= 0 ? masterWords[prov[j]].cut : undefined;
    if (cut !== undefined) out[j] = { ...out[j], cut };
  }

  // dropping commas / periods on the master ("No commas") is an edit too
  const has = (ws: Word[], re: RegExp) => ws.some((w) => re.test(w.text));
  const dropCommas = has(origMaster, /,/) && !has(masterWords, /,/);
  // a full stop, never an ellipsis ("so...")
  const dropPeriods = has(origMaster, /[^.]\.$/) && !has(masterWords, /[^.]\.$/);
  if (dropCommas || dropPeriods) {
    for (let j = 0; j < out.length; j++) {
      let s = out[j].text;
      if (dropCommas) s = s.replace(/,/g, "");
      if (dropPeriods) s = s.replace(/([^.])\.$/, "$1");
      if (s && s !== out[j].text) out[j] = { ...out[j], text: s };
    }
  }

  // caption breaks: the master's on words the two share, the target's
  // own everywhere else
  const masterStarts = new Set<number>();
  let mi = 0;
  for (const cue of masterCues) {
    if (cue.words.length) masterStarts.add(mi);
    mi += cue.words.length;
  }
  const ownStarts = new Set(targetCues.map((c) => c.words[0]?.id));
  const breaks: number[] = [];
  for (let j = 1; j < out.length; j++) {
    if (
      prov[j] >= 0
        ? masterStarts.has(prov[j])
        : own[j] >= 0 && ownStarts.has(target[own[j]].id)
    ) {
      breaks.push(j);
    }
  }
  const cues = cuesFromBreaks(out, breaks, maxChars, maxLines);
  const posSegments = masterSegments.length
    ? applyMasterToSegments(masterWords, masterSegments, out, Int32Array.from(prov), nextPosId)
    : null;
  return {
    words: cues.flatMap((c) => c.words),
    cues,
    posSegments,
    coverage,
    inserted,
    corrected,
    missed,
  };
}
