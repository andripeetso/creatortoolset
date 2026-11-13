import { describe, expect, it } from "vitest";
import type { DesignPage } from "@contracts/design";
import { coloursOn, toHex, toHsv, typedHex } from "./colour";

describe("the colour picker's colours", () => {
  it("reads a colour as hue, strength and lightness, and writes the same colour back", () => {
    expect(toHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
    expect(toHsv("#00ff00").h).toBe(120);
    expect(toHsv("#0000ff").h).toBe(240);
    expect(toHsv("#808080")).toMatchObject({ h: 0, s: 0 });
    expect(toHsv("#000000")).toEqual({ h: 0, s: 0, v: 0 });
    for (const c of ["#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#0d99ff", "#e4572e", "#17202a", "#f4e9d8", "#7c3aed"]) expect(toHex(toHsv(c))).toBe(c);
    expect(toHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(toHex({ h: 210, s: 0, v: 0.5 })).toBe("#808080");
    expect(toHsv("not a colour")).toEqual({ h: 0, s: 0, v: 0 });
  });

  it("takes a typed colour with or without its #, three digits or six, and nothing else", () => {
    expect(typedHex("FFAA00")).toBe("#ffaa00");
    expect(typedHex(" #abc ")).toBe("#aabbcc");
    expect(typedHex("#ffaa0")).toBeNull();
    expect(typedHex("red")).toBeNull();
  });

  it("lists the colours a design already uses, the most used first", () => {
    const shape = (fill: string) => ({ id: fill, type: "shape", shape: "rect", fill, x: 0, y: 0, w: 1, h: 1 }) as never;
    const pages = [
      { id: "p1", background: "#FFFFFF", layers: [shape("#ff0000"), shape("#ff0000"), { id: "t", type: "text", text: "a", font: "Inter", size: 10, color: "#111111", align: "left", x: 0, y: 0, w: 1, h: 1, outline: { color: "#ff0000", width: 2 }, shadow: { color: "#000000", opacity: 0.3, blur: 1, x: 0, y: 0 } }] },
      { id: "p2", background: "#ffffff", layers: [] },
    ] as DesignPage[];
    expect(coloursOn(pages)).toEqual(["#ff0000", "#ffffff", "#111111", "#000000"]);
    expect(coloursOn(pages, 2)).toEqual(["#ff0000", "#ffffff"]);
  });
});
