import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { blurOf, pictureHash, qualityOf, readPicture, SAME_PICTURE_BITS, samePicture, shiftOf } from "./look";
import { MIGRATIONS } from "./schema";
import { setUserLine, storeStretches, stretchesOf } from "./stretches";

describe("picture hash", () => {
  const frame = (f: (x: number, y: number) => number) => Uint8Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));
  it("the same picture, a little brighter, is the same; another picture is not", () => {
    const a = frame((x, y) => (x * 23 + y * 7) % 251);
    const brighter = frame((x, y) => Math.min(255, ((x * 23 + y * 7) % 251) + 3));
    const other = frame((x, y) => (x * 61 + y * 97 + 13) % 241);
    expect(samePicture(pictureHash(a), pictureHash(brighter))).toBe(true);
    expect(samePicture(pictureHash(a), pictureHash(other))).toBe(false);
  });
  it(`up to ${SAME_PICTURE_BITS} bits apart is the same picture (a still scene, 0-3 measured); 5 is another moment (one fight's, 6-11 measured)`, () => {
    expect(SAME_PICTURE_BITS).toBe(4);
    expect(samePicture("0000000000000000", "000000000000000f")).toBe(true);
    expect(samePicture("0000000000000000", "100000000000000f")).toBe(false);
  });
  it("an empty or broken hash is never the same", () => {
    expect(samePicture("", "")).toBe(false);
    expect(samePicture("zz", "0000000000000000")).toBe(false);
  });
});

describe("stretchesOf", () => {
  it("reads in order, and the person's own line wins", () => {
    const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
    mkdirSync(scratch, { recursive: true });
    const db = new DatabaseSync(path.join(mkdtempSync(path.join(scratch, "stretches-")), "l.db"));
    db.exec("PRAGMA foreign_keys = OFF");
    for (const m of MIGRATIONS) db.exec(m);
    const add = db.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)");
    add.run("v1", 1, 6, 12, 0.9, 5, 1, '["fight","boss"]', "a boss fight", "00ff00ff00ff00ff", "ai", "s1");
    add.run("v1", 0, 0, 6, 0.1, 0, 0, '["menu"]', "character select", "ffffffffffffffff", "ai", "s1");
    add.run("v1", 0, 0, 6, 0.1, 0, 0, "[]", "his own line", null, "user", null);
    const got = stretchesOf(db, "v1");
    expect(got.map((s) => [s.seg, s.text, s.source])).toEqual([
      [0, "his own line", "user"],
      [1, "a boss fight", "ai"],
    ]);
    expect(got[1]).toMatchObject({ action: 5, clear: true, tags: ["fight", "boss"], stamp: "s1" });
  });
});

describe("how a shot is taken", () => {
  const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(path.join(scratch, "quality-"));
  /** 3 s of a busy test picture, 25 a second, through `vf` (the same crop for every take, so they differ only by it) */
  const take = async (name: string, vf: string) => {
    const file = path.join(dir, `${name}.mp4`);
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=704x396:r=25:d=3", "-vf", vf, "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", file]);
    const read = await readPicture(file, 25);
    return qualityOf(read, 0, read.step.length);
  };
  const still = "crop=640:360:32:18";

  it("names a blurry, a dark and a shaky take, and a good one not, scored below it", async () => {
    const good = await take("good", still);
    const blurry = await take("blurry", `${still},gblur=sigma=4`);
    const dark = await take("dark", `${still},lutyuv=y=val*0.25`);
    const shaky = await take("shaky", "crop=640:360:32+28*sin(2*PI*t*4.3):18+16*sin(2*PI*t*6.1+1)");
    expect(good.flaws).toBeUndefined();
    expect(blurry.flaws).toEqual(["blurry"]);
    expect(dark.flaws).toContain("too dark");
    expect(shaky.flaws).toEqual(["shaky"]);
    for (const bad of [blurry, dark, shaky]) expect(bad.quality!).toBeLessThan(good.quality!);
  }, 60_000);

  it("reads a move of the whole picture to a tenth of a pixel, and a frame without detail as unknown", () => {
    const W = 160;
    const H = 90;
    const pic = (dx: number) => Float32Array.from({ length: W * H }, (_, i) => 128 + 50 * Math.sin(((i % W) + dx) / 5) + 50 * Math.cos(Math.floor(i / W) / 7));
    const [x, y] = shiftOf(pic(0), pic(-2.5), W, H);
    expect(x * W).toBeCloseTo(2.5, 0);
    expect(Math.abs(y * H)).toBeLessThan(0.2);
    expect(blurOf(new Uint8Array(W * H).fill(90), W, H)).toBe(-1);
  });

  it("is kept with the stretch, also under the person's own line", () => {
    const db = new DatabaseSync(path.join(dir, "l.db"));
    db.exec("PRAGMA foreign_keys = OFF");
    for (const m of MIGRATIONS) db.exec(m);
    storeStretches(db, "v1", [
      { a: 0, b: 4, motion: 0.2, quality: 0.3, flaws: ["blurry"] },
      { a: 4, b: 8, motion: 0.5 },
    ]);
    expect(setUserLine(db, "v1", 0, "the jump")).toBe(true);
    expect(stretchesOf(db, "v1").map((x) => [x.text, x.quality, x.flaws])).toEqual([
      ["the jump", 0.3, ["blurry"]],
      ["", null, []],
    ]);
  });
});
