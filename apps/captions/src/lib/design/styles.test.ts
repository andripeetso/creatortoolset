import { describe, expect, it } from "vitest";
import type { DesignPage, DesignStyles, GroupLayer, Layer, ShapeLayer, TextLayer } from "@contracts/design";
import { syncInstances } from "./components";
import { findLayer } from "./tree";
import { coloursOf, lookOf, mergeStyles, styled, styleId, swapColour, textStyleOf, unlinked, withLook, withStyle } from "./styles";

const text = (id: string, words: string, more: Partial<TextLayer> = {}): TextLayer => ({ id, type: "text", text: words, font: "Inter", size: 40, color: "#111111", align: "left", x: 0, y: 0, w: 400, h: 60, ...more });
const rect = (id: string, more: Partial<ShapeLayer> = {}): ShapeLayer => ({ id, type: "shape", shape: "rect", fill: "#dddddd", x: 0, y: 0, w: 100, h: 100, ...more });
const page = (id: string, layers: Layer[], more: Partial<DesignPage> = {}): DesignPage => ({ id, x: 0, y: 0, w: 1080, h: 1350, background: "#ffffff", layers, ...more });
const styles: DesignStyles = {
  colors: { accent: { name: "Accent", color: "#ff5500" }, ink: { name: "Ink", color: "#111827" } },
  text: { headline: { name: "Headline", font: "Anton", size: 96, lineHeight: 1, case: "upper" }, body: { name: "Body", font: "Inter", size: 36, weight: 400 } },
  effects: { card: { name: "Card shadow", effects: [{ type: "shadow", color: "#000000", opacity: 0.2, blur: 30, x: 0, y: 12 }] } },
};
const at = (pages: readonly DesignPage[], frame: string, id: string) => findLayer(pages.find((p) => p.id === frame)!.layers, id) as Layer & Record<string, unknown>;
/** A change as the designer makes one: what changed leaves its style, instances made again, styles put on. */
const change = (pages: DesignPage[], s: DesignStyles, fn: (l: Layer) => Layer) => {
  const next = pages.map((p) => ({ ...p, layers: p.layers.map(fn) }));
  return styled(syncInstances(unlinked(next, pages, s), pages), s);
};

describe("styles put on the layers that name them", () => {
  it("gives every colour place, text and effects its style's value, and leaves a design with none as it is", () => {
    const pages = [
      page("p1", [rect("a", { colorStyle: "accent" }), text("t", "Big news", { textStyle: "headline", colorStyle: "ink", upper: true, runs: [{ start: 0, end: 3, colorStyle: "accent", textStyle: "body" }] })], { colorStyle: "ink" }),
      page("p2", [rect("b", { fills: [{ type: "solid", color: "#000000", colorStyle: "accent" }], strokes: [{ color: "#000000", width: 4, colorStyle: "ink" }], effectStyle: "card" })]),
    ];
    const out = styled(pages, styles);
    expect(out[0]!.background).toBe("#111827");
    expect(at(out, "p1", "a").fill).toBe("#ff5500");
    expect(at(out, "p1", "t")).toMatchObject({ font: "Anton", size: 96, lineHeight: 1, case: "upper", color: "#111827", runs: [{ start: 0, end: 3, color: "#ff5500", font: "Inter", size: 36, weight: 400 }] });
    expect(at(out, "p1", "t").upper).toBeUndefined();
    expect(at(out, "p2", "b")).toMatchObject({ fills: [{ color: "#ff5500" }], strokes: [{ color: "#111827" }], effects: styles.effects!.card!.effects });
    // put on again: nothing changes, the same frames
    expect(styled(out, styles)).toBe(out);
    const plain = [page("p1", [rect("a")])];
    expect(styled(plain, undefined)).toBe(plain);
  });

  it("recolours every slide when a style changes, and a run takes only the first six digits of a see-through colour", () => {
    const pages = styled([page("p1", [rect("a", { colorStyle: "accent" })]), page("p2", [text("t", "Hi", { colorStyle: "accent", runs: [{ start: 0, end: 1, colorStyle: "accent" }] })])], styles);
    const next = withStyle(styles, "colors", "accent", { name: "Accent", color: "#00aa0080" });
    const out = styled(unlinked(pages, pages, next), next);
    expect(at(out, "p1", "a").fill).toBe("#00aa0080");
    expect(at(out, "p2", "t")).toMatchObject({ color: "#00aa0080", runs: [{ color: "#00aa00" }] });
  });

  it("detaches a layer that names a style the design has not (deleted, or never made), keeping its value, and says so", () => {
    const notes: string[] = [];
    const pages = [page("p1", [rect("a", { fill: "#123456", colorStyle: "gone" }), text("t", "x", { textStyle: "nope", styleOwn: ["size"], size: 50, effectStyle: "none" })])];
    const out = styled(pages, styles, (n) => notes.push(n));
    expect(at(out, "p1", "a")).toMatchObject({ fill: "#123456" });
    expect(at(out, "p1", "a").colorStyle).toBeUndefined();
    expect(at(out, "p1", "t")).toMatchObject({ size: 50 });
    expect(["textStyle", "styleOwn", "effectStyle"].map((k) => at(out, "p1", "t")[k])).toEqual([undefined, undefined, undefined]);
    expect(notes).toEqual(['layer a names no colour style "gone": its own colour kept', 'layer t names no effect style "none": its own effects kept', 'layer t names no text style "nope": its own font and size kept']);
    // deleting a used style: its layers keep the colour it gave them
    const used = styled([page("p1", [rect("a", { colorStyle: "accent" })])], styles);
    const less = withStyle(styles, "colors", "accent", null);
    expect(at(styled(used, less), "p1", "a")).toMatchObject({ fill: "#ff5500" });
    expect(at(styled(used, less), "p1", "a").colorStyle).toBeUndefined();
  });
});

describe("a value changed on a styled layer", () => {
  it("leaves the colour's style (a colour of its own), but not when it is changed to the style's own or the style changes", () => {
    const pages = styled([page("p1", [rect("a", { colorStyle: "accent" }), rect("b", { colorStyle: "accent" })])], styles);
    const out = change(pages, styles, (l) => (l.id === "a" ? { ...l, fill: "#0000ff" } as Layer : l));
    expect(at(out, "p1", "a")).toMatchObject({ fill: "#0000ff" });
    expect(at(out, "p1", "a").colorStyle).toBeUndefined();
    expect(at(out, "p1", "b")).toMatchObject({ fill: "#ff5500", colorStyle: "accent" });
    // a fill of its list too, and its line
    const listed = styled([page("p1", [rect("c", { fills: [{ type: "solid", color: "#000000", colorStyle: "accent" }], strokes: [{ color: "#000000", width: 2, colorStyle: "ink" }] })])], styles);
    const recoloured = change(listed, styles, (l) => ({ ...l, fills: [{ type: "solid", color: "#00ff00", colorStyle: "accent" }] }) as Layer);
    expect(at(recoloured, "p1", "c").fills).toEqual([{ type: "solid", color: "#00ff00" }]);
    expect(at(recoloured, "p1", "c").strokes).toEqual([{ color: "#111827", width: 2, colorStyle: "ink" }]);
  });

  it("keeps a text's changed fields its own on top of its text style, and the rest follows the style", () => {
    const pages = styled([page("p1", [text("t", "Title", { textStyle: "headline" })])], styles);
    const out = change(pages, styles, (l) => ({ ...l, size: 120 }) as Layer);
    expect(at(out, "p1", "t")).toMatchObject({ size: 120, styleOwn: ["size"], font: "Anton" });
    const next = withStyle(styles, "text", "headline", { ...styles.text!.headline!, font: "Inter", size: 80 });
    const after = styled(unlinked(out, out, next), next);
    expect(at(after, "p1", "t")).toMatchObject({ size: 120, font: "Inter" });
    // a run whose look is changed leaves its style
    const runs = styled([page("p1", [text("r", "Hello world", { runs: [{ start: 0, end: 5, textStyle: "body" }] })])], styles);
    const moved = change(runs, styles, (l) => ({ ...l, runs: [{ ...(l as TextLayer).runs![0]!, size: 70 }] }) as Layer);
    expect((at(moved, "p1", "r") as unknown as TextLayer).runs).toEqual([{ start: 0, end: 5, font: "Inter", size: 70, weight: 400 }]);
  });

  it("leaves a layer's effect style when its effects are changed", () => {
    const pages = styled([page("p1", [rect("a", { effectStyle: "card" })])], styles);
    const out = change(pages, styles, (l) => ({ ...l, effects: [{ type: "blur", blur: 4 }] }) as Layer);
    expect(at(out, "p1", "a")).toMatchObject({ effects: [{ type: "blur", blur: 4 }] });
    expect(at(out, "p1", "a").effectStyle).toBeUndefined();
  });
});

describe("styles in components", () => {
  const main = (): GroupLayer => ({ id: "m", type: "group", box: true, x: 0, y: 0, w: 200, h: 60, name: "Pill", component: "pill", layers: [rect("bg", { w: 200, h: 60, colorStyle: "accent" })] });
  const inst = (id: string): GroupLayer => ({ id, type: "group", x: 0, y: 500, w: 10, h: 10, layers: [], instance: { of: "pill" } });

  it("copies a main's style into every instance, and a style set or left on an instance's layer is its override", () => {
    let pages = styled(syncInstances([page("p1", [main(), inst("i1")]), page("p2", [inst("i2")])]), styles);
    expect([at(pages, "p1", "i1.bg"), at(pages, "p2", "i2.bg")].map((l) => [l.fill, l.colorStyle])).toEqual([["#ff5500", "accent"], ["#ff5500", "accent"]]);
    // Accent changed: every instance too
    const next = withStyle(styles, "colors", "accent", { name: "Accent", color: "#22cc88" });
    pages = styled(syncInstances(unlinked(pages, pages, next), pages), next);
    expect(at(pages, "p2", "i2.bg").fill).toBe("#22cc88");
    // one instance takes Ink, another a colour of its own
    pages = change(pages, next, (l) => (l.id === "i1" ? { ...l, layers: (l as GroupLayer).layers.map((k) => ({ ...k, colorStyle: "ink" }) as Layer) } : l));
    pages = change(pages, next, (l) => (l.id === "i2" ? { ...l, layers: (l as GroupLayer).layers.map((k) => ({ ...k, fill: "#abcdef" }) as Layer) } : l));
    expect([at(pages, "p1", "i1.bg").fill, at(pages, "p2", "i2.bg").fill, at(pages, "p2", "i2.bg").colorStyle]).toEqual(["#111827", "#abcdef", undefined]);
    expect((at(pages, "p2", "i2") as unknown as GroupLayer).instance!.overrides).toEqual({ bg: { fill: "#abcdef", colorStyle: null } });
    // a later edit elsewhere and Ink changed keep both: the instance on Ink follows it, the one of its own stays
    const inked = withStyle(next, "colors", "ink", { name: "Ink", color: "#000000" });
    pages = change(pages, inked, (l) => (l.id === "m" ? { ...l, name: "Pill 2" } : l));
    expect([at(pages, "p1", "i1.bg").fill, at(pages, "p2", "i2.bg").fill, at(pages, "p1", "bg").fill]).toEqual(["#000000", "#abcdef", "#22cc88"]);
  });
});

describe("styles of two windows merged", () => {
  it("keeps each side's styles and fields, and a style deleted on one side and changed on the other", () => {
    const base: DesignStyles = { colors: { accent: { name: "Accent", color: "#ff0000" }, ink: { name: "Ink", color: "#000000" }, old: { name: "Old", color: "#999999" } } };
    const mine: DesignStyles = { colors: { accent: { name: "Brand", color: "#ff0000" }, ink: { name: "Ink", color: "#000000" }, mine: { name: "Mine", color: "#00ff00" } }, text: { h: { name: "H", font: "Inter", size: 40 } } };
    const theirs: DesignStyles = { colors: { accent: { name: "Accent", color: "#0000ff" }, old: { name: "Old", color: "#888888" }, ai: { name: "AI", color: "#123456" } } };
    expect(mergeStyles(mine, base, theirs)).toEqual({
      colors: { accent: { name: "Brand", color: "#0000ff" }, old: { name: "Old", color: "#888888" }, ai: { name: "AI", color: "#123456" }, mine: { name: "Mine", color: "#00ff00" } },
      text: { h: { name: "H", font: "Inter", size: 40 } },
    });
    // nothing changed here: the server's
    expect(mergeStyles(base, base, theirs)).toEqual(theirs);
    // one field both sides changed: this window's, as a layer's field is
    expect(mergeStyles({ colors: { accent: { name: "Accent", color: "#111111" } } }, base, { colors: { accent: { name: "Accent", color: "#222222" } } }).colors!.accent!.color).toBe("#111111");
  });
});

describe("what the panels do with styles", () => {
  it("names ids after their names, makes a text style from a text, and lists and swaps the colours of a selection", () => {
    expect(styleId("Accent", [])).toBe("accent");
    expect(styleId("Accent", ["accent", "accent-2"])).toBe("accent-3");
    expect(styleId("!!!", [])).toBe("style");
    expect(textStyleOf(text("t", "x", { font: "Anton", size: 90, weight: 700, upper: true }), "Headline")).toEqual({ name: "Headline", font: "Anton", size: 90, weight: 700, case: "upper" });
    const layers = styled([page("p1", [rect("a", { colorStyle: "accent" }), rect("b", { fill: "#FF5500" }), text("t", "x", { color: "#ff5500", outline: { color: "#000000", width: 2 } })])], styles)[0]!.layers;
    expect(coloursOf(layers)).toEqual([{ color: "#ff5500", style: "accent", count: 1 }, { color: "#ff5500", count: 2 }, { color: "#000000", count: 1 }]);
    const swapped = swapColour(layers, { color: "#ff5500" }, { color: "#ff5500", style: "accent" });
    expect(swapped.map((l) => [(l as ShapeLayer).fill ?? (l as TextLayer).color, (l as ShapeLayer).colorStyle])).toEqual([["#ff5500", "accent"], ["#ff5500", "accent"], ["#ff5500", "accent"]]);
    const plain = swapColour(layers, { color: "#ff5500", style: "accent" }, { color: "#0000ff" });
    expect([(plain[0] as ShapeLayer).fill, (plain[0] as ShapeLayer).colorStyle, (plain[1] as ShapeLayer).fill]).toEqual(["#0000ff", undefined, "#FF5500"]);
  });

  it("pastes a copied look: a text's colour as a shape's fill, effects and their style, never the place or the words", () => {
    const from = text("t", "Words", { colorStyle: "accent", color: "#ff5500", effectStyle: "card", effects: styles.effects!.card!.effects, textStyle: "headline", opacity: 0.5 });
    const onto = withLook(rect("a", { x: 50, shadow: { color: "#000000", opacity: 1, blur: 1, x: 0, y: 0 } }), lookOf(from));
    expect(onto).toMatchObject({ x: 50, fill: "#ff5500", colorStyle: "accent", effectStyle: "card", opacity: 0.5 });
    expect(onto.shadow).toBeUndefined();
    expect((onto as unknown as Record<string, unknown>).textStyle).toBeUndefined();
    const onText = withLook(text("u", "Other", { font: "Inter" }), lookOf(from));
    expect(onText).toMatchObject({ text: "Other", textStyle: "headline", colorStyle: "accent" });
  });
});

describe("a style id that is a name every object has", () => {
  it("is no style unless the design has it, and one the design has is its own", () => {
    const pages = [page("p1", [rect("a", { fill: "#123456", colorStyle: "constructor" }), text("t", "x", { color: "#222222", textStyle: "constructor", runs: [{ start: 0, end: 1, textStyle: "tostring" }] })])];
    const out = styled(pages, styles);
    expect(at(out, "p1", "a")).toMatchObject({ fill: "#123456" });
    expect([at(out, "p1", "a").colorStyle, at(out, "p1", "t").textStyle]).toEqual([undefined, undefined]);
    expect(at(out, "p1", "t")).toMatchObject({ color: "#222222", font: "Inter", size: 40 });
    const own = { colors: { constructor: { name: "Odd", color: "#abcdef" } } } as DesignStyles;
    expect(at(styled(pages, own), "p1", "a").fill).toBe("#abcdef");
    expect(mergeStyles(own, {}, {})).toEqual(own);
    expect(mergeStyles({}, {}, own)).toEqual(own);
  });
});

describe("found in review", () => {
  it("a colour given to part of a run naming a style leaves the style there, and the rest keeps it", async () => {
    const { patchRange } = await import("./runs");
    const pages = styled([page("p1", [text("t", "Hello world", { runs: [{ start: 0, end: 11, colorStyle: "accent" }] })])], styles);
    const t = at(pages, "p1", "t") as unknown as TextLayer;
    const out = change(pages, styles, (l) => (l.id === "t" ? patchRange(t, (x) => ({ ...x, color: "#00ff00" }), 3, 5) : l));
    expect((at(out, "p1", "t") as unknown as TextLayer).runs).toEqual([{ start: 0, end: 3, color: "#ff5500", colorStyle: "accent" }, { start: 3, end: 5, color: "#00ff00" }, { start: 5, end: 11, color: "#ff5500", colorStyle: "accent" }]);
  });

  it("a colour changed while a line is added in the same change still leaves the style", () => {
    const pages = styled([page("p1", [text("t", "Hi", { colorStyle: "accent" })])], styles);
    const out = change(pages, styles, (l) => ({ ...l, color: "#00ff00", strokes: [{ color: "#000000", width: 2 }] }) as Layer);
    expect([at(out, "p1", "t").color, at(out, "p1", "t").colorStyle]).toEqual(["#00ff00", undefined]);
  });

  it("a run naming a style the design has not, with no colour of its own, keeps none", () => {
    const out = styled([page("p1", [text("t", "Hi", { runs: [{ start: 0, end: 1, colorStyle: "gone", size: 50 }] })])], styles);
    expect((at(out, "p1", "t") as unknown as TextLayer).runs).toEqual([{ start: 0, end: 1, size: 50 }]);
  });
});
