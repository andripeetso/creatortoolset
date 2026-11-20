import { INSTANCE_FIXED, INSTANCE_FROM_MAIN, type DesignInstance, type DesignPage, type GroupLayer, type Layer } from "../../../contracts/design";
import { fitContents } from "./resize";
import { retext } from "./runs";
import { everyLayer, isGroup, mapLayers } from "./tree";

/**
 * Components (contracts/design.ts GroupLayer `component`, `instance`): a badge, a handle pill or a slide number made once
 * as a main, placed on every slide as instances that follow it. A main lies on the canvas like any group. An instance
 * is a group whose layers are kept as its main makes them, so drawing, picking, layout, exports and the server's
 * pictures need nothing of their own: every change goes through syncInstances, which makes each instance again from its
 * main, its property values and its overrides, and keeps what was changed on an instance's layers as its overrides.
 * Plain functions the browser and the server both read. No DOM here.
 */

export type Main = GroupLayer & { component: string };
export type Instance = GroupLayer & { instance: DesignInstance };
export const isMain = (l: Layer | null | undefined): l is Main => isGroup(l) && typeof l.component === "string" && !l.instance;
export const isInstance = (l: Layer | null | undefined): l is Instance => isGroup(l) && !!l.instance && typeof l.instance.of === "string";
/** Whether any frame has a main or an instance (else syncInstances has nothing to do). */
export const usesComponents = (pages: readonly DesignPage[]): boolean => pages.some((p) => everyLayer(p.layers).some((l) => isGroup(l) && (l.component !== undefined || !!l.instance)));

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const FIXED = new Set(INSTANCE_FIXED);
const FROM_MAIN = new Set(INSTANCE_FROM_MAIN);
const MAIN_ONLY = ["component", "set", "variant"];
type Rec = Record<string, unknown>;

/** Every main of the design by its key, with the frame it lies on: the first of a key in the frames' order. */
export function mainsOf(pages: readonly DesignPage[]): Map<string, { page: string; main: Main }> {
  const out = new Map<string, { page: string; main: Main }>();
  for (const p of pages) for (const l of everyLayer(p.layers)) if (isMain(l) && !out.has(l.component)) out.set(l.component, { page: p.id, main: l });
  return out;
}

/** The mains of a design and the ones made so far (null: being made, so an instance of it inside it is a loop). */
interface Made {
  mains: Map<string, Main>;
  made: Map<string, Main | null>;
}
const madeFrom = (pages: readonly DesignPage[]): Made => ({ mains: new Map([...mainsOf(pages)].map(([k, v]) => [k, v.main])), made: new Map() });

/** A main with the instances inside it made; undefined when there is none of that key, or it is being made (a loop). */
function madeMain(key: string, c: Made): Main | undefined {
  if (c.made.has(key)) return c.made.get(key) ?? undefined;
  const m = c.mains.get(key);
  if (!m) return undefined;
  c.made.set(key, null);
  const out = { ...m, layers: mapLayers(m.layers, (l) => (isInstance(l) ? make(l, c) : l)) };
  c.made.set(key, out);
  return out;
}

/** A layer's fields `ov` says, where `ok` lets them (null takes a field away); its runs move with new words. */
function overridden<L extends Layer>(l: L, ov: Rec | undefined, ok: (f: string) => boolean): L {
  if (!ov || typeof ov !== "object") return l;
  let n = { ...l } as Rec;
  if (l.type === "text" && typeof ov.text === "string" && !("runs" in ov)) n = retext(l, ov.text) as unknown as Rec;
  for (const [f, v] of Object.entries(ov)) {
    if (!ok(f) || (f === "instance" && !(isInstance(l) && v && typeof v === "object" && typeof (v as Rec).of === "string"))) continue;
    if (v === null) delete n[f];
    else n[f] = v;
  }
  return n as L;
}

/** A layer of a main showing an instance's property values (Box `bind`). */
function withProps(l: Layer, props: Record<string, string | boolean>): Layer {
  const b = l.bind;
  if (!b) return l;
  let n = l;
  const t = b.text ? props[b.text] : undefined;
  if (typeof t === "string" && n.type === "text") n = retext(n, t);
  const v = b.visible ? props[b.visible] : undefined;
  if (typeof v === "boolean") n = { ...n, hidden: v ? undefined : true };
  const s = b.swap ? props[b.swap] : undefined;
  if (typeof s === "string" && isInstance(n)) n = { ...n, instance: { ...n.instance, of: s } };
  return n;
}

/**
 * An instance made from its main: the main's layers (ids `<instance id>.<main layer id>`) showing its property values and
 * its overrides, its own place and fade, its main's size unless it was given its own (its layers then follow the main's
 * pins). Kept as it is when its main is not in the design or would hold itself.
 */
function make(inst: Instance, c: Made): Instance {
  const m = madeMain(inst.instance.of, c);
  if (!m) return inst;
  const pre = `${inst.id}.`;
  const o = inst.instance.overrides ?? {};
  const props = inst.instance.props ?? {};
  // what the layout worked out (a hugging or filling side, a place in a flow) is kept as the instance's layers have it:
  // the layout makes it again from there, and an instance made again with nothing changed is the same as it was
  const had = new Map(everyLayer(inst.layers).map((l) => [l.id, l as unknown as Rec]));
  const laidOut = <L extends Layer>(n: L, was: Rec | undefined, inFlow: boolean): L => {
    if (!was) return n;
    const out = { ...n } as Rec;
    for (const ax of ["w", "h"] as const) if (n.sizing?.[ax] && typeof was[ax] === "number") out[ax] = was[ax];
    if (inFlow && !n.absolute && typeof was.x === "number" && typeof was.y === "number") ((out.x = was.x), (out.y = was.y));
    return out as L;
  };
  const flowing = (g: Layer) => isGroup(g) && !!g.box && !!g.layout;
  const copy = (l: Layer, inFlow: boolean): Layer => {
    let n = { ...l, id: pre + l.id } as Layer;
    for (const f of MAIN_ONLY) delete (n as Rec)[f];
    n = laidOut(overridden(withProps(n, props), o[l.id], (f) => !FIXED.has(f)), had.get(pre + l.id), inFlow);
    // a nested instance shown as another main (a swap, a property) is made from that one
    if (isInstance(n) && isInstance(l) && !same(n.instance, l.instance)) return overridden(make({ ...n, layers: [] }, c), o[l.id], (f) => !FIXED.has(f) && f !== "instance");
    return isGroup(n) && isGroup(l) ? { ...n, layers: l.layers.map((k) => copy(k, flowing(l))) } : n;
  };
  const root: Rec = {};
  for (const [f, v] of Object.entries(inst)) if (!FROM_MAIN.has(f) && !MAIN_ONLY.includes(f)) root[f] = v;
  for (const f of FROM_MAIN) if ((m as Rec)[f] !== undefined) root[f] = (m as Rec)[f];
  const out = overridden({ ...root, type: "group", layers: m.layers.map((k) => copy(k, flowing(m))) } as unknown as Instance, o[""], (f) => FROM_MAIN.has(f));
  // given a size of its own, its layers follow the main's pins to it
  if (o[""] && ("w" in o[""] || "h" in o[""])) return fitContents(m, out);
  return laidOut(out, inst as unknown as Rec, false);
}

/** What was changed on an instance's own layers since `before` (by the person, by an AI), kept as its overrides and property values. */
function noticed(inst: Instance, c: Made, before: ReadonlyMap<string, Layer>): Instance {
  // one with no layers yet is being placed, one that was not there is a copy (pasted, duplicated, a frame copied in
  // another size): nothing of it was changed, its overrides go with it
  if (!inst.layers.length || !before.has(inst.id)) return inst;
  // shown as another main now (a variant, a swap): its overrides go to the layers named alike there
  const old = before.get(inst.id);
  if (isInstance(old) && old.instance.of !== inst.instance.of && c.mains.has(inst.instance.of)) {
    const { overrides, ...rest } = inst.instance;
    const moved = overrides ? remapped(overrides, c.mains.get(old.instance.of), c.mains.get(inst.instance.of)!) : {};
    return { ...inst, layers: [], instance: { ...rest, ...(Object.keys(moved).length ? { overrides: moved } : {}) } };
  }
  const want = make(inst, c);
  if (want === inst) return inst;
  const pre = `${inst.id}.`;
  const made = new Map(everyLayer([want]).map((l) => [l.id, l]));
  const overrides: Record<string, Rec> = Object.fromEntries(Object.entries(inst.instance.overrides ?? {}).map(([k, v]) => [k, { ...v }]));
  const props = { ...inst.instance.props };
  let changed = false;
  const look = (l: Layer, key: string, ok: (f: string) => boolean) => {
    const w = made.get(l.id) as Rec | undefined;
    if (!w) return;
    const p = before.get(l.id) as Rec | undefined;
    const r = l as unknown as Rec;
    for (const f of new Set([...Object.keys(r), ...Object.keys(w)])) {
      const v = r[f];
      if (!ok(f) || same(v, w[f]) || (p && same(v, p[f]))) continue;
      changed = true;
      const b = l.bind;
      const swapped = f === "instance" && b?.swap && isInstance(l) && isInstance(w as unknown as Layer) && same({ ...l.instance, of: (w as unknown as Instance).instance.of }, (w as unknown as Instance).instance);
      if (f === "text" && b?.text && typeof v === "string") props[b.text] = v;
      else if (f === "hidden" && b?.visible) props[b.visible] = !v;
      else if (swapped) props[b!.swap!] = (l as Instance).instance.of;
      else (overrides[key] ??= {})[f] = v === undefined ? null : v;
    }
  };
  // its own size only when it is a box of a size of its own on that side: a plain group's is the box round its layers, a
  // hugging or filling side the layout's
  const sized = (f: string) => (f !== "w" && f !== "h") || (!!want.box && !want.sizing?.[f as "w" | "h"]);
  look(inst, "", (f) => FROM_MAIN.has(f) && sized(f));
  const walk = (ls: readonly Layer[]) => {
    for (const l of ls) {
      if (!l.id.startsWith(pre)) continue;
      look(l, l.id.slice(pre.length), (f) => !FIXED.has(f));
      // a nested instance's own layers are its own: what changed there is its overrides (it was looked at first)
      if (isGroup(l) && !isInstance(l)) walk(l.layers);
    }
  };
  walk(inst.layers);
  // overrides of layers its main no longer has go
  for (const k of Object.keys(overrides)) if (k && !made.has(pre + k)) (delete overrides[k], (changed = true));
  if (!changed) return inst;
  const { overrides: _o, props: _p, ...rest } = inst.instance;
  return { ...inst, instance: { ...rest, ...(Object.keys(props).length ? { props } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) } };
}

/** A main copied (pasted, duplicated) is an instance of it: of each key the main kept is the one that was there before (`was`), else the first. */
function copiesOfMains<P extends DesignPage>(pages: readonly P[], was?: readonly DesignPage[]): P[] {
  const before = new Set(was?.flatMap((p) => everyLayer(p.layers).flatMap((l) => (isMain(l) ? [`${p.id}/${l.id}/${l.component}`] : []))));
  const keeper = new Map<string, string>();
  for (const p of pages) for (const l of everyLayer(p.layers)) if (isMain(l) && before.has(`${p.id}/${l.id}/${l.component}`)) keeper.set(l.component, `${p.id}/${l.id}`);
  for (const p of pages) for (const l of everyLayer(p.layers)) if (isMain(l) && !keeper.has(l.component)) keeper.set(l.component, `${p.id}/${l.id}`);
  let changed = false;
  const out = pages.map((p) => {
    const layers = mapLayers(p.layers, (l) => {
      if (!isMain(l) || keeper.get(l.component) === `${p.id}/${l.id}`) return l;
      const { component, set: _s, variant: _v, ...rest } = l;
      return { ...rest, instance: { of: component } };
    });
    return layers === p.layers ? p : ((changed = true), { ...p, layers });
  });
  return changed ? out : (pages as P[]);
}

/**
 * Every instance of a design made again from its main (make). `was`: the frames before this change, when it is a change
 * (the person's, an AI's): what was changed since on an instance's own layers is kept as its overrides (its words or
 * its showing, on a layer bound to a property: that property's value), and a main copied is an instance of it. Without
 * `was` (a design loaded, frames merged, undone) the instances are only made again. The same list when nothing changed.
 */
export function syncInstances<P extends DesignPage>(pages: readonly P[], was?: readonly DesignPage[]): P[] {
  if (!usesComponents(pages)) return pages as P[];
  let out = was ? copiesOfMains(pages, was) : (pages as P[]);
  if (was) {
    const c = madeFrom(out);
    out = out.map((p) => {
      const b = was.find((q) => q.id === p.id);
      const before = new Map(b ? everyLayer(b.layers).map((l) => [l.id, l]) : []);
      const layers = mapLayers(p.layers, (l) => (isInstance(l) ? noticed(l, c, before) : l));
      return layers === p.layers ? p : { ...p, layers };
    });
  }
  const c = madeFrom(out);
  let changed = out !== pages;
  const made = out.map((p) => {
    const layers = mapLayers(p.layers, (l) => {
      if (!isInstance(l)) return l;
      const n = make(l, c);
      return same(n, l) ? l : n;
    });
    return layers === p.layers ? p : ((changed = true), { ...p, layers });
  });
  return changed ? made : (pages as P[]);
}

/** The names from a main down to one of its layers ("Badge/Label"): how a layer is found again in another variant. */
function namePath(layers: readonly Layer[], id: string, at: string[] = []): string[] | null {
  for (const l of layers) {
    const here = [...at, l.name ?? l.type];
    if (l.id === id) return here;
    if (isGroup(l) && !isInstance(l)) {
      const p = namePath(l.layers, id, here);
      if (p) return p;
    }
  }
  return null;
}
function byPath(layers: readonly Layer[], path: readonly string[]): string | null {
  const [head, ...rest] = path;
  const l = layers.find((k) => (k.name ?? k.type) === head);
  if (!l) return null;
  return rest.length ? (isGroup(l) ? byPath(l.layers, rest) : null) : l.id;
}

/** An instance's overrides for another main: each kept where that main has a layer of the same names down to it. */
function remapped(overrides: Record<string, Rec>, from: Main | undefined, to: Main): Record<string, Rec> {
  const out: Record<string, Rec> = {};
  for (const [k, v] of Object.entries(overrides)) {
    const path = k && from ? namePath(from.layers, k) : null;
    const nk = k ? path && byPath(to.layers, path) : "";
    if (nk !== null) out[nk] = v;
  }
  return out;
}

/** The variants of the set a main is in, with the set's properties and each one's values in the order first met. Just the main when it is in no set. */
export function variantsOf(key: string, pages: readonly DesignPage[]): { set?: string; members: Main[]; props: Map<string, string[]> } {
  const mains = [...mainsOf(pages).values()].map((v) => v.main);
  const me = mains.find((m) => m.component === key);
  const members = me?.set ? mains.filter((m) => m.set === me.set) : me ? [me] : [];
  const props = new Map<string, string[]>();
  for (const m of members) for (const [k, v] of Object.entries(m.variant ?? {})) if (!(props.get(k) ?? props.set(k, []).get(k)!).includes(v)) props.get(k)!.push(v);
  return { set: me?.set, members, props };
}

/** The main of a set that has `prop` = `value` and as many of the current one's other values as can be; null when none has it. */
export function variantWith(key: string, prop: string, value: string, pages: readonly DesignPage[]): string | null {
  const { members } = variantsOf(key, pages);
  const now = members.find((m) => m.component === key)?.variant ?? {};
  const fits = members.filter((m) => m.variant?.[prop] === value);
  const score = (m: Main) => Object.entries(now).filter(([k, v]) => k !== prop && m.variant?.[k] === v).length;
  return fits.sort((a, b) => score(b) - score(a))[0]?.component ?? null;
}

/** The properties a main's layers are bound to (Box `bind`), with the kind of each and its value as the main has it; a nested instance's own are its own. */
export function propsOf(main: GroupLayer): { name: string; kind: "text" | "visible" | "swap"; value: string | boolean }[] {
  const out: { name: string; kind: "text" | "visible" | "swap"; value: string | boolean }[] = [];
  const add = (name: string | undefined, kind: "text" | "visible" | "swap", value: string | boolean) => name && !out.some((p) => p.name === name) && out.push({ name, kind, value });
  const walk = (ls: readonly Layer[]) => {
    for (const l of ls) {
      if (l.type === "text") add(l.bind?.text, "text", l.text);
      add(l.bind?.visible, "visible", !l.hidden);
      if (isInstance(l)) add(l.bind?.swap, "swap", l.instance.of);
      if (isGroup(l) && !isInstance(l)) walk(l.layers);
    }
  };
  walk(main.layers);
  return out;
}

/** An instance made plain layers: it no longer follows its main (instances inside it stay instances). */
export function detached(inst: Instance): GroupLayer {
  const { instance: _i, ...rest } = inst;
  return rest;
}

/** A key no main of the design has: c1, c2 … */
export function freshKey(pages: readonly DesignPage[]): string {
  const taken = new Set(pages.flatMap((p) => everyLayer(p.layers).flatMap((l) => (isGroup(l) && l.component ? [l.component] : []))));
  let n = 1;
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

/** The instance a layer lies in (the innermost), or null. */
export const instanceAround = (path: readonly GroupLayer[]): Instance | null => ([...path].reverse().find(isInstance) as Instance | undefined) ?? null;

/**
 * What a design's components break, said and mended before it is kept: past the limit of mains, a main inside an instance
 * or holding (through its layers or others) an instance of itself, an instance of a main the design does not have.
 */
export function componentCheck<P extends DesignPage>(pages: readonly P[], limit: number): { pages: P[]; notes: string[] } {
  const notes: string[] = [];
  const mains = mainsOf(pages);
  const keys = [...mains.keys()];
  const over = new Set(keys.slice(limit));
  if (over.size) notes.push(`a design holds at most ${limit} components: ${[...over].join(", ")} made plain groups`);
  // which mains each main shows, through its instances (and the instances in those)
  const seen = new Map<string, Set<string>>();
  const shows = (key: string): Set<string> => {
    if (seen.has(key)) return seen.get(key)!;
    const out = new Set<string>();
    seen.set(key, out);
    for (const l of everyLayer(mains.get(key)?.main.layers ?? [])) if (isInstance(l) && !out.has(l.instance.of)) [l.instance.of, ...shows(l.instance.of)].forEach((k) => out.add(k));
    return out;
  };
  /** `inside`: the keys of the mains these layers lie in. */
  const mend = (p: DesignPage, ls: readonly Layer[], inside: readonly string[]): Layer[] =>
    ls.flatMap((l): Layer[] => {
      if (!isGroup(l)) return [l];
      if (isInstance(l)) {
        const loop = inside.find((k) => k === l.instance.of || shows(l.instance.of).has(k));
        if (loop) return notes.push(`frame ${p.id}, layer ${l.id}: an instance of "${l.instance.of}" inside main "${loop}", which it would hold: left out`), [];
        if (!mains.has(l.instance.of)) notes.push(`frame ${p.id}, layer ${l.id}: an instance of "${l.instance.of}", which this design has no main component of: kept as it was${l.layers.length ? "" : " (nothing to draw)"}`);
        return [l];
      }
      if (isMain(l) && over.has(l.component)) {
        const { component: _c, set: _s, variant: _v, ...rest } = l;
        return [{ ...rest, layers: mend(p, l.layers, inside) }];
      }
      const layers = mend(p, l.layers, isMain(l) ? [...inside, l.component] : inside);
      return [same(layers, l.layers) ? l : { ...l, layers }];
    });
  const out = pages.map((p) => {
    const layers = mend(p, p.layers, []);
    return same(layers, p.layers) ? p : { ...p, layers };
  });
  return { pages: out, notes };
}

/** An instance's overrides and property values as its layers now are (after a check clamped or dropped what an override gave). */
export function overridesAsKept<P extends DesignPage>(pages: readonly P[]): P[] {
  return pages.map((p) => {
    const layers = mapLayers(p.layers, (l) => {
      if (!isInstance(l) || !l.instance.overrides) return l;
      const pre = `${l.id}.`;
      const byId = new Map(everyLayer(l.layers).map((k) => [k.id, k as unknown as Rec]));
      const overrides: Record<string, Rec> = {};
      for (const [k, ov] of Object.entries(l.instance.overrides)) {
        const at = k ? byId.get(pre + k) : (l as unknown as Rec);
        if (!at) continue;
        const kept: Rec = {};
        for (const [f, v] of Object.entries(ov)) {
          if (at[f] !== undefined) kept[f] = at[f];
          else if (v === null) kept[f] = null;
        }
        if (Object.keys(kept).length) overrides[k] = kept;
      }
      if (same(overrides, l.instance.overrides)) return l;
      const { overrides: _o, ...rest } = l.instance;
      return { ...l, instance: { ...rest, ...(Object.keys(overrides).length ? { overrides } : {}) } };
    });
    return layers === p.layers ? p : { ...p, layers };
  });
}
