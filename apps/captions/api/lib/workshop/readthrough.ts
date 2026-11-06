import type { Document } from "./types";
import { INSTAGRAM_CAPTION_MAX } from "./doc";

/**
 * The read-through: after a turn edits a piece, code reads
 * the whole of it for what the model never checks: the same opening on two
 * sentences in a row (across slides too), a phrase said twice on different
 * slides, slides far longer than the author's posted carousels' slides, and more
 * clipped fragments than the author writes. Measurements, not rules: the notes go
 * under the turn and the writer reads them next turn.
 */

/** The author's posted carousels' slides (on-screen text) and the author's posted captions: the yardstick for length and rhythm. */
export interface HisSlides {
  slides: string[];
  captions?: string[];
}

const STOP = new Set("a an and are as at be but by for from has have he her his i if in into is it its just of on or our so that the their them then there they this to was we what when which who will with you your".split(" "));
const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const sentences = (s: string) => s.split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter((x) => words(x).length);
/** A sentence this short, twice in a row, reads clipped ("Fine for the bus. Not the whole trip.", "Reaching for a cup and missing."). */
const CLIPPED = 6;
/** Clipped: very short, or an -ing fragment with no subject ("Leaning on one arm and tipping over."). */
const clipped = (s: string) => words(s).length <= CLIPPED || (/^[A-Z][a-z]+ing\b/.test(s.trim()) && !/\b(i|you|we|they|he|she|it|is|are|was|were)\b/i.test(s));
const opening = (s: string) => words(s).slice(0, 2).join(" ");
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

export function readThrough(doc: Pick<Document, "kind" | "blocks"> & Partial<Pick<Document, "caption">>, his?: HisSlides): string[] {
  if (doc.kind === "notes" || !doc.blocks.length) return [];
  const unit = doc.kind === "carousel" ? "slide" : "part";
  const label = (i: number) => (doc.blocks.length > 1 ? `${unit} ${i + 1}` : "the script");
  const notes: string[] = [];

  // the same two opening words on two sentences in a row, wherever they fall
  const seq = doc.blocks.flatMap((b, i) => sentences(b.text).map((text) => ({ text, at: i })));
  for (let k = 1; k < seq.length; k++) {
    const a = seq[k - 1]!;
    const b = seq[k]!;
    const o = opening(b.text);
    if (o.split(" ").length === 2 && o === opening(a.text)) {
      const where = a.at === b.at ? label(a.at) : `the end of ${label(a.at)} and the start of ${label(b.at)}`;
      notes.push(`Two sentences in a row open with "${o}" (${where}).`);
    }
  }

  // two clipped sentences in a row ("Fine for the bus. Not the whole trip."): the author lets sentences run
  doc.blocks.forEach((b, i) => {
    const ss = sentences(b.text);
    for (let k = 1; k < ss.length; k++) {
      if (clipped(ss[k - 1]!) && clipped(ss[k]!) && /[.!?…]$/.test(ss[k - 1]!.trim())) {
        notes.push(`Two clipped sentences in a row on ${label(i)}: "${ss[k - 1]} ${ss[k]}"`);
        break;
      }
    }
  });

  // a four-word phrase said again on another slide
  const seen = new Map<string, number>();
  const repeats: string[] = [];
  doc.blocks.forEach((b, i) => {
    const w = words(b.text);
    const mine = new Set<string>();
    for (let k = 0; k + 4 <= w.length; k++) {
      const g = w.slice(k, k + 4);
      if (g.every((x) => STOP.has(x))) continue;
      const key = g.join(" ");
      if (mine.has(key)) continue;
      mine.add(key);
      const first = seen.get(key);
      if (first === undefined) seen.set(key, i);
      else if (first !== i && repeats.length < 3 && !repeats.some((r) => r.includes(key))) repeats.push(`"${key}" (${label(first)} and ${label(i)})`);
    }
  });
  if (repeats.length) notes.push(`Said twice: ${repeats.join(", ")}.`);

  // against the author's own posted carousels
  const hisSlides = (his?.slides ?? []).filter((s) => words(s).length);
  if (doc.kind === "carousel" && hisSlides.length >= 8) {
    const lengths = hisSlides.map((s) => words(s).length);
    const long = quantile(lengths, 0.9);
    const over = doc.blocks.map((b, i) => ({ i, n: words(b.text).length })).filter((x) => x.n > long * 1.25);
    if (over.length) {
      notes.push(`Longer than your posted slides (most run ${quantile(lengths, 0.25)}–${quantile(lengths, 0.75)} words, ${long} at most): ${over.map((x) => `${label(x.i)} has ${x.n}`).join(", ")}.`);
    }
    const short = (texts: string[]) => {
      const s = texts.flatMap(sentences);
      return s.length ? s.filter((x) => words(x).length <= 4).length / s.length : 0;
    };
    const mineShare = short(hisSlides);
    const pieceShare = short(doc.blocks.map((b) => b.text));
    if (pieceShare >= 0.25 && pieceShare >= mineShare * 2) {
      notes.push(`${Math.round(pieceShare * 100)}% of the sentences are four words or fewer; in your posted carousels it's ${Math.round(mineShare * 100)}%.`);
    }
  }
  const caption = doc.caption?.text ?? "";
  if (caption.length > INSTAGRAM_CAPTION_MAX) {
    notes.push(`The post description is ${caption.length.toLocaleString("en-US")} characters; Instagram cuts captions at ${INSTAGRAM_CAPTION_MAX.toLocaleString("en-US")}.`);
  } else {
    const theirs = (his?.captions ?? []).map((c) => c.length).filter((n) => n > 0);
    if (theirs.length >= 20 && caption.length > quantile(theirs, 0.9)) {
      notes.push(`The post description is ${caption.length.toLocaleString("en-US")} characters; your posted captions run about ${quantile(theirs, 0.5).toLocaleString("en-US")}, and 9 in 10 are under ${quantile(theirs, 0.9).toLocaleString("en-US")}.`);
    }
  }
  if (caption) {
    // a recap: the description retelling the slides in their own words
    const grams = (t: string) => {
      const w = words(t);
      const out = new Set<string>();
      for (let k = 0; k + 4 <= w.length; k++) if (!w.slice(k, k + 4).every((x) => STOP.has(x))) out.add(w.slice(k, k + 4).join(" "));
      return out;
    };
    const mineG = grams(caption);
    const slideG = grams(doc.blocks.map((b) => b.text).join("\n"));
    const shared = [...mineG].filter((g) => slideG.has(g)).length;
    if (mineG.size >= 10 && shared / mineG.size >= 0.25) notes.push(`About ${Math.round((shared / mineG.size) * 100)}% of the post description repeats the slides' own wording.`);
    const cs = sentences(caption);
    for (let k = 1; k < cs.length; k++) {
      if (clipped(cs[k - 1]!) && clipped(cs[k]!) && /[.!?…]$/.test(cs[k - 1]!.trim())) {
        notes.push(`Two clipped sentences in a row in the post description: "${cs[k - 1]} ${cs[k]}"`);
        break;
      }
    }
  }
  return notes;
}

