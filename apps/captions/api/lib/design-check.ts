import { DESIGN_ADJUST, DESIGN_BLENDS, DESIGN_GAP, DESIGN_LIMITS, DESIGN_SHAPES, type DesignPage, type Gradient, type ImageLayer, type Layer, type Radius, type Stroke } from "../../contracts/design";
import { splitSlideAreas } from "../../src/lib/carousel-visualize";
import { DESIGN_FONTS } from "../../src/lib/design/fonts";
import { PICTURE_TOKEN } from "../../src/lib/workshop-markdown";

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

/** What a shape's line has beside its colour and width: dashes (with a gap, or they are none), round ends, a side. */
const strokeMore = (v: unknown): Partial<Stroke> => {
  if (!obj(v)) return {};
  const dash = Array.isArray(v.dash) && v.dash.length === 2 ? ([round(num(v.dash[0], 0, 2000, 0)), round(num(v.dash[1], 0, 2000, 0))] as [number, number]) : null;
  return { ...(dash && dash[1] > 0 ? { dash } : {}), ...(v.round === true ? { round: true } : {}), ...(v.side === "inside" || v.side === "outside" ? { side: v.side } : {}) };
};

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
   * For an AI's answer: each frame's own words (its slide's text), in the frames' order. A text layer that says
   * anything else is left out: where the words go and how they look is the design, what they are is the author's.
   * A frame with none here (undefined: it is no slide) may say anything.
   */
  words?: readonly (string | undefined)[];
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
    ...(obj(raw.shadow)
      ? { shadow: { color: sixDigits(color(raw.shadow.color, "#000000")), opacity: round(num(raw.shadow.opacity, 0, 1, 0.35)), blur: round(num(raw.shadow.blur, 0, 400, 24)), x: round(num(raw.shadow.x, -1000, 1000, 0)), y: round(num(raw.shadow.y, -1000, 1000, 8)) } }
      : {}),
    ...(DESIGN_BLENDS.includes(raw.blend as never) ? { blend: raw.blend as (typeof DESIGN_BLENDS)[number] } : {}),
    // a picture's blur is one of its adjustments (retouched, below); any other layer's is its own
    ...(raw.type !== "image" && Math.round(num(raw.blur, 0, 200, 0)) ? { blur: Math.round(num(raw.blur, 0, 200, 0)) } : {}),
    ...(raw.flipX === true ? { flipX: true } : {}),
    ...(raw.flipY === true ? { flipY: true } : {}),
    ...(groupId(raw.group) ? { group: groupId(raw.group) } : {}),
    ...(named(raw.name) ? { name: named(raw.name) } : {}),
    ...(raw.hidden === true ? { hidden: true } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
  };
  const line = (v: unknown, max: number) => (obj(v) && num(v.width, 0, max, 0) > 0 ? { color: color(v.color, "#000000"), width: round(num(v.width, 0, max, 0)) } : null);
  if (raw.type === "text") {
    const text = typeof raw.text === "string" ? raw.text.replace(/\r\n/g, "\n").trim().slice(0, DESIGN_LIMITS.text) : "";
    if (!text) return null;
    // its words are a run of the page's own words, whole words: not a part of one, not letters out of two
    if (own !== undefined && !` ${plainWords(own)} `.includes(` ${plainWords(text)} `)) {
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
      ...gradient(raw.gradient),
      ...(typeof raw.spacing === "number" && num(raw.spacing, -20, 200, 0) ? { spacing: round(num(raw.spacing, -20, 200, 0)) } : {}),
      ...(raw.fit === "shrink" ? { fit: "shrink" as const } : {}),
      ...(raw.balance === true ? { balance: true } : {}),
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
      ...(stroke ? { stroke: { ...stroke, ...strokeMore(raw.stroke) } } : {}),
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
    return {
      type: "path",
      ...box,
      points,
      ...(raw.closed === true ? { closed: true } : {}),
      ...(fill ? { fill } : {}),
      ...gradient(raw.gradient),
      // a path with neither a fill nor a line would be nothing to see: it gets a thin line
      ...(stroke ? { stroke: { ...stroke, ...strokeMore(raw.stroke) } } : fill ? {} : { stroke: { color: "#111111", width: 4 } }),
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
    if (!obj(p)) {
      // an AI's answer keeps a page's place: what comes after it stays with its own words
      if (r.words) pages.push({ id: `p${k + 1}`, background: "#ffffff", layers: [] });
      continue;
    }
    const ids = new Set<string>();
    const layers: Layer[] = [];
    // a frame's own size, when it has one (a width and a height): its layers are held to it
    const sized = typeof p.w === "number" && typeof p.h === "number";
    const size = sized ? { w: Math.round(num(p.w, DESIGN_LIMITS.frameMin, DESIGN_LIMITS.frameMax, r.w)), h: Math.round(num(p.h, DESIGN_LIMITS.frameMin, DESIGN_LIMITS.frameMax, r.h)) } : { w: r.w, h: r.h };
    const place = {
      ...(typeof p.x === "number" && typeof p.y === "number" ? { x: Math.round(num(p.x, -DESIGN_LIMITS.canvas, DESIGN_LIMITS.canvas, 0)), y: Math.round(num(p.y, -DESIGN_LIMITS.canvas, DESIGN_LIMITS.canvas, 0)) } : {}),
      ...(sized ? size : {}),
      ...(typeof p.block === "string" && ID.test(p.block) ? { block: p.block } : {}),
    };
    for (const l of (Array.isArray(p.layers) ? p.layers : []).slice(0, DESIGN_LIMITS.layers)) {
      const clean = cleanLayer(l, { ...r, ...size }, (why) => notes.push(`Page ${k + 1}: ${why}`), r.words ? r.words[k] : undefined);
      if (!clean) continue;
      const given = obj(l) && typeof l.id === "string" && ID.test(l.id) && !ids.has(l.id) ? l.id : "";
      let id = given;
      for (let n = layers.length + 1; !id || ids.has(id); n++) id = `l${n}`;
      ids.add(id);
      layers.push({ ...clean, id } as Layer);
    }
    // an AI's page says all of its words: any it left off are named, so it can put them back (a page with nothing
    // on it is said so by whoever asked for it)
    if (r.words?.[k] !== undefined && layers.length) {
      const left = plainWords(r.words[k] ?? "").split(" ").filter(Boolean);
      for (const word of plainWords(layers.flatMap((l) => (l.type === "text" ? [l.text] : [])).join(" ")).split(" ")) {
        const at = left.indexOf(word);
        if (at >= 0) left.splice(at, 1);
      }
      if (left.length) notes.push(`Page ${k + 1}: these words of it are not on the page: ${left.slice(0, 12).join(" ")}${left.length > 12 ? " …" : ""}`);
    }
    pages.push({ id: typeof p.id === "string" && ID.test(p.id) && !pages.some((x) => x.id === p.id) ? p.id : `p${k + 1}`, ...(named(p.name) ? { name: named(p.name) } : {}), ...place, background: color(p.background, "#ffffff"), ...gradient(p.gradient), ...finish(p), layers });
  }
  return { pages, notes };
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
