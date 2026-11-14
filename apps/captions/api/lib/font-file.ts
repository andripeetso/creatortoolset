/**
 * A font file someone adds to their designs, read from its own bytes: the faces in it, each with the name it gives
 * itself and a file of its own. A TrueType or OpenType file is one face. A collection (.ttc, what a system keeps a
 * whole family in) is several, and a browser draws only one face a file, so each is cut out into a file of its own.
 *
 * The bytes come from outside: every place read is checked against the file's end first, and nothing in the file is
 * trusted to be where it says. A compressed web font (WOFF, WOFF2) is not read: its names are packed away.
 * ponytail: no WOFF. Add its unpacking (zlib a table, or one brotli stream) when someone has only a web font.
 */

export class FontError extends Error {}

export interface FontFaceFile {
  /** what the face calls itself, family and style together: "Superclarendon Black" */
  family: string;
  ext: "ttf" | "otf";
  bytes: Buffer;
}

/** Faces a collection may hold, tables a face may have, and the longest name kept. */
const MAX_FACES = 24;
const MAX_TABLES = 80;
export const FONT_NAME_MAX = 60;

const TRUETYPE = [0x00010000, 0x74727565]; // 1.0, "true"
const OPENTYPE = 0x4f54544f; // "OTTO"
const COLLECTION = 0x74746366; // "ttcf"

interface Table {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

function need(file: Buffer, at: number, length: number): void {
  if (!Number.isInteger(at) || at < 0 || length < 0 || at + length > file.length) throw new FontError("This font file is cut short or damaged");
}

/** One face's tables, read from its table list at `at`. */
function tablesAt(file: Buffer, at: number): { kind: number; tables: Table[] } {
  need(file, at, 12);
  const kind = file.readUInt32BE(at);
  if (!TRUETYPE.includes(kind) && kind !== OPENTYPE) throw new FontError("This is not a TrueType or OpenType font");
  const count = file.readUInt16BE(at + 4);
  if (!count || count > MAX_TABLES) throw new FontError("This font file is cut short or damaged");
  need(file, at + 12, count * 16);
  const tables: Table[] = [];
  for (let k = 0; k < count; k++) {
    const r = at + 12 + k * 16;
    const t = { tag: file.toString("latin1", r, r + 4), checksum: file.readUInt32BE(r + 4), offset: file.readUInt32BE(r + 8), length: file.readUInt32BE(r + 12) };
    need(file, t.offset, t.length);
    tables.push(t);
  }
  return { kind, tables };
}

/** A face as a file of its own: its tables one after another, each on a four-byte step, behind a list that says where. */
function faceFile(file: Buffer, kind: number, tables: Table[]): Buffer {
  const n = tables.length;
  const pad = (len: number) => (len + 3) & ~3;
  const out = Buffer.alloc(12 + n * 16 + tables.reduce((sum, t) => sum + pad(t.length), 0));
  const power = 2 ** Math.floor(Math.log2(n));
  out.writeUInt32BE(kind, 0);
  out.writeUInt16BE(n, 4);
  out.writeUInt16BE(power * 16, 6);
  out.writeUInt16BE(Math.log2(power), 8);
  out.writeUInt16BE(n * 16 - power * 16, 10);
  let at = 12 + n * 16;
  [...tables]
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))
    .forEach((t, k) => {
      const r = 12 + k * 16;
      out.write(t.tag, r, 4, "latin1");
      out.writeUInt32BE(t.checksum, r + 4);
      out.writeUInt32BE(at, r + 8);
      out.writeUInt32BE(t.length, r + 12);
      file.copy(out, at, t.offset, t.offset + t.length);
      at += pad(t.length);
    });
  return out;
}

/**
 * A face's name from its name table: the family and the style it gives itself, the names a designer picks it by when
 * it has them (16 and 17), else the plain ones (1 and 2). "Regular" is left off. English from the Windows names first,
 * then any Windows name, then a Mac one.
 */
function nameOf(file: Buffer, tables: Table[]): string {
  const t = tables.find((x) => x.tag === "name");
  if (!t) throw new FontError("This font does not say what it is called");
  need(file, t.offset, 6);
  const count = file.readUInt16BE(t.offset + 2);
  const strings = t.offset + file.readUInt16BE(t.offset + 4);
  need(file, t.offset + 6, count * 12);
  const found = new Map<number, { rank: number; text: string }>();
  for (let k = 0; k < count; k++) {
    const r = t.offset + 6 + k * 12;
    const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => file.readUInt16BE(r + o)) as [number, number, number, number, number, number];
    if (![1, 2, 16, 17].includes(id) || (platform !== 3 && platform !== 1 && platform !== 0)) continue;
    const from = strings + offset;
    if (from + length > t.offset + t.length || from + length > file.length) continue;
    const rank = platform === 1 ? 1 : language === 0x409 ? 3 : 2;
    if ((found.get(id)?.rank ?? 0) >= rank) continue;
    // Windows and Unicode names are two bytes a letter, high byte first; a Mac name is one
    const text = platform === 1 ? file.toString("latin1", from, from + length) : Buffer.from(file.subarray(from, from + length)).swap16().toString("utf16le");
    found.set(id, { rank, text });
  }
  const family = (found.get(16) ?? found.get(1))?.text ?? "";
  const style = (found.get(16) ? found.get(17) : found.get(2))?.text ?? "";
  // a name goes into a canvas's font and a style sheet: letters, digits, spaces and hyphens only
  const name = `${family} ${/^regular$/i.test(style.trim()) ? "" : style}`.replace(/[^\p{L}\p{N} -]/gu, " ").replace(/\s+/g, " ").trim().slice(0, FONT_NAME_MAX).trim();
  if (!/\p{L}/u.test(name)) throw new FontError("This font does not say what it is called");
  return name;
}

/** The faces in a font file. Throws FontError, in words for the person who added it, for anything that is not one. */
export function fontFaces(file: Buffer): FontFaceFile[] {
  need(file, 0, 12);
  const magic = file.readUInt32BE(0);
  if (magic === 0x774f4646 || magic === 0x774f4632) throw new FontError("A web font (WOFF) cannot be added: add the font's .ttf or .otf file");
  const starts: number[] = [];
  if (magic === COLLECTION) {
    const count = file.readUInt32BE(8);
    if (!count || count > MAX_FACES) throw new FontError("This font file is cut short or damaged");
    need(file, 12, count * 4);
    for (let k = 0; k < count; k++) starts.push(file.readUInt32BE(12 + k * 4));
  } else starts.push(0);
  const faces = starts.map((at) => {
    const { kind, tables } = tablesAt(file, at);
    return { family: nameOf(file, tables), ext: kind === OPENTYPE ? ("otf" as const) : ("ttf" as const), bytes: magic === COLLECTION ? faceFile(file, kind, tables) : file };
  });
  // two faces of one name in a file (a collection's copies for other scripts): the first stands
  return faces.filter((f, k) => faces.findIndex((x) => x.family.toLowerCase() === f.family.toLowerCase()) === k);
}
