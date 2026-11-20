import { describe, expect, it } from "vitest";
import type { DesignPage, GroupLayer, Layer, TextLayer } from "@contracts/design";
import { detached, isInstance, syncInstances } from "./components";
import { hits } from "./draw";
import { mergeFrames, settles, withSent, type SentSave } from "./hands";
import { everyLayer, findLayer, takeId } from "./tree";

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

describe("third review: never lose the person's work", () => {
  const g = (id: string, layers: Layer[], more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", x: 100, y: 100, w: 300, h: 100, layers, ...more });
  const f = (layers: Layer[], more: Partial<DesignPage> = {}) => ({ ...page("p1", layers), ...more });
  const merge1 = (mine: DesignPage, base: DesignPage, theirs: DesignPage, sent?: DesignPage) => mergeFrames([mine], [base], [theirs], sent ? [{ pages: [sent], base: [base] }] : [])[0]!;
  const find = (p: DesignPage, id: string) => findLayer(p.layers, id) as Layer & Record<string, unknown>;
  const parentOfId = (p: DesignPage, id: string): string | null => {
    const walk = (ls: Layer[], parent: string | null): string | null | undefined => {
      for (const l of ls) {
        if (l.id === id) return parent;
        if (l.type === "group") {
          const r = walk(l.layers, l.id);
          if (r !== undefined) return r;
        }
      }
      return undefined;
    };
    return walk(p.layers, null) ?? null;
  };

  it("keeps this window's edit of a layer the server moved into another group, grouped or ungrouped", () => {
    const base = f([g("g", [shape("a", "#ff0000")]), g("g2", [], { x: 500 })]);
    const mine = f([g("g", [shape("a", "#0000ff")]), g("g2", [], { x: 500 })]);
    const moved = merge1(mine, base, f([g("g", []), g("g2", [shape("a", "#ff0000", { x: 7 })], { x: 500 })]));
    expect([parentOfId(moved, "a"), find(moved, "a").fill, find(moved, "a").x]).toEqual(["g2", "#0000ff", 7]);
    const tBase = f([g("g", [text("a", "Hi")])]);
    const ungrouped = merge1(f([g("g", [text("a", "Hello")])]), tBase, f([text("a", "Hi", { x: 110, y: 110 })]));
    expect([parentOfId(ungrouped, "a"), find(ungrouped, "a").text, find(ungrouped, "a").x]).toEqual([null, "Hello", 110]);
    const grouped = merge1(f([shape("a", "#0000ff"), shape("b")]), f([shape("a"), shape("b")]), f([g("G", [shape("a"), shape("b")])]));
    expect([parentOfId(grouped, "a"), find(grouped, "a").fill, find(grouped, "b").fill]).toEqual(["G", "#0000ff", "#111111"]);
  });

  it("keeps a frame the server deleted that this window changed", () => {
    const base = [page("A", [text("t", "Old")])];
    const out = mergeFrames([page("A", [text("t", "Mine")])], base, []);
    expect(out.map((p) => [p.id, (p.layers[0] as TextLayer).text])).toEqual([["A", "Mine"]]);
    expect(mergeFrames(base, base, [])).toEqual([]);
  });

  it("lifts out what the server added to a group this window took apart or deleted, and keeps the server's edit of a layer this window moved", () => {
    const base = f([g("g", [shape("a")])]);
    const theirs = f([g("g", [shape("a"), shape("c", "#00ff00", { x: 5, y: 6 })])]);
    const ungrouped = merge1(f([shape("a", "#111111", { x: 100, y: 100 })]), base, theirs);
    expect([parentOfId(ungrouped, "c"), find(ungrouped, "c").fill, find(ungrouped, "c").x, find(ungrouped, "c").y]).toEqual([null, "#00ff00", 105, 106]);
    const deleted = merge1(f([]), base, theirs);
    expect(find(deleted, "c")?.fill).toBe("#00ff00");
    const movedOut = merge1(f([g("g", []), shape("a", "#111111", { x: 100, y: 100 })]), base, f([g("g", [shape("a", "#ff0000")])]));
    expect([parentOfId(movedOut, "a"), find(movedOut, "a").fill, find(movedOut, "a").x]).toEqual([null, "#ff0000", 100]);
  });

  it("takes this window's own save come back from the server, written in the server's order and rounding, as one layer", () => {
    const base = f([shape("l1")]);
    const sent = f([shape("l1"), shape("l9", "#ff0000", { x: 10.004 })]);
    const echoed = f([shape("l1"), { fill: "#ff0000", y: 0, x: 10, id: "l9", type: "shape", shape: "rect", w: 220, h: 70 } as Layer, shape("l10", "#00ff00")]);
    const out = merge1(sent, base, echoed, sent);
    expect(everyLayer(out.layers).map((l) => [l.id, (l as { x: number }).x])).toEqual([["l1", 0], ["l9", 10], ["l10", 0]]);
  });

  it("goes on from the higher next of the two sides", () => {
    expect(merge1(f([], { next: 12 }), f([]), f([], { next: 20 })).next).toBe(20);
  });

  it("is the server's when this window changed nothing, this window's when the server changed nothing, and the same merged again", () => {
    const deep = (n: number): Layer => (n ? g(`g${n}`, [deep(n - 1), shape(`s${n}`)]) : shape("leaf"));
    const base = f([deep(5)]);
    const mine = f([deep(5)].map((l) => mapAll([l], (k) => (k.id === "leaf" ? ({ ...k, fill: "#0000ff" } as Layer) : k))[0]!));
    const theirs = f([deep(5)].map((l) => mapAll([l], (k) => (k.id === "s3" ? ({ ...k, fill: "#00ff00" } as Layer) : k))[0]!));
    expect(merge1(mine, base, mine)).toEqual(mine);
    expect(merge1(base, base, theirs)).toEqual(theirs);
    const once = merge1(mine, base, theirs);
    expect([find(once, "leaf").fill, find(once, "s3").fill, parentOfId(once, "leaf")]).toEqual(["#0000ff", "#00ff00", "g1"]);
    expect(merge1(once, theirs, theirs)).toEqual(once);
  });

  it("puts a layer twice when the server moved it to another frame while this window changed it (frames are merged one by one)", () => {
    const base = [page("A", [shape("x", "#ff0000")])];
    const out = mergeFrames([page("A", [shape("x", "#0000ff")])], base, [page("A", []), { ...page("loose1", [shape("x", "#ff0000")]), loose: true }]);
    expect(out.map((p) => [p.id, (p.layers[0] as { fill?: string })?.fill])).toEqual([["A", "#0000ff"], ["loose1", "#ff0000"]]);
  });
});

describe("third review: keys", () => {
  it("makes a main copied and changed in one write an instance with that change as its override", () => {
    const was = [page("p1", [pill()]), page("p2", [])];
    const copy = { ...pill(), id: "k", layers: [shape("bg2", "#ff0000"), text("label2", "@tinyacrobatics", { bind: { text: "Handle" } })] };
    const out = syncInstances([was[0]!, page("p2", [copy])], was);
    expect(at(out, "p2", "k").instance).toEqual({ of: "pill", overrides: { bg: { fill: "#ff0000" } } });
    expect(at(out, "p2", "k.bg").fill).toBe("#ff0000");
  });

  it("keeps a new instance whose overrides name the first main's layers on the first main", () => {
    const was = [page("p1", [pill()]), page("p2", [])];
    const other = main("x", "pill", [shape("other", "#00ff00")], { x: 600 });
    const out = syncInstances([was[0]!, page("p2", [other, inst("j", "pill", { instance: { of: "pill", overrides: { bg: { fill: "#ff0000" } } } }), inst("j2", "pill")])], was);
    const renamed = at(out, "p2", "x").component as string;
    expect([(at(out, "p2", "j") as GroupLayer).instance!.of, (at(out, "p2", "j2") as GroupLayer).instance!.of]).toEqual(["pill", renamed]);
  });
});

describe("fourth review", () => {
  const g = (id: string, layers: Layer[], more: Partial<GroupLayer> = {}): GroupLayer => ({ id, type: "group", x: 100, y: 100, w: 300, h: 100, layers, ...more });
  const f = (layers: Layer[]) => page("p1", layers);
  const merge1 = (mine: DesignPage, base: DesignPage, theirs: DesignPage, sent?: DesignPage) => mergeFrames([mine], [base], [theirs], sent ? [{ pages: [sent], base: [base] }] : [])[0]!;
  const find = (p: DesignPage, id: string) => findLayer(p.layers, id) as Layer & Record<string, unknown>;

  it("keeps both groups and what they hold when each side moved one into the other", () => {
    const base = f([g("g1", [shape("a")]), g("g2", [shape("b")], { x: 500 })]);
    const mine = f([g("g1", [shape("a"), g("g2", [shape("b")], { x: 0 })])]);
    const theirs = f([g("g2", [shape("b"), g("g1", [shape("a")], { x: 0 })], { x: 500 })]);
    const out = merge1(mine, base, theirs);
    expect(["g1", "g2", "a", "b"].map((id) => find(out, id)?.id)).toEqual(["g1", "g2", "a", "b"]);
  });

  it("keeps a group this window changed with what it holds when the server deleted it", () => {
    const base = f([g("g", [shape("a", "#ff0000")])]);
    const out = merge1(f([g("g", [shape("a", "#ff0000")], { x: 400 })]), base, f([]));
    expect([find(out, "g")?.x, find(out, "a")?.fill]).toEqual([400, "#ff0000"]);
  });

  it("never takes a refused save's layer for the server's: a new layer of the server's under that id is another", () => {
    const base = f([shape("l1")]);
    const sent = f([shape("l1"), text("l9", "Mine")]);
    const out = merge1(sent, base, f([shape("l1"), text("l9", "The AI's")]), sent);
    expect(everyLayer(out.layers).filter((l) => l.type === "text").map((l) => (l as TextLayer).text).sort()).toEqual(["Mine", "The AI's"]);
  });

  it("lifts what came out of a deleted group to where the group lay", () => {
    const base = f([shape("x"), g("g", [shape("a")]), shape("y")]);
    const out = merge1(f([shape("x"), shape("y")]), base, f([shape("x"), g("g", [shape("a"), shape("c", "#00ff00")]), shape("y")]));
    expect(out.layers.map((l) => l.id)).toEqual(["x", "c", "y"]);
  });

  it("makes a main copied with other points, layout or mask a main of its own, not an instance", () => {
    const was = [page("p1", [pill()]), page("p2", [])];
    const copy = { ...pill(), id: "k", layers: [shape("bg2", "#111111", { mask: "alpha" }), text("label2", "@tinyacrobatics", { bind: { text: "Handle" } })] };
    expect(at(syncInstances([was[0]!, page("p2", [copy])], was), "p2", "k").component).toMatch(/^c\d+$/);
  });
});

describe("saves on their way (sent)", () => {
  const f = (layers: Layer[]) => page("p1", layers);
  it("keeps an undo made while a save was on its way, of a layer and of a frame", () => {
    const base = [f([shape("l1", "#111111", { x: 10 })]), page("p2", [shape("q")])];
    const sent = [f([shape("l1", "#111111", { x: 50 })])];
    // the server has the save (a reply that never came): l1 at 50, p2 gone; this window undid both
    const theirs = [f([shape("l1", "#111111", { x: 50 })])];
    const out = mergeFrames(base, base, theirs, [{ pages: sent, base }]);
    expect(out.map((p) => [p.id, (p.layers[0] as { x: number }).x])).toEqual([["p1", 10], ["p2", 0]]);
  });

  it("never doubles a layer a save added whose reply was lost, after a later save of this window's was refused", () => {
    const base = [f([shape("l1")])];
    const save1 = [f([shape("l1"), shape("l7", "#ff0000", { x: 5 })])];
    const mine = [f([shape("l1"), shape("l7", "#ff0000", { x: 90 })])];
    // save 2 (mine) was refused: only save 1 is still on its way
    const theirs = [f([shape("l1", "#00ff00"), shape("l7", "#ff0000", { x: 5 })])];
    const out = mergeFrames(mine, base, theirs, [{ pages: save1, base }]);
    expect(everyLayer(out[0]!.layers).map((l) => [l.id, (l as { fill: string }).fill, l.x])).toEqual([["l1", "#00ff00", 0], ["l7", "#ff0000", 90]]);
  });
});

describe("saves on their way: what each one left (review)", () => {
  const f = (layers: Layer[], more: Partial<DesignPage> = {}) => ({ ...page("p1", layers), ...more });
  const xs = (pages: readonly DesignPage[]) => pages.map((p) => [p.id, ...everyLayer(p.layers).map((l) => `${l.id}@${l.x}:${(l as { fill?: string }).fill}`)]);

  it("keeps an undo made while a save was on its way when the server also changed another layer of the frame, and a field undone too", () => {
    const base = [f([shape("l1", "#111111", { x: 10 }), shape("l2", "#ff0000")], { background: "#ffffff" })];
    const sent = [f([shape("l1", "#111111", { x: 50 }), shape("l2", "#ff0000")], { background: "#000000" })];
    const theirs = [f([shape("l1", "#111111", { x: 50 }), shape("l2", "#0000ff")], { background: "#000000" })];
    const out = mergeFrames(base, base, theirs, [{ pages: sent, base }]);
    expect(xs(out)).toEqual([["p1", "l1@10:#111111", "l2@0:#0000ff"]]);
    expect(out[0]!.background).toBe("#ffffff");
  });

  it("lets the AI's delete of a frame it added stand while an older save is on its way", () => {
    const old = [f([shape("l1")])];
    const mine = [f([shape("l1")]), page("p2", [shape("q")])];
    const out = mergeFrames(mine, mine, [f([shape("l1")])], [{ pages: old, base: old }]);
    expect(out.map((p) => p.id)).toEqual(["p1"]);
  });

  it("keeps the undo of a frame added and of a layer taken out while their save was on its way", () => {
    const base = [f([shape("l1"), shape("l7", "#ff0000")])];
    const sent = [f([shape("l1")]), page("p3", [shape("q")])];
    // the server has the save: l7 gone, p3 there; this window undid both
    const out = mergeFrames(base, base, [f([shape("l1")]), page("p3", [shape("q")])], [{ pages: sent, base }]);
    expect(xs(out)).toEqual([["p1", "l1@0:#111111", "l7@0:#ff0000"]]);
  });
});

describe("the person's window's ids", () => {
  it("keeps a copied frame's l45 (its own), however far past a new frame's next", () => {
    expect(takeId("l45", new Set(), () => true, undefined, 1, false, true)).toBe("l45");
  });
});

describe("saves on their way, kept and settled (last gate)", () => {
  const f = (layers: Layer[]) => page("p1", layers);
  const xs = (pages: readonly DesignPage[]) => everyLayer(pages[0]!.layers).map((l) => `${l.id}@${l.x}`);

  it("keeps the save that matters however many failed after it offline, and settles one that never left the browser", () => {
    const base = [f([shape("l1")])];
    const save1 = { pages: [f([shape("l1"), shape("l2", "#ff0000", { x: 10 })])], base };
    let list: SentSave[] = [save1];
    for (let n = 0; n < 5; n++) list = withSent(list, { pages: [f([shape("l1"), shape("l2", "#ff0000", { x: 60 })])], base: save1.pages });
    expect(list[0]).toBe(save1);
    // offline: the saves after it never left, and are settled
    expect([settles({ offline: true }), settles({ offline: false }), settles({ status: 502, offline: false }), settles({ status: 404, offline: false }), settles({ refused: true, offline: false })]).toEqual([true, false, false, true, true]);
    const mine = [f([shape("l1"), shape("l2", "#ff0000", { x: 60 })])];
    const theirs = [f([shape("l1"), shape("l2", "#ff0000", { x: 10 }), shape("l9", "#00ff00")])];
    expect(xs(mergeFrames(mine, base, theirs, [save1]))).toEqual(["l1@0", "l2@60", "l9@0"]);
  });

  it("takes a new layer the server cleaned (a weight snapped, a value held in) as the one sent, never a second", () => {
    const base = [f([shape("l1")])];
    const sent = [f([shape("l1"), text("l3", "Hi", { weight: 450, size: 5000 })])];
    const theirs = [f([shape("l1"), text("l3", "Hi", { weight: 400, size: 1000 }), shape("l9")])];
    expect(xs(mergeFrames(sent, base, theirs, [{ pages: sent, base }]))).toEqual(["l1@0", "l3@10", "l9@0"]);
  });

  it("takes a new text the server trimmed (spaces at its ends, a name's spaces) as the one sent, with what was typed since", () => {
    const base = [f([shape("l1")])];
    const sent = [f([shape("l1"), text("l3", "Hello \r\n", { name: "  My  words " })])];
    const theirs = [f([shape("l1"), text("l3", "Hello", { name: "My words" }), shape("l9")])];
    const mine = [f([shape("l1"), text("l3", "Hello wor", { name: "  My  words " })])];
    const out = mergeFrames(mine, base, theirs, [{ pages: sent, base }]);
    expect(xs(out)).toEqual(["l1@0", "l3@10", "l9@0"]);
    expect((out[0]!.layers[1] as TextLayer).text).toBe("Hello wor");
  });
});
