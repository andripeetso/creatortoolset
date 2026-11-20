import type { TextLayer, TextRun, TextStyle } from "../../../contracts/design";
import { faceOf } from "./fonts";

/**
 * Parts of a text set their own way (a word in another colour, size, font or weight: contracts/design.ts TextRun),
 * kept right as the words are typed, and laid out in lines. Read by the server too (the checks and the AI's pictures):
 * nothing here touches the page.
 *
 * Every change is worked out letter by letter: the text's runs spread out to one style a letter, changed, and joined
 * up again, so a run is never left overlapping, empty, or saying what the layer says already.
 */

// (and the styles a part names: lib/design/styles.ts puts their values on it)
export const STYLE_KEYS = ["font", "weight", "italic", "size", "color", "underline", "strike", "spacing", "colorStyle", "textStyle"] as const satisfies readonly (keyof TextStyle)[];
type Key = (typeof STYLE_KEYS)[number];
/** The most runs a text keeps. */
export const RUNS_MAX = 200;

const FLAGS = new Set<Key>(["italic", "underline", "strike"]);
/** A value as it compares with another: a switch that is off, no spacing and none at all are the same. */
const plain = (k: Key, v: unknown) => (v === undefined ? (FLAGS.has(k) ? false : k === "spacing" ? 0 : undefined) : v);

/** A text whose drawing needs its runs worked out (the others are drawn as one style, as before runs were). */
export const usesRuns = (l: Pick<TextLayer, "runs" | "italic" | "underline" | "strike" | "case">): boolean => !!(l.runs?.length || l.italic || l.underline || l.strike || l.case === "small");

/** The fonts a text names: its own and its runs'. */
export const textFonts = (l: Pick<TextLayer, "font" | "runs">): string[] => [...new Set([l.font, ...(l.runs ?? []).flatMap((r) => (r.font ? [r.font] : []))])];

/** One style a letter: what each letter's runs set (null: nothing beyond the layer). */
function spread(l: Pick<TextLayer, "text" | "runs">): (TextStyle | null)[] {
  const out: (TextStyle | null)[] = new Array(l.text.length).fill(null);
  for (const r of l.runs ?? []) {
    const own = Object.fromEntries(STYLE_KEYS.flatMap((k) => (r[k] === undefined ? [] : [[k, r[k]]]))) as TextStyle;
    for (let i = Math.max(0, r.start); i < Math.min(l.text.length, r.end); i++) out[i] = { ...out[i], ...own };
  }
  return out;
}

/** Letters' styles joined up into runs: what the layer says already left out, the same styles side by side made one. */
function join(l: TextStyle, each: readonly (TextStyle | null)[]): TextRun[] | undefined {
  const out: TextRun[] = [];
  let was = "";
  each.forEach((s, i) => {
    const own: TextStyle = {};
    for (const k of STYLE_KEYS) if (s?.[k] !== undefined && plain(k, s[k]) !== plain(k, l[k])) (own as Record<string, unknown>)[k] = s[k];
    const key = JSON.stringify(own);
    if (key === "{}") return void (was = "");
    if (key === was && out.at(-1)!.end === i) out.at(-1)!.end = i + 1;
    else out.push({ start: i, end: i + 1, ...own });
    was = key;
  });
  return out.length ? out.slice(0, RUNS_MAX) : undefined;
}

/** A layer with its runs set again from letters' styles (none left: the field goes). */
function withRuns<L extends TextStyle & { runs?: TextRun[] }>(l: L, each: readonly (TextStyle | null)[]): L {
  const runs = join(l, each);
  const { runs: _, ...rest } = l;
  return (runs ? { ...rest, runs } : rest) as L;
}

/** A text's runs as they may be kept: inside the text, in order, none overlapping, none saying what the layer says. */
export const normalRuns = <L extends TextStyle & Pick<TextLayer, "text" | "runs">>(l: L): L => (l.runs ? withRuns(l, spread(l)) : l);

/**
 * The text changed in one place (`removed` letters at `at` taken out, `inserted` put there): the runs move with the
 * words. What is typed takes the style of the letter before it (at the very start, of the letter after it).
 */
export function editRuns<L extends TextLayer>(l: L, at: number, removed: number, inserted: string): L {
  const text = l.text.slice(0, at) + inserted + l.text.slice(at + removed);
  if (!l.runs?.length) return { ...l, text };
  const each = spread(l);
  const like = at > 0 ? each[at - 1]! : (each[at + removed] ?? null);
  each.splice(at, removed, ...new Array<TextStyle | null>(inserted.length).fill(like));
  return withRuns({ ...l, text }, each);
}

/**
 * Where one text became another, as one change: the letters taken out at a place and what was put there. `caret`
 * (where the caret is after it, when known) says which of two equal letters was typed: "aa" from "a" is at the end
 * when the caret is there.
 */
export function diffText(was: string, now: string, caret?: number): { at: number; removed: number; inserted: string } {
  const grow = now.length - was.length;
  if (caret !== undefined) {
    // typed (or pasted over nothing) just before the caret, or taken out just after it
    if (grow > 0 && caret >= grow && now.slice(0, caret - grow) === was.slice(0, caret - grow) && now.slice(caret) === was.slice(caret - grow)) return { at: caret - grow, removed: 0, inserted: now.slice(caret - grow, caret) };
    if (grow < 0 && now.slice(0, caret) === was.slice(0, caret) && now.slice(caret) === was.slice(caret - grow)) return { at: caret, removed: -grow, inserted: "" };
  }
  let p = 0;
  while (p < was.length && p < now.length && was[p] === now[p]) p++;
  let s = 0;
  while (s < was.length - p && s < now.length - p && was[was.length - 1 - s] === now[now.length - 1 - s]) s++;
  return { at: p, removed: was.length - p - s, inserted: now.slice(p, now.length - s) };
}

/** The text set to new words: its runs follow the change (as `editRuns`), and its ends trimmed the same way. */
export function retext<L extends TextLayer>(l: L, words: string, caret?: number): L {
  const d = diffText(l.text, words, caret);
  let out = editRuns(l, d.at, d.removed, d.inserted);
  const lead = out.text.length - out.text.trimStart().length;
  if (lead) out = editRuns(out, 0, lead, "");
  const tail = out.text.length - out.text.trimEnd().length;
  if (tail) out = editRuns(out, out.text.length - tail, tail, "");
  return out;
}

/** The style a letter is drawn in, the layer's and its run's together. */
export function styleAt(l: TextLayer, i: number): Required<Pick<TextStyle, "font" | "size" | "color">> & TextStyle {
  const own = l.runs?.length ? (spread(l)[i] ?? {}) : {};
  const out = { font: l.font, size: l.size, color: l.color } as Required<Pick<TextStyle, "font" | "size" | "color">> & TextStyle;
  for (const k of STYLE_KEYS) {
    const v = own[k] ?? l[k];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The text as a style panel shows it for letters `start` to `end`: with the style of the first of them as its own.
 * What the panel does to that is then put on those letters alone (`styleRange`).
 */
export function viewRange(l: TextLayer, start: number, end: number): TextLayer {
  if (end <= start) return l;
  const s = styleAt(l, Math.min(start, l.text.length - 1));
  const out = { ...l } as Record<string, unknown>;
  for (const k of STYLE_KEYS) {
    if (s[k] === undefined) delete out[k];
    else out[k] = s[k];
  }
  return out as unknown as TextLayer;
}

/**
 * Letters `start` to `end` set in `style`. All of the text: the style is the layer's own and no run says otherwise
 * any more (a size given to the whole text is its size). A switch off or no spacing given to the whole text takes the
 * field off.
 */
export function styleRange<L extends TextLayer>(l: L, start: number, end: number, style: TextStyle): L {
  const keys = STYLE_KEYS.filter((k) => k in style);
  if (!keys.length) return l;
  const each = spread(l);
  if (start <= 0 && end >= l.text.length) {
    const out = { ...l } as Record<string, unknown>;
    for (const k of keys) {
      const v = style[k];
      if (v === undefined || v === false || (k === "spacing" && v === 0)) delete out[k];
      else out[k] = v;
    }
    return withRuns(out as unknown as L, each.map((s) => (s ? (Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k as Key))) as TextStyle) : s)));
  }
  for (let i = Math.max(0, start); i < Math.min(l.text.length, end); i++) each[i] = { ...each[i], ...style };
  return withRuns(l, each);
}

/** What a panel's change `fn` (made to the text as `viewRange` shows it) does to letters `start` to `end`: their style there, everything else (an alignment, a box) to the whole layer. */
export function patchRange(l: TextLayer, fn: (l: TextLayer) => TextLayer, start: number, end: number): TextLayer {
  if (end <= start) return fn(l);
  const shown = viewRange(l, start, end);
  const after = fn(shown);
  const style: TextStyle = {};
  for (const k of STYLE_KEYS) if (plain(k, after[k]) !== plain(k, shown[k])) (style as Record<string, unknown>)[k] = after[k] ?? plain(k, undefined);
  const rest = { ...after } as Record<string, unknown>;
  for (const k of STYLE_KEYS) {
    if (l[k] === undefined) delete rest[k];
    else rest[k] = l[k];
  }
  return styleRange(rest as unknown as TextLayer, start, end, style);
}

/** A letter's case as drawn. `start`: it begins a word. */
function cased(ch: string, how: TextLayer["case"], start: boolean): string {
  if (how === "upper") return ch.toUpperCase();
  if (how === "lower") return ch.toLowerCase();
  if (how === "title" && start) return ch.toUpperCase();
  return ch;
}
export const caseOf = (l: Pick<TextLayer, "case" | "upper">): TextLayer["case"] => l.case ?? (l.upper ? "upper" : undefined);
/** A text's words in the case they are drawn in (small capitals aside: those are drawn as capitals, smaller). */
export function casedText(l: Pick<TextLayer, "text" | "case" | "upper">): string {
  const how = caseOf(l);
  if (!how || how === "small") return l.text;
  if (how === "upper") return l.text.toUpperCase();
  if (how === "lower") return l.text.toLowerCase();
  return l.text.replace(/(^|\s)(\S)/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

/** A piece of a line drawn in one style: its letters as drawn, its style, and its width at the size it is set at. */
export interface Piece {
  text: string;
  font: string;
  weight?: number;
  /** the face asked for and how it is drawn: its CSS font at size 1 is `${css} 1px "${family}"` */
  family: string;
  css: number;
  slant: boolean;
  size: number;
  /** its own colour; absent = the layer's fill (its colour or gradient) */
  color?: string;
  underline: boolean;
  strike: boolean;
  spacing: number;
  width: number;
}
export interface RunLine {
  pieces: Piece[];
  text: string;
  width: number;
  /** its height (the line height of its largest letters, never under the layer's) and the size of its largest letters */
  height: number;
  size: number;
}

/** The CSS font a piece is drawn in at `size`. A sign the face does not have is drawn in Inter (draw.ts fontOf). */
export const pieceFont = (p: Pick<Piece, "css" | "family">, size: number): string => `${p.css} ${size}px "${p.family}", "Inter"`;

/** What a width is measured with: a string's width in a CSS font. */
export type Measure = (font: string, s: string) => number;

/** The smallest size words are shrunk to, in pixels. */
const SMALLEST = 8;

/**
 * The scale a text is set at, for draw.ts setText and setRuns alike: 1, or (shrinking to fit, or held to a number of
 * lines, and not fitting at its own size) the largest that `fits` between SMALLEST and its own size, to a
 * four-thousandth. Held to a number of lines, a little smaller still (down to 0.92 of that) when that is enough for no
 * paragraph to end on a word alone (`orphaned`).
 */
export function fitScale(l: Pick<TextLayer, "fit" | "lines" | "size">, fits: (k: number) => boolean, orphaned: (k: number) => boolean): number {
  let k = 1;
  if ((l.fit === "shrink" || l.lines) && !fits(1)) {
    let lo = Math.min(1, SMALLEST / l.size);
    let hi = 1;
    for (let n = 0; n < 12; n++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    k = lo;
  }
  if (l.lines && orphaned(k))
    for (let s = k * 0.99; s >= k * 0.92; s -= k * 0.01)
      if (fits(s) && !orphaned(s)) return s;
  return k;
}

/** A balanced paragraph's width: the narrowest up to `width` at which it still takes no more than `lines` lines (`count` gives the lines at a width). */
export function balancedWidth(width: number, lines: number, count: (width: number) => number): number {
  let lo = 0;
  let hi = width;
  for (let n = 0; n < 10; n++) {
    const mid = (lo + hi) / 2;
    if (count(mid) <= lines) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * How a text with runs is set in its box: the size of its own letters (its runs in proportion) and its lines, each
 * piece with its style and width. Words wrap as draw.ts setText wraps them (spaces between words count once, a word
 * wider than the box stays whole), shrink to fit the same way, and balance a paragraph at a time; a line is as high as
 * its largest letters need. `measure` is called at each style's own size; the shrunk widths are in proportion.
 */
export function setRuns(l: TextLayer, measure: Measure): { size: number; scale: number; lines: RunLine[] } {
  const each = l.runs?.length ? spread(l) : [];
  const how = caseOf(l);
  const lh = l.lineHeight ?? 1.15;
  const memo = new Map<string, number>();
  const wide = (font: string, s: string) => {
    const key = `${font}\u0000${s}`;
    let w = memo.get(key);
    if (w === undefined) memo.set(key, (w = measure(font, s)));
    return w;
  };
  // the text as words, each a list of pieces at the layer's own size, and the space after it; a paragraph a list of words
  type Word = { pieces: Piece[]; gap: Piece | null };
  const paras: Word[][] = [[]];
  let word: Piece[] = [];
  const pieceFor = (i: number, ch: string): Piece => {
    const own = each[i] ?? {};
    const font = own.font ?? l.font;
    const weight = own.weight ?? l.weight;
    const face = faceOf(font, weight, own.italic ?? l.italic);
    const small = how === "small" && ch !== ch.toUpperCase();
    const size = (own.size ?? l.size) * (small ? 0.72 : 1);
    return { text: small ? ch.toUpperCase() : ch, font, weight, family: face.family, css: face.css, slant: face.slant, size, color: own.color, underline: !!(own.underline ?? l.underline), strike: !!(own.strike ?? l.strike), spacing: own.spacing ?? l.spacing ?? 0, width: 0 };
  };
  const same = (a: Piece, b: Piece) => a.family === b.family && a.css === b.css && a.slant === b.slant && a.size === b.size && a.color === b.color && a.underline === b.underline && a.strike === b.strike && a.spacing === b.spacing;
  const endWord = (gap: Piece | null) => {
    if (word.length) paras.at(-1)!.push({ pieces: word, gap });
    else if (gap && paras.at(-1)!.length) paras.at(-1)!.at(-1)!.gap ??= gap;
    word = [];
  };
  const chars = Array.from(l.text);
  let i = 0;
  let start = true;
  for (const ch of chars) {
    if (ch === "\n") {
      endWord(null);
      paras.push([]);
      start = true;
    } else if (ch === " " || ch === "\t") {
      // spaces between words count once, in the style of the first
      endWord(pieceFor(i, " "));
      start = true;
    } else {
      const p = pieceFor(i, cased(ch, how, start));
      const last = word.at(-1);
      if (last && same(last, p)) last.text += p.text;
      else word.push(p);
      start = false;
    }
    i += ch.length;
  }
  endWord(null);
  // widths at the layer's own size: with letters spaced apart each letter is measured by itself, as it is drawn
  const glyphs = (p: Piece) => (p.spacing ? Array.from(p.text).reduce((n, ch) => n + wide(pieceFont(p, p.size), ch), 0) : wide(pieceFont(p, p.size), p.text));
  for (const para of paras) for (const w of para) for (const p of [...w.pieces, ...(w.gap ? [w.gap] : [])]) p.width = glyphs(p);
  const letters = (p: Piece) => Array.from(p.text).length;
  const widthOf = (p: Piece, k: number) => p.width * k + p.spacing * letters(p);
  const wordWidth = (w: Word, k: number) => w.pieces.reduce((n, p) => n + widthOf(p, k), 0);
  // a line's width leaves out the spacing after its last letter
  const lineWidth = (ws: Word[], k: number) => {
    if (!ws.length) return 0;
    const lastPiece = ws.at(-1)!.pieces.at(-1)!;
    return ws.reduce((n, w, j) => n + wordWidth(w, k) + (j < ws.length - 1 && w.gap ? widthOf(w.gap, k) : 0), 0) - lastPiece.spacing;
  };
  const wrap = (para: Word[], width: number, k: number): Word[][] => {
    const out: Word[][] = [];
    let line: Word[] = [];
    for (const w of para) {
      if (line.length && lineWidth([...line, w], k) > width) {
        out.push(line);
        line = [w];
      } else line.push(w);
    }
    out.push(line);
    return out;
  };
  const sizeOfLine = (ws: Word[]) => Math.max(l.size, ...ws.flatMap((w) => w.pieces.map((p) => p.size)));
  const linesAt = (k: number) => paras.flatMap((p) => wrap(p, l.w, k));
  const fits = (k: number) => {
    const lines = linesAt(k);
    return lines.reduce((n, ws) => n + sizeOfLine(ws) * lh * k, 0) <= l.h + 0.5 && lines.every((ws) => lineWidth(ws, k) <= l.w + 0.5) && (!l.lines || lines.length <= l.lines);
  };
  // held to a number of lines: no word alone on a paragraph's last line
  const orphaned = (at: number) => paras.some((para) => {
    const ls = wrap(para, l.w, at);
    return ls.length > 1 && ls.at(-1)!.length === 1;
  });
  const k = fitScale(l, fits, orphaned);
  const words = paras.flatMap((para) => {
    let out = wrap(para, l.w, k);
    if (l.balance && out.length > 1) out = wrap(para, balancedWidth(l.w, out.length, (width) => wrap(para, width, k).length), k);
    // still alone: the word before it comes down to keep it company, when the two fit the width together
    const last = out.at(-1)!;
    const before = out.at(-2);
    if (l.lines && last.length === 1 && before && before.length > 1 && lineWidth([before.at(-1)!, ...last], k) <= l.w + 0.5) out = [...out.slice(0, -2), before.slice(0, -1), [before.at(-1)!, ...last]];
    return out;
  });
  const lines = words.map((ws): RunLine => {
    // pieces at the size they are drawn at, the space between words among them
    const pieces = ws.flatMap((w, j) => [...w.pieces, ...(j < ws.length - 1 && w.gap ? [w.gap] : [])]).map((p) => ({ ...p, size: p.size * k, width: widthOf(p, k) }));
    const size = sizeOfLine(ws) * k;
    return { pieces, text: pieces.map((p) => p.text).join(""), width: lineWidth(ws, k), height: size * lh, size };
  });
  return { size: Math.round(l.size * k * 100) / 100, scale: k, lines };
}
