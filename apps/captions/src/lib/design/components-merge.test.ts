import { describe, expect, it } from "vitest";
import type { DesignPage, GroupLayer, Layer, TextLayer } from "@contracts/design";
import { detached, isInstance, syncInstances } from "./components";
import { hits } from "./draw";
import { mergeFrames } from "./hands";
import { everyLayer, findLayer } from "./tree";

/** Second review of components: merges, nested overrides, keys, ids. */
const text = (id: string, words: string, more: Partial<TextLayer> = {}): TextLayer => ({ id, type: "text", text: words, font: "Inter", size: 40, color: "#ffffff", align: "center", x: 10, y: 10, w: 200, h: 50, ...more });
const shape = (id: string, fill = "#111111", more: object = {}): Layer => ({ id, type: "shape", shape: "rect", fill, x: 0, y: 0, w: 220, h: 70, ...more }) as Layer;
const main = (id: string, key: string, layers: Layer[], more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", box: true, x: 40, y: 40, w: 220, h: 70, name: "Pill", component: key, layers, ...more });
const inst = (id: string, of: string, more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", x: 100, y: 900, w: 10, h: 10, layers: [], instance: { of }, ...more });
const page = (id: string, layers: Layer[]): DesignPage => ({ id, x: 0, y: 0, w: 1080, h: 1350, background: "#ffffff", layers });
const pill = () => main("m", "pill", [shape("bg"), text("label", "@tinyacrobatics", { bind: { text: "Handle" } })]);
const at = (pages: readonly DesignPage[], frame: string, id: string) => findLayer(pages.find((p) => p.id === frame)!.layers, id) as Layer & Record<string, unknown>;
const mapAll = (ls: Layer[], fn: (l: Layer) => Layer): Layer[] =>
  ls.map((l) => {
    const n = fn(l);
    return n.type === "group" ? { ...n, layers: mapAll(n.layers, fn) } : n;
  });
const edit = (pages: DesignPage[], fn: (l: Layer, frame: string) => Layer) => syncInstances(pages.map((p) => ({ ...p, layers: mapAll(p.layers, (l) => fn(l, p.id)) })), pages);
const start = () => syncInstances([page("p1", [pill(), inst("i1", "pill")]), page("p2", [inst("i2", "pill")])]);
const ids = (pages: readonly DesignPage[]) => pages.flatMap((p) => everyLayer(p.layers).map((l) => l.id));

describe("an instance changed on both sides of a merge", () => {
  it("keeps the property this window set and the override the AI set, through the server's save too", () => {
    const base = start();
    const mine = edit(base, (l) => (l.id === "i2.label" ? ({ ...l, text: "Mine" } as Layer) : l));
    const theirs = edit(base, (l) => (l.id === "i2.label" ? ({ ...l, color: "#ffcc00" } as Layer) : l));
    const merged = syncInstances(mergeFrames(mine, base, theirs));
    expect(at(merged, "p2", "i2").instance).toEqual({ of: "pill", props: { Handle: "Mine" }, overrides: { label: { color: "#ffcc00" } } });
    const saved = syncInstances(merged, theirs);
    expect(at(saved, "p2", "i2.label")).toMatchObject({ text: "Mine", color: "#ffcc00" });
  });
});

describe("an instance inside an instance", () => {
  const dot = main("d", "dot", [shape("o1", "#ff0000")], { x: 600 });
  const ring = main("r", "ring", [shape("o2", "#00ff00")], { x: 800 });
  const chip = main("c", "chip", [shape("bg"), inst("n", "dot")]);
  const pages0 = () => syncInstances([page("p1", [dot, ring, chip]), page("p2", [inst("i", "chip")])]);

  it("keeps what was changed inside it flat on the outer instance, and still follows the main's own swap", () => {
    let pages = edit(pages0(), (l) => (l.id === "i.n.o1" ? ({ ...l, fill: "#0000ff", name: "Dot" } as Layer) : l));
    expect(at(pages, "p2", "i").instance).toEqual({ of: "chip", overrides: { "n.o1": { fill: "#0000ff", name: "Dot" } } });
    expect(at(pages, "p2", "i.n").instance).toEqual({ of: "dot" });
    // made again from nothing (a reload): the override is there
    expect(at(syncInstances(pages.map((p) => ({ ...p, layers: mapAll(p.layers, (l) => (l.id === "i" ? { ...l, layers: [] } : l)) }))), "p2", "i.n.o1").fill).toBe("#0000ff");
    // the main shows the ring now: the instance follows it
    pages = edit(pages, (l) => (l.id === "n" && isInstance(l) ? { ...l, instance: { of: "ring" } } : l));
    expect(at(pages, "p2", "i.n").instance).toMatchObject({ of: "ring" });
    expect(at(pages, "p2", "i.n.o2").fill).toBe("#00ff00");
  });
});

describe("two mains of one key", () => {
  it("keeps a main that differs as a main of a new key, and makes one that is a copy an instance", () => {
    const was = [page("p1", [pill()]), page("p2", [])];
    const other = main("x", "pill", [shape("other", "#00ff00")]);
    const notes: string[] = [];
    const out = syncInstances([was[0]!, page("p2", [other])], was, (n) => notes.push(n));
    expect(at(out, "p2", "x")).toMatchObject({ component: expect.not.stringMatching(/^pill$/) });
    expect((at(out, "p2", "x") as GroupLayer).layers.map((l) => l.id)).toEqual(["other"]);
    expect(at(out, "p1", "m").component).toBe("pill");
    expect(notes.join()).toMatch(/pill/);
    const copy = { ...pill(), id: "k", layers: pill().layers.map((l) => ({ ...l, id: `${l.id}2` })) };
    expect(at(syncInstances([was[0]!, page("p2", [copy])], was), "p2", "k").instance).toEqual({ of: "pill" });
  });

  it("keeps the first of two mains that were both there before", () => {
    const two = [page("p1", [pill()]), page("p2", [{ ...pill(), id: "m2", layers: [shape("q")] }])];
    const out = syncInstances(two, two);
    expect(at(out, "p1", "m").component).toBe("pill");
  });
});

describe("a merge where one side took away what the other changed", () => {
  const g = (layers: Layer[]): GroupLayer => ({ id: "g", type: "group", x: 100, y: 100, w: 300, h: 100, layers });
  const frame = (layers: Layer[]) => [page("p1", layers)];

  it("lifts what this window added into a group the server ungrouped, with no layer twice", () => {
    const base = frame([g([shape("a"), shape("b", "#111111", { x: 50 })])]);
    const theirs = frame([shape("a", "#111111", { x: 100, y: 100 }), shape("b", "#111111", { x: 150, y: 100 })]);
    const mine = frame([g([shape("a"), shape("b", "#111111", { x: 50 }), shape("c", "#ff0000", { x: 10, y: 5 })])]);
    const merged = mergeFrames(mine, base, theirs);
    expect(ids(merged).sort()).toEqual(["a", "b", "c"]);
    expect(at(merged, "p1", "c")).toMatchObject({ x: 110, y: 105 });
  });

  it("keeps a layer this window edited that the server took away, and never twice one the server moved", () => {
    const base = frame([text("t", "Hi"), g([shape("a")]), { ...g([]), id: "g2" }]);
    expect(ids(mergeFrames(frame([text("t", "Hi there"), g([shape("a")]), { ...g([]), id: "g2" }]), base, frame([g([shape("a")]), { ...g([]), id: "g2" }])))).toContain("t");
    // the server moved a into g2 while this window coloured it in g
    const moved = mergeFrames(frame([text("t", "Hi"), g([shape("a", "#00ff00")]), { ...g([]), id: "g2" }]), base, frame([text("t", "Hi"), g([]), { ...g([shape("a")]), id: "g2" }]));
    expect(ids(moved).filter((i) => i === "a")).toHaveLength(1);
  });

  it("keeps both sides' new layers when they took the same id, and the server's other changes", () => {
    const base = frame([text("l1", "One")]);
    const mine = frame([text("l1", "One"), shape("l2", "#ff0000")]);
    const theirs = frame([text("l1", "Uno"), shape("l2", "#0000ff")]);
    const merged = mergeFrames(mine, base, theirs);
    expect(everyLayer(merged[0]!.layers).map((l) => (l.type === "text" ? l.text : (l as { fill: string }).fill)).sort()).toEqual(["#0000ff", "#ff0000", "Uno"]);
    expect(new Set(ids(merged)).size).toBe(3);
  });

  it("never puts this window's edit of an old layer onto a new one that took its id", () => {
    const base = frame([text("l5", "Old")]);
    const merged = mergeFrames(frame([text("l5", "Old, edited")]), base, frame([{ id: "l5", type: "image", picture: "p", fit: "cover", x: 0, y: 0, w: 10, h: 10 } as Layer]));
    expect(merged[0]!.layers.map((l) => l.type).sort()).toEqual(["image", "text"]);
    expect(new Set(ids(merged)).size).toBe(2);
    expect((merged[0]!.layers.find((l) => l.type === "image") as unknown as Record<string, unknown>).text).toBeUndefined();
  });

  it("keeps a text's words and its runs together from the side that changed them", () => {
    const base = frame([text("t", "Hello world", { runs: [{ start: 0, end: 5, color: "#ff0000" }] })]);
    const mine = frame([text("t", "Hello world", { runs: [{ start: 6, end: 11, color: "#00ff00" }] })]);
    const theirs = frame([text("t", "Hi world", { runs: [{ start: 0, end: 2, color: "#ff0000" }] })]);
    const t = mergeFrames(mine, base, theirs)[0]!.layers[0] as TextLayer;
    expect([t.text, t.runs]).toEqual(["Hello world", [{ start: 6, end: 11, color: "#00ff00" }]]);
  });
});

describe("an instance detached, changed and attached again", () => {
  it("keeps what was changed while it was detached as its overrides", () => {
    let pages = start();
    pages = edit(pages, (l) => (l.id === "i2" && isInstance(l) ? detached(l) : l));
    pages = edit(pages, (l) => (l.id === "i2.bg" ? ({ ...l, fill: "#ff0000" } as Layer) : l));
    pages = edit(pages, (l) => (l.id === "i2" ? ({ ...l, instance: { of: "pill" } } as Layer) : l));
    expect(at(pages, "p2", "i2").instance).toEqual({ of: "pill", overrides: { bg: { fill: "#ff0000" } } });
  });
});

describe("an instance with nothing to draw", () => {
  it("is picked where its box is", () => {
    expect(hits(inst("i", "gone", { x: 0, y: 0, w: 100, h: 50 }) as Layer, 50, 25)).toBe(true);
  });
});

describe("cost: a move on a frame with no instance", () => {
  it("makes no instance again when no main changed", () => {
    const many = syncInstances([page("p1", [pill()]), ...Array.from({ length: 19 }, (_, n) => page(`f${n}`, Array.from({ length: 5 }, (_, k) => inst(`i${k}`, "pill", { x: k * 10 }))))]);
    const plain = [...many, page("q", [shape("s")])];
    const moved = plain.map((p) => (p.id === "q" ? { ...p, layers: [shape("s", "#111111", { x: 5 })] } : p));
    const out = syncInstances(moved, plain);
    out.forEach((p, n) => p.id !== "q" && expect(p).toBe(moved[n]));
    const t = performance.now();
    for (let i = 0; i < 50; i++) syncInstances(moved, plain);
    // a loose guard (a busy test machine): measured 1.5 ms a move before, 0.09 ms after, at 20 frames
    expect((performance.now() - t) / 50).toBeLessThan(50);
  });
});

describe("third review", () => {
  const g = (id: string, layers: Layer[], more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", x: 100, y: 100, w: 300, h: 100, layers, ...more });
  const frame = (layers: Layer[]) => [page("p1", layers)];

  it("keeps the layers this window took out of a group or moved into one while the server changed the frame", () => {
    const base = frame([g("g", [shape("a"), shape("b", "#111111", { x: 50 })]), shape("c")]);
    const theirs = frame([g("g", [shape("a"), shape("b", "#111111", { x: 50 })]), shape("c", "#ff0000")]);
    const ungrouped = mergeFrames(frame([shape("a", "#111111", { x: 100, y: 100 }), shape("b", "#111111", { x: 150, y: 100 }), shape("c")]), base, theirs);
    expect(ids(ungrouped).sort()).toEqual(["a", "b", "c"]);
    const intoBase = frame([g("g", [shape("a")]), shape("c")]);
    const into = mergeFrames(frame([g("g", [shape("a"), shape("c", "#111111", { x: -100, y: -100 })])]), intoBase, frame([g("g", [shape("a", "#00ff00")]), shape("c")]));
    expect(ids(into).sort()).toEqual(["a", "c", "g"]);
    expect(at(into, "p1", "a").fill).toBe("#00ff00");
  });

  it("lets the AI's delete of an instance stand while this window edited its main elsewhere, and a reflowed layer is no edit", () => {
    const base = start();
    const mine = edit(base, (l) => (l.id === "bg" ? ({ ...l, fill: "#2255ff" } as Layer) : l));
    const theirs = base.map((p) => (p.id === "p2" ? { ...p, layers: [] } : p));
    expect(ids(mergeFrames(mine, base, theirs))).not.toContain("i2");
  });

  it("takes a value set on an instance inside an instance", () => {
    const dot = main("d", "dot", [text("w", "A", { bind: { text: "Letter" } })], { x: 600 });
    const chip = main("c", "chip", [shape("bg"), inst("n", "dot")]);
    let pages = syncInstances([page("p1", [dot, chip]), page("p2", [inst("i", "chip")])]);
    pages = edit(pages, (l) => (l.id === "i.n" && isInstance(l) ? { ...l, instance: { ...l.instance, props: { Letter: "B" } } } : l));
    expect(at(pages, "p2", "i.n.w").text).toBe("B");
  });

  it("keeps a frame copied in another size an instance of its main, and points the instances of a renamed second main at it", () => {
    const was = [page("p1", [pill()])];
    const scaled = page("p9", [{ ...pill(), w: 110, h: 35, layers: pill().layers.map((l) => ({ ...l, w: l.w / 2 })) }]);
    expect(at(syncInstances([...was, scaled], was), "p9", "m").instance).toEqual({ of: "pill" });
    const theirMain = main("x", "pill", [shape("other", "#00ff00")]);
    const out = syncInstances([was[0]!, page("p2", [theirMain, inst("j", "pill")])], was);
    expect((at(out, "p2", "j") as GroupLayer).instance!.of).toBe(at(out, "p2", "x").component);
  });

  it("never renames the same new layer both sides have (a save of this window's that came back), and renames an instance's layers with it", () => {
    const base = frame([shape("l1")]);
    const same9 = shape("l9", "#ff0000");
    expect(ids(mergeFrames(frame([shape("l1"), same9]), base, frame([shape("l1", "#00ff00"), same9])))).toEqual(["l1", "l9"]);
    const mineInst = { ...inst("l7", "pill"), layers: [shape("l7.bg", "#ff0000")] };
    const merged = mergeFrames(frame([shape("l1"), mineInst]), base, frame([shape("l1"), { ...inst("l7", "pill"), layers: [shape("l7.bg", "#0000ff")] }]));
    const renamed = merged[0]!.layers.find((l) => l.id !== "l1" && l.id !== "l7") as GroupLayer;
    expect(renamed.layers[0]!.id).toBe(`${renamed.id}.bg`);
  });
});
