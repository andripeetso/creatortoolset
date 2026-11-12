import { DESIGN_LIMITS, type DesignPage, type Layer } from "../../contracts/design";
import { splitSlideAreas } from "../../src/lib/carousel-visualize";
import { FONT_OPTIONS } from "../../src/lib/types";
import { PICTURE_TOKEN } from "../../src/lib/workshop-markdown";

/**
 * A design's pages, checked. Whatever sends them (the person's own changes, or their AI's answer), every value is
 * read as data and brought inside what a page can hold: a number out of range is moved to the nearest one in it, a
 * colour or font the app does not have becomes one it has, and a layer that cannot be drawn is left out with a note.
 * Nothing here runs anything: a drawing is SVG shapes only (safeSvg).
 */

const FONTS = FONT_OPTIONS.map((f) => f.family);
export const DEFAULT_FONT = "Inter";
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const ID = /^[a-z0-9-]{1,24}$/;

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, or: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : or);
const color = (v: unknown, or: string): string => (typeof v === "string" && COLOR.test(v.trim()) ? v.trim().toLowerCase() : or);
const oneOf = <T extends string>(v: unknown, all: readonly T[], or: T): T => (all.includes(v as T) ? (v as T) : or);
const round = (n: number) => Math.round(n * 100) / 100;
/** A name as one line of at most the limit's letters, or "" when there is none. */
const named = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, DESIGN_LIMITS.layerName) : "");

/** A span moved inside 0..page, and cut to the page when it is longer than it. */
const inside = (at: number, size: number, page: number): [number, number] => (size >= page ? [0, page] : [Math.min(Math.max(at, 0), page - size), size]);

/** Letters and digits only, lower case, one space between words: what "the same words" is compared on. */
export const plainWords = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** A slide's text as words alone: its picture tokens taken out. */
export const slideWords = (text: string): string => text.replace(PICTURE_TOKEN, " ").replace(/[ \t]+\n/g, "\n").trim();

/**
 * A drawing's markup, or null when it holds anything but shapes: a script, a handler, a link, an address, text, a
 * picture, a style sheet, an animation, a document type. It is drawn as a picture, where none of those would run, and
 * refused here all the same so that a saved design holds nothing a later reader might treat otherwise.
 */
export function safeSvg(svg: unknown): string | null {
  if (typeof svg !== "string") return null;
  const s = svg.trim();
  if (s.length > DESIGN_LIMITS.svg || !/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s) || !/\sviewBox\s*=/.test(s)) return null;
  if (/<\s*(script|foreignObject|image|a|text|tspan|style|use|iframe|animate\w*|set|link|meta)[\s/>]/i.test(s)) return null;
  if (/<!|\son\w+\s*=|href\s*=|javascript:|data:|url\(\s*(?!["']?#)/i.test(s)) return null;
  return /\sxmlns\s*=/.test(s) ? s : s.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

export interface PageRules {
  w: number;
  h: number;
  /** the pictures a layer may show: the ids in the design's folder */
  pictures: readonly string[];
  /**
   * For an AI's answer: each page's own words (the slide's text, a cover's title). A text layer that says anything
   * else is left out: where the words go and how they look is the design, what they are is the author's.
   */
  words?: readonly string[];
}

/** A layer without its id, kind by kind (Omit over the whole union would keep only what every kind has). */
type Unnamed = Layer extends infer L ? (L extends Layer ? Omit<L, "id"> : never) : never;

function cleanLayer(raw: unknown, r: PageRules, say: (why: string) => void, own: string | undefined): Unnamed | null {
  if (!obj(raw)) return null;
  const box = {
    x: round(num(raw.x, -r.w, 2 * r.w, 0)),
    y: round(num(raw.y, -r.h, 2 * r.h, 0)),
    w: round(num(raw.w, 1, 2 * r.w, r.w / 2)),
    h: round(num(raw.h, 1, 2 * r.h, r.h / 4)),
    ...(typeof raw.rotate === "number" && raw.rotate ? { rotate: round(num(raw.rotate, -360, 360, 0)) } : {}),
    ...(typeof raw.opacity === "number" && raw.opacity < 1 ? { opacity: round(num(raw.opacity, 0, 1, 1)) } : {}),
    ...(named(raw.name) ? { name: named(raw.name) } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
  };
  const line = (v: unknown, max: number) => (obj(v) && num(v.width, 0, max, 0) > 0 ? { color: color(v.color, "#000000"), width: round(num(v.width, 0, max, 0)) } : null);
  if (raw.type === "text") {
    const text = typeof raw.text === "string" ? raw.text.replace(/\r\n/g, "\n").trim().slice(0, DESIGN_LIMITS.text) : "";
    if (!text) return null;
    if (own !== undefined && !plainWords(own).includes(plainWords(text))) {
      say(`“${text.replace(/\s+/g, " ").slice(0, 60)}” is not in its own words: left out`);
      return null;
    }
    const outline = line(raw.outline, 60);
    // an AI's words are on the page whole: a box that sticks out of it is moved in (a model often gives centred
    // words their middle as x), since a word cut off at the page's edge is a word dropped. A turned box is left alone,
    // and so is whatever the person places by hand.
    let place = box;
    if (own !== undefined && !box.rotate) {
      const [x, w] = inside(box.x, box.w, r.w);
      const [y, h] = inside(box.y, box.h, r.h);
      if (x !== box.x || y !== box.y || w !== box.w || h !== box.h) say("words that stuck out of the page were moved onto it");
      place = { ...box, x, y, w, h };
    }
    return {
      type: "text",
      ...place,
      text,
      font: oneOf(raw.font, FONTS, DEFAULT_FONT),
      size: round(num(raw.size, 8, 600, 48)),
      color: color(raw.color, "#111111"),
      align: oneOf(raw.align, ["left", "center", "right"] as const, "left"),
      ...(raw.valign === "middle" || raw.valign === "bottom" ? { valign: raw.valign } : {}),
      ...(typeof raw.lineHeight === "number" ? { lineHeight: round(num(raw.lineHeight, 0.8, 3, 1.15)) } : {}),
      ...(raw.upper === true ? { upper: true } : {}),
      ...(outline ? { outline } : {}),
    };
  }
  if (raw.type === "image") {
    if (typeof raw.picture !== "string" || !r.pictures.includes(raw.picture)) {
      say("a picture that is not in this design: left out");
      return null;
    }
    return { type: "image", ...box, picture: raw.picture, fit: oneOf(raw.fit, ["cover", "contain"] as const, "cover"), ...(num(raw.radius, 0, 2000, 0) ? { radius: round(num(raw.radius, 0, 2000, 0)) } : {}) };
  }
  if (raw.type === "shape") {
    const stroke = line(raw.stroke, 200);
    return {
      type: "shape",
      ...box,
      shape: oneOf(raw.shape, ["rect", "ellipse"] as const, "rect"),
      fill: color(raw.fill, "#dddddd"),
      ...(num(raw.radius, 0, 2000, 0) ? { radius: round(num(raw.radius, 0, 2000, 0)) } : {}),
      ...(stroke ? { stroke } : {}),
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
  return null;
}

/** Pages as they may be saved: at most the limits' count of pages and layers, every id its page's own. */
export function cleanPages(raw: unknown, r: PageRules): { pages: DesignPage[]; notes: string[] } {
  const notes: string[] = [];
  const pages: DesignPage[] = [];
  for (const [k, p] of (Array.isArray(raw) ? raw : []).slice(0, DESIGN_LIMITS.pages).entries()) {
    if (!obj(p)) continue;
    const ids = new Set<string>();
    const layers: Layer[] = [];
    for (const l of (Array.isArray(p.layers) ? p.layers : []).slice(0, DESIGN_LIMITS.layers)) {
      const clean = cleanLayer(l, r, (why) => notes.push(`Page ${k + 1}: ${why}`), r.words ? (r.words[k] ?? "") : undefined);
      if (!clean) continue;
      const given = obj(l) && typeof l.id === "string" && ID.test(l.id) && !ids.has(l.id) ? l.id : "";
      let id = given;
      for (let n = layers.length + 1; !id || ids.has(id); n++) id = `l${n}`;
      ids.add(id);
      layers.push({ ...clean, id } as Layer);
    }
    // an AI's page says all of its words: any it left off are named, so it can put them back (a page with nothing
    // on it is said so by whoever asked for it)
    if (r.words && layers.length) {
      const left = plainWords(r.words[k] ?? "").split(" ").filter(Boolean);
      for (const word of plainWords(layers.flatMap((l) => (l.type === "text" ? [l.text] : [])).join(" ")).split(" ")) {
        const at = left.indexOf(word);
        if (at >= 0) left.splice(at, 1);
      }
      if (left.length) notes.push(`Page ${k + 1}: these words of it are not on the page: ${left.slice(0, 12).join(" ")}${left.length > 12 ? " …" : ""}`);
    }
    pages.push({ id: typeof p.id === "string" && ID.test(p.id) && !pages.some((x) => x.id === p.id) ? p.id : `p${k + 1}`, ...(named(p.name) ? { name: named(p.name) } : {}), background: color(p.background, "#ffffff"), layers });
  }
  return { pages, notes };
}

/**
 * A carousel's pages before anyone has designed them: each slide's first part as its headline and the rest under it,
 * black on white. Only a place to start from: the person's AI designs the pages (api/designs.ts), or the person does.
 */
export function plainPages(slides: readonly string[], w: number, h: number): DesignPage[] {
  const m = Math.round(w * 0.09);
  const k = w / 1080;
  return slides.map((slide, n) => {
    const [head = "", ...rest] = splitSlideAreas(slideWords(slide));
    const body = rest.join("\n\n");
    const size = Math.round((head.length <= 40 ? 96 : head.length <= 90 ? 74 : 58) * k);
    const layers: Layer[] = [];
    if (head) layers.push({ id: "l1", type: "text", text: head, font: "Montserrat ExtraBold", size, color: "#111111", align: "left", x: m, w: w - 2 * m, ...(body ? { y: m, h: Math.round(h * 0.44) - m, valign: "bottom" as const } : { y: Math.round(h * 0.2), h: Math.round(h * 0.6), valign: "middle" as const }) });
    if (body) layers.push({ id: "l2", type: "text", text: body.slice(0, DESIGN_LIMITS.text), font: DEFAULT_FONT, size: Math.round(44 * k), color: "#333333", align: "left", lineHeight: 1.3, x: m, y: Math.round(h * 0.48), w: w - 2 * m, h: Math.round(h * 0.44) });
    return { id: `p${n + 1}`, background: "#ffffff", layers };
  });
}

/** A cover or thumbnail before anyone has designed it: the video's frame filling the page, its title over the lower part. */
export function coverPage(picture: string, title: string, w: number, h: number): DesignPage {
  const layers: Layer[] = [{ id: "l1", type: "image", picture, fit: "cover", x: 0, y: 0, w, h }];
  const text = title.trim().slice(0, DESIGN_LIMITS.text);
  if (text) {
    layers.push({ id: "l2", type: "text", text, font: "Anton", size: Math.round(Math.min(w, h) * 0.13), color: "#ffffff", align: "center", valign: "middle", upper: true, lineHeight: 1.05, outline: { color: "#000000", width: Math.round(Math.min(w, h) * 0.012) }, x: Math.round(w * 0.07), y: Math.round(h * 0.58), w: Math.round(w * 0.86), h: Math.round(h * 0.3) });
  }
  return { id: "p1", background: "#000000", layers };
}
