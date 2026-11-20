import { DESIGN_LIMITS, type DesignPage, type GroupLayer, type Layer } from "../../../contracts/design";

/**
 * Layers that hold layers (contracts/design.ts GroupLayer), as plain functions the browser and the server both read.
 * A container's layers lie in its own pixels; the canvas, the panels and an AI's changes work on the layers of one
 * container at a time (its "scope") as they lie in the frame, through every container round them (scopeLayers), and
 * write them back the same way (withScope). Ids are unique in a frame however deep a layer lies, so one id finds a
 * layer anywhere in it. No DOM here.
 */

/** Two values alike, whatever order their fields were written in (the server, a check, write them in their own order). */
export const stable = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const same = (a: unknown, b: unknown): boolean => a === b || stable(a) === stable(b);

/** An id's number (l<n>), or 0: one past what a frame can count to (a hand-typed l99999999999) is no number of its own. */
const idNumber = (id: string): number => {
  const n = Number(/^l(\d{1,6})$/.exec(id)?.[1] ?? 0);
  return n < 1_000_000 ? n : 0;
};

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Turned = Rect & { rotate?: number };
type Placed = Turned & { flipX?: boolean; flipY?: boolean };

export const isGroup = (l: Layer | null | undefined): l is GroupLayer => l?.type === "group";

/** The upright box round every layer given, each through its own rotation. */
export function boundsOf(layers: readonly Turned[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of layers) {
    const a = ((l.rotate ?? 0) * Math.PI) / 180;
    const hw = (Math.abs(Math.cos(a)) * l.w + Math.abs(Math.sin(a)) * l.h) / 2;
    const hh = (Math.abs(Math.sin(a)) * l.w + Math.abs(Math.cos(a)) * l.h) / 2;
    x0 = Math.min(x0, l.x + l.w / 2 - hw);
    y0 = Math.min(y0, l.y + l.h / 2 - hh);
    x1 = Math.max(x1, l.x + l.w / 2 + hw);
    y1 = Math.max(y1, l.y + l.h / 2 + hh);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Every layer, depth first, each container before its own layers. */
export function everyLayer(layers: readonly Layer[]): Layer[] {
  const out: Layer[] = [];
  for (const l of layers) {
    out.push(l);
    if (isGroup(l)) out.push(...everyLayer(l.layers));
  }
  return out;
}

/** The containers a layer lies in, outermost first ([] at the frame's own level); null when it is not there. */
export function pathTo(layers: readonly Layer[], id: string): GroupLayer[] | null {
  for (const l of layers) {
    if (l.id === id) return [];
    if (isGroup(l)) {
      const p = pathTo(l.layers, id);
      if (p) return [l, ...p];
    }
  }
  return null;
}
export const findLayer = (layers: readonly Layer[], id: string): Layer | undefined => everyLayer(layers).find((l) => l.id === id);
export const parentOf = (layers: readonly Layer[], id: string): GroupLayer | null => pathTo(layers, id)?.at(-1) ?? null;
/** The container the picked layers lie in (picked layers are always of one container), null at the frame's own level. */
export const scopeOf = (layers: readonly Layer[], ids: readonly string[]): string | null => (ids.length ? (parentOf(layers, ids[0]!)?.id ?? null) : null);
/** How deep containers go: 0 with none, 1 with containers holding no container, … */
export const depthOf = (layers: readonly Layer[]): number => Math.max(0, ...layers.map((l) => (isGroup(l) ? 1 + depthOf(l.layers) : 0)));

/**
 * Every layer through `fn`, a container's layers before the container (which `fn` then gets with its new layers);
 * `fn` answering null takes the layer out. The same list when nothing changed.
 */
export function mapLayers(layers: readonly Layer[], fn: (l: Layer) => Layer | null): Layer[] {
  let changed = false;
  const out: Layer[] = [];
  for (const l of layers) {
    let m: Layer = l;
    if (isGroup(l)) {
      const inner = mapLayers(l.layers, fn);
      if (inner !== l.layers) m = { ...l, layers: inner };
    }
    const r = fn(m);
    if (r !== l) changed = true;
    if (r) out.push(r);
  }
  return changed ? out : (layers as Layer[]);
}

/** The layers of container `scope` (null: the frame's own) through `fn`. The same list when there is no such container. */
export function editIn(layers: readonly Layer[], scope: string | null, fn: (inner: Layer[]) => Layer[]): Layer[] {
  if (scope === null) return fn(layers as Layer[]);
  let hit = false;
  const out = layers.map((l) => {
    if (hit || !isGroup(l)) return l;
    if (l.id === scope) return (hit = true), { ...l, layers: fn(l.layers) };
    const inner = editIn(l.layers, scope, fn);
    return inner === l.layers ? l : ((hit = true), { ...l, layers: inner });
  });
  return hit ? out : (layers as Layer[]);
}

const round = (n: number) => Math.round(n * 100) / 100;
const turn = (d: number) => {
  const r = ((d % 360) + 540) % 360 - 180;
  return r === -180 ? 180 : r;
};
const mirrored = (c: Placed) => !!c.flipX !== !!c.flipY;

/** A point of a container's own pixels, in its parent's. */
export function outOf(c: Placed, p: { x: number; y: number }): { x: number; y: number } {
  const a = ((c.rotate ?? 0) * Math.PI) / 180;
  const dx = (p.x - c.w / 2) * (c.flipX ? -1 : 1);
  const dy = (p.y - c.h / 2) * (c.flipY ? -1 : 1);
  return { x: c.x + c.w / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + c.h / 2 + dx * Math.sin(a) + dy * Math.cos(a) };
}
/** A point of a container's parent, in the container's own pixels. */
export function into(c: Placed, p: { x: number; y: number }): { x: number; y: number } {
  const a = ((c.rotate ?? 0) * Math.PI) / 180;
  const dx = p.x - c.x - c.w / 2;
  const dy = p.y - c.y - c.h / 2;
  return { x: (dx * Math.cos(a) + dy * Math.sin(a)) * (c.flipX ? -1 : 1) + c.w / 2, y: (-dx * Math.sin(a) + dy * Math.cos(a)) * (c.flipY ? -1 : 1) + c.h / 2 };
}

/** A layer of container `c` as it lies in c's parent: placed, turned and mirrored through c. */
export function layerOut<L extends Placed>(c: Placed, l: L): L {
  if (!c.rotate && !c.flipX && !c.flipY) return { ...l, x: l.x + c.x, y: l.y + c.y };
  const m = outOf(c, { x: l.x + l.w / 2, y: l.y + l.h / 2 });
  const r = turn((c.rotate ?? 0) + (mirrored(c) ? -1 : 1) * (l.rotate ?? 0));
  return { ...l, x: round(m.x - l.w / 2), y: round(m.y - l.h / 2), rotate: r || undefined, flipX: !!l.flipX !== !!c.flipX || undefined, flipY: !!l.flipY !== !!c.flipY || undefined };
}
/** A layer as it lies in container c's parent, as a layer of c (layerOut undone). */
export function layerIn<L extends Placed>(c: Placed, l: L): L {
  if (!c.rotate && !c.flipX && !c.flipY) return { ...l, x: l.x - c.x, y: l.y - c.y };
  const m = into(c, { x: l.x + l.w / 2, y: l.y + l.h / 2 });
  const r = turn((mirrored(c) ? -1 : 1) * ((l.rotate ?? 0) - (c.rotate ?? 0)));
  return { ...l, x: round(m.x - l.w / 2), y: round(m.y - l.h / 2), rotate: r || undefined, flipX: !!l.flipX !== !!c.flipX || undefined, flipY: !!l.flipY !== !!c.flipY || undefined };
}

/** The layers of container `scope` (null: the frame's own) as they lie in the frame; [] when there is no such container. */
export function scopeLayers(layers: readonly Layer[], scope: string | null): Layer[] {
  if (!scope) return layers as Layer[];
  const path = pathTo(layers, scope);
  const c = path && findLayer(path.at(-1)?.layers ?? layers, scope);
  if (!path || !isGroup(c)) return [];
  const chain = [...path, c].reverse();
  return c.layers.map((l) => chain.reduce((m, g) => layerOut(g, m), l));
}

/** A layer as it lies in the frame (through every container round it). */
export function inFrame(layers: readonly Layer[], id: string): Layer | undefined {
  const path = pathTo(layers, id);
  const l = path ? findLayer(path.at(-1)?.layers ?? layers, id) : undefined;
  return l && [...path!].reverse().reduce((m, g) => layerOut(g, m), l);
}

/** `inner`, as they lie in the frame, made the layers of container `scope` again (scopeLayers undone); its plain groups then keep to their layers (hug). */
export function withScope(layers: readonly Layer[], scope: string | null, inner: readonly Layer[]): Layer[] {
  if (!scope) return hug(inner);
  const path = pathTo(layers, scope);
  const c = path && findLayer(path.at(-1)?.layers ?? layers, scope);
  if (!path || !isGroup(c)) return layers as Layer[];
  const chain = [...path, c];
  return hug(editIn(layers, scope, () => inner.map((l) => chain.reduce((m, g) => layerIn(g, m), l))));
}

/**
 * The mask each layer of a list is cut by: a mask cuts the layers above it up to the next mask, a hidden one cuts
 * nothing. None in a boolean group (`combined`): its layers are its shape.
 */
export function masksOf(list: readonly Layer[], combined = false): Map<string, Layer> {
  const out = new Map<string, Layer>();
  let on: Layer | null = null;
  for (const l of combined ? [] : list) {
    if (l.mask) on = l.hidden ? null : l;
    else if (on) out.set(l.id, on);
  }
  return out;
}

/** A layer's box as it is seen among the layers of its list: one a mask cuts, only where the mask's box is too. */
export function seenBox(list: readonly Layer[], l: Layer): Rect {
  const b = boundsOf([l]);
  const m = masksOf(list).get(l.id);
  if (!m) return b;
  const c = boundsOf([m]);
  const x = Math.max(b.x, c.x);
  const y = Math.max(b.y, c.y);
  const w = Math.min(b.x + b.w, c.x + c.w) - x;
  const h = Math.min(b.y + b.h, c.y + c.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : { x: c.x, y: c.y, w: 0, h: 0 };
}

/**
 * The box round what a plain group draws: its layers' (a layer a mask cuts is seen only in the mask's box, so a group
 * with a mask at the bottom is the mask's box), or a boolean group's shape's (its shown layers, the bottom one alone
 * when the rest are taken from it, where they all overlap when only that is kept), in its own pixels.
 */
export function shapeBounds(g: GroupLayer): Rect {
  const shown = g.layers.filter((l) => !l.hidden);
  const cut = g.boolean ? null : masksOf(g.layers);
  const ls = g.boolean && shown.length ? shown : cut?.size ? g.layers.filter((l) => !cut.has(l.id)) : g.layers;
  if (g.boolean === "subtract") return boundsOf(ls.slice(0, 1));
  if (g.boolean !== "intersect") return boundsOf(ls);
  const all = ls.map((k) => boundsOf([k]));
  const x = Math.max(...all.map((b) => b.x));
  const y = Math.max(...all.map((b) => b.y));
  // nothing overlaps: a pixel where the bottom one starts, so the group is never of no size
  const w = Math.min(...all.map((b) => b.x + b.w)) - x;
  const h = Math.min(...all.map((b) => b.y + b.h)) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : { x: all[0]!.x, y: all[0]!.y, w: 1, h: 1 };
}

/**
 * Every plain group kept to its layers: its box made the box round them (they keep their place in the frame), and one
 * with no layer left taken out (a boolean group: the box round its shape, shapeBounds). A box keeps its own size. The
 * same list when nothing changed.
 */
export function hug(layers: readonly Layer[]): Layer[] {
  return mapLayers(layers, (l) => {
    if (!isGroup(l) || l.box) return l;
    // an instance waiting for its main's layers keeps its place (lib/design/components.ts)
    if (!l.layers.length) return l.instance ? l : null;
    const b = shapeBounds(l);
    if (Math.abs(b.x) < 0.02 && Math.abs(b.y) < 0.02 && Math.abs(b.w - l.w) < 0.02 && Math.abs(b.h - l.h) < 0.02) return l;
    const m = outOf(l, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    return { ...l, x: round(m.x - b.w / 2), y: round(m.y - b.h / 2), w: round(b.w), h: round(b.h), layers: l.layers.map((k) => ({ ...k, x: round(k.x - b.x), y: round(k.y - b.y) })) };
  });
}
/**
 * Layers (siblings, in the frame's pixels as scopeLayers gives them) made one container in their place: a plain group,
 * or with `box` a box round them. It lies where the frontmost of them was, they keep their order and their place in
 * the frame. Gives the container's layers as the scope's new list, or null when fewer than one is given.
 */
export function wrap(inner: readonly Layer[], ids: readonly string[], id: string, box = false): Layer[] | null {
  const mine = inner.filter((l) => ids.includes(l.id));
  if (!mine.length) return null;
  const b = boundsOf(mine);
  const g: GroupLayer = { id, type: "group", x: round(b.x), y: round(b.y), w: round(b.w), h: round(b.h), layers: mine.map(({ group: _old, ...l }) => ({ ...l, x: round(l.x - b.x), y: round(l.y - b.y) }) as Layer), ...(box ? { box: true } : {}) };
  const rest = inner.filter((l) => !ids.includes(l.id));
  // the layers under the frontmost picked one that are not picked stay under the container
  const under = inner.indexOf(mine.at(-1)!) - (mine.length - 1);
  return [...rest.slice(0, under), g, ...rest.slice(under)];
}

/**
 * Layer `id` of a scope's layers (siblings, as scopeLayers gives them) made a mask of the layer just above it, the two
 * in a plain group `gid` of their own: in an auto layout box the group is one place in the flow, so the mask never lies
 * beside what it cuts. Null when nothing lies above it.
 */
export function maskWithNext(inner: readonly Layer[], id: string, gid: string): Layer[] | null {
  const at = inner.findIndex((l) => l.id === id);
  const next = at < 0 ? undefined : inner[at + 1];
  const out = next && !next.mask ? wrap(inner, [id, next.id], gid) : null;
  return out && out.map((l) => (l.id === gid && isGroup(l) ? { ...l, layers: l.layers.map((k) => (k.id === id ? ({ ...k, mask: "alpha" } as Layer) : k)) } : l));
}

/**
 * Containers taken apart (siblings in the frame's pixels): each one's layers lie where it was, where they are, in its
 * place in the order. What the container was is kept by them: its fade (times their own), hidden, locked, and its blend
 * on those that have none (each then blends alone, which is near what the whole did).
 */
const unmasked = ({ mask: _m, ...rest }: Layer): Layer => rest as Layer;
export function unwrap(inner: readonly Layer[], ids: readonly string[]): Layer[] {
  return inner.flatMap((l, i) => {
    if (!isGroup(l) || !ids.includes(l.id)) return [l];
    const o = l.opacity ?? 1;
    // a mask freed from it would cut the layers after the group too: it stays a mask only when none come after (or a
    // mask of their own starts there), else it is a plain layer again
    const ends = i === inner.length - 1 || !!inner[i + 1]?.mask;
    return l.layers.map((k): Layer => ({
      ...layerOut(l, k.mask && !ends ? unmasked(k) : k),
      ...(o < 1 ? { opacity: round((k.opacity ?? 1) * o) } : {}),
      ...(l.hidden ? { hidden: true } : {}),
      ...(l.locked ? { locked: true } : {}),
      ...(l.blend && !k.blend ? { blend: l.blend } : {}),
    }));
  });
}

/**
 * The number a frame's next new layer id starts from (l<n>): past its `next` and every l<n> it has, so an id is never
 * given again once a layer had it (another window, an AI, an instance's override may still name it).
 */
export const nextOf = (p: Pick<DesignPage, "layers" | "next">): number => Math.max(Math.min(p.next ?? 0, 1_000_000), ...everyLayer(p.layers).map((l) => idNumber(l.id) + 1));

/** Frames after a change, each that changed with `next` past every id it or its version before had (nextOf). The same list when none needs it. */
export function keepNext<P extends DesignPage>(pages: P[], was: readonly DesignPage[]): P[] {
  let changed = false;
  const out = pages.map((p) => {
    const q = was.find((x) => x.id === p.id);
    if (!q || q === p) return p;
    const n = Math.max(nextOf(p), nextOf(q));
    return n === (p.next ?? 0) || n === nextOf({ layers: p.layers }) ? p : ((changed = true), { ...p, next: n });
  });
  return changed ? out : pages;
}

/** What a frame had before a write: its nextOf and its layers' ids (an id below `next` it no longer has was another layer's). */
export interface IdsBefore {
  next: number;
  ids: ReadonlySet<string>;
}
export const idsBefore = (p: DesignPage | undefined): IdsBefore | undefined => p && { next: nextOf(p), ids: new Set(everyLayer(p.layers).map((l) => l.id)) };

/**
 * The id a layer coming into a frame gets: the one asked for when `ok` takes it, no layer has it and it was no other
 * layer's before (`before`), else l<n> from `from` and past the frame's next. `added`: the layer is new, so an id the
 * frame had (one taken out in this same write too) is another layer's; else it may be its own, kept.
 */
export function takeId(asked: unknown, taken: ReadonlySet<string>, ok: (id: string) => boolean, before?: IdsBefore, from = 1, added = false, own = false): string {
  // `own`: the layers are the person's window's, which never gives an id twice (keepNext): one below `next` is its own layer back (undone)
  const reused = (id: string) => {
    if (own) return false;
    const n = idNumber(id);
    return !!before && ((added && before.ids.has(id)) || (n > 0 && n < before.next && !before.ids.has(id)));
  };
  // and never one far past what the frame counts to (an asked l999999 would use up its ids)
  // (the person's window's own ids are its own: a copied frame keeps its layers' l45)
  const far = (id: string) => !own && !before?.ids.has(id) && idNumber(id) > Math.max(before?.next ?? 0, ...[...taken].map(idNumber)) + DESIGN_LIMITS.layers;
  if (typeof asked === "string" && ok(asked) && !taken.has(asked) && !reused(asked) && !far(asked)) return asked;
  for (let n = Math.max(from, Math.min(before?.next ?? 0, 1_000_000)); ; n++) if (!taken.has(`l${n}`)) return `l${n}`;
}

/** Ids a frame does not use yet, however deep (nor any in `also`), from `floor` up (its nextOf): l1, l2 … */
export function freshLayerIds(layers: readonly Layer[], count: number, also: readonly string[] = [], floor = 0): string[] {
  const all = everyLayer(layers);
  const taken = new Set([...all.map((l) => l.id), ...also]);
  const out: string[] = [];
  // past the highest l<n> it has, so one taken out in the middle is never given again (another window may still edit it)
  const top = Math.max(all.length, Math.min(floor, 1_000_000) - 1, ...[...taken].map(idNumber));
  for (let n = top + 1; out.length < count; n++) if (!taken.has(`l${n}`)) out.push(`l${n}`);
  return out;
}

/** Layers coming into a frame (pasted, duplicated), every layer inside them given an id the frame does not use. `ids`: the top ones' (as freshLayerIds gave them). */
export function reid(coming: readonly Layer[], ids: readonly string[], frame: readonly Layer[]): Layer[] {
  const inner = everyLayer(coming).length - coming.length;
  const more = freshLayerIds(frame, inner, ids);
  let n = 0;
  const deep = (l: Layer): Layer => (isGroup(l) ? { ...l, layers: l.layers.map((k) => deep({ ...k, id: more[n++]! })) } : l);
  return coming.map((l, i) => deep({ ...l, id: ids[i]! }));
}

/**
 * A frame as the canvas and the panels work on it while a container is open: its `layers` are that container's, as they
 * lie in the frame, and `scope` says which, so a change made to it goes back there (unscope). The frame itself when
 * `scope` is null.
 */
export type Scoped = DesignPage & { scope?: string };
export const inScope = <P extends DesignPage>(p: P, scope: string | null): P => (scope ? { ...p, scope, layers: scopeLayers(p.layers, scope) } : p);
/** Frames changed through inScope made whole again: each one's layers put back into its container, in the frame as `now` has it. */
export function unscope<P extends DesignPage>(next: readonly P[], now: readonly DesignPage[]): P[] {
  return next.map((p) => {
    const { scope, ...rest } = p as P & Scoped;
    if (!scope) return p;
    const real = now.find((r) => r.id === p.id);
    return { ...rest, layers: real ? withScope(real.layers, scope, p.layers) : hug(p.layers) } as unknown as P;
  });
}

/**
 * Where layers dragged on their frame belong, by the point their middle is let go at (frame pixels): the deepest box
 * (frame-like container) under it, or the container they are in while it is still under it (as it was when the drag
 * began), else the frame's own layers (null). Never a container among them or inside one of them, a hidden or locked
 * one, or one that would take containers past DESIGN_LIMITS-style `depth`.
 */
export function dropInto(layers: readonly Layer[], ids: readonly string[], mid: { x: number; y: number }, scope: string | null, depth: number): string | null {
  const moving = ids.map((id) => findLayer(layers, id)).filter((l): l is Layer => !!l);
  // what is bigger than a box never goes into it (a background nudged under a card stays the background)
  const size = boundsOf(moving.map((l) => inFrame(layers, l.id)!));
  const tall = depthOf(moving);
  let best: { id: string; deep: number } | null = null;
  for (const g of everyLayer(layers)) {
    if (!isGroup(g) || (!g.box && g.id !== scope)) continue;
    const path = pathTo(layers, g.id) ?? [];
    if ([g, ...path].some((c) => ids.includes(c.id) || c.hidden || c.locked) || path.length + 1 + tall > depth) continue;
    const f = inFrame(layers, g.id)!;
    if (g.id !== scope && (size.w > f.w || size.h > f.h)) continue;
    const p = into(f, mid);
    if (p.x < 0 || p.y < 0 || p.x > f.w || p.y > f.h) continue;
    if (!best || path.length >= best.deep) best = { id: g.id, deep: path.length };
  }
  return best?.id ?? null;
}

/** Layers moved into container `to` (null: the frame's own layers), on top of its layers, staying where they are on the frame. */
export function moveInto(layers: readonly Layer[], ids: readonly string[], to: string | null): Layer[] {
  const out = ids.map((id) => inFrame(layers, id)).filter((l): l is Layer => !!l);
  const rest = mapLayers(layers, (l) => (ids.includes(l.id) ? null : l));
  return withScope(rest, to, [...scopeLayers(rest, to), ...out]);
}

/**
 * Layer `id` moved in frame `p`'s layers beside layer `by` (in front of it, or behind it with `behind`), or into container
 * `by` on top of its layers: it stays where it is on the frame. Null when it cannot go there (into itself, or containers
 * deeper than they may go).
 */
export function moveRow(p: DesignPage, id: string, by: string, how: "front" | "behind" | "into"): DesignPage | null {
  const parent = how === "into" ? by : (parentOf(p.layers, by)?.id ?? null);
  const me = p.layers.length ? inFrame(p.layers, id) : undefined;
  if (!me || id === by || (parent && (parent === id || pathTo(p.layers, parent)?.some((g) => g.id === id)))) return null;
  if ((parent ? (pathTo(p.layers, parent)?.length ?? 0) + 1 : 0) + depthOf([me]) > DESIGN_LIMITS.depth) return null;
  const rest = mapLayers(p.layers, (l) => (l.id === id ? null : l));
  const inner = scopeLayers(rest, parent);
  const at = inner.findIndex((l) => l.id === by);
  inner.splice(how === "into" ? inner.length : how === "front" ? at + 1 : at, 0, me);
  return { ...p, layers: withScope(rest, parent, inner) };
}
