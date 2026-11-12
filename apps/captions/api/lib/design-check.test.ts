import { describe, expect, it } from "vitest";
import { DESIGN_LIMITS } from "../../contracts/design";
import { cleanPages, coverPage, plainPages, plainWords, safeSvg, slideWords } from "./design-check";

const rules = { w: 1080, h: 1350, pictures: ["ab12cd34.jpg"] };
const text = (more: object = {}) => ({ type: "text", x: 90, y: 100, w: 900, h: 300, text: "Roll the mat out", font: "Anton", size: 96, color: "#112233", align: "center", ...more });

describe("a design's pages, checked", () => {
  it("keeps a good page as it is, gives every layer and page an id of its own, and brings a number out of range back inside", () => {
    const { pages, notes } = cleanPages(
      [
        { background: "#FFEECC", layers: [text({ id: "title" }), text({ id: "title", text: "Then the ramp" }), { type: "shape", shape: "ellipse", x: -5000, y: 10, w: 99999, h: 0, fill: "#f00", radius: 30, stroke: { color: "#000", width: 900 } }] },
        { id: "p1", background: "not a colour", layers: [{ type: "image", picture: "ab12cd34.jpg", x: 0, y: 0, w: 1080, h: 1350, fit: "stretch", rotate: 720, opacity: 0.5 }] },
      ],
      rules,
    );
    expect(notes).toEqual([]);
    expect(pages.map((p) => [p.id, p.background])).toEqual([["p1", "#ffeecc"], ["p2", "#ffffff"]]);
    expect(pages[0]!.layers.map((l) => l.id)).toEqual(["title", "l2", "l3"]);
    expect(pages[0]!.layers[0]).toEqual({ id: "title", type: "text", x: 90, y: 100, w: 900, h: 300, text: "Roll the mat out", font: "Anton", size: 96, color: "#112233", align: "center" });
    expect(pages[0]!.layers[2]).toEqual({ id: "l3", type: "shape", shape: "ellipse", x: -1080, y: 10, w: 2160, h: 1, fill: "#f00", radius: 30, stroke: { color: "#000", width: 200 } });
    expect(pages[1]!.layers[0]).toEqual({ id: "l1", type: "image", picture: "ab12cd34.jpg", x: 0, y: 0, w: 1080, h: 1350, fit: "cover", rotate: 360, opacity: 0.5 });
  });

  it("a font or colour the app does not have becomes one it has; a size, line height and outline are held to what can be drawn", () => {
    const [l] = cleanPages([{ layers: [text({ font: "Comic Sans", color: "red", size: 5000, lineHeight: 9, valign: "middle", upper: true, outline: { color: "#FFF", width: 400 }, align: "justify" })] }], rules).pages[0]!.layers;
    expect(l).toMatchObject({ font: "Inter", color: "#111111", size: 600, lineHeight: 3, valign: "middle", upper: true, outline: { color: "#fff", width: 60 }, align: "left" });
  });

  it("leaves out what cannot be drawn, each with its reason: a picture not in the design, a drawing that is not plain shapes, a kind it does not know, empty words", () => {
    const { pages, notes } = cleanPages(
      [{ layers: [{ type: "image", picture: "ffffffff.png", x: 0, y: 0, w: 10, h: 10 }, { type: "drawing", x: 0, y: 0, w: 10, h: 10, svg: '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>' }, { type: "video", x: 0, y: 0, w: 1, h: 1 }, text({ text: "   " }), "nonsense"] }],
      rules,
    );
    expect(pages[0]!.layers).toEqual([]);
    expect(notes).toEqual(["Page 1: a picture that is not in this design: left out", "Page 1: a drawing that is not plain shapes: left out"]);
  });

  it("holds an AI's answer to each page's own words: placed, split and cased as it likes, never added to or changed", () => {
    const words = ["Roll the mat out.\n\nThen the ramp goes down → slowly.", "Try it today"];
    const { pages, notes } = cleanPages(
      [
        { layers: [text({ text: "ROLL THE MAT OUT" }), text({ text: "Then the ramp goes down, slowly" }), text({ text: "Swipe for more!" }), text({ text: "Try it today" })] },
        { layers: [text({ text: "Try it today" })] },
      ],
      { ...rules, words },
    );
    expect(pages[0]!.layers.map((l) => l.type === "text" && l.text)).toEqual(["ROLL THE MAT OUT", "Then the ramp goes down, slowly"]);
    expect(pages[1]!.layers).toHaveLength(1);
    expect(notes).toEqual(["Page 1: “Swipe for more!” is not in its own words: left out", "Page 1: “Try it today” is not in its own words: left out"]);
    // the person's own changes are never held to that
    expect(cleanPages([{ layers: [text({ text: "Swipe for more!" })] }], rules).pages[0]!.layers).toHaveLength(1);
  });

  it("holds a design to its limits: pages, layers, the length of a text", () => {
    const many = cleanPages(Array.from({ length: 30 }, () => ({ layers: Array.from({ length: 60 }, () => text({ text: "x".repeat(900) })) })), rules).pages;
    expect(many).toHaveLength(DESIGN_LIMITS.pages);
    expect(many[0]!.layers).toHaveLength(DESIGN_LIMITS.layers);
    expect(many[0]!.layers[0]).toMatchObject({ text: "x".repeat(DESIGN_LIMITS.text) });
    expect(cleanPages("nonsense", rules).pages).toEqual([]);
  });
});

describe("a drawing is shapes only", () => {
  const ok = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#f90"/><path d="M10 10L90 90" stroke="#000"/></svg>';
  it("takes shapes and paths, and names its own kind when the markup did not", () => {
    expect(safeSvg(ok)).toBe(ok.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"'));
    expect(safeSvg(`  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="url(#g)"/></svg> `)).toContain('fill="url(#g)"');
  });
  it("refuses anything that could run, load or say something: scripts, handlers, links, pictures, text, styles, animations, addresses", () => {
    for (const bad of [
      '<svg viewBox="0 0 1 1"><script>1</script></svg>',
      '<svg viewBox="0 0 1 1" onload="x()"><rect/></svg>',
      '<svg viewBox="0 0 1 1"><a href="https://example.com"><rect/></a></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://example.com/a.png"/></svg>',
      '<svg viewBox="0 0 1 1"><text>Buy now</text></svg>',
      '<svg viewBox="0 0 1 1"><style>@import url(https://example.com/a.css)</style></svg>',
      '<svg viewBox="0 0 1 1"><rect fill="url(https://example.com/a.svg#x)"/></svg>',
      '<svg viewBox="0 0 1 1"><foreignObject><div/></foreignObject></svg>',
      '<svg viewBox="0 0 1 1"><animate attributeName="x"/></svg>',
      '<svg viewBox="0 0 1 1"><use xlink:href="#a"/></svg>',
      '<!DOCTYPE svg><svg viewBox="0 0 1 1"><rect/></svg>',
      '<svg><rect/></svg>',
      "<div>not a drawing</div>",
      `<svg viewBox="0 0 1 1">${"<rect/>".repeat(4000)}</svg>`,
      42,
    ]) expect(safeSvg(bad), String(bad).slice(0, 60)).toBeNull();
  });
});

describe("what the layers list keeps", () => {
  it("a layer's name, hidden and locked and a page's name are saved; anything else in their place is not", () => {
    const shape = { type: "shape", shape: "rect", fill: "#ff0000", x: 0, y: 0, w: 10, h: 10 };
    const { pages } = cleanPages([{ name: "  The  hook ", background: "#ffffff", layers: [{ ...shape, id: "a", name: " Red\n box ", hidden: true, locked: true }, { ...shape, id: "b", name: 7, hidden: "yes", locked: 1 }, { ...shape, id: "c", name: "x".repeat(200) }] }, { name: "", layers: [] }], { w: 100, h: 100, pictures: [] });
    expect(pages[0]!.name).toBe("The hook");
    expect(pages[0]!.layers[0]).toEqual({ ...shape, id: "a", name: "Red box", hidden: true, locked: true });
    expect(pages[0]!.layers[1]).toEqual({ ...shape, id: "b" });
    expect(pages[0]!.layers[2]!.name).toHaveLength(60);
    expect("name" in pages[1]!).toBe(false);
  });
});

describe("an AI's words on the page", () => {
  it("a box of words that sticks out of the page is moved onto it, with a note; the person's own stay where they put them", () => {
    const text = { type: "text", text: "Roll it", font: "Inter", size: 40, color: "#111111", align: "center", x: 540, y: -30, w: 1000, h: 200 };
    const ai = cleanPages([{ layers: [text, { ...text, x: -5, y: 100, w: 2000 }, { ...text, x: 900, y: 100, rotate: 20 }] }], { w: 1080, h: 1350, pictures: [], words: ["Roll it"] });
    expect(ai.pages[0]!.layers.map((l) => [l.x, l.y, l.w, l.h])).toEqual([[80, 0, 1000, 200], [0, 100, 1080, 200], [900, 100, 1000, 200]]);
    expect(ai.notes).toEqual(["Page 1: words that stuck out of the page were moved onto it", "Page 1: words that stuck out of the page were moved onto it"]);
    const own = cleanPages([{ layers: [text] }], { w: 1080, h: 1350, pictures: [] });
    expect(own.pages[0]!.layers[0]).toMatchObject({ x: 540, y: -30, w: 1000 });
    expect(own.notes).toEqual([]);
  });
});

describe("the pages a design starts with", () => {
  it("a carousel: each slide's first part as its headline and the rest under it, picture tokens taken out, every word kept", () => {
    const slides = ["Roll the mat out\n\nOn a soft floor, with you next to it.\n\n![a mat](pic:abc12345)", "Try it today"];
    expect(slideWords(slides[0]!)).toBe("Roll the mat out\n\nOn a soft floor, with you next to it.");
    const pages = plainPages(slides, 1080, 1350);
    expect(pages.map((p) => p.layers.map((l) => l.type === "text" && l.text))).toEqual([["Roll the mat out", "On a soft floor, with you next to it."], ["Try it today"]]);
    for (const p of pages) for (const l of p.layers) expect(l.x >= 0 && l.y >= 0 && l.x + l.w <= 1080 && l.y + l.h <= 1350).toBe(true);
    // what it starts with passes its own check, with the slides as the pages' words
    expect(cleanPages(pages, { w: 1080, h: 1350, pictures: [], words: slides.map(slideWords) })).toEqual({ pages, notes: [] });
    expect(plainWords("  Then the ramp — goes DOWN, slowly! ")).toBe("then the ramp goes down slowly");
  });

  it("a cover: the video's frame filling the page and its title over the lower part; no title, the frame alone", () => {
    const page = coverPage("ab12cd34.jpg", "Why the floor comes first", 1080, 1920);
    expect(page.layers[0]).toEqual({ id: "l1", type: "image", picture: "ab12cd34.jpg", fit: "cover", x: 0, y: 0, w: 1080, h: 1920 });
    expect(page.layers[1]).toMatchObject({ type: "text", text: "Why the floor comes first", upper: true, align: "center" });
    expect(cleanPages([page], { w: 1080, h: 1920, pictures: ["ab12cd34.jpg"] }).pages).toEqual([page]);
    expect(coverPage("ab12cd34.jpg", "  ", 1280, 720).layers).toHaveLength(1);
  });
});
