import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FontError, fontFaces } from "./font-file";

const bundled = (name: string) => readFileSync(path.join(import.meta.dirname, "..", "..", "public", "fonts", name));
const bevan = bundled("Bevan-Regular.ttf");
const coustard = bundled("Coustard-Black.ttf");

/** Single-face fonts as one collection, the way a system keeps a family: a list of where each face is, then the faces, each one's tables now counted from the collection's start. */
function collectionOf(fonts: Buffer[]): Buffer {
  const head = Buffer.alloc(12 + fonts.length * 4);
  head.write("ttcf", 0, "latin1");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(fonts.length, 8);
  let at = head.length;
  const parts = fonts.map((font, k) => {
    const copy = Buffer.from(font);
    for (let t = 0; t < copy.readUInt16BE(4); t++) copy.writeUInt32BE(copy.readUInt32BE(12 + t * 16 + 8) + at, 12 + t * 16 + 8);
    head.writeUInt32BE(at, 12 + k * 4);
    at += copy.length;
    return copy;
  });
  return Buffer.concat([head, ...parts]);
}

/** A font file's tables by their four-letter names. */
function tablesOf(file: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (let t = 0; t < file.readUInt16BE(4); t++) {
    const r = 12 + t * 16;
    out.set(file.toString("latin1", r, r + 4), file.subarray(file.readUInt32BE(r + 8), file.readUInt32BE(r + 8) + file.readUInt32BE(r + 12)));
  }
  return out;
}

describe("a font file someone adds", () => {
  it("a TrueType file is one face, named as it names itself: its family, and its style when that is not Regular", () => {
    expect(fontFaces(bevan).map((f) => [f.family, f.ext, f.bytes === bevan])).toEqual([["Bevan", "ttf", true]]);
    expect(fontFaces(coustard).map((f) => f.family)).toEqual(["Coustard Black"]);
    expect(fontFaces(bundled("Montserrat-ExtraBold.ttf")).map((f) => f.family)).toEqual(["Montserrat ExtraBold"]);
  });

  it("a collection is its faces, each cut out into a file of its own with every table as it was", () => {
    const faces = fontFaces(collectionOf([bevan, coustard]));
    expect(faces.map((f) => [f.family, f.ext])).toEqual([["Bevan", "ttf"], ["Coustard Black", "ttf"]]);
    for (const [k, whole] of [bevan, coustard].entries()) {
      const cut = tablesOf(faces[k]!.bytes);
      const was = tablesOf(whole);
      expect([...cut.keys()].sort()).toEqual([...was.keys()].sort());
      for (const [tag, bytes] of was) expect(cut.get(tag)!.equals(bytes), tag).toBe(true);
      // and the cut file is a font file again: read once more, it is that one face
      expect(fontFaces(faces[k]!.bytes).map((f) => f.family)).toEqual([faces[k]!.family]);
    }
    // the same face twice in a collection is one font
    expect(fontFaces(collectionOf([bevan, bevan])).map((f) => f.family)).toEqual(["Bevan"]);
  });

  it("says in words what is not a font it can read, and never reads past a file's end", () => {
    const said = (file: Buffer) => {
      try {
        fontFaces(file);
        return "read";
      } catch (e) {
        return e instanceof FontError ? e.message : `threw ${String(e)}`;
      }
    };
    expect(said(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]))).toBe("This is not a TrueType or OpenType font");
    expect(said(bundled("Archivo-ExpandedBlack.woff2"))).toBe("A web font (WOFF) cannot be added: add the font's .ttf or .otf file");
    expect(said(Buffer.alloc(4))).toBe("This font file is cut short or damaged");
    expect(said(bevan.subarray(0, 4000))).toBe("This font file is cut short or damaged");
    // a table said to lie past the file's end
    const far = Buffer.from(bevan);
    far.writeUInt32BE(far.length + 10, 12 + 8);
    expect(said(far)).toBe("This font file is cut short or damaged");
    // a collection that says it holds more faces than there is room for, or a thousand
    const many = collectionOf([bevan]);
    many.writeUInt32BE(1000, 8);
    expect(said(many)).toBe("This font file is cut short or damaged");
    const lying = collectionOf([bevan]);
    lying.writeUInt32BE(lying.length - 2, 12);
    expect(said(lying)).toBe("This font file is cut short or damaged");
    // a font with no name table
    const nameless = Buffer.from(bevan);
    for (let t = 0; t < nameless.readUInt16BE(4); t++) if (nameless.toString("latin1", 12 + t * 16, 16 + t * 16) === "name") nameless.write("nam2", 12 + t * 16, 4, "latin1");
    expect(said(nameless)).toBe("This font does not say what it is called");
  });
});
