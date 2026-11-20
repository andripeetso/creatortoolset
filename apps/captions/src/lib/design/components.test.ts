import { describe, expect, it } from "vitest";
import type { DesignPage, GroupLayer, Layer, TextLayer } from "@contracts/design";
import { componentCheck, detached, freshKey, isInstance, overridesAsKept, propsOf, syncInstances, variantWith, type Instance } from "./components";
import { everyLayer, findLayer, reid } from "./tree";
import { mergeFrames } from "./hands";

const text = (id: string, words: string, more: Partial<TextLayer> = {}): TextLayer => ({ id, type: "text", text: words, font: "Inter", size: 40, color: "#ffffff", align: "center", x: 10, y: 10, w: 200, h: 50, ...more });
const shape = (id: string, fill = "#111111"): Layer => ({ id, type: "shape", shape: "rect", fill, x: 0, y: 0, w: 220, h: 70 });
const main = (id: string, key: string, layers: Layer[], more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", box: true, x: 40, y: 40, w: 220, h: 70, name: "Pill", component: key, layers, ...more });
const inst = (id: string, of: string, more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", x: 100, y: 900, w: 10, h: 10, layers: [], instance: { of }, ...more });
const page = (id: string, layers: Layer[]): DesignPage => ({ id, x: 0, y: 0, w: 1080, h: 1350, background: "#ffffff", layers });
const pill = () => main("m", "pill", [shape("bg"), text("label", "@tinyacrobatics", { bind: { text: "Handle" } })]);
const at = (pages: DesignPage[], frame: string, id: string) => findLayer(pages.find((p) => p.id === frame)!.layers, id) as Layer & Record<string, unknown>;
/** One change as the designer makes it: `fn` on the frames, then every instance made again, what was changed kept. */
const edit = (pages: DesignPage[], fn: (l: Layer, frame: string) => Layer) => syncInstances(pages.map((p) => ({ ...p, layers: mapAll(p.layers, (l) => fn(l, p.id)) })), pages);
const mapAll = (ls: Layer[], fn: (l: Layer) => Layer): Layer[] => ls.map((l) => {
  const n = fn(l);
  return n.type === "group" ? { ...n, layers: mapAll(n.layers, fn) } : n;
});

describe("components and instances", () => {
  const start = () => syncInstances([page("p1", [pill(), inst("i1", "pill")]), page("p2", [inst("i2", "pill")]), page("p3", [inst("i3", "pill", { x: 300 })])]);

  it("makes an instance from its main: its layers with ids of their own in the frame, its own place, the main's size and look", () => {
    const pages = start();
    const i2 = at(pages, "p2", "i2") as Instance;
    expect(i2).toMatchObject({ x: 100, y: 900, w: 220, h: 70, box: true, name: "Pill", instance: { of: "pill" } });
    expect(i2.layers.map((l) => l.id)).toEqual(["i2.bg", "i2.label"]);
    expect((i2.layers[1] as TextLayer).text).toBe("@tinyacrobatics");
    expect(i2.component).toBeUndefined();
    // ids are unique in the frame however many instances lie on it
    const ids = everyLayer(pages[0]!.layers).map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("follows every change to the main on every frame, and keeps an override where the main still has that field", () => {
    let pages = start();
    // the person colours one instance's background
    pages = edit(pages, (l, f) => (f === "p3" && l.id === "i3.bg" ? { ...l, fill: "#ff0000" } : l));
    expect(at(pages, "p3", "i3").instance).toEqual({ of: "pill", overrides: { bg: { fill: "#ff0000" } } });
    // then the main's colour and words change
    pages = edit(pages, (l, f) => (f === "p1" && l.id === "bg" ? { ...l, fill: "#2255ff" } : f === "p1" && l.id === "label" ? { ...l, text: "@tiny", size: 48 } as Layer : l));
    expect(at(pages, "p2", "i2.bg").fill).toBe("#2255ff");
    expect(at(pages, "p1", "i1.bg").fill).toBe("#2255ff");
    expect(at(pages, "p2", "i2.label")).toMatchObject({ text: "@tiny", size: 48 });
    // the override stays; the rest of that instance follows
    expect(at(pages, "p3", "i3.bg").fill).toBe("#ff0000");
    expect(at(pages, "p3", "i3.label").size).toBe(48);
  });

  it("keeps a word typed on an instance as its property value, and Reset brings back the main's", () => {
    let pages = start();
    pages = edit(pages, (l, f) => (f === "p2" && l.id === "i2.label" ? { ...l, text: "Slide 2" } as Layer : l));
    expect(at(pages, "p2", "i2").instance).toEqual({ of: "pill", props: { Handle: "Slide 2" } });
    pages = edit(pages, (l, f) => (f === "p1" && l.id === "label" ? { ...l, text: "@new" } as Layer : l));
    expect(at(pages, "p2", "i2.label").text).toBe("Slide 2");
    expect(at(pages, "p3", "i3.label").text).toBe("@new");
    pages = edit(pages, (l) => (l.id === "i2" && isInstance(l) ? { ...l, instance: { of: "pill" } } : l));
    expect(at(pages, "p2", "i2.label").text).toBe("@new");
  });

  it("never moves or resizes a layer inside an instance: that follows the main", () => {
    const pages = edit(start(), (l, f) => (f === "p2" && l.id === "i2.label" ? { ...l, x: 500, w: 20 } : l));
    expect(at(pages, "p2", "i2.label")).toMatchObject({ x: 10, w: 200 });
    expect(at(pages, "p2", "i2").instance).toEqual({ of: "pill" });
  });

  it("is only made again, nothing kept as an override, when the frames are not a change (loaded, undone, merged)", () => {
    const pages = start();
    const stale = pages.map((p) => (p.id === "p1" ? { ...p, layers: p.layers.map((l) => (l.id === "m" ? { ...l, layers: [shape("bg", "#00ff00"), (l as GroupLayer).layers[1]!] } as Layer : l)) } : p));
    const out = syncInstances(stale);
    expect(at(out, "p2", "i2.bg").fill).toBe("#00ff00");
    expect(at(out, "p2", "i2").instance).toEqual({ of: "pill" });
    expect(syncInstances(out)).toBe(out);
  });

  it("detaches an instance into plain layers that no longer follow", () => {
    let pages = start();
    pages = edit(pages, (l) => (l.id === "i2" && isInstance(l) ? detached(l) : l));
    pages = edit(pages, (l, f) => (f === "p1" && l.id === "bg" ? { ...l, fill: "#2255ff" } : l));
    expect(at(pages, "p2", "i2.bg").fill).toBe("#111111");
    expect(at(pages, "p3", "i3.bg").fill).toBe("#2255ff");
  });

  it("makes a pasted or duplicated main an instance of it, its layers given the instance's ids", () => {
    const pages = start();
    const copy = reid([at(pages, "p1", "m") as Layer], ["l9"], pages[1]!.layers)[0]!;
    const out = syncInstances(pages.map((p) => (p.id === "p2" ? { ...p, layers: [...p.layers, copy] } : p)), pages);
    expect(at(out, "p2", "l9")).toMatchObject({ instance: { of: "pill" } });
    expect(at(out, "p2", "l9").component).toBeUndefined();
    expect((at(out, "p2", "l9") as GroupLayer).layers.map((l) => l.id)).toEqual(["l9.bg", "l9.label"]);
    expect(at(out, "p1", "m").component).toBe("pill");
  });

  it("shows and hides by a boolean property and swaps a nested instance by a swap property", () => {
    const arrow: Layer = { id: "arrow", type: "shape", shape: "arrow", fill: "#ffffff", x: 180, y: 20, w: 30, h: 30, bind: { visible: "Arrow" } };
    const dot = main("d", "dot", [shape("o1", "#ff0000")], { x: 600 });
    const ring = main("r", "ring", [shape("o2", "#00ff00")], { x: 800 });
    const chip = main("m", "chip", [shape("bg"), arrow, { ...inst("n", "dot"), bind: { swap: "Icon" } }]);
    let pages = syncInstances([page("p1", [dot, ring, chip]), page("p2", [inst("i", "chip", { instance: { of: "chip", props: { Arrow: false, Icon: "ring" } } })])]);
    expect(at(pages, "p2", "i.arrow").hidden).toBe(true);
    expect(at(pages, "p2", "i.n").instance).toMatchObject({ of: "ring" });
    expect(at(pages, "p2", "i.n.o2").fill).toBe("#00ff00");
    expect(propsOf(chip).map((p) => [p.name, p.kind])).toEqual([["Arrow", "visible"], ["Icon", "swap"]]);
    // the ring's main changes: the swapped chip follows it
    pages = edit(pages, (l, f) => (f === "p1" && l.id === "r" ? { ...l, layers: [shape("o2", "#0000ff")] } as Layer : l));
    expect(at(pages, "p2", "i.n.o2").fill).toBe("#0000ff");
  });

  it("switches a variant keeping the overrides on layers of the same name, and picks the variant nearest the current one", () => {
    const a = main("a", "pill-dark", [{ ...shape("bg"), name: "Back" }, { ...text("t", "GO"), name: "Label" }], { set: "Pill", variant: { Theme: "Dark", Size: "4:5" } });
    const b = main("b", "pill-light", [{ ...text("t2", "GO"), name: "Label" }, { ...shape("bg2", "#ffffff"), name: "Back" }], { set: "Pill", variant: { Theme: "Light", Size: "4:5" }, x: 400 });
    const c = main("c", "pill-light-tall", [{ ...shape("bg3", "#eeeeee"), name: "Back" }], { set: "Pill", variant: { Theme: "Light", Size: "9:16" }, x: 700 });
    let pages = syncInstances([page("p1", [a, b, c]), page("p2", [inst("i", "pill-dark")])]);
    pages = edit(pages, (l) => (l.id === "i.t" ? { ...l, color: "#ff00ff" } as Layer : l));
    expect(variantWith("pill-dark", "Theme", "Light", pages)).toBe("pill-light");
    pages = edit(pages, (l) => (l.id === "i" && isInstance(l) ? { ...l, instance: { ...l.instance, of: "pill-light" } } : l));
    expect(at(pages, "p2", "i").instance).toEqual({ of: "pill-light", overrides: { t2: { color: "#ff00ff" } } });
    expect(at(pages, "p2", "i.t2").color).toBe("#ff00ff");
    expect(at(pages, "p2", "i.bg2").fill).toBe("#ffffff");
  });

  it("refuses a main that holds an instance of itself, and says what has no main, without a crash", () => {
    const loop = main("m", "pill", [shape("bg"), inst("n", "pill")]);
    const checked = componentCheck([page("p1", [loop]), page("p2", [inst("i", "gone")])], 60);
    expect(findLayer(checked.pages[0]!.layers, "n")).toBeUndefined();
    expect(checked.notes.join("\n")).toMatch(/inside main "pill", which it would hold/);
    expect(checked.notes.join("\n")).toMatch(/no main component of/);
    // made anyway (an unchecked loop): kept as it was, never a crash
    const out = syncInstances([page("p1", [main("m", "a", [inst("n", "b")]), main("m2", "b", [inst("n2", "a")])])]);
    expect(everyLayer(out[0]!.layers).length).toBeGreaterThan(0);
    const missing = syncInstances([page("p2", [inst("i", "gone")])]);
    expect(at(missing, "p2", "i").layers).toEqual([]);
  });

  it("keeps an override as the check left it, and drops it where the main has no such layer", () => {
    const pages = syncInstances([page("p1", [pill(), inst("i", "pill", { instance: { of: "pill", overrides: { bg: { fill: "#ff0000" }, nope: { fill: "#000000" } } } })])]);
    // the check cut a field down (as cleanPages would a too-long text)
    const cut = pages.map((p) => ({ ...p, layers: mapAll(p.layers, (l) => (l.id === "i.bg" ? { ...l, fill: "#00ff00" } : l)) }));
    expect(at(overridesAsKept(cut), "p1", "i").instance).toEqual({ of: "pill", overrides: { bg: { fill: "#00ff00" } } });
    const pruned = edit(pages, (l) => l);
    expect(at(pruned, "p1", "i").instance).toEqual({ of: "pill", overrides: { bg: { fill: "#ff0000" } } });
  });

  it("keeps a main changed in this window and an override an AI set on the same frame meanwhile, both", () => {
    const base = start();
    const mine = edit(base, (l, f) => (f === "p1" && l.id === "bg" ? { ...l, fill: "#2255ff" } : l));
    const theirs = edit(base, (l, f) => (f === "p1" && l.id === "i1.label" ? { ...l, color: "#ffcc00" } as Layer : l));
    const merged = syncInstances(mergeFrames(mine, base, theirs));
    expect(at(merged, "p1", "i1").instance).toEqual({ of: "pill", overrides: { label: { color: "#ffcc00" } } });
    expect(at(merged, "p1", "i1.bg").fill).toBe("#2255ff");
    expect(at(merged, "p1", "i1.label").color).toBe("#ffcc00");
    expect(at(merged, "p2", "i2.bg").fill).toBe("#2255ff");
  });

  it("keeps the overrides of a copy (pasted, a frame copied) and takes nothing of it as changed", () => {
    let pages = edit(start(), (l, f) => (f === "p2" && l.id === "i2.bg" ? { ...l, fill: "#ff0000" } : l));
    const copy = { ...pages[1]!, id: "p9", layers: pages[1]!.layers.map((l) => ({ ...l, id: "k", layers: (l as GroupLayer).layers.map((c) => ({ ...c, size: 99 })) })) as Layer[] };
    pages = syncInstances([...pages, copy], pages);
    expect(at(pages, "p9", "k").instance).toEqual({ of: "pill", overrides: { bg: { fill: "#ff0000" } } });
    expect(at(pages, "p9", "k.bg").fill).toBe("#ff0000");
  });

  it("gives a new main a key no other has", () => {
    expect(freshKey([page("p1", [main("m", "c1", []), main("n", "c2", [])])])).toBe("c3");
  });
});
