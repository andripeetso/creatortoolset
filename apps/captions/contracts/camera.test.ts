import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { metaFrom } from "../editor-steps/colour/plugin";
import { convert, cube, detectCamera, metaBoxes, PROFILES, readCube, type Profile, type ReadBytes } from "./camera";

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("the camera module gives what the Colour step gave before it moved", () => {
  // the Colour step's outputs on main 1ff453fba, before the move: each profile's 33-point .cube and conversions on a grid
  const BEFORE: Record<string, string> = {
    "cube:slog3": "eea452f727727f19", "convert:slog3": "aacdd1dac81c26ae", "cube:flog": "49141f97db60db4c", "convert:flog": "f30cebdbccaaad3a",
    "cube:flog2": "da93d74cb920d6e4", "convert:flog2": "82905844d54eaa20", "cube:applelog": "dbc25557c7f57a0b", "convert:applelog": "fefe0d701137d9fb",
    "cube:vlog": "35174bc26b06009c", "convert:vlog": "73bb5d33d984c9ab", "cube:clog2": "ea463200c8c621df", "convert:clog2": "314b8e304b2ad32e",
    "cube:clog3": "93878f6f2c0e3a85", "convert:clog3": "70235b8174d941e7", "cube:identity5": "8fc6334153f31d02",
  };
  it("the same .cube text and conversions, byte for byte", () => {
    const now: Record<string, string> = {};
    for (const p of Object.keys(PROFILES) as Profile[]) {
      now[`cube:${p}`] = h(cube(convert(p)));
      const fn = convert(p);
      const pts: number[][] = [];
      for (let i = 0; i <= 20; i++) pts.push(fn([i / 20, ((i * 7) % 21) / 20, ((i * 13) % 21) / 20]));
      now[`convert:${p}`] = h(JSON.stringify(pts));
    }
    now["cube:identity5"] = h(cube((rgb) => rgb, 5));
    expect(now).toEqual(BEFORE);
  });
});

/** A top-level box: 32-bit size, or 1 and a 64-bit size after the type. */
function box(type: string, body: Uint8Array, large = false): Buffer {
  const head = Buffer.alloc(large ? 16 : 8);
  if (large) {
    head.writeUInt32BE(1, 0);
    head.writeBigUInt64BE(BigInt(16 + body.length), 8);
  } else head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
// a Sony-style file: ftyp, moov, the media data (a 64-bit size), then the NonRealTimeMeta XML in its own box
const XML = `<?xml version="1.0"?><NonRealTimeMeta><Device manufacturer="Tiny Acrobatics" modelName="T1"/><AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/></Group></AcquisitionRecord></NonRealTimeMeta>`;
const sony = (xml = XML) =>
  Buffer.concat([box("ftyp", Buffer.from("XAVC\0\0\0\0")), box("moov", Buffer.alloc(40)), box("mdat", Buffer.alloc(200_000, 7), true), box("uuid", Buffer.from(xml))]);
const reads = (file: Buffer) => {
  const asked: [number, number][] = [];
  const read: ReadBytes = async (o, n) => (asked.push([o, n]), file.subarray(o, o + n));
  return { read, asked };
};

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "camera-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("what the file says, from a few reads", () => {
  it("finds Sony's S-Log3 without reading the media data", async () => {
    const { read, asked } = reads(sony());
    expect(await detectCamera(read)).toEqual({ curve: "slog3", from: "file" });
    expect(Math.max(...asked.map(([, n]) => n))).toBeLessThan(1000);
  });
  it("names no curve for normal video, another log, or a file with no metadata", async () => {
    expect(await detectCamera(reads(sony(XML.replace("s-log3-cine", "rec709"))).read)).toBeNull();
    expect(await detectCamera(reads(sony(XML.replace("s-gamut3-cine", "s-gamut3"))).read)).toBeNull();
    expect(await detectCamera(reads(Buffer.concat([box("ftyp", Buffer.alloc(8)), box("mdat", Buffer.alloc(100))])).read)).toBeNull();
    expect(await detectCamera(reads(Buffer.alloc(0)).read)).toBeNull();
  });
  it("the Colour step's file reads give the same boxes as the page's reads", async () => {
    const file = path.join(dir, "take.mp4");
    writeFileSync(file, sony());
    const page = await metaBoxes(reads(sony()).read);
    expect(Buffer.from(await metaFrom(file)).equals(Buffer.from(page))).toBe(true);
    expect(page.length).toBe(16 + 48 + 8 + XML.length);
  });
});

describe("a .cube someone adds", () => {
  const good = cube((rgb) => rgb, 33);
  it("reads a 33-point 3D LUT, red fastest", () => {
    const r = readCube(`TITLE "Tiny look"\n# made for a test\n${good}`);
    if ("error" in r) throw new Error(r.error);
    expect(r.size).toBe(33);
    expect(r.title).toBe("Tiny look");
    expect(r.values.length).toBe(33 ** 3 * 3);
    expect([r.values[3]!, r.values[4], r.values[33 * 3 + 4]!]).toEqual([expect.closeTo(1 / 32, 5), 0, expect.closeTo(1 / 32, 5)]);
  });
  it("refuses a 1D shaper, a short table, a wrong row count, a bad size and numbers out of range", () => {
    expect(readCube(`LUT_1D_SIZE 1024\n${good}`)).toEqual({ error: expect.stringContaining("1D shaper") });
    const rows = good.trim().split("\n");
    expect(readCube(rows.slice(0, -5).join("\n"))).toEqual({ error: expect.stringContaining("35932 rows where a 33-point LUT has 35937") });
    expect(readCube([...rows, "0 0 0"].join("\n"))).toEqual({ error: expect.stringContaining("more than the 35937 rows") });
    expect(readCube("LUT_3D_SIZE 200\n0 0 0")).toEqual({ error: expect.stringContaining("2 to 129") });
    expect(readCube("LUT_3D_SIZE 2\n0 0 0\n255 255 255\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0\n0 0 0")).toEqual({ error: expect.stringContaining("is not three numbers") });
    expect(readCube("0 0 0")).toEqual({ error: expect.stringContaining("no LUT_3D_SIZE") });
  });
});
