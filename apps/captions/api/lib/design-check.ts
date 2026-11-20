import { DESIGN_ADJUST, DESIGN_BLENDS, DESIGN_BOOLEANS, DESIGN_EFFECTS, DESIGN_MASKS, DESIGN_GAP, DESIGN_GRADIENTS, DESIGN_HEADS, DESIGN_LIMITS, DESIGN_PICTURE_MODES, DESIGN_PINS_X, DESIGN_PINS_Y, DESIGN_SHAPES, EFFECTS_MAX, INSTANCE_FIXED, INSTANCE_FROM_MAIN, DESIGN_FLOW_ALIGNS, DESIGN_SIZINGS, type AutoLayout, type DesignPage, type Sizing, type Effect, type Pin, type Gradient, type GroupLayer, type ImageLayer, type Layer, type Paint, type PaintLook, type Radius, type Stroke, type TextLayer, type TextRun, type TextStyle } from "../../contracts/design";
import { splitSlideAreas } from "../../src/lib/carousel-visualize";
import { DESIGN_FONTS } from "../../src/lib/design/fonts";
import { normalRuns, RUNS_MAX } from "../../src/lib/design/runs";
import { guessWidth, layoutLayers } from "../../src/lib/design/layout";
import type { Measure } from "../../src/lib/design/runs";
import { everyLayer } from "../../src/lib/design/tree";
import { fillsOf, strokesOf } from "../../src/lib/design/paint";
import { PICTURE_TOKEN } from "../../src/lib/workshop-markdown";
import { cleanAids } from "./design-aids";

/**
 * A design's pages, checked. Whatever sends them (the person's own changes, or their AI's answer), every value is
 * read as data and brought inside what a page can hold: a number out of range is moved to the nearest one in it, a
 * colour or font the app does not have becomes one it has, and a layer that cannot be drawn is left out with a note.
 * Nothing here runs anything: a drawing is SVG shapes only (safeSvg).
 */

const FONTS = DESIGN_FONTS.map((f) => f.family);
export const DEFAULT_FONT = "Inter";
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ID = /^[a-z0-9-]{1,24}$/;
/** A layer's id: an instance's layers are `<instance id>.<main layer id>` (lib/design/components.ts), so ids may have parts. */
const LAYER_ID = /^[a-z0-9-]{1,24}(\.[a-z0-9-]{1,24}){0,5}$/;
/** A main component's key, what an instance's "of" names. */
const KEY = /^[\w-]{1,40}$/;
/** A component property's or a variant property's name. */
const propName = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 40) : "");

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, or: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : or);
const color = (v: unknown, or: string): string => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim().toLowerCase() : or);
/** A colour as "#rrggbb": three digits written out, a see-through part dropped. */
const sixDigits = (c: string): string => (c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c.slice(0, 7));
const oneOf = <T extends string>(v: unknown, all: readonly T[], or: T): T => (all.includes(v as T) ? (v as T) : or);
const round = (n: number) => Math.round(n * 100) / 100;
/** A name as one line of at most the limit's letters, or "" when there is none. */
const named = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, DESIGN_LIMITS.layerName) : "");

/** A gradient as it may be saved (its colour "#rrggbb", its angle in a full turn), or nothing when it is none. */
const gradient = (v: unknown): { gradient?: Gradient } =>
  obj(v) && typeof v.to === "string" && COLOR.test(v.to.trim())
    ? { gradient: { to: sixDigits(color(v.to, "#000000")), angle: round(num(v.angle, -360, 360, 90)), ...(v.kind === "radial" ? { kind: "radial" as const } : {}), ...(typeof v.via === "string" && COLOR.test(v.via.trim()) ? { via: sixDigits(color(v.via, "#000000")) } : {}) } }
    : {};

/** A corner radius as it may be saved: one number, or four (one a corner) when they differ; nothing when it is none. */
const corners = (v: unknown): { radius?: Radius } => {
  if (Array.isArray(v) && v.length === 4) {
    const r = v.map((n) => round(num(n, 0, 2000, 0))) as [number, number, number, number];
    return r.every((n) => n === r[0]) ? (r[0] ? { radius: r[0] } : {}) : { radius: r };
  }
  const r = round(num(v, 0, 2000, 0));
  return r ? { radius: r } : {};
};

/** What a paint or a line of a list has beside itself: hidden, how see-through (absent when solid), how it mixes. */
const paintLook = (v: Record<string, unknown>): PaintLook => ({
  ...(v.hidden === true ? { hidden: true } : {}),
  ...(typeof v.opacity === "number" && v.opacity < 1 ? { opacity: round(num(v.opacity, 0, 1, 1)) } : {}),
  ...(DESIGN_BLENDS.includes(v.blend as never) ? { blend: v.blend as (typeof DESIGN_BLENDS)[number] } : {}),
});

/** What a shape's line has beside its colour and width: dashes (with a gap, or they are none), its ends and corners, a side, a width a side, heads, and how it looks in its list. */
const strokeMore = (v: unknown, max = 200): Partial<Stroke> => {
  if (!obj(v)) return {};
  const dash = Array.isArray(v.dash) && v.dash.length === 2 ? ([round(num(v.dash[0], 0, 2000, 0)), round(num(v.dash[1], 0, 2000, 0))] as [number, number]) : null;
  const sides = Array.isArray(v.sides) && v.sides.length === 4 ? (v.sides.map((n) => round(num(n, 0, max, 0))) as [number, number, number, number]) : null;
  return {
    ...(dash && dash[1] > 0 ? { dash } : {}),
    ...(v.round === true ? { round: true } : {}),
    ...(v.side === "inside" || v.side === "outside" ? { side: v.side } : {}),
    ...(sides?.some((n) => n > 0) ? { sides } : {}),
    ...(v.cap === "butt" || v.cap === "round" || v.cap === "square" ? { cap: v.cap } : {}),
    ...(v.join === "miter" || v.join === "round" || v.join === "bevel" ? { join: v.join } : {}),
    ...(DESIGN_HEADS.includes(v.start as never) ? { start: v.start as Stroke["start"] } : {}),
    ...(DESIGN_HEADS.includes(v.end as never) ? { end: v.end as Stroke["end"] } : {}),
    ...paintLook(v),
  };
};

/** A layer's or a frame's lines as they may be saved (`strokes`, bottom first): each with a width (or a width a side), at most the limit's count. Absent when none was given; an empty list stays: no line at all. */
function strokeList(v: unknown, max: number): { strokes?: Stroke[] } {
  if (!Array.isArray(v)) return {};
  const strokes = v
    .filter(obj)
    .slice(0, DESIGN_LIMITS.paints)
    .flatMap((s): Stroke[] => {
      const more = strokeMore(s, max);
      const width = round(num(s.width, 0, max, 0));
      return width > 0 || more.sides ? [{ color: color(s.color, "#000000"), width, ...more }] : [];
    });
  return { strokes };
}

/**
 * A layer's or a frame's fills as they may be saved (`fills`, bottom first): a colour, a gradient of two or more stops
 * (any number up to the limit, each at 0 to 1), or a picture of the design's own, at most the limit's count. Absent
 * when none was given; an empty list stays: no fill at all.
 */
function fillList(v: unknown, r: PageRules, say: (why: string) => void): { fills?: Paint[] } {
  if (!Array.isArray(v)) return {};
  const fills = v
    .filter(obj)
    .slice(0, DESIGN_LIMITS.paints)
    .flatMap((p): Paint[] => {
      const look = paintLook(p);
      if (p.type === "gradient") {
        const stops = (Array.isArray(p.stops) ? p.stops : [])
          .filter(obj)
          .slice(0, DESIGN_LIMITS.stops)
          .map((x) => ({ at: round(num(x.at, 0, 1, 0)), color: color(x.color, "#000000") }))
          .sort((a, b) => a.at - b.at);
        if (stops.length < 2) {
          say("a gradient fill with fewer than two colours: left out");
          return [];
        }
        const kind = DESIGN_GRADIENTS.includes(p.kind as never) && p.kind !== "linear" ? { kind: p.kind as Exclude<(typeof DESIGN_GRADIENTS)[number], "linear"> } : {};
        return [{ type: "gradient", ...kind, angle: round(num(p.angle, -360, 360, 90)), stops, ...look }];
      }
      if (p.type === "image") {
        if (typeof p.picture !== "string" || !r.pictures.includes(p.picture)) {
          say("a picture fill of a picture that is not in this design: left out");
          return [];
        }
        const mode = oneOf(p.mode, DESIGN_PICTURE_MODES, "fill");
        const c = obj(p.crop) ? p.crop : null;
        // a crop is a part of the picture: at least a hundredth of it each way, and inside it
        const cw = c ? round(num(c.w, 0.01, 1, 1)) : 1;
        const ch = c ? round(num(c.h, 0.01, 1, 1)) : 1;
        const crop = c && mode === "crop" ? { crop: { x: round(num(c.x, 0, 1 - cw, 0)), y: round(num(c.y, 0, 1 - ch, 0)), w: cw, h: ch } } : {};
        const scale = mode === "tile" && typeof p.scale === "number" ? { scale: round(num(p.scale, 0.02, 4, 0.25)) } : {};
        return [{ type: "image", picture: p.picture, mode, ...crop, ...scale, ...look }];
      }
      return typeof p.color === "string" ? [{ type: "solid", color: color(p.color, "#000000"), ...look }] : [];
    });
  return { fills };
}

/** Corners rounded smoothly into the sides, 0 to 1; nothing when it is none. */
const smoothed = (v: unknown): { smooth?: number } => (round(num(v, 0, 1, 0)) ? { smooth: round(num(v, 0, 1, 0)) } : {});

/**
 * A text's style beside its font, size and colour as it may be saved: a weight in hundreds, switches, a size and
 * spacing in range. `run`: a run's, which may also set a font, size and colour, and a switch off (the layer's is on).
 */
function textStyle(v: Record<string, unknown>, fonts: readonly string[], run: boolean): TextStyle {
  const out: TextStyle = {};
  if (typeof v.weight === "number" && Number.isFinite(v.weight)) out.weight = Math.round(num(v.weight, 100, 900, 400) / 100) * 100;
  for (const k of ["italic", "underline", "strike"] as const) if (v[k] === true || (run && v[k] === false)) out[k] = v[k] as boolean;
  if (!run) return out;
  if (typeof v.font === "string" && fonts.includes(v.font)) out.font = v.font;
  if (typeof v.size === "number") out.size = round(num(v.size, 8, 600, 48));
  if (typeof v.color === "string" && COLOR.test(v.color.trim())) out.color = sixDigits(color(v.color, "#111111"));
  if (typeof v.spacing === "number") out.spacing = round(num(v.spacing, -20, 200, 0));
  return out;
}

/**
 * A text's runs as they may be saved: each from a letter to a letter of the text (`start`, `end`), or every place a
 * phrase of it is in (`words`, as a highlighter's), with a style that says something. Put in order and joined up after.
 */
function textRuns(v: unknown, text: string, fonts: readonly string[]): { runs?: TextRun[] } {
  const out: TextRun[] = [];
  const lower = fold(text);
  // runs are worked out a letter each after this (normalRuns): letters past twice the text's are overlaps of overlaps, left out so one text cannot cost millions of copies
  let room = 2 * text.length;
  const keep = (start: number, end: number, style: TextStyle): boolean => {
    room -= end - start;
    if (room < 0) return false;
    out.push({ start, end, ...style });
    return true;
  };
  for (const r of (Array.isArray(v) ? v : []).filter(obj).slice(0, RUNS_MAX)) {
    const style = textStyle(r, fonts, true);
    if (!Object.keys(style).length) continue;
    const words = typeof r.words === "string" ? fold(r.words) : "";
    if (words) for (let at = lower.indexOf(words); at >= 0 && keep(at, at + words.length, style); at = lower.indexOf(words, at + words.length));
    else if (typeof r.start === "number" && typeof r.end === "number") {
      const start = Math.round(num(r.start, 0, text.length, 0));
      const end = Math.round(num(r.end, 0, text.length, 0));
      if (end > start) keep(start, end, style);
    }
    if (room < 0) break;
  }
  return out.length ? { runs: out } : {};
}

/** Lower case letter by letter, a letter whose lower case is longer ("İ") kept as it is: every place in it is the same place in the text. */
// a final sigma folds to σ like any sigma (both one unit long): "ΟΔΟΣ" lowers to "οδοσ" letter by letter, words say "οδος"
const fold = (s: string): string => Array.from(s, (ch) => (ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch)).join("").replace(/ς/g, "σ");

/** A text's highlighter strokes as they may be saved: a few, each a colour and (or not) the words it goes behind. */
function marks(v: unknown): { marks?: { color: string; words?: string; low?: true }[] } {
  const list = (Array.isArray(v) ? v : [])
    .filter(obj)
    .slice(0, DESIGN_LIMITS.marks)
    .map((m) => {
      const words = typeof m.words === "string" ? m.words.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      return { color: sixDigits(color(m.color, "#f2b63c")), ...(words ? { words } : {}), ...(m.low === true ? { low: true as const } : {}) };
    });
  return list.length ? { marks: list } : {};
}

/** A layer's sizing, least and most size and place out of an auto layout's flow, as given (cleanPages keeps each only where it applies). */
function sizes(raw: Record<string, unknown>, r: { w: number; h: number }) {
  const side = (v: unknown, ax: "w" | "h") => (typeof v === "number" && Number.isFinite(v) ? round(num(v, 0, 2 * r[ax], 0)) : undefined);
  const pair = (v: unknown) => {
    const w = obj(v) ? side(v.w, "w") : undefined;
    const h = obj(v) ? side(v.h, "h") : undefined;
    return w === undefined && h === undefined ? undefined : { ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}) };
  };
  const min = pair(raw.min);
  // a most below the least is the least
  // a most of nothing is none (a layer 0 wide is no layer)
  const given = pair(raw.max);
  const most = given && Object.fromEntries(Object.entries(given).filter(([, n]) => n! > 0));
  const max = most && (most.w !== undefined || most.h !== undefined) ? { ...(most.w !== undefined ? { w: Math.max(most.w, min?.w ?? 0) } : {}), ...(most.h !== undefined ? { h: Math.max(most.h, min?.h ?? 0) } : {}) } : undefined;
  const sw = obj(raw.sizing) && DESIGN_SIZINGS.includes(raw.sizing.w as Sizing) ? (raw.sizing.w as Sizing) : undefined;
  const sh = obj(raw.sizing) && DESIGN_SIZINGS.includes(raw.sizing.h as Sizing) ? (raw.sizing.h as Sizing) : undefined;
  return {
    ...(sw || sh ? { sizing: { ...(sw ? { w: sw } : {}), ...(sh ? { h: sh } : {}) } } : {}),
    ...(min ? { min } : {}),
    ...(max ? { max } : {}),
    ...(raw.absolute === true ? { absolute: true as const } : {}),
  };
}

/** A box's auto layout as given, every number held to what can be drawn; null when it names no direction. */
function autoLayout(v: unknown): AutoLayout | null {
  if (!obj(v) || (v.dir !== "row" && v.dir !== "column")) return null;
  const pad = Array.isArray(v.pad) && v.pad.length === 4 ? (v.pad.map((n) => round(num(n, 0, 2000, 0))) as [number, number, number, number]) : typeof v.pad === "number" ? round(num(v.pad, 0, 2000, 0)) : 0;
  const gap = round(num(v.gap, -2000, 2000, 0));
  const lineGap = typeof v.lineGap === "number" ? round(num(v.lineGap, -2000, 2000, 0)) : undefined;
  return {
    dir: v.dir,
    ...(gap ? { gap } : {}),
    ...(v.between === true ? { between: true as const } : {}),
    ...(pad ? { pad } : {}),
    ...(DESIGN_FLOW_ALIGNS.includes(v.align as never) && v.align !== "start" ? { align: v.align as AutoLayout["align"] } : {}),
    ...(DESIGN_FLOW_ALIGNS.includes(v.cross as never) && v.cross !== "start" ? { cross: v.cross as AutoLayout["cross"] } : {}),
    ...(v.wrap === true ? { wrap: true as const } : {}),
    ...(lineGap !== undefined ? { lineGap } : {}),
  };
}

/** A layer's pin as it may be saved: each side one of its own words, and none when neither is. */
function pin(v: unknown): { pin?: Pin } {
  if (!obj(v)) return {};
  const x = DESIGN_PINS_X.find((p) => p === v.x);
  const y = DESIGN_PINS_Y.find((p) => p === v.y);
  return x || y ? { pin: { ...(x ? { x } : {}), ...(y ? { y } : {}) } } : {};
}

/** A layer's effects as they may be saved: a few known ones, each with its numbers in range; none when the list is empty. */
function effectList(v: unknown[]): { effects?: Effect[] } {
  const list = v
    .filter(obj)
    .filter((e) => DESIGN_EFFECTS.includes(e.type as never))
    .slice(0, EFFECTS_MAX)
    .map((e): Effect => {
      const hidden = e.hidden === true ? { hidden: true as const } : {};
      const blur = round(num(e.blur, 0, 200, 24));
      if (e.type === "shadow" || e.type === "inner-shadow") {
        const spread = round(num(e.spread, -200, 200, 0));
        return { type: e.type as "shadow" | "inner-shadow", color: sixDigits(color(e.color, "#000000")), opacity: round(num(e.opacity, 0, 1, 0.35)), blur: round(num(e.blur, 0, 400, 24)), x: round(num(e.x, -1000, 1000, 0)), y: round(num(e.y, -1000, 1000, 8)), ...(spread ? { spread } : {}), ...hidden };
      }
      if (e.type === "progressive-blur") return { type: "progressive-blur", blur, from: round(num(e.from, 0, 1, 0.5)), to: round(num(e.to, 0, 1, 1)), angle: round(num(e.angle, -360, 360, 90)), ...hidden };
      if (e.type === "noise") {
        const size = round(num(e.size, 1, 20, 1));
        return { type: "noise", amount: Math.round(num(e.amount, 1, 100, 12)), ...(size !== 1 ? { size } : {}), ...hidden };
      }
      return { type: e.type as "blur" | "background-blur", blur, ...hidden };
    });
  return list.length ? { effects: list } : {};
}

/** A frame's finish as it may be saved: a whole number each in its range, and none when it is 0. */
function finish(raw: Record<string, unknown>): Pick<DesignPage, "grain" | "vignette"> {
  const grain = Math.round(num(raw.grain, 0, 100, 0));
  const vignette = Math.round(num(raw.vignette, -100, 100, 0));
  return { ...(grain ? { grain } : {}), ...(vignette ? { vignette } : {}) };
}

/** A picture's colour changes as they may be saved: each one named, a whole number in its range, and none at all when every one is 0. */
function retouched(raw: Record<string, unknown>): Pick<ImageLayer, "adjust" | "duotone" | "vignette" | "grain" | "blur"> {
  const whole = (v: unknown, lo: number, hi: number) => Math.round(num(v, lo, hi, 0));
  const adjust = Object.fromEntries(DESIGN_ADJUST.map((k) => [k, obj(raw.adjust) ? whole(raw.adjust[k], -100, 100) : 0] as const).filter(([, v]) => v));
  const two = obj(raw.duotone) && typeof raw.duotone.dark === "string" && typeof raw.duotone.light === "string" && COLOR.test(raw.duotone.dark.trim()) && COLOR.test(raw.duotone.light.trim()) ? raw.duotone : null;
  return {
    ...(Object.keys(adjust).length ? { adjust } : {}),
    ...(two ? { duotone: { dark: sixDigits(color(two.dark, "#000000")), light: sixDigits(color(two.light, "#ffffff")) } } : {}),
    ...(whole(raw.vignette, -100, 100) ? { vignette: whole(raw.vignette, -100, 100) } : {}),
    ...(whole(raw.grain, 0, 100) ? { grain: whole(raw.grain, 0, 100) } : {}),
    ...(whole(raw.blur, 0, 200) ? { blur: whole(raw.blur, 0, 200) } : {}),
  };
}

/** A group's id as it is kept: lower case letters, digits and hyphens, at most 24. What a person or an AI called it is brought to that ("Hero_Badge" → "hero-badge"), so two layers given the same name are still one group; "" when nothing is left. */
const groupId = (v: unknown): string => (typeof v === "string" ? v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/, "") : "");

/** A span moved inside 0..page, and cut to the page when it is longer than it. */
const inside = (at: number, size: number, page: number): [number, number] => (size >= page ? [0, page] : [Math.min(Math.max(at, 0), page - size), size]);

/** Letters and digits only, lower case, one space between words: what "the same words" is compared on. */
export const plainWords = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Whether a text's words are a run of a page's own words, whole words: not a part of one, not letters out of two. */
export const inWords = (own: string, text: string): boolean => ` ${plainWords(own)} `.includes(` ${plainWords(text)} `);
/** A slide's text as words alone: its picture tokens taken out. */
export const slideWords = (text: string): string => text.replace(PICTURE_TOKEN, " ").replace(/[ \t]+\n/g, "\n").trim();

/** What a drawing may be made of: shapes, groups, gradients, clip paths and masks. Nothing that holds words, a picture, a link, a style sheet or a script. */
const SVG_ELEMENTS = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask"]);
const SVG_ATTRS = new Set(
  "id d x y x1 y1 x2 y2 cx cy r rx ry fx fy width height points viewBox fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-miterlimit stroke-opacity fill-opacity fill-rule clip-rule opacity transform gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity clip-path mask clipPathUnits maskUnits maskContentUnits preserveAspectRatio vector-effect paint-order".split(
    " ",
  ),
);
/** A number, a colour, a path, a transform or a keyword: letters, digits and the few signs those are written with. No address, no escape, nothing to decode. */
const SVG_VALUE = /^[\w\s#.,()%+-]*$/;
/** The one reference a value may hold: to something inside the same drawing. */
const SVG_REF = /^url\(#[\w-]+\)$/;
const SVG_REFS = new Set(["fill", "stroke", "clip-path", "mask"]);
const SVG_TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>|([^<]+)/y;
const SVG_ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const SVG_MAX = { elements: 1500, depth: 24 } as const;

/**
 * A drawing's markup, written again from the parts of it that are known to be shapes, or null when it is not a
 * drawing. Only the elements and attributes named above are kept, each value only when it can be nothing but a
 * number, a colour, a path or a keyword; an attribute that is anything else (a handler, a link, a class) is left out,
 * and a style attribute's own declarations are kept the same way. An element that is not a shape, words between the
 * shapes, a reference to anything outside the drawing, or markup that cannot be read part by part refuses the whole
 * drawing. What comes out is built here, so nothing passes by being written in a way the check did not think of.
 */
export function safeSvg(svg: unknown): string | null {
  if (typeof svg !== "string" || svg.length > DESIGN_LIMITS.svg) return null;
  // a comment and the XML line on top say nothing that is drawn
  const s = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*<\?xml[^>]*\?>/, "").trim();
  const open: string[] = [];
  let out = "";
  let at = 0;
  let count = 0;
  let done = false;
  while (at < s.length) {
    SVG_TAG.lastIndex = at;
    const m = SVG_TAG.exec(s);
    if (!m) return null;
    at = SVG_TAG.lastIndex;
    if (m[5] !== undefined) {
      if (m[5].trim()) return null;
      continue;
    }
    const name = m[2]!;
    if (!SVG_ELEMENTS.has(name) || done) return null;
    if (m[1]) {
      if (m[3] || m[4] || open.pop() !== name) return null;
      out += `</${name}>`;
      done = !open.length;
      continue;
    }
    // one drawing: the root is the only svg
    if ((name === "svg") !== (open.length === 0)) return null;
    if (++count > SVG_MAX.elements || open.length >= SVG_MAX.depth) return null;
    const kept = new Map<string, string>();
    const keep = (key: string, raw: string): boolean => {
      const value = raw.trim();
      if (/url\s*\(/i.test(value) && !(SVG_REF.test(value) && SVG_REFS.has(key))) return false;
      if (SVG_ATTRS.has(key) && !kept.has(key) && SVG_VALUE.test(value)) kept.set(key, value);
      return true;
    };
    for (const a of m[3]!.matchAll(SVG_ATTR)) {
      const raw = a[2] ?? a[3] ?? "";
      const parts = a[1] === "style" ? raw.split(";").map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1)] as const) : [[a[1]!, raw] as const];
      for (const [key, value] of parts) if (!keep(key, value)) return null;
    }
    if (name === "svg" && !/^[\d\s.,+-]+$/.test(kept.get("viewBox") ?? "")) return null;
    out += `<${name}${name === "svg" ? ' xmlns="http://www.w3.org/2000/svg"' : ""}${[...kept].map(([k, v]) => ` ${k}="${v}"`).join("")}${m[4] ? "/" : ""}>`;
    if (m[4]) done = !open.length;
    else open.push(name);
  }
  return done && !open.length ? out : null;
}

export interface PageRules {
  /** a frame's size when it gives none of its own */
  w: number;
  h: number;
  /** the pictures a layer may show: the ids in the design's folder */
  pictures: readonly string[];
  /**
   * The fonts a text may be set in beside the app's own: the person's own, and the ones the design's words are set in
   * already (a font of theirs that was taken away stays named in its layers, and is drawn again once it is back).
   */
  fonts?: readonly string[];
  /**
   * For an AI's answer: each frame's own words (its slide's text), in the frames' order. A text layer that says
   * anything else is left out: where the words go and how they look is the design, what they are is the author's.
   * A frame with none here (undefined: it is no slide) may say anything.
   */
  words?: readonly (string | undefined)[];
  /**
   * What a text's words are measured with to lay out its auto layout boxes and hugging texts (src/lib/design/layout.ts):
   * absent, a guess (an AI's work); null, every text keeps the size it has (a save by hand, laid out by the browser).
   */
  measure?: Measure | null;
  /** An AI's write: each frame's auto layout boxes as saved before it, by the frame's id (layout.ts settledBoxes); a box not among its frame's is new */
  settled?: ReadonlyMap<string, ReadonlyMap<string, readonly { w: number; h: number }[]>>;
  /**
   * Where a note goes instead of the notes list: the page's place in the list, the note, and the layer as it was given
   * (for a note about one layer), so a caller can say which of the things it sent the note is about.
   */
  say?: (page: number, why: string, layer?: unknown) => void;
}

/** A layer without its id, kind by kind (Omit over the whole union would keep only what every kind has). */
type Unnamed = Layer extends infer L ? (L extends Layer ? Omit<L, "id"> : never) : never;

/** `deep`: a layer inside a container, placed in the container's own pixels. A container comes back with no layers: cleanPages checks them. */
/** A layer's bindings to its main's properties (Box `bind`), each a property's name. */
function bindOf(v: unknown): { bind?: NonNullable<Layer["bind"]> } {
  if (!obj(v)) return {};
  const b = Object.fromEntries((["text", "visible", "swap"] as const).flatMap((k) => (propName(v[k]) ? [[k, propName(v[k])]] : [])));
  return Object.keys(b).length ? { bind: b } : {};
}

const FIXED = new Set(INSTANCE_FIXED);
const FROM_MAIN = new Set(INSTANCE_FROM_MAIN);
/**
 * A group as a main component (`component`, a set's `set` and `variant`) or an instance (`instance`: the main's key, its
 * property values, its overrides). Overrides are kept as given here, only fields an override may change and at most so
 * much of them: their values are checked as the instance's layers are, once it is made from its main (api/designs.ts).
 */
function componentOf(raw: Record<string, unknown>, say: (why: string) => void): Pick<GroupLayer, "component" | "set" | "variant" | "instance"> {
  if (raw.instance !== undefined && raw.instance !== null) {
    const i = raw.instance;
    if (!obj(i) || typeof i.of !== "string" || !KEY.test(i.of)) {
      say('an instance needs "instance": {"of": a main component\'s "component" key}: it is a plain group');
      return {};
    }
    const props = Object.fromEntries(
      (obj(i.props) ? Object.entries(i.props) : [])
        .flatMap(([k, v]): [string, string | boolean][] => (propName(k) && (typeof v === "boolean" || typeof v === "string") ? [[propName(k), typeof v === "string" ? v.slice(0, DESIGN_LIMITS.text) : v]] : []))
        .slice(0, DESIGN_LIMITS.props),
    );
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of (obj(i.overrides) ? Object.entries(i.overrides) : []).slice(0, DESIGN_LIMITS.layers + 1)) {
      if ((k !== "" && !LAYER_ID.test(k)) || !obj(v)) continue;
      const kept = Object.fromEntries(Object.entries(v).filter(([f]) => (k ? !FIXED.has(f) : FROM_MAIN.has(f))));
      if (Object.keys(kept).length) overrides[k] = kept;
    }
    // values as a layer has them: a few levels deep at most (a fill's stops), never a nest without end
    const deep = (v: unknown, d: number): boolean => !!v && typeof v === "object" && (d > 5 || Object.values(v).some((x) => deep(x, d + 1)));
    for (const [k, v] of Object.entries(overrides)) if (deep(v, 0)) delete overrides[k];
    const big = JSON.stringify(overrides).length > DESIGN_LIMITS.overrideBytes;
    if (big) say(`an instance's overrides run past ${DESIGN_LIMITS.overrideBytes} characters: left out`);
    return { instance: { of: i.of, ...(Object.keys(props).length ? { props } : {}), ...(!big && Object.keys(overrides).length ? { overrides } : {}) } };
  }
  if (raw.component === undefined || raw.component === null) return {};
  if (typeof raw.component !== "string" || !KEY.test(raw.component)) {
    say(`"component" is a key of letters, digits, "-" and "_" (at most 40): ${JSON.stringify(raw.component).slice(0, 30)} left out`);
    return {};
  }
  const variant = Object.fromEntries(
    (obj(raw.variant) ? Object.entries(raw.variant) : []).flatMap(([k, v]): [string, string][] => (propName(k) && named(v) ? [[propName(k), named(v)]] : [])).slice(0, DESIGN_LIMITS.props),
  );
  return { component: raw.component, ...(named(raw.set) ? { set: named(raw.set) } : {}), ...(named(raw.set) && Object.keys(variant).length ? { variant } : {}) };
}

function cleanLayer(raw: unknown, r: PageRules, say: (why: string) => void, own: string | undefined, deep = false): Unnamed | null {
  if (!obj(raw)) {
    say("a layer that is not an object: left out");
    return null;
  }
  const box = {
    x: round(num(raw.x, -r.w, 2 * r.w, 0)),
    y: round(num(raw.y, -r.h, 2 * r.h, 0)),
    w: round(num(raw.w, 1, 2 * r.w, r.w / 2)),
    h: round(num(raw.h, 1, 2 * r.h, r.h / 4)),
    ...(typeof raw.rotate === "number" && raw.rotate ? { rotate: round(num(raw.rotate, -360, 360, 0)) } : {}),
    ...(typeof raw.opacity === "number" && raw.opacity < 1 ? { opacity: round(num(raw.opacity, 0, 1, 1)) } : {}),
    // a list of effects stands for the one shadow and blur a layer had before (they are left out beside one)
    ...(Array.isArray(raw.effects)
      ? effectList(raw.effects)
      : {
          ...(obj(raw.shadow)
            ? { shadow: { color: sixDigits(color(raw.shadow.color, "#000000")), opacity: round(num(raw.shadow.opacity, 0, 1, 0.35)), blur: round(num(raw.shadow.blur, 0, 400, 24)), x: round(num(raw.shadow.x, -1000, 1000, 0)), y: round(num(raw.shadow.y, -1000, 1000, 8)) } }
            : {}),
          // a picture's blur is one of its adjustments (retouched, below); any other layer's is its own
          ...(raw.type !== "image" && Math.round(num(raw.blur, 0, 200, 0)) ? { blur: Math.round(num(raw.blur, 0, 200, 0)) } : {}),
        }),
    ...(DESIGN_BLENDS.includes(raw.blend as never) ? { blend: raw.blend as (typeof DESIGN_BLENDS)[number] } : {}),
    ...(raw.flipX === true ? { flipX: true } : {}),
    ...(raw.flipY === true ? { flipY: true } : {}),
    ...(groupId(raw.group) ? { group: groupId(raw.group) } : {}),
    ...(named(raw.name) ? { name: named(raw.name) } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
    ...(raw.reference === true ? { reference: true as const } : {}),
    ...pin(raw.pin),
    ...sizes(raw, r),
    ...(DESIGN_MASKS.includes(raw.mask as never) ? { mask: raw.mask as (typeof DESIGN_MASKS)[number] } : {}),
    ...bindOf(raw.bind),
  };
  if (raw.mask !== undefined && raw.mask !== null && raw.mask !== false && !box.mask) say(`a mask is "alpha", "vector" or "luminance": ${JSON.stringify(raw.mask).slice(0, 30)} left out`);
  const line = (v: unknown, max: number) => (obj(v) && num(v.width, 0, max, 0) > 0 ? { color: color(v.color, "#000000"), width: round(num(v.width, 0, max, 0)) } : null);
  if (raw.type === "text") {
    const text = typeof raw.text === "string" ? raw.text.replace(/\r\n/g, "\n").trim().slice(0, DESIGN_LIMITS.text) : "";
    if (!text) {
      say("a text with no words: left out");
      return null;
    }
    // its words are a run of the page's own words, whole words: not a part of one, not letters out of two
    if (own !== undefined && !inWords(own, text)) {
      say(`“${text.replace(/\s+/g, " ").slice(0, 60)}” is not in its own words: left out`);
      return null;
    }
    const outline = line(raw.outline, 60);
    // an AI's words are on the page whole: a box that sticks out of it is moved in (a model often gives centred
    // words their middle as x), since a word cut off at the page's edge is a word dropped. A turned box is left alone,
    // and so is whatever the person places by hand.
    let place = box;
    if (own !== undefined && !box.rotate && !deep) {
      const [x, w] = inside(box.x, box.w, r.w);
      const [y, h] = inside(box.y, box.h, r.h);
      if (x !== box.x || y !== box.y || w !== box.w || h !== box.h) say("words that stuck out of the page were moved onto it");
      place = { ...box, x, y, w, h };
    }
    const fonts = r.fonts?.length ? [...FONTS, ...r.fonts] : FONTS;
    return normalRuns<Omit<TextLayer, "id">>({
      type: "text" as const,
      ...place,
      text,
      font: oneOf(raw.font, fonts, DEFAULT_FONT),
      size: round(num(raw.size, 8, 600, 48)),
      color: color(raw.color, "#111111"),
      ...gradient(raw.gradient),
      ...(typeof raw.spacing === "number" && num(raw.spacing, -20, 200, 0) ? { spacing: round(num(raw.spacing, -20, 200, 0)) } : {}),
      ...(raw.fit === "shrink" ? { fit: "shrink" as const } : {}),
      ...(Math.round(num(raw.lines, 0, 12, 0)) ? { lines: Math.round(num(raw.lines, 0, 12, 0)) } : {}),
      ...marks(raw.marks),
      ...(raw.balance === true ? { balance: true } : {}),
      align: oneOf(raw.align, ["left", "center", "right"] as const, "left"),
      ...(raw.valign === "middle" || raw.valign === "bottom" ? { valign: raw.valign } : {}),
      ...(typeof raw.lineHeight === "number" ? { lineHeight: round(num(raw.lineHeight, 0.8, 3, 1.15)) } : {}),
      ...(raw.upper === true ? { upper: true } : {}),
      ...(raw.case === "upper" || raw.case === "lower" || raw.case === "title" || raw.case === "small" ? { case: raw.case as "upper" | "lower" | "title" | "small" } : {}),
      ...textStyle(raw, fonts, false),
      ...textRuns(raw.runs, text, fonts),
      ...(outline ? { outline } : {}),
      ...fillList(raw.fills, r, say),
      ...strokeList(raw.strokes, 60),
    });
  }
  if (raw.type === "image") {
    if (typeof raw.picture !== "string" || !r.pictures.includes(raw.picture)) {
      say("a picture that is not in this design: left out");
      return null;
    }
    return {
      type: "image",
      ...box,
      picture: raw.picture,
      fit: oneOf(raw.fit, ["cover", "contain"] as const, "cover"),
      ...(num(raw.zoom, 1, 8, 1) > 1 ? { zoom: round(num(raw.zoom, 1, 8, 1)) } : {}),
      ...(obj(raw.focus) ? { focus: { x: round(num(raw.focus.x, 0, 1, 0.5)), y: round(num(raw.focus.y, 0, 1, 0.5)) } } : {}),
      ...retouched(raw),
      // the picture it was cut out of: one of this design's own, and not itself
      ...(typeof raw.uncut === "string" && raw.uncut !== raw.picture && r.pictures.includes(raw.uncut) ? { uncut: raw.uncut } : {}),
      ...corners(raw.radius),
      ...smoothed(raw.smooth),
      ...strokeList(raw.strokes, 200),
    };
  }
  if (raw.type === "group") {
    // an auto layout makes it a box of its own
    const layout = autoLayout(raw.layout);
    if (raw.layout !== undefined && raw.layout !== null && !layout) say('an auto layout needs "dir": "row" or "column": left out');
    const boolean = DESIGN_BOOLEANS.includes(raw.boolean as never) ? (raw.boolean as (typeof DESIGN_BOOLEANS)[number]) : undefined;
    if (raw.boolean !== undefined && raw.boolean !== null && !boolean) say(`"boolean" is "union", "subtract", "intersect" or "exclude": ${JSON.stringify(raw.boolean).slice(0, 30)} left out`);
    // a boolean group is a plain group whose layers make one shape: its own fills and lines are that shape's
    if (boolean && (raw.box === true || layout)) say('a boolean group is a plain group: its "box" and "layout" left out');
    const own = !boolean && (raw.box === true || !!layout);
    // a plain group is only what holds its layers: no fill, no line, no corners, no clip of its own
    return {
      type: "group",
      ...box,
      layers: [],
      ...(boolean ? { boolean, ...fillList(raw.fills, r, say), ...strokeList(raw.strokes, 200) } : {}),
      ...(own ? { box: true as const, ...fillList(raw.fills, r, say), ...strokeList(raw.strokes, 200), ...corners(raw.radius), ...smoothed(raw.smooth), ...(raw.clip === true ? { clip: true as const } : {}), ...(layout ? { layout } : {}) } : {}),
      ...componentOf(raw, say),
    };
  }
  if (raw.type === "shape") {
    const stroke = line(raw.stroke, 200);
    return {
      type: "shape",
      ...box,
      shape: oneOf(raw.shape, DESIGN_SHAPES, "rect"),
      fill: color(raw.fill, "#dddddd"),
      ...gradient(raw.gradient),
      ...corners(raw.radius),
      ...smoothed(raw.smooth),
      ...(stroke ? { stroke: { ...stroke, ...strokeMore(raw.stroke) } } : {}),
      ...fillList(raw.fills, r, say),
      ...strokeList(raw.strokes, 200),
    };
  }
  if (raw.type === "path") {
    const fine = (n: number) => Math.round(n * 1e5) / 1e5;
    // a handle's end, in parts of the box: it may lie well outside the box (the box is drawn round the line, not round its handles)
    const given = (Array.isArray(raw.points) ? raw.points : []).filter(obj).slice(0, DESIGN_LIMITS.points);
    // Points are parts of the box. Ones far outside it were written in pixels (every other number of a layer is in
    // pixels, so that is how an AI writes them when it forgets): they are read as pixels of the box, all of them.
    const far = (v: unknown) => Math.abs(num(v, -1e6, 1e6, 0)) > 2;
    const pixels = given.some((p) => far(p.x) || far(p.y));
    const part = (v: unknown, size: number, lo: number, hi: number) => fine(num(num(v, -1e6, 1e6, 0) / (pixels ? size : 1), lo, hi, 0));
    const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && (part(v[0], box.w, -16, 16) || part(v[1], box.h, -16, 16)) ? [part(v[0], box.w, -16, 16), part(v[1], box.h, -16, 16)] : null);
    const points = given.map((p) => ({ x: part(p.x, box.w, -1, 2), y: part(p.y, box.h, -1, 2), ...(pair(p.in) ? { in: pair(p.in)! } : {}), ...(pair(p.out) ? { out: pair(p.out)! } : {}) }));
    if (points.length < 2) {
      say("a path with fewer than two points: left out");
      return null;
    }
    const stroke = line(raw.stroke, 200);
    const fill = typeof raw.fill === "string" && COLOR.test(raw.fill.trim()) ? color(raw.fill, "#000000") : null;
    const fills = fillList(raw.fills, r, say);
    const strokes = strokeList(raw.strokes, 200);
    return {
      type: "path",
      ...box,
      points,
      ...(raw.closed === true ? { closed: true } : {}),
      ...(fill ? { fill } : {}),
      ...gradient(raw.gradient),
      // a path with neither a fill nor a line would be nothing to see: it gets a thin line
      ...(stroke ? { stroke: { ...stroke, ...strokeMore(raw.stroke) } } : fill || fills.fills?.length || strokes.strokes?.length ? {} : { stroke: { color: "#111111", width: 4 } }),
      ...fills,
      ...strokes,
    };
  }
  if (raw.type === "drawing") {
    const svg = safeSvg(raw.svg);
    if (!svg) {
      say("a drawing that is not plain shapes: left out");
      return null;
    }
    return { type: "drawing", ...box, svg };
  }
  say(`a layer of no type that can be drawn (${JSON.stringify(raw.type ?? null).slice(0, 30)}): left out; the types are text, shape, path, image, drawing and group`);
  return null;
}

/** Hug kept to texts and auto layout boxes, fill and a place out of the flow to an auto layout box's layers (each said when given elsewhere). */
function fitSizing(l: { type: string; sizing?: Layer["sizing"]; absolute?: true; box?: true; layout?: AutoLayout }, flowing: boolean, say: (why: string) => void): void {
  const hugs = l.type === "text" || !!l.layout;
  for (const ax of ["w", "h"] as const) {
    const s = l.sizing?.[ax];
    if ((s === "hug" && !hugs) || (s === "fill" && (!flowing || (l.type === "group" && !l.box)))) {
      say(s === "hug" ? `"hug" is for a text or a box with an auto layout: ${ax === "w" ? "width" : "height"} kept fixed` : `"fill" is for a layer of a box with an auto layout: ${ax === "w" ? "width" : "height"} kept fixed`);
      delete l.sizing![ax];
    }
  }
  if (l.sizing && !l.sizing.w && !l.sizing.h) delete l.sizing;
  if (l.absolute && !flowing) delete l.absolute;
}

/** Pages as they may be saved: at most the limits' count of pages and layers, every id its page's own. */
export function cleanPages(raw: unknown, r: PageRules): { pages: DesignPage[]; notes: string[] } {
  const notes: string[] = [];
  const pages: DesignPage[] = [];
  // frames and loose layers are counted apart: layers lying beside the frames take no frame's place
  const count = { frames: 0, loose: 0 };
  for (const [k, p] of (Array.isArray(raw) ? raw : []).slice(0, DESIGN_LIMITS.pages + DESIGN_LIMITS.loose).entries()) {
    const loose = obj(p) && p.loose === true;
    if (loose ? ++count.loose > DESIGN_LIMITS.loose : ++count.frames > DESIGN_LIMITS.pages) continue;
    if (!obj(p)) {
      // an AI's answer keeps a page's place: what comes after it stays with its own words
      if (r.words) pages.push({ id: `p${k + 1}`, background: "#ffffff", layers: [] });
      continue;
    }
    const ids = new Set<string>();
    const sayPage = (why: string) => (r.say ? r.say(k, why) : notes.push(`Page ${k + 1}: ${why}`));
    // a frame's own size, when it has one (a width and a height): its layers are held to it
    const sized = typeof p.w === "number" && typeof p.h === "number";
    const size = sized ? { w: Math.round(num(p.w, DESIGN_LIMITS.frameMin, DESIGN_LIMITS.frameMax, r.w)), h: Math.round(num(p.h, DESIGN_LIMITS.frameMin, DESIGN_LIMITS.frameMax, r.h)) } : { w: r.w, h: r.h };
    const place = {
      ...(typeof p.x === "number" && typeof p.y === "number" ? { x: Math.round(num(p.x, -DESIGN_LIMITS.canvas, DESIGN_LIMITS.canvas, 0)), y: Math.round(num(p.y, -DESIGN_LIMITS.canvas, DESIGN_LIMITS.canvas, 0)) } : {}),
      ...(sized ? size : {}),
      ...(typeof p.block === "string" && ID.test(p.block) ? { block: p.block } : {}),
    };
    // every layer of the frame, however deep in its containers, counts once against the limit and has an id of its own in it
    let held = 0;
    let full = false;
    /** `flowing`: the layers are an auto layout box's: they may fill and lie out of its flow. */
    const take = (list: unknown, depth: number, flowing = false): Layer[] => {
      const out: Layer[] = [];
      for (const l of Array.isArray(list) ? list : []) {
        const sayL = (why: string) => (r.say ? r.say(k, why, l) : notes.push(`Page ${k + 1}: ${why}`));
        if (held >= DESIGN_LIMITS.layers) {
          if (!full) sayL(`a frame holds at most ${DESIGN_LIMITS.layers} layers, counting those inside groups: the rest left out`);
          full = true;
          break;
        }
        if (obj(l) && l.type === "group" && depth >= DESIGN_LIMITS.depth) {
          sayL(`groups go at most ${DESIGN_LIMITS.depth} deep: one deeper left out`);
          continue;
        }
        const clean = cleanLayer(l, { ...r, ...size }, sayL, r.words ? r.words[k] : undefined, depth > 0);
        if (!clean) continue;
        held++;
        const given = obj(l) && typeof l.id === "string" && LAYER_ID.test(l.id) && !ids.has(l.id) ? l.id : "";
        let id = given;
        for (let n = held; !id || ids.has(id); n++) id = `l${n}`;
        ids.add(id);
        fitSizing(clean, flowing, sayL);
        // in a flow a mask takes a place of its own, beside what it cuts (which is then cut away)
        if (flowing && clean.mask && !clean.absolute) sayL("a mask in an auto layout box takes a place in its flow like any layer, so what it cuts lies beside it: put the mask and what it cuts in a plain group of their own in the box");
        if (clean.type !== "group") {
          out.push({ ...clean, id } as Layer);
          continue;
        }
        const inner = take(obj(l) ? l.layers : [], depth + 1, !!clean.layout);
        // a plain group with nothing in it is nothing (a box may be empty: a card waiting for its words)
        if (!inner.length && !clean.box && !clean.instance) {
          sayL("a group with no layers in it: left out");
          continue;
        }
        // a boolean group given no fills is drawn in its bottom layer's fills and lines, as one made by hand is (a grey
        // when that has none: a picture, a group), never in nothing
        const bottom = clean.boolean && !clean.fills && inner[0] ? fillsOf(inner[0]) : null;
        if (bottom && !bottom.length) sayL('a boolean group is drawn in its own "fills" (its layers\' colours are not drawn): given none, it is grey');
        const look = bottom ? { fills: bottom.length ? bottom : [{ type: "solid" as const, color: "#d9d9d9" }], ...(!clean.strokes && strokesOf(inner[0]!).length ? { strokes: strokesOf(inner[0]!) } : {}) } : {};
        out.push({ ...clean, id, layers: inner, ...look });
      }
      return out;
    };
    // a plain group's box is the box round its layers, whatever it was given, and every auto layout laid out
    const pid = typeof p.id === "string" && ID.test(p.id) && !pages.some((x) => x.id === p.id) ? p.id : `p${k + 1}`;
    const layers = layoutLayers(take(p.layers, 0), r.measure === undefined ? guessWidth : r.measure, sayPage, r.settled && (r.settled.get(pid) ?? new Map()));
    // an AI's page says all of its words: any it left off are named, so it can put them back (a page with nothing
    // on it is said so by whoever asked for it)
    if (r.words?.[k] !== undefined && layers.length) {
      const left = plainWords(r.words[k] ?? "").split(" ").filter(Boolean);
      for (const word of plainWords(everyLayer(layers).flatMap((l) => (l.type === "text" ? [l.text] : [])).join(" ")).split(" ")) {
        const at = left.indexOf(word);
        if (at >= 0) left.splice(at, 1);
      }
      const why = `these words of it are not on the page: ${left.slice(0, 12).join(" ")}${left.length > 12 ? " …" : ""}`;
      if (left.length) sayPage(why);
    }
    // a loose piece with nothing left on it is gone
    if (loose && !layers.length) continue;
    pages.push({ id: pid, ...(named(p.name) ? { name: named(p.name) } : {}), ...(loose ? { loose: true as const } : p.clip === false ? { clip: false as const } : {}), ...place, background: color(p.background, "#ffffff"), ...gradient(p.gradient), ...fillList(p.fills, { ...r, ...size }, sayPage), ...strokeList(p.strokes, 200), ...finish(p), ...cleanAids(p), layers });
  }
  // loose layers after the frames: a frame's place in the list is its number
  return { pages: [...pages.filter((p) => !p.loose), ...pages.filter((p) => p.loose)], notes };
}

/**
 * Every frame with a place and a size on the canvas. One that has none takes the place it had before (`was`: the
 * same frame as the design holds it, so a save from a window that knows nothing of places moves nothing), and its
 * slide with it. One that is new goes beside the rightmost frame; a design none of whose frames has a place yet
 * (saved before frames had one) gets them in a row, each the design's size.
 */
export function withFrames(pages: readonly DesignPage[], w: number, h: number, was: readonly DesignPage[] = []): DesignPage[] {
  const kept = pages.map((p) => {
    const old = was.find((x) => x.id === p.id);
    return { ...p, ...(p.x === undefined && old?.x !== undefined ? { x: old.x, y: old.y } : {}), ...(p.w === undefined && old?.w !== undefined ? { w: old.w, h: old.h } : {}), ...(p.block === undefined && old?.block ? { block: old.block } : {}) };
  });
  const placed = kept.filter((p) => p.x !== undefined);
  let right = placed.length ? Math.max(...placed.map((p) => p.x! + (p.w ?? w))) + DESIGN_GAP : 0;
  const top = placed.length ? Math.min(...placed.map((p) => p.y!)) : 0;
  return kept.map((p) => {
    const size = { w: p.w ?? w, h: p.h ?? h };
    if (p.x !== undefined) return { ...p, ...size };
    const x = right;
    right += size.w + DESIGN_GAP;
    return { ...p, x, y: top, ...size };
  });
}

/**
 * A carousel's pages before anyone has designed them: each slide's first part as its headline and the rest under it,
 * black on white, each shrunk to fit its box when it is long. Only a place to start from: the person's AI designs the pages (api/designs.ts), or the person does.
 */
export function plainPages(slides: readonly string[], w: number, h: number, blocks: readonly string[] = []): DesignPage[] {
  const m = Math.round(w * 0.09);
  const k = w / 1080;
  return slides.map((slide, n) => {
    const [head = "", ...rest] = splitSlideAreas(slideWords(slide));
    const body = rest.join("\n\n");
    const size = Math.round((head.length <= 40 ? 96 : head.length <= 90 ? 74 : 58) * k);
    const layers: Layer[] = [];
    if (head) layers.push({ id: "l1", type: "text", text: head, font: "Montserrat ExtraBold", size, color: "#111111", align: "left", fit: "shrink", x: m, w: w - 2 * m, ...(body ? { y: m, h: Math.round(h * 0.44) - m, valign: "bottom" as const } : { y: Math.round(h * 0.2), h: Math.round(h * 0.6), valign: "middle" as const }) });
    if (body) layers.push({ id: "l2", type: "text", text: body.slice(0, DESIGN_LIMITS.text), font: DEFAULT_FONT, size: Math.round(44 * k), color: "#333333", align: "left", fit: "shrink", lineHeight: 1.3, x: m, y: Math.round(h * 0.48), w: w - 2 * m, h: Math.round(h * 0.44) });
    return { id: `p${n + 1}`, x: n * (w + DESIGN_GAP), y: 0, w, h, ...(blocks[n] ? { block: blocks[n] } : {}), background: "#ffffff", layers };
  });
}

/** A cover or thumbnail before anyone has designed it: the video's frame filling the page, its title over the lower part. */
export function coverPage(picture: string, title: string, w: number, h: number): DesignPage {
  const layers: Layer[] = [{ id: "l1", type: "image", picture, fit: "cover", x: 0, y: 0, w, h }];
  const text = title.trim().slice(0, DESIGN_LIMITS.text);
  if (text) {
    layers.push({ id: "l2", type: "text", text, font: "Anton", size: Math.round(Math.min(w, h) * 0.13), color: "#ffffff", align: "center", fit: "shrink", valign: "middle", upper: true, lineHeight: 1.05, outline: { color: "#000000", width: Math.round(Math.min(w, h) * 0.012) }, x: Math.round(w * 0.07), y: Math.round(h * 0.58), w: Math.round(w * 0.86), h: Math.round(h * 0.3) });
  }
  return { id: "p1", x: 0, y: 0, w, h, background: "#000000", layers };
}
