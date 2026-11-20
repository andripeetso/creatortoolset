import { DESIGN_LIMITS, INSTANCE_FIXED, INSTANCE_FROM_MAIN, type DesignInstance, type DesignPage, type GroupLayer, type Layer } from "../../../contracts/design";
import { fitContents } from "./resize";
import { retext } from "./runs";
import { everyLayer, isGroup, mapLayers, same, stable } from "./tree";

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


/** How many layers one pass may make: what a design can hold many times over, so a component placed inside itself through property values or a hostile write stops. */
const BUDGET = 20_000;
const FIXED = new Set(INSTANCE_FIXED);
const FROM_MAIN = new Set(INSTANCE_FROM_MAIN);
const MAIN_ONLY = ["component", "set", "variant"];
type Rec = Record<string, unknown>;

/** Every main of the design by its key, with the frame it lies on: the first of a key in the frames' order. */
export function mainsOf(pages: readonly DesignPage[]): Map<string, { page: string; main: Main }> {
  const out = new Map<string, { page: string; main: Main }>();
  // never one inside an instance: those layers are a main's copies
  const walk = (p: DesignPage, ls: readonly Layer[]) => {
    for (const l of ls) {
      if (isMain(l) && !out.has(l.component)) out.set(l.component, { page: p.id, main: l });
      if (isGroup(l) && !isInstance(l)) walk(p, l.layers);
    }
  };
  for (const p of pages) walk(p, p.layers);
  return out;
}

/** The mains of a design and the ones made so far (null: being made, so an instance of it inside it is a loop). */
interface Made {
  mains: Map<string, Main>;
  made: Map<string, Main | null>;
  /** layers this pass may still make */
  budget: number;
}
const madeFrom = (pages: readonly DesignPage[]): Made => ({ mains: new Map([...mainsOf(pages)].map(([k, v]) => [k, v.main])), made: new Map(), budget: BUDGET });

/** A main with the instances inside it made; undefined when there is none of that key, or it is being made (a loop). */
function madeMain(key: string, c: Made): Main | undefined {
  if (c.made.has(key)) return c.made.get(key) ?? undefined;
  const m = c.mains.get(key);
  if (!m) return undefined;
  c.made.set(key, null);
  const out = { ...m, layers: mapLayers(m.layers, (l) => (isInstance(l) ? make(l, c, [key]) : l)) };
  c.made.set(key, out);
  return out;
}

/** A layer's fields `ov` says, where `ok` lets them (null takes a field away); its runs move with new words. */
function overridden<L extends Layer>(l: L, ov: Rec | undefined, ok: (f: string) => boolean): L {
  if (!ov || typeof ov !== "object") return l;
  let n = { ...l } as Rec;
  if (l.type === "text" && typeof ov.text === "string" && !("runs" in ov)) n = retext(l, ov.text) as unknown as Rec;
  for (const [f, v] of Object.entries(ov)) {
    if (!ok(f) || (f === "instance" && !(isInstance(l) && v && typeof v === "object" && typeof ((v as Rec).of ?? l.instance.of) === "string"))) continue;
    if (v === null) delete n[f];
    // a nested instance's main or values: onto what its main gives it (its own overrides stay the main's)
    else n[f] = f === "instance" ? { ...(l as unknown as Instance).instance, ...(v as Rec) } : v;
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
function make(inst: Instance, c: Made, chain: readonly string[] = []): Instance {
  // `chain`: the mains being made round it; one shown inside itself (through a swap) or past the depth a design holds stops
  if (chain.includes(inst.instance.of) || chain.length > DESIGN_LIMITS.depth + 1 || c.budget <= 0) return inst;
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
  /** A layer of the main's (`nested`: inside an instance in it, whose properties are its own) as this instance has it: its overrides are flat, by the id it has in the main ("n.x" inside instance n). */
  const copy = (l: Layer, inFlow: boolean, nested = false): Layer => {
    c.budget--;
    let n = { ...l, id: pre + l.id } as Layer;
    for (const f of MAIN_ONLY) delete (n as unknown as Rec)[f];
    n = laidOut(overridden(nested ? n : withProps(n, props), o[l.id], (f) => !FIXED.has(f)), had.get(pre + l.id), inFlow);
    // a nested instance shown as another main (a swap, a property) is made from that one, what this one changes inside it on top
    if (isInstance(n) && isInstance(l) && !same(n.instance, l.instance)) {
      const swapped = overridden(make({ ...n, layers: [] }, c, [...chain, inst.instance.of]), o[l.id], (f) => !FIXED.has(f) && f !== "instance");
      return { ...swapped, layers: mapLayers(swapped.layers, (k) => overridden(k, o[k.id.slice(pre.length)], (f) => !FIXED.has(f))) };
    }
    return isGroup(n) && isGroup(l) ? { ...n, layers: l.layers.map((k) => copy(k, flowing(l), nested || isInstance(l))) } : n;
  };
  const root: Rec = {};
  for (const [f, v] of Object.entries(inst)) if (!FROM_MAIN.has(f) && !MAIN_ONLY.includes(f)) root[f] = v;
  for (const f of FROM_MAIN) if ((m as unknown as Rec)[f] !== undefined) root[f] = (m as unknown as Rec)[f];
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
  // attached again (it was plain layers): what they were changed to is what it changes
  const fresh = !isInstance(old);
  // (only while its layers are still the old main's: a window that switched it sends them made from the new one, its
  // overrides moved already; told by their ids, as a check may have laid them out again)
  const ids = (ls: readonly Layer[]) => everyLayer(ls).map((l) => l.id).join("|");
  if (isInstance(old) && old.instance.of !== inst.instance.of && c.mains.has(inst.instance.of) && ids(inst.layers) === ids(old.layers)) {
    const { overrides, ...rest } = inst.instance;
    const moved = overrides ? remapped(overrides, madeMain(old.instance.of, c), madeMain(inst.instance.of, c) ?? c.mains.get(inst.instance.of)!) : {};
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
    const p = fresh ? undefined : (before.get(l.id) as Rec | undefined);
    const r = l as unknown as Rec;
    for (const f of new Set([...Object.keys(r), ...Object.keys(w)])) {
      const v = r[f];
      // the runs of words that are a property's move with its value: never an override of their own
      if (!ok(f) || same(v, w[f]) || (p && same(v, p[f])) || (f === "runs" && l.bind?.text)) continue;
      const b = l.bind;
      const swapped = f === "instance" && b?.swap && isInstance(l) && isInstance(w as unknown as Layer) && same({ ...l.instance, of: (w as unknown as Instance).instance.of }, (w as unknown as Instance).instance);
      const own = !key.includes(".");
      if (f === "instance" && isInstance(l)) {
        // a nested instance: only which main it shows and its values (what changed in it is kept flat, above)
        const wi = (w as unknown as Instance).instance;
        const rec: Rec = { ...(l.instance.of !== wi.of ? { of: l.instance.of } : {}), ...(!same(l.instance.props, wi.props) ? { props: l.instance.props ?? null } : {}) };
        if (!Object.keys(rec).length) continue;
        if (own && swapped) props[b!.swap!] = l.instance.of;
        else (overrides[key] ??= {}).instance = rec;
      } else if (own && f === "text" && b?.text && typeof v === "string") props[b.text] = v;
      else if (own && f === "hidden" && b?.visible) props[b.visible] = !v;
      else (overrides[key] ??= {})[f] = v === undefined ? null : v;
      changed = true;
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
      // inside a nested instance too: kept here by the id in the main ("n.x"), so the main's own changes still reach it
      if (isGroup(l)) walk(l.layers);
    }
  };
  walk(inst.layers);
  // overrides of layers its main no longer has go
  for (const k of Object.keys(overrides)) if (k && !made.has(pre + k)) (delete overrides[k], (changed = true));
  if (!changed) return inst;
  const { overrides: _o, props: _p, ...rest } = inst.instance;
  return { ...inst, instance: { ...rest, ...(Object.keys(props).length ? { props } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) } };
}

/**
 * A main copied (pasted, duplicated) is an instance of it: of each key the main kept is the one that was there before
 * (`was`), else the first. A second main of a key that is not a copy of the first (made in two windows at once, an AI's
 * with a key the design has) keeps its layers under a key of its own, said.
 */
function copiesOfMains<P extends DesignPage>(pages: readonly P[], was?: readonly DesignPage[], say?: (note: string) => void): P[] {
  const before = new Set(was?.flatMap((p) => everyLayer(p.layers).flatMap((l) => (isMain(l) ? [`${p.id}/${l.id}/${l.component}`] : []))));
  const keeper = new Map<string, { at: string; main: Main }>();
  for (const pass of [true, false])
    for (const p of pages) for (const l of everyLayer(p.layers)) if (isMain(l) && !keeper.has(l.component) && (!pass || before.has(`${p.id}/${l.id}/${l.component}`))) keeper.set(l.component, { at: `${p.id}/${l.id}`, main: l });
  // a copy (and one changed since it was copied) has the same layers in the same places, whatever their looks and ids
  // (and all an instance never changes of a layer: a path's points, an auto layout, a mask…)
  const skeleton = (m: GroupLayer) => stable([m.w, m.h, everyLayer(m.layers).map((k) => [k.name ?? "", Object.fromEntries(Object.entries(k).filter(([f]) => FIXED.has(f) && f !== "id" && f !== "layers"))])]);
  /** A copy of main `k` as an instance of it: what its layers look like that the main's do not, its overrides. */
  const asInstance = (l: Main, k: Main): Instance => {
    const theirs = everyLayer(k.layers);
    const overrides: Record<string, Rec> = {};
    everyLayer(l.layers).forEach((c, n) => {
      const m = theirs[n] as unknown as Rec | undefined;
      if (!m) return;
      const r = c as unknown as Rec;
      for (const f of new Set([...Object.keys(r), ...Object.keys(m)])) if (!FIXED.has(f) && f !== "instance" && !same(r[f], m[f])) (overrides[m.id as string] ??= {})[f] = r[f] === undefined ? null : r[f];
    });
    const { component, set: _s, variant: _v, ...rest } = l;
    return { ...rest, layers: [], instance: { of: component, ...(Object.keys(overrides).length ? { overrides } : {}) } };
  };
  const taken = new Set<string>();
  const fresh = () => {
    let n = 1;
    while (taken.has(`c${n}`) || keeper.has(`c${n}`) || pages.some((p) => everyLayer(p.layers).some((l) => isGroup(l) && (l.component === `c${n}` || l.instance?.of === `c${n}`)))) n++;
    taken.add(`c${n}`);
    return `c${n}`;
  };
  let changed = false;
  // a main made a key of its own: the new instances of its old key are its (made with it, in that window or that write),
  // but for one whose overrides name only the first main's layers
  const moved = new Map<string, { key: string; mine: Set<string>; first: Set<string> }>();
  const placed = new Set(was?.flatMap((p) => everyLayer(p.layers).flatMap((l) => (isInstance(l) ? [`${p.id}/${l.id}`] : []))));
  const out = pages.map((p) => {
    // a frame copied whole (in another size too) keeps its layers' ids: its main is a copy whatever its size
    const copied = !was?.some((q) => q.id === p.id);
    const layers = mapLayers(p.layers, (l) => {
      const k = isMain(l) ? keeper.get(l.component) : undefined;
      if (!isMain(l) || !k || k.at === `${p.id}/${l.id}`) return l;
      if (copied && l.id === k.main.id) {
        const { component, set: _s, variant: _v, ...rest } = l;
        return { ...rest, instance: { of: component } };
      }
      if (skeleton(l) === skeleton(k.main)) return asInstance(l, k.main);
      const key = fresh();
      if (!moved.has(l.component)) moved.set(l.component, { key, mine: new Set(everyLayer(l.layers).map((x) => x.id)), first: new Set(everyLayer(k.main.layers).map((x) => x.id)) });
      say?.(`frame ${p.id}, layer ${l.id}: a second "${l.component}" main is now "${key}"`);
      return { ...l, component: key };
    });
    return layers === p.layers ? p : ((changed = true), { ...p, layers });
  });
  if (!changed) return pages as P[];
  const follows = (l: Instance) => {
    const m = moved.get(l.instance.of)!;
    const keys = Object.keys(l.instance.overrides ?? {}).filter(Boolean);
    return !(keys.length && keys.every((k) => m.first.has(k)) && !keys.every((k) => m.mine.has(k)));
  };
  return !moved.size ? out : out.map((p) => ({ ...p, layers: mapLayers(p.layers, (l) => (isInstance(l) && moved.has(l.instance.of) && !placed.has(`${p.id}/${l.id}`) && follows(l) ? { ...l, instance: { ...l.instance, of: moved.get(l.instance.of)!.key } } : l)) }));
}

/** Every instance of a list that lies in no instance, through `fn`; the same list when nothing changed. */
function outerInstances(layers: readonly Layer[], fn: (l: Instance) => Layer): Layer[] {
  let changed = false;
  const out = layers.map((l) => {
    const n = isInstance(l) ? fn(l) : isGroup(l) ? ((inner) => (inner === l.layers ? l : { ...l, layers: inner }))(outerInstances(l.layers, fn)) : l;
    if (n !== l) changed = true;
    return n;
  });
  return changed ? out : (layers as Layer[]);
}

/**
 * Every instance of a design made again from its main (make). `was`: the frames before this change, when it is a change
 * (the person's, an AI's): what was changed since on an instance's own layers is kept as its overrides (its words or
 * its showing, on a layer bound to a property: that property's value), and a main copied is an instance of it. Without
 * `was` (a design loaded, frames merged, undone) the instances are only made again. The same list when nothing changed.
 */
export function syncInstances<P extends DesignPage>(pages: readonly P[], was?: readonly DesignPage[], say?: (note: string) => void): P[] {
  if (!usesComponents(pages)) return pages as P[];
  let out = was ? copiesOfMains(pages, was, say) : (pages as P[]);
  if (was) {
    const c = madeFrom(out);
    out = out.map((p) => {
      const b = was.find((q) => q.id === p.id);
      if (b === p) return p;
      const before = new Map(b ? everyLayer(b.layers).map((l) => [l.id, l]) : []);
      const layers = outerInstances(p.layers, (l) => noticed(l, c, before));
      return layers === p.layers ? p : { ...p, layers };
    });
  }
  const c = madeFrom(out);
  let changed = out !== pages;
  // no main changed (a layer moved, a word typed elsewhere): only the frames this change touched are made again
  const mainsWere = was && new Map([...mainsOf(was)].map(([k, v]) => [k, v.main]));
  const still = !!mainsWere && mainsWere.size === c.mains.size && [...c.mains].every(([k, m]) => mainsWere.get(k) === m);
  const made = out.map((p) => {
    if (still && was!.find((q) => q.id === p.id) === p) return p;
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
    if (isGroup(l)) {
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

/** A layer that is no main, no instance and shows no property (pasted from another design, where its keys meant something else). */
export function plainOf(l: Layer): Layer {
  const { component: _c, set: _s, variant: _v, instance: _i, bind: _b, ...rest } = l as GroupLayer;
  return (isGroup(l) || l.bind ? rest : l) as Layer;
}

/** A frame to copy from (a template filled row by row): its mains placed as instances of themselves, made, so what is filled in them is their property values. */
export function asInstances<P extends DesignPage>(page: P, pages: readonly DesignPage[]): P {
  const placed = { ...page, layers: mapLayers(page.layers, (l) => (isMain(l) ? ({ ...plainOf(l), layers: [], instance: { of: l.component } } as Layer) : l)) };
  return syncInstances([...pages, placed]).at(-1) as P;
}

/** A key no main of the design has: c1, c2 … */
export function freshKey(pages: readonly DesignPage[]): string {
  // nor one an instance names whose main is gone: it would take those instances over
  const taken = new Set(pages.flatMap((p) => everyLayer(p.layers).flatMap((l) => (isGroup(l) ? [l.component, l.instance?.of].filter((k): k is string => !!k) : []))));
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
    for (const l of everyLayer(mains.get(key)?.main.layers ?? [])) if (isInstance(l)) for (const t of targets(l)) if (!out.has(t)) [t, ...shows(t)].forEach((k) => out.add(k));
    return out;
  };
  /** The mains an instance may show: its own, and any its property values name (a swap). */
  const targets = (l: Instance) => [l.instance.of, ...Object.values(l.instance.props ?? {}).filter((v): v is string => typeof v === "string" && mains.has(v))];
  // how many layers a main comes to with its instances made (each instance its main's): one past what a frame holds is no main
  const sizes = new Map<string, number>();
  const size = (key: string): number => {
    if (sizes.has(key)) return sizes.get(key)!;
    sizes.set(key, 0);
    const count = (ls: readonly Layer[]): number => ls.reduce((n, l) => n + 1 + (isInstance(l) ? size(l.instance.of) : isGroup(l) ? count(l.layers) : 0), 0);
    const n = count(mains.get(key)?.main.layers ?? []);
    sizes.set(key, n);
    return n;
  };
  for (const k of keys) if (!over.has(k) && size(k) > DESIGN_LIMITS.layers) (over.add(k), notes.push(`component "${k}" comes to ${size(k)} layers with its instances made, past the ${DESIGN_LIMITS.layers} a frame holds: made a plain group`));
  /** `inside`: the keys of the mains these layers lie in. */
  const mend = (p: DesignPage, ls: readonly Layer[], inside: readonly string[]): Layer[] =>
    ls.flatMap((l): Layer[] => {
      if (!isGroup(l)) return [l];
      if (isInstance(l)) {
        const loop = inside.find((k) => targets(l).some((t) => k === t || shows(t).has(k)));
        if (loop) return notes.push(`frame ${p.id}, layer ${l.id}: an instance of "${l.instance.of}" inside main "${loop}", which it would hold: left out`), [];
        if (!mains.has(l.instance.of)) notes.push(`frame ${p.id}, layer ${l.id}: an instance of "${l.instance.of}", which this design has no main component of: kept as it was${l.layers.length ? "" : " (nothing to draw)"}`);
        // what it holds is a main's copy: never a main of its own
        const inner = mapLayers(l.layers, (k) => (isGroup(k) && (k.component !== undefined || k.set !== undefined || k.variant !== undefined) ? plainOf(k) : k));
        return [inner === l.layers ? l : { ...l, layers: inner }];
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
        // a layer the check cut (past what a frame holds) keeps its override for when there is room again
        if (!at) {
          overrides[k] = ov;
          continue;
        }
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
