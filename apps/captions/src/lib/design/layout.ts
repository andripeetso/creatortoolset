import type { AutoLayout, DesignPage, GroupLayer, Layer, TextLayer } from "../../../contracts/design";
import { fitContents, placeLayers } from "./resize";
import { setRuns, type Measure } from "./runs";
import { boundsOf, editIn, findLayer, hug, isGroup, mapLayers, wrap, type Rect } from "./tree";

/**
 * Auto layout (contracts/design.ts AutoLayout, Box `sizing`, `min`, `max`, `absolute`) as pure maths, read by the
 * canvas, the server (an AI's writes, copies in another size) and the drawing browser alike: nothing here may touch the
 * DOM. Words are measured by the `Measure` given: the browser's canvas, or on the server a guess (guessWidth); `null`
 * keeps every text the size it has (a save by hand, already laid out by the browser).
 *
 * A pass (layoutLayers) goes from the inside out: a text that hugs takes the size of its words, a plain group keeps to
 * its layers (tree.ts hug) and a box with auto layout places its layers and, where it hugs, takes their size. A layer
 * that fills is given its size by its box, and is laid out again inside at that size.
 */

export type Say = (note: string) => void;
type Flowing = GroupLayer & { layout: AutoLayout };
type Axis = "w" | "h";

const R = (n: number) => Math.round(n * 100) / 100;
const PLACE = { start: 0, center: 0.5, end: 1 } as const;
const AXIS_NAME = { w: "Width", h: "Height" } as const;

export const flows = (l: Layer | null | undefined): l is Flowing => isGroup(l) && !!l.box && !!l.layout;
/** A box's padding as top, right, bottom, left. */
export const padOf = (a: Pick<AutoLayout, "pad">): [number, number, number, number] => (Array.isArray(a.pad) ? a.pad : [a.pad ?? 0, a.pad ?? 0, a.pad ?? 0, a.pad ?? 0]);
/** What a notice calls a layer: its name, a text's first words, else what it is. */
export const nameOf = (l: Layer): string => l.name ?? (l.type === "text" ? l.text.split("\n")[0]!.slice(0, 40) : l.type === "group" ? (l.box ? "Frame" : "Group") : l.type === "image" ? "Picture" : l.type === "shape" ? "Shape" : "Layer");
/** A size kept to a layer's least and most along one side. */
export const clampTo = (l: Pick<Layer, "min" | "max">, axis: Axis, n: number): number => Math.max(l.min?.[axis] ?? 0, Math.min(l.max?.[axis] ?? Infinity, n));

/** How big a text's words are set at their own size: unwrapped, or wrapped at `width`. Rounded up, so they fit the box made from it. */
export function wordsSize(l: TextLayer, measure: Measure, width?: number): { w: number; h: number } {
  const set = setRuns({ ...l, w: width ?? 1e6, h: 1e6, fit: undefined, lines: undefined }, measure);
  return { w: Math.ceil(Math.max(0, ...set.lines.map((r) => r.width))), h: Math.ceil(set.lines.reduce((n, r) => n + r.height, 0)) };
}

/**
 * A string's width guessed from its letters' kinds: the server has no fonts to measure with.
 * shortcut: a guess (display faces run wider); the browser measures the real widths and lays the design out again when
 * it is opened, and the pictures an AI is shown are laid out by the drawing browser. Upgrade: measure with the font
 * files once the server has a text shaper.
 */
export const guessWidth: Measure = (font, s) => {
  const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? 16);
  let n = 0;
  for (const ch of s) n += ch === " " ? 0.27 : /[ilIj.,:;'|!`]/.test(ch) ? 0.3 : /[mwMW@%]/.test(ch) ? 0.88 : /[A-Z0-9]/.test(ch) ? 0.68 : 0.56;
  return n * size;
};

/** A text that hugs its words, sized to them (a hugging width wraps at its most). */
function settleText(l: TextLayer, m: Measure | null): TextLayer {
  if (!m || (l.sizing?.w !== "hug" && l.sizing?.h !== "hug")) return l;
  const w = l.sizing.w === "hug" ? clampTo(l, "w", wordsSize(l, m).w) : l.w;
  const h = l.sizing.h === "hug" ? clampTo(l, "h", wordsSize(l, m, w).h) : l.h;
  return w === l.w && h === l.h ? l : { ...l, w, h };
}

/** A layer given a size by its box (it fills): what it holds follows, a text that hugs its height is set again at the new width. */
function resizeTo(k: Layer, w: number, h: number, m: Measure | null, say?: Say): Layer {
  if (k.w === w && k.h === h) return k;
  let n: Layer = { ...k, w, h };
  if (n.type === "text" && m && n.sizing?.h === "hug" && w !== k.w) n = { ...n, h: clampTo(n, "h", wordsSize(n, m, w).h) };
  if (isGroup(n)) n = fitContents(k, n);
  if (flows(n)) n = arrange(n, m, say);
  return n;
}

const atPlace = (k: Layer, x: number, y: number): Layer => (k.x === x && k.y === y ? k : { ...k, x, y });

/** A box's layers placed by its auto layout, and its size where it hugs them. The same box when nothing moved. */
function arrange(g: Flowing, m: Measure | null, say?: Say): GroupLayer {
  const a = g.layout;
  const row = a.dir === "row";
  const M: Axis = row ? "w" : "h";
  const C: Axis = row ? "h" : "w";
  const [pt, pr, pb, pl] = padOf(a);
  const [m0, m1, c0, c1] = row ? [pl, pr, pt, pb] : [pt, pb, pl, pr];
  const sizing = { ...g.sizing };
  const flow = g.layers.filter((k) => !k.absolute && !k.hidden);
  const fills = (k: Layer, ax: Axis) => k.sizing?.[ax] === "fill";
  // a layer cannot fill the way its box hugs: the box keeps the size it has (as a person changing either is told)
  if (sizing[M] === "hug" && flow.some((k) => fills(k, M))) {
    sizing[M] = undefined;
    say?.(`${AXIS_NAME[M]} set to Fixed for ${nameOf(g)}`);
  }
  if (sizing[C] === "hug" && flow.length && flow.every((k) => fills(k, C))) {
    sizing[C] = undefined;
    say?.(`${AXIS_NAME[C]} set to Fixed for ${nameOf(g)}`);
  }
  const hugM = sizing[M] === "hug";
  const hugC = sizing[C] === "hug";
  const gap = a.gap ?? 0;
  const lineGap = a.lineGap ?? gap;
  const innerM = g[M] - m0 - m1;
  const innerC = g[C] - c0 - c1;
  const items = flow.slice();
  const put = (i: number, ax: Axis, n: number) => {
    const k = items[i]!;
    items[i] = resizeTo(k, ax === "w" ? R(n) : k.w, ax === "h" ? R(n) : k.h, m, say);
  };
  // lines: one, or (wrapping at a fixed size) as many as it takes; a layer that fills counts as its least
  const lines: number[][] = [[]];
  let used = 0;
  items.forEach((k, i) => {
    const s = fills(k, M) && !hugM ? (k.min?.[M] ?? 0) : k[M];
    const line = lines.at(-1)!;
    if (a.wrap && !hugM && line.length && used + gap + s > innerM + 0.5) {
      lines.push([i]);
      used = s;
    } else {
      used += (line.length ? gap : 0) + s;
      line.push(i);
    }
  });
  // a line is as thick across as its thickest layer that does not fill across (one that does counts its least)
  const thick = (line: number[]) => Math.max(0, ...line.map((i) => (fills(items[i]!, C) ? (items[i]!.min?.[C] ?? 0) : items[i]![C])));
  const crossOf = (line: number[]) => (lines.length === 1 && !hugC ? innerC : thick(line));
  const stretch = () => lines.forEach((line) => line.forEach((i) => fills(items[i]!, C) && put(i, C, clampTo(items[i]!, C, Math.max(0, crossOf(line))))));
  stretch();
  // along the flow, the layers that fill share what the others leave (each kept to its least and most, as flexbox does)
  if (!hugM)
    for (const line of lines) {
      let open = line.filter((i) => fills(items[i]!, M));
      let free = innerM - gap * (line.length - 1) - line.filter((i) => !fills(items[i]!, M)).reduce((n, i) => n + items[i]![M], 0);
      while (open.length) {
        const each = Math.max(0, free / open.length);
        const held = open.find((i) => clampTo(items[i]!, M, each) !== each);
        if (held === undefined) {
          open.forEach((i) => put(i, M, each));
          break;
        }
        const n = clampTo(items[held]!, M, each);
        put(held, M, n);
        free -= n;
        open = open.filter((i) => i !== held);
      }
    }
  // a text given a width is as high as its words then: across again
  stretch();
  const along = (line: number[]) => line.reduce((n, i) => n + items[i]![M], 0);
  const floor = (ax: Axis, n: number) => Math.max(ax === M ? m0 + m1 : c0 + c1, clampTo(g, ax, n));
  const sizeM = R(floor(M, hugM ? Math.max(0, ...lines.map((l) => along(l) + gap * (l.length - 1))) + m0 + m1 : g[M]));
  const crosses = lines.map((l) => (lines.length === 1 && !hugC ? Math.max(0, floor(C, g[C]) - c0 - c1) : thick(l)));
  const block = crosses.reduce((n, c) => n + c, 0) + lineGap * (lines.length - 1);
  const sizeC = R(floor(C, hugC ? block + c0 + c1 : g[C]));
  const roomM = sizeM - m0 - m1;
  let at = c0 + (sizeC - c0 - c1 - block) * PLACE[a.cross ?? "start"];
  lines.forEach((line, n) => {
    const spread = a.between && !hugM;
    const space = spread ? (line.length > 1 ? Math.max(0, (roomM - along(line)) / (line.length - 1)) : 0) : gap;
    let p = m0 + (spread ? 0 : (roomM - along(line) - gap * (line.length - 1)) * PLACE[a.align ?? "start"]);
    for (const i of line) {
      const k = items[i]!;
      const q = at + (crosses[n]! - k[C]) * PLACE[a.cross ?? "start"];
      items[i] = row ? atPlace(k, R(p), R(q)) : atPlace(k, R(q), R(p));
      p += k[M] + space;
    }
    at += crosses[n]! + lineGap;
  });
  const size = row ? { w: sizeM, h: sizeC } : { w: sizeC, h: sizeM };
  const resized = size.w !== g.w || size.h !== g.h;
  // what is out of the flow follows the box's edges by its pin when the box takes another size
  const out = g.layers.filter((k) => k.absolute && !k.hidden);
  const moved = resized && out.length ? placeLayers(out, { w: g.w, h: g.h }, size, "stay") : out;
  let changed = resized || sizing.w !== g.sizing?.w || sizing.h !== g.sizing?.h;
  const layers = g.layers.map((k) => {
    const i = flow.indexOf(k);
    const n = i >= 0 ? items[i]! : out.includes(k) ? moved[out.indexOf(k)]! : k;
    if (n !== k) changed = true;
    return n;
  });
  if (!changed) return g;
  const { sizing: _was, ...rest } = g;
  return { ...rest, ...size, layers, ...(sizing.w || sizing.h ? { sizing: { ...(sizing.w ? { w: sizing.w } : {}), ...(sizing.h ? { h: sizing.h } : {}) } } : {}) };
}

/** One layer settled, its own layers settled before it: a hugging text, a plain group round its layers, a box laid out. */
function settle(l: Layer, m: Measure | null, say?: Say): Layer | null {
  if (l.type === "text") return settleText(l, m);
  if (flows(l)) return arrange(l, m, say);
  if (isGroup(l) && !l.box) return hug([l])[0] ?? null;
  return l;
}

/** Every layer laid out (see above), deepest first. The same list when nothing changed. */
export const layoutLayers = (layers: readonly Layer[], m: Measure | null, say?: Say): Layer[] => mapLayers(layers, (l) => settle(l, m, say));

/** Every frame's layers laid out (layoutLayers); the same list when nothing changed. */
export function layoutPages<P extends DesignPage>(pages: readonly P[], m: Measure | null, say?: Say): P[] {
  let changed = false;
  const out = pages.map((p) => {
    const layers = layoutLayers(p.layers, m, say);
    return layers === p.layers ? p : ((changed = true), { ...p, layers });
  });
  return changed ? out : (pages as P[]);
}

/**
 * A layer resized by hand (a handle, the W and H fields): a side that hugged or filled is fixed at its new size from
 * then on, and the notice says so.
 */
export function fixedBy<L extends Layer>(was: Layer, now: L, say?: Say): L {
  const drop = (["w", "h"] as const).filter((ax) => now.sizing?.[ax] && Math.abs(was[ax] - now[ax]) > 0.01);
  if (!drop.length) return now;
  drop.forEach((ax) => say?.(`${AXIS_NAME[ax]} set to Fixed for ${nameOf(now)}`));
  const sizing = { ...now.sizing };
  drop.forEach((ax) => delete sizing[ax]);
  const { sizing: _old, ...rest } = now;
  return (sizing.w || sizing.h ? { ...rest, sizing } : rest) as L;
}

/**
 * A layer's sizing along one side set to `to` ("fixed" takes it off). Hug is only a text's or an auto layout box's,
 * fill only a layer in an auto layout box (`inFlow`). A box set to hug along its flow makes its layers that filled that
 * way fixed (each named in a notice).
 */
export function withSizing(l: Layer, axis: Axis, to: "fixed" | "hug" | "fill", inFlow: boolean, say?: Say): Layer {
  if ((to === "hug" && l.type !== "text" && !flows(l)) || (to === "fill" && !inFlow)) return l;
  const sizing = { ...l.sizing, [axis]: to === "fixed" ? undefined : to };
  const { sizing: _old, ...rest } = l;
  let out = (sizing.w || sizing.h ? { ...rest, sizing: { ...(sizing.w ? { w: sizing.w } : {}), ...(sizing.h ? { h: sizing.h } : {}) } } : rest) as Layer;
  if (to === "hug" && flows(out) && (out.layout.dir === "row") === (axis === "w"))
    out = { ...out, layers: out.layers.map((k) => (k.sizing?.[axis] === "fill" ? (say?.(`${AXIS_NAME[axis]} set to Fixed for ${nameOf(k)}`), withSizing(k, axis, "fixed", true)) : k)) };
  return out;
}

/** A box's auto layout taken off: its layers stay where they are, those that filled keep their size. */
export function withoutLayout(g: GroupLayer): GroupLayer {
  const { layout: _l, sizing: _s, ...rest } = g;
  return { ...rest, layers: g.layers.map((k) => (["w", "h"] as const).reduce((n, ax) => (n.sizing?.[ax] === "fill" ? withSizing(n, ax, "fixed", false) : n), k)) };
}

/**
 * An auto layout worked out from layers as they lie (visible ones in its flow): side by side or one under another, the
 * mean gap between them, how they line up across, and the padding round them in `box` (their box when absent). Gives
 * their order along it too.
 */
export function inferLayout(layers: readonly Layer[], box?: { w: number; h: number }): { layout: AutoLayout; order: string[] } {
  const flow = layers.filter((l) => !l.hidden && !l.absolute);
  const apart = (ax: "x" | "y") => {
    const M = ax === "x" ? "w" : "h";
    const s = [...flow].sort((p, q) => p[ax] - q[ax]);
    const gaps = s.slice(1).map((l, i) => l[ax] - (s[i]![ax] + s[i]![M]));
    return { s, gaps, clear: gaps.every((g) => g >= -1) };
  };
  const ys = apart("y");
  const xs = apart("x");
  const b = flow.length ? boundsOf(flow) : { x: 0, y: 0, w: 0, h: 0 };
  const dir: AutoLayout["dir"] = ys.clear && flow.length > 1 ? "column" : xs.clear && flow.length > 1 ? "row" : b.w >= b.h ? "row" : "column";
  const { s, gaps } = dir === "row" ? xs : ys;
  const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((n, g) => n + g, 0) / gaps.length)) : 0;
  // across: middles in line → centre, far ends in line → end
  const C = dir === "row" ? (["y", "h"] as const) : (["x", "w"] as const);
  const lined = (f: (l: Layer) => number) => flow.length > 1 && flow.every((l) => Math.abs(f(l) - f(flow[0]!)) <= 2);
  const cross = lined((l) => l[C[0]]) ? undefined : lined((l) => l[C[0]] + l[C[1]] / 2) ? "center" : lined((l) => l[C[0]] + l[C[1]]) ? "end" : undefined;
  const pad = box ? ([b.y, box.w - b.x - b.w, box.h - b.y - b.h, b.x].map((n) => Math.max(0, Math.round(n))) as [number, number, number, number]) : undefined;
  const one = pad && pad.every((n) => n === pad[0]) ? pad[0] : pad;
  return { layout: { dir, ...(gap ? { gap } : {}), ...(one ? { pad: one } : {}), ...(cross ? { cross } : {}) }, order: s.map((l) => l.id) };
}

/** A text made to hug its words: its width too while its words fit on one line now, else its height only. */
function hugWords(l: Layer, m: Measure | null): Layer {
  if (l.type !== "text" || !m) return l;
  const wide = wordsSize(l, m).w <= l.w + 1 && !l.text.includes("\n");
  return { ...l, sizing: { ...l.sizing, ...(wide ? { w: "hug" as const } : {}), h: "hug" } };
}

/**
 * Auto layout added (⇧A) to the picked layers of a scope (in the frame's pixels): one container is given it in place
 * (a plain group becomes a box), else they are wrapped in a new box `id` that has it. The box hugs them, they go in the
 * order they lie in, and texts hug their words. Gives the scope's new layers and the box's id, or null.
 */
export function addAutoLayout(inner: readonly Layer[], ids: readonly string[], id: string, m: Measure | null): { layers: Layer[]; id: string } | null {
  const picked = inner.filter((l) => ids.includes(l.id));
  const one = picked.length === 1 && isGroup(picked[0]) && !flows(picked[0]) ? picked[0] : null;
  let layers: Layer[];
  let boxId = id;
  if (one) {
    boxId = one.id;
    layers = inner as Layer[];
  } else {
    const w = wrap(inner, ids, id, true);
    if (!w) return null;
    layers = w;
  }
  const box = layers.find((l) => l.id === boxId) as GroupLayer;
  const { layout, order } = inferLayout(box.layers, one ? box : undefined);
  const items = [...order.map((k) => box.layers.find((l) => l.id === k)!), ...box.layers.filter((l) => !order.includes(l.id))].map((l) => hugWords(l, m));
  const made: GroupLayer = { ...box, box: true, layout, layers: items, ...(items.length ? { sizing: { w: "hug", h: "hug" } } : {}) };
  return { layers: layers.map((l) => (l.id === boxId ? made : l)), id: boxId };
}

/**
 * Where layers moving over an auto layout box's flow (`others`: its layers but the moving ones, and `at`: the moving
 * layers' box, both in the same pixels) go in it: before the first layer of the flow whose middle theirs has not
 * passed (in a wrapping box, line by line), as an index into `others`, and the line that shows it.
 */
export function flowSlot(layout: AutoLayout, others: readonly Layer[], at: Rect): { index: number; line: { x1: number; y1: number; x2: number; y2: number } } {
  const row = layout.dir === "row";
  const [P, Q, M, C] = row ? (["x", "y", "w", "h"] as const) : (["y", "x", "h", "w"] as const);
  const mid = at[P] + at[M] / 2;
  const midC = at[Q] + at[C] / 2;
  const flow = others.filter((l) => !l.hidden && !l.absolute);
  // a layer is before: on an earlier line (all of it across before the middle), or on this line with its middle before
  const before = (l: Layer) => (layout.wrap && l[Q] + l[C] < midC ? true : layout.wrap && l[Q] > midC ? false : l[P] + l[M] / 2 < mid);
  const n = flow.findIndex((l) => !before(l));
  const next = n < 0 ? null : flow[n]!;
  const prev = n < 0 ? flow.at(-1) : n > 0 ? flow[n - 1] : null;
  const half = (layout.gap ?? 0) / 2;
  const by = next ?? prev;
  const p = next ? next[P] - Math.max(0, half) : prev ? prev[P] + prev[M] + Math.max(0, half) : at[P];
  const span = by ? [by[Q], by[Q] + by[C]] : [at[Q], at[Q] + at[C]];
  const index = next ? others.indexOf(next) : others.length;
  return { index, line: row ? { x1: p, y1: span[0]!, x2: p, y2: span[1]! } : { x1: span[0]!, y1: p, x2: span[1]!, y2: p } };
}

/** Layers `ids` of auto layout box `boxId` (found anywhere in `layers`) put where they lie now in its flow (flowSlot). */
export function flowInsert(layers: readonly Layer[], boxId: string, ids: readonly string[]): Layer[] {
  const box = findLayer(layers, boxId);
  if (!flows(box)) return layers as Layer[];
  const moving = box.layers.filter((l) => ids.includes(l.id));
  if (!moving.length) return layers as Layer[];
  const others = box.layers.filter((l) => !ids.includes(l.id));
  const { index } = flowSlot(box.layout, others, boundsOf(moving));
  return editIn(layers, boxId, () => [...others.slice(0, index), ...moving, ...others.slice(index)]);
}
