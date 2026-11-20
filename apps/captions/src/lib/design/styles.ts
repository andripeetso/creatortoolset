import { DESIGN_LIMITS, TEXT_STYLE_FIELDS, type DesignPage, type DesignStyleKind, type DesignStyles, type DesignTextStyle, type Layer, type TextLayer, type TextStyleField } from "../../../contracts/design";
import { everyLayer, mapLayers, same } from "./tree";

/**
 * A design's styles (contracts/design.ts DesignStyles): "Accent", "Headline", "Card shadow", each named once and used by
 * any colour, text or layer. A style's value is kept on every layer that names it, so drawing, layout, exports and the
 * server's pictures read layers as they always have; what changes is that every change of the design ends with
 * `styled`, which puts each style's value on the layers naming it. Before that (when it is a change of the person's or
 * an AI's), `unlinked` lets a value changed on such a layer leave its style (a text's own fields stay its own). Plain
 * functions the browser and the server both read. No DOM here.
 */

type Rec = Record<string, unknown>;
export type Say = (note: string) => void;

export const STYLE_KINDS = ["colors", "text", "effects"] as const satisfies readonly DesignStyleKind[];
/** What a style's id may be. */
export const STYLE_ID = /^[a-z0-9-]{1,24}$/;
/** What a run of a text takes from a text style (a run has no line height or case of its own). */
const RUN_FIELDS = ["font", "size", "weight", "italic", "spacing"] as const;

/** A style of a kind by its id: only one of the design's own (an id like "constructor" is no style of an object's). */
export const styleOf = <K extends DesignStyleKind>(s: DesignStyles | undefined, kind: K, id: string): NonNullable<DesignStyles[K]>[string] | undefined => {
  const list = s?.[kind];
  return list && Object.hasOwn(list, id) ? (list[id] as NonNullable<DesignStyles[K]>[string]) : undefined;
};
const ownOf = (r: Record<string, Rec>, id: string): Rec | undefined => (Object.hasOwn(r, id) ? r[id] : undefined);

/** One colour of a layer or a frame: its value, the style it names, and whether that place can name one at all. */
export interface Colour {
  color: string;
  style?: string;
  slot: boolean;
  /** where it is on the layer ("own", "fills.0", "runs.2"…): the same place on another version of it */
  at?: string;
}

/** A copy of `o` with `k` set to `v` (absent when undefined); `o` itself when that is what it has. */
const field = <T>(o: T, k: string, v: unknown): T => {
  const r = o as Rec;
  if (r[k] === v) return o;
  const out = { ...r };
  if (v === undefined) delete out[k];
  else out[k] = v;
  return out as T;
};
/** Each of a list through `fn`: the same list when none changed. */
const each = <T>(v: unknown, fn: (x: T) => T): unknown => {
  if (!Array.isArray(v)) return v;
  let changed = false;
  const out = v.map((x: T) => {
    const y = fn(x);
    if (y !== x) changed = true;
    return y;
  });
  return changed ? out : v;
};

/**
 * Every colour of a layer, or of a frame (its own: never its layers'), through `fn`, always in the same order: its own
 * colour (a text's `color`, a shape's or path's `fill`, a frame's `background`), its fills (a solid's colour, a
 * gradient's stops), its lines, its line, its runs' colours; then the colours that name no style (a gradient's `to`
 * and `via`, an outline, highlighter marks, shadows). `fn` answers the colour and the style it names now (none: it
 * names none). The same object when nothing changed.
 */
export function mapColours<T extends Layer | DesignPage>(l: T, fn: (c: Colour) => { color: string; style?: string }): T {
  const one = <O>(o: O, key: string, styleKey: string | null, six = false, at = key): O => {
    const r = o as Rec;
    const style = r && styleKey && typeof r[styleKey] === "string" ? (r[styleKey] as string) : undefined;
    // (a run naming a colour style may have no colour of its own yet)
    if (!r || (typeof r[key] !== "string" && style === undefined)) return o;
    const color = typeof r[key] === "string" ? (r[key] as string) : "";
    const got = fn({ color, ...(style !== undefined ? { style } : {}), slot: !!styleKey, at });
    // (no colour at all: a run that named a style it could not have keeps none of its own)
    const out = field(o, key, (six ? got.color.slice(0, 7) : got.color) || undefined);
    return styleKey ? field(out, styleKey, got.style) : out;
  };
  let o = l;
  const page = !("type" in l);
  const own = page ? "background" : l.type === "text" ? "color" : l.type === "shape" || l.type === "path" ? "fill" : null;
  if (own) o = one(o, own, "colorStyle", false, "own");
  const r = () => o as unknown as Rec;
  let n = 0;
  o = field(o, "fills", each<Rec>(r().fills, (p) => (n++, p.type === "solid" ? one(p, "color", "colorStyle", false, `fills.${n}`) : p.type === "gradient" ? field(p, "stops", each<Rec>(p.stops, (s) => one(s, "color", null))) : p)));
  n = 0;
  o = field(o, "strokes", each<Rec>(r().strokes, (s) => one(s, "color", "colorStyle", false, `strokes.${n++}`)));
  if (r().stroke) o = field(o, "stroke", one(r().stroke, "color", "colorStyle", false, "stroke"));
  n = 0;
  o = field(o, "runs", each<Rec>(r().runs, (x) => one(x, "color", "colorStyle", true, `runs.${n++}`)));
  if (r().gradient) o = field(o, "gradient", one(one(r().gradient, "to", null, true), "via", null, true));
  if (r().outline) o = field(o, "outline", one(r().outline, "color", null));
  o = field(o, "marks", each<Rec>(r().marks, (m) => one(m, "color", null, true)));
  o = field(o, "effects", each<Rec>(r().effects, (e) => one(e, "color", null, true)));
  if (r().shadow) o = field(o, "shadow", one(r().shadow, "color", null, true));
  return o;
}

/** Every colour the layers use (and those inside them), each once: by the style it names, else by its value. */
export function coloursOf(layers: readonly Layer[]): { color: string; style?: string; count: number }[] {
  const out = new Map<string, { color: string; style?: string; count: number }>();
  for (const l of everyLayer(layers))
    mapColours(l, (c) => {
      const key = c.style ?? c.color.toLowerCase();
      const had = out.get(key);
      if (had) had.count++;
      else out.set(key, { color: c.color.toLowerCase(), ...(c.style ? { style: c.style } : {}), count: 1 });
      return c;
    });
  return [...out.values()];
}

/** The layers with one of their colours (by `from`'s style, else its value where it names no style) made `to` everywhere: a colour of its own, or a style's. */
export function swapColour(layers: readonly Layer[], from: { color: string; style?: string }, to: { color: string; style?: string }): Layer[] {
  const hit = (c: Colour) => (from.style ? c.style === from.style : !c.style && c.color.toLowerCase() === from.color.toLowerCase());
  return mapLayers(layers, (l) => mapColours(l, (c) => (hit(c) ? { color: to.color, ...(to.style && c.slot ? { style: to.style } : {}) } : c)));
}

/** A text style's value of a field, as a text has it (absent: the text's default). */
const textValue = (st: DesignTextStyle, f: TextStyleField): unknown => st[f];

/** A layer with its styles' values on it: one naming no style there is (a style deleted, or never made) keeps its own values and names none, said. */
function styledLayer<L extends Layer | DesignPage>(l: L, s: DesignStyles, say?: Say): L {
  const who = "type" in l ? `layer ${l.id}` : "the frame";
  let o = mapColours(l, (c) => {
    if (c.style === undefined) return c;
    const st = styleOf(s, "colors", c.style);
    if (!st) {
      say?.(`${who} names no colour style "${c.style}": its own colour kept`);
      return { color: c.color };
    }
    return { color: st.color, style: c.style };
  });
  if (!("type" in o)) return o;
  const r = () => o as unknown as Rec;
  if (typeof r().effectStyle === "string") {
    const st = styleOf(s, "effects", r().effectStyle as string);
    if (!st) {
      say?.(`${who} names no effect style "${String(r().effectStyle)}": its own effects kept`);
      o = field(o, "effectStyle", undefined);
    } else if (!same(r().effects, st.effects)) o = field(o, "effects", structuredClone(st.effects));
  }
  if ((o as Layer).type !== "text") return o;
  let t = o as TextLayer;
  if (t.textStyle !== undefined) {
    const st = styleOf(s, "text", t.textStyle);
    if (!st) {
      say?.(`${who} names no text style "${t.textStyle}": its own font and size kept`);
      t = field(field(t, "textStyle", undefined), "styleOwn", undefined);
    } else {
      const own = new Set(t.styleOwn ?? []);
      for (const f of TEXT_STYLE_FIELDS) if (!own.has(f)) t = field(t, f, textValue(st, f));
      // the style says the case: the older all-capitals switch is not read beside it
      if (!own.has("case")) t = field(t, "upper", undefined);
    }
  } else if (t.styleOwn) t = field(t, "styleOwn", undefined);
  t = field(t, "runs", each<Rec>(t.runs, (run) => {
    if (typeof run.textStyle !== "string") return run;
    const st = styleOf(s, "text", run.textStyle);
    if (!st) {
      say?.(`a part of ${who} names no text style "${run.textStyle}": its own look kept`);
      return field(run, "textStyle", undefined);
    }
    let x = run;
    for (const f of RUN_FIELDS) x = field(x, f, st[f]);
    return x;
  }));
  return t as unknown as L;
}

/**
 * The frames with every style's value put on the layers (and frames) that name it, and any naming a style the design
 * does not have naming none, keeping its own value (`say` tells each). The same list (and frames) when nothing changed.
 */
export function styled<P extends DesignPage>(pages: readonly P[], styles: DesignStyles | undefined, say?: Say): P[] {
  const s = styles ?? {};
  let changed = false;
  const out = pages.map((p) => {
    const own = styledLayer(p, s, say);
    const layers = mapLayers(p.layers, (l) => styledLayer(l, s, say));
    if (own === p && layers === p.layers) return p;
    changed = true;
    return { ...own, layers };
  });
  return changed ? out : (pages as P[]);
}

/** A layer's colours, in mapColours' order. */
const coloursIn = (l: Layer | DesignPage): Colour[] => {
  const out: Colour[] = [];
  mapColours(l, (c) => (out.push(c), c));
  return out;
};

/** A layer as `was` had it, with what was changed on it since that is a style's leaving that style (unlinked). */
function unlinkedLayer<L extends Layer | DesignPage>(l: L, b: L, s: DesignStyles): L {
  // a colour changed here (not to the style's own) names that style no more: each told from what was at the same place
  const had = new Map(coloursIn(b).flatMap((c) => (c.style !== undefined && c.at ? [[c.at, c] as const] : [])));
  let o = mapColours(l, (c) => {
    const w = c.at !== undefined ? had.get(c.at) : undefined;
    const st = c.style !== undefined ? styleOf(s, "colors", c.style) : undefined;
    return st && w && c.style === w.style && c.color.toLowerCase() !== w.color.toLowerCase() && c.color.toLowerCase() !== st.color.toLowerCase().slice(0, c.color.length) ? { color: c.color } : c;
  });
  if (!("type" in o) || !("type" in b)) return o;
  const r = o as unknown as Rec;
  const q = b as unknown as Rec;
  if (typeof r.effectStyle === "string" && r.effectStyle === q.effectStyle) {
    const st = styleOf(s, "effects", r.effectStyle);
    if (st && !same(r.effects, q.effects) && !same(r.effects, st.effects)) o = field(o, "effectStyle", undefined);
  }
  if ((o as Layer).type !== "text" || (b as Layer).type !== "text") return o;
  let t = o as TextLayer;
  const tb = b as TextLayer;
  const st = t.textStyle !== undefined && t.textStyle === tb.textStyle ? styleOf(s, "text", t.textStyle) : undefined;
  if (st) {
    const own = new Set(t.styleOwn ?? []);
    const before = own.size;
    for (const f of TEXT_STYLE_FIELDS) if (!same(t[f], tb[f]) && !same(t[f], textValue(st, f))) own.add(f);
    if (own.size > before) t = field(t, "styleOwn", TEXT_STYLE_FIELDS.filter((f) => own.has(f)));
  }
  if (t.runs && tb.runs && t.runs.length === tb.runs.length) {
    let k = 0;
    t = field(t, "runs", each<Rec>(t.runs, (run) => {
      const was = tb.runs![k++] as unknown as Rec;
      const rs = typeof run.textStyle === "string" && run.textStyle === was.textStyle ? styleOf(s, "text", run.textStyle) : undefined;
      return rs && RUN_FIELDS.some((f) => !same(run[f], was[f]) && !same(run[f], rs[f])) ? field(run, "textStyle", undefined) : run;
    }));
  }
  return t as unknown as L;
}

/**
 * The frames of a change (the person's, an AI's) with each value it changed on a layer that names a style, to anything
 * but the style's own, leaving that style: a colour, a layer's effects, a run's look; on a text naming a text style, the
 * fields it changed are its own on top of the style (`styleOwn`). `was`: the frames before the change. Run before
 * syncInstances, so a style left on an instance's layer is that instance's override. The same list when nothing changed.
 */
export function unlinked<P extends DesignPage>(pages: readonly P[], was: readonly DesignPage[], styles: DesignStyles | undefined): P[] {
  if (!styles || !STYLE_KINDS.some((k) => Object.keys(styles[k] ?? {}).length)) return pages as P[];
  const wasOf = new Map(was.map((p) => [p.id, p]));
  let changed = false;
  const out = pages.map((p) => {
    const b = wasOf.get(p.id);
    if (!b || b === p) return p;
    const before = new Map(everyLayer(b.layers).map((l) => [l.id, l]));
    const own = unlinkedLayer(p, b as P, styles);
    const layers = mapLayers(p.layers, (l) => {
      const q = before.get(l.id);
      return q && q !== l && q.type === l.type ? unlinkedLayer(l, q, styles) : l;
    });
    if (own === p && layers === p.layers) return p;
    changed = true;
    return { ...own, layers };
  });
  return changed ? out : (pages as P[]);
}

/**
 * A design's styles as this window has them (`mine`, changed from `base`) put onto the server's (`theirs`): each style
 * by its id, and each of its fields, from the side that changed it (this window's where both did, as a layer's field
 * is). A style one side deleted and the other changed is kept.
 */
export function mergeStyles(mine: DesignStyles | undefined, base: DesignStyles | undefined, theirs: DesignStyles | undefined): DesignStyles {
  const out: DesignStyles = {};
  for (const kind of STYLE_KINDS) {
    const m = (mine?.[kind] ?? {}) as unknown as Record<string, Rec>;
    const b = (base?.[kind] ?? {}) as unknown as Record<string, Rec>;
    const t = (theirs?.[kind] ?? {}) as unknown as Record<string, Rec>;
    const merged: Record<string, Rec> = {};
    for (const id of new Set([...Object.keys(t), ...Object.keys(m)])) {
      const [mi, bi, ti] = [ownOf(m, id), ownOf(b, id), ownOf(t, id)];
      let v: Rec | undefined;
      if (same(mi, bi)) v = ti;
      else if (same(ti, bi) || !ti) v = mi;
      else if (!mi) v = ti;
      else {
        v = {};
        for (const f of new Set([...Object.keys(ti), ...Object.keys(mi)])) {
          const x = same(mi[f], bi?.[f]) ? ti[f] : mi[f];
          if (x !== undefined) v[f] = x;
        }
      }
      if (v) merged[id] = v;
    }
    if (Object.keys(merged).length) (out as Record<string, unknown>)[kind] = merged;
  }
  return out;
}

/** A new style's id from its name, one no style of that kind has. */
export function styleId(name: string, taken: Iterable<string>): string {
  const have = new Set(taken);
  const root = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "style";
  let id = root;
  for (let n = 2; have.has(id); n++) id = `${root}-${n}`;
  return id;
}

/** A text's look as a text style of `name`. */
export function textStyleOf(l: TextLayer, name: string): DesignTextStyle {
  const out: DesignTextStyle = { name, font: l.font, size: l.size };
  for (const f of TEXT_STYLE_FIELDS) if (f !== "font" && f !== "size" && l[f] !== undefined) (out as unknown as Rec)[f] = l[f];
  if (out.case === undefined && l.upper) out.case = "upper";
  return out;
}

/** How many styles of a kind a design may have. */
export const stylesFull = (s: DesignStyles | undefined, kind: DesignStyleKind) => Object.keys(s?.[kind] ?? {}).length >= DESIGN_LIMITS.styles;

/** A design's styles with one put in (null: taken out); none of a kind left: the kind goes too. */
export function withStyle<K extends DesignStyleKind>(s: DesignStyles | undefined, kind: K, id: string, v: NonNullable<DesignStyles[K]>[string] | null): DesignStyles {
  const list = { ...(s?.[kind] ?? {}) } as Record<string, unknown>;
  if (v === null) delete list[id];
  else list[id] = v;
  const out = { ...s } as Record<string, unknown>;
  if (Object.keys(list).length) out[kind] = list;
  else delete out[kind];
  return out as DesignStyles;
}

/** A layer's look, as Copy style takes it: what Paste style puts on another layer (its place, size and words stay its own). */
const LOOK = ["opacity", "blend", "effects", "effectStyle", "shadow", "blur", "fills", "strokes", "stroke", "radius", "smooth", "gradient"] as const;
const TEXT_LOOK = ["font", "size", "weight", "italic", "lineHeight", "spacing", "case", "upper", "underline", "strike", "outline", "marks", "textStyle", "styleOwn", "align", "valign"] as const;
/** Which of the look's fields a kind of layer takes. */
const TAKES: Record<Layer["type"], readonly string[]> = {
  text: ["opacity", "blend", "effects", "effectStyle", "shadow", "blur", "fills", "strokes", "gradient", ...TEXT_LOOK],
  shape: ["opacity", "blend", "effects", "effectStyle", "shadow", "blur", "fills", "strokes", "stroke", "radius", "smooth", "gradient"],
  path: ["opacity", "blend", "effects", "effectStyle", "shadow", "blur", "fills", "strokes", "stroke", "gradient"],
  image: ["opacity", "blend", "effects", "effectStyle", "shadow", "strokes", "radius", "smooth"],
  drawing: ["opacity", "blend", "effects", "effectStyle", "shadow", "blur"],
  group: ["opacity", "blend", "effects", "effectStyle", "shadow", "blur", "fills", "strokes", "radius", "smooth"],
};
export type Look = { type: Layer["type"]; own?: { color: string; style?: string }; fields: Rec };
export function lookOf(l: Layer): Look {
  const r = l as unknown as Rec;
  const fields: Rec = {};
  for (const k of [...LOOK, ...TEXT_LOOK]) if (TAKES[l.type].includes(k)) fields[k] = r[k];
  const own = l.type === "text" ? { color: l.color, style: l.colorStyle } : l.type === "shape" || l.type === "path" ? (l.fill !== undefined ? { color: l.fill, style: l.colorStyle } : undefined) : undefined;
  return { type: l.type, ...(own ? { own } : {}), fields: structuredClone(fields) };
}
/** A layer with a copied look on it: each field of the look its kind takes (one the look has not is taken off), its own colour as a text's colour or a shape's fill. */
export function withLook<L extends Layer>(l: L, look: Look): L {
  let o = l;
  for (const k of TAKES[l.type]) if (k in look.fields) o = field(o, k, structuredClone(look.fields[k]));
  const ownKey = l.type === "text" ? "color" : l.type === "shape" || l.type === "path" ? "fill" : null;
  if (ownKey && look.own) o = field(field(o, ownKey, look.own.color), "colorStyle", look.own.style);
  return o;
}
