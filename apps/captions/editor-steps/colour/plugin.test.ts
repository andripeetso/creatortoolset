import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpeg } from "../../api/library/media/run";
import { convert, convertColour, cube, display, flatStats, gamutTo709, isFlat, PROFILES, rangeOf, readTag, toXyz, type Profile } from "./plugin";

/**
 * Each paper's own table: [scene value, 10-bit code]. Sony, Fujifilm, Panasonic and Apple give reflection (0.18 = 18%
 * grey); Canon gives scene linear (0.2 = 18% grey, reflection = scene linear * 0.9).
 */
const TABLES: Record<Profile, [number, number][]> = {
  slog3: [[0, 95], [0.18, 420], [0.9, 598]],
  flog: [[0, 95], [0.18, 470], [0.9, 705]],
  flog2: [[0, 95], [0.18, 400], [0.9, 570]],
  vlog: [[0, 128], [0.18, 433], [0.9, 602]],
  applelog: [[0, 154], [0.18, 500], [0.9, 697], [12, 1023]],
  clog2: [[0, 95], [0.2, 407], [1, 575], [8, 797], [16, 871], [64, 1020]].map(([x, cv]) => [x! * 0.9, cv!]),
  clog3: [[0, 128], [0.2, 351], [1, 577], [8, 908], [16, 1020]].map(([x, cv]) => [x! * 0.9, cv!]),
};
const near = (a: number[][], b: number[][], d: number) => a.flat().forEach((v, i) => expect(Math.abs(v - b.flat()[i]!)).toBeLessThan(d));

describe("the curves, against each paper's table", () => {
  for (const [p, rows] of Object.entries(TABLES) as [Profile, [number, number][]][]) {
    it(`${PROFILES[p].label}: each printed code value decodes to its reflection (within half a code)`, () => {
      const dec = PROFILES[p].decode;
      for (const [r, cv] of rows) {
        expect(dec((cv - 0.5) / 1023)).toBeLessThan(r);
        expect(dec((cv + 0.5) / 1023)).toBeGreaterThan(r);
      }
    });
  }
  it("Apple Log: the paper's float values too (0.150477 for 0%, 0.488272 for 18%, 1.0 for 1200%)", () => {
    expect(PROFILES.applelog.decode(0.150477)).toBeCloseTo(0, 5);
    expect(PROFILES.applelog.decode(0.488272)).toBeCloseTo(0.18, 5);
    expect(PROFILES.applelog.decode(1)).toBeCloseTo(12, 3);
  });
});

describe("the gamut matrices", () => {
  it("map white to white, and Rec.709 to itself", () => {
    for (const p of Object.values(PROFILES)) for (const row of gamutTo709(p.primaries)) expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 9);
    near(gamutTo709([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]]), [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1e-12);
  });
  it("match the matrices the papers and ITU-R BT.2087 print", () => {
    // Panasonic V-Gamut → BT.709 and V-Gamut → XYZ (Reference Manual 4.2)
    near(gamutTo709(PROFILES.vlog.primaries), [[1.806576, -0.695697, -0.110879], [-0.17009, 1.305955, -0.135865], [-0.025206, -0.154468, 1.179674]], 2e-4);
    near(toXyz(PROFILES.vlog.primaries), [[0.679644, 0.152211, 0.1186], [0.260686, 0.774894, -0.03558], [-0.00931, -0.004612, 1.10298]], 2e-4);
    // Canon Cinema Gamut → BT.709 (PUB. DIM-1102-000): up to 3.1e-4 apart, as its primaries are printed to two decimals
    near(gamutTo709(PROFILES.clog3.primaries), [[1.923598, -0.798602, -0.125039], [-0.204343, 1.495909, -0.291538], [-0.023715, -0.420205, 1.444117]], 5e-4);
    // BT.2020 → BT.709 (ITU-R BT.2087-0, the F-Log and Apple Log gamut)
    near(gamutTo709(PROFILES.applelog.primaries), [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]], 2e-4);
  });
});

describe("the display transform and the LUT", () => {
  it("puts 18% grey at the Rec.709 OETF's 0.409, is the OETF below the knee and stays under 1 above it", () => {
    expect(display(0.18)).toBeCloseTo(1.099 * 0.18 ** 0.45 - 0.099, 9);
    expect(display(-0.1)).toBe(0);
    expect(display(1)).toBeLessThan(1);
    expect(display(40)).toBeLessThanOrEqual(1);
    for (let x = 0.5; x < 4; x += 0.05) expect(display(x + 0.05)).toBeGreaterThan(display(x));
  });
  it("writes size³ lines, red fastest, and an identity transform as the grid itself", () => {
    const lines = cube((rgb) => rgb, 3).trim().split("\n");
    expect(lines.slice(0, 3)).toEqual(["LUT_3D_SIZE 3", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"]);
    expect(lines).toHaveLength(3 + 27);
    expect(lines[3]).toBe("0.000000 0.000000 0.000000");
    expect(lines[4]).toBe("0.500000 0.000000 0.000000");
    expect(lines[6]).toBe("0.000000 0.500000 0.000000");
    expect(lines[3 + 9]).toBe("0.000000 0.000000 0.500000");
    expect(lines.at(-1)).toBe("1.000000 1.000000 1.000000");
  });
  it("keeps a neutral code neutral, for every profile", () => {
    for (const p of Object.keys(PROFILES) as Profile[]) {
      const fn = convert(p);
      for (const v of [0.1, 0.3, 0.42, 0.6, 0.9]) {
        const [r, g, b] = fn([v, v, v]);
        expect(Math.abs(r - g) + Math.abs(g - b)).toBeLessThan(1e-9);
      }
    }
    expect(convert("slog3")([420 / 1023, 420 / 1023, 420 / 1023])[0]).toBeCloseTo(0.409, 3); // grey in, grey out
  });
});

// Excerpts of real files' metadata (identifiers, dates and serials left out)
const SONY_SLOG3 = `<AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="s-log3-cine"/><Item name="CaptureColorPrimaries" value="s-gamut3-cine"/><Item name="CodingEquations" value="rec709"/></Group></AcquisitionRecord>`;
const SONY_709 = `<Device manufacturer="Sony" modelName="ZV-E1"/><AcquisitionRecord><Group name="CameraUnitMetadataSet"><Item name="CaptureGammaEquation" value="rec709"/><Item name="CaptureColorPrimaries" value="rec709"/><Item name="CodingEquations" value="rec709"/></Group></AcquisitionRecord>`;
/** Fujifilm's maker note as it sits in a MOV's MVTG box: "FUJIFILM", the IFD's offset (12), then the IFD (little-endian). */
function fuji(mode: number): Buffer {
  const ifd = Buffer.alloc(2 + 12 * 2);
  ifd.writeUInt16LE(2, 0);
  ifd.writeUInt16LE(0x1401, 2); // another tag first, as in the file
  ifd.writeUInt16LE(3, 4);
  ifd.writeUInt16LE(0x3803, 14);
  ifd.writeUInt16LE(4, 16);
  ifd.writeUInt32LE(1, 18);
  ifd.writeUInt32LE(mode, 22);
  return Buffer.concat([Buffer.from("MVTG....FUJIFILM\x0c\x00\x00\x00", "latin1"), ifd]);
}

describe("what the file says", () => {
  it("Sony: S-Log3 with S-Gamut3.Cine is S-Log3, rec709 is normal, another log is named", () => {
    expect(readTag(Buffer.from(SONY_SLOG3))).toEqual({ log: "slog3" });
    expect(readTag(Buffer.from(SONY_709))).toEqual({ normal: true });
    expect(readTag(Buffer.from(SONY_SLOG3.replace("s-gamut3-cine", "s-gamut3")))).toEqual({ other: "s-log3-cine with s-gamut3 colour primaries" });
  });
  it("Fujifilm: video mode 0x10 is F-Log, 0x30 F-Log2, 0 and HLG normal", () => {
    expect(readTag(fuji(0x10))).toEqual({ log: "flog" });
    expect(readTag(fuji(0x30))).toEqual({ log: "flog2" });
    expect(readTag(fuji(0))).toEqual({ normal: true });
    expect(readTag(fuji(0x20))).toEqual({ normal: true });
    expect(readTag(fuji(0x40))).toEqual({ other: "Fujifilm video mode 0x40" });
  });
  it("nothing either way otherwise", () => expect(readTag(Buffer.from("moov....udta"))).toBeNull());
  it("reads a camera file's codes as they are, whatever its range tag, and ProRes as video range", () => {
    expect([rangeOf("hevc"), rangeOf("h264"), rangeOf("prores")]).toEqual(["full", "full", "limited"]);
    // why: the papers' IRE columns are (code − 64) / 876 of the same codes the curves take as code / 1023
    for (const [cv, ire] of [[95, 0.035], [420, 0.41], [128, 0.073], [433, 0.42]]) expect((cv! - 64) / 876).toBeCloseTo(ire!, 2);
  });
});

const frame = (fn: (i: number) => [number, number, number], n = 2000) => Buffer.from(Array.from({ length: n }, (_, i) => fn(i)).flat());
describe("looks flat", () => {
  it("a lifted, short, grey picture is flat; ordinary contrast or colour is not", () => {
    const flat = frame((i) => { const y = 50 + (i % 120); return [y + 4, y, y - 3]; });
    const normal = frame((i) => { const y = (i * 37) % 256; return [y, y, y]; });
    const colourful = frame((i) => { const y = 50 + (i % 120); return [y + 60, y, y - 40]; });
    expect(isFlat(flatStats(flat))).toBe(true);
    expect(isFlat(flatStats(normal))).toBe(false);
    expect(isFlat(flatStats(colourful))).toBe(false);
  });
});

const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "colour-step-"));
const probe = (file: string) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8" }));

describe("the Colour step on a file", () => {
  it("converts flat footage with the picked profile into a ProRes copy with the same frames and timecode, notes it, and only notes it on Auto", async () => {
    const take = path.join(dir, "take.mov");
    // a flat picture: lifted blacks, low contrast and little colour, as log footage looks
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2", "-f", "lavfi", "-i", "sine=d=2",
      "-vf", "lutyuv=y=150+(val-16)*0.45:u=128+(val-128)*0.1:v=128+(val-128)*0.1", "-c:v", "mpeg4", "-q:v", "2", "-c:a", "aac", "-timecode", "01:00:10:00", "-shortest", take]);
    const timeline = {
      sources: { t: { name: "Tiny-take", w: 320, h: 180, fps: 25, dur: 50 }, a: { name: "voice", w: 0, h: 0 } },
      tracks: { V1: { items: [{ src: "t" }] }, V2: { items: [] }, A1: { items: [{ src: "a" }] } },
    } as unknown as Timeline;
    const notes: string[] = [];
    const input = { edit: { id: "e", name: "E", createdBy: "me" }, variant: "", files: { t: take, a: take }, timeline, values: { profile: "auto" }, workDir: dir, signal: new AbortController().signal, note: (t: string) => notes.push(t), say: () => {} };
    expect(await convertColour(input)).toEqual({});
    expect(notes).toEqual(["Tiny-take looks flat (log?) but its camera profile isn't in the file: pick it under Colour in Settings → AI Editor"]);

    notes.length = 0;
    const out = await convertColour({ ...input, values: { profile: "slog3" } });
    expect(Object.keys(out)).toEqual(["t"]);
    expect(notes).toEqual(["Tiny-take: S-Log3 as set under Colour, converted to normal video"]);
    const [before, after] = [probe(take), probe(out.t!)];
    const video = (p: { streams: Record<string, unknown>[] }) => p.streams.find((s) => s.codec_type === "video")!;
    expect(video(after).codec_name).toBe("prores");
    expect(video(after).nb_frames).toBe(video(before).nb_frames);
    expect(video(after).color_transfer).toBe("bt709");
    expect(JSON.stringify(after)).toContain("01:00:10:00");
    expect(after.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
    expect(await convertColour({ ...input, values: { profile: "slog3" } })).toEqual(out); // the same copy again
    expect(await convertColour({ ...input, values: { profile: "off" } })).toEqual({});
  }, 60_000);
});
