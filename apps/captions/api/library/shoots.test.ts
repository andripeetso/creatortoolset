import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

// Smart folders by shoot (shoots.ts, MEDIA LIBRARY CEO 11-19): a vlog's clips go into the folder of the day and place
// they were filmed, never a topic folder; topics stay tags; a camera photo is footage, only a graphic goes to Graphics;
// the folders the AI named by topic before are filed again once.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-shoots-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "scratch");
delete process.env.APP_SECRET;
const { blobs, libraryDb } = await import("./db");
const { enqueueJob } = await import("./jobs");
const { organizeOnProbe, refileShoots } = await import("./organize");
const { dayLabel, nameShoot, SHOOT_GAP_MS } = await import("./shoots");
const { indexOnMac } = await import("./on-mac");
const { tick } = await import("./worker");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const YEAR = new Date().getFullYear();
/** 12 Nov this year, 08:00 in Costa Rica (UTC-6) */
const DAY1 = Date.UTC(YEAR, 10, 12, 14, 0);
const MIN = 60_000;

const lib = (id: string) =>
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at, settings) VALUES (?, 'local', ?, 'local', 0, ?)")
    .run(id, id, JSON.stringify({ organize: "ai" }));

/** A ready clip with this probe, an AI tag, and no file (filing reads only the database). */
function clip(library: string, id: string, probe: Record<string, unknown>, tag?: string, kind = "video") {
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'local', ?)").run(id, library, kind, id, `v-${id}`, Date.now());
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'local', 1)").run(
    `v-${id}`,
    id,
    `libraries/${library}/v/v-${id}/source`,
    `sha-${id}`,
    JSON.stringify(probe),
  );
  if (tag) d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(id, tag);
  return `v-${id}`;
}

const foldersOf = (library: string) =>
  (libraryDb().prepare("SELECT name FROM collections WHERE library_id = ? ORDER BY name").all(library) as { name: string }[]).map((r) => r.name);
const inFolder = (asset: string) =>
  (libraryDb().prepare("SELECT c.name FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE i.asset_id = ? ORDER BY c.name").all(asset) as { name: string }[]).map((r) => r.name);
const count = (library: string, name: string) =>
  (
    libraryDb().prepare("SELECT COUNT(*) AS n FROM collection_items i JOIN collections c ON c.id = i.collection_id WHERE c.library_id = ? AND c.name = ?").get(library, name) as {
      n: number;
    }
  ).n;

/** A JPEG as a pair of Meta glasses writes it: EXIF make and model, when (with its offset) and where (Nosara, Costa Rica). */
function glassesPhoto(file: string, taken: string) {
  execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=green:s=64x48", "-frames:v", "1", file]);
  const t = Buffer.alloc(256);
  t.write("MM\0*", 0, "latin1");
  t.writeUInt32BE(8, 4);
  const entry = (o: number, tag: number, type: number, n: number, value: number) => {
    t.writeUInt16BE(tag, o);
    t.writeUInt16BE(type, o + 2);
    t.writeUInt32BE(n, o + 4);
    t.writeUInt32BE(value, o + 8);
  };
  t.writeUInt16BE(4, 8); // IFD0: make, model, the Exif IFD, the GPS IFD
  entry(10, 0x010f, 2, 5, 146);
  entry(22, 0x0110, 2, 27, 151);
  entry(34, 0x8769, 4, 1, 62);
  entry(46, 0x8825, 4, 1, 92);
  t.writeUInt16BE(2, 62); // Exif IFD: DateTimeOriginal, OffsetTimeOriginal
  entry(64, 0x9003, 2, 20, 178);
  entry(76, 0x9011, 2, 7, 198);
  t.writeUInt16BE(4, 92); // GPS IFD
  entry(94, 1, 2, 2, 0x4e000000); // "N"
  entry(106, 2, 5, 3, 208);
  entry(118, 3, 2, 2, 0x57000000); // "W"
  entry(130, 4, 5, 3, 232);
  t.write("Meta\0", 146, "latin1");
  t.write("Ray-Ban Meta Smart Glasses\0", 151, "latin1");
  t.write(`${taken}\0`, 178, "latin1");
  t.write("-06:00\0", 198, "latin1");
  [9, 1, 58, 1, 48, 1, 85, 1, 39, 1, 0, 1].forEach((n, i) => t.writeUInt32BE(n, 208 + i * 4));
  const len = 2 + 6 + t.length;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), Buffer.from("Exif\0\0", "latin1"), t]);
  const jpg = readFileSync(file);
  writeFileSync(file, Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));
}

/** An asset whose file is `file`, probed by the worker as an upload is. */
async function probed(library: string, id: string, kind: string, file: string) {
  const d = libraryDb();
  const v = `v-${id}`;
  const key = `libraries/${library}/v/${v}/source`;
  const copy = path.join(dir, `copy-${id}`);
  copyFileSync(file, copy);
  await blobs.put(key, copy);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'local', ?)").run(id, library, kind, id, v, Date.now());
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'processing', 'local', 1)").run(v, id, key, `sha-${id}`);
  enqueueJob(d, library, v, "probe", "local");
  const state = () => (d.prepare("SELECT state FROM jobs WHERE version_id = ? AND kind = 'probe'").get(v) as { state: string } | undefined)?.state;
  for (let turns = 0; state() === "queued"; turns++) {
    if (turns > 5000) throw new Error(`probe of ${id} still queued`);
    await tick();
    await new Promise((r) => setImmediate(r));
  }
  return v;
}

beforeAll(() => {
  for (const id of ["lib_one", "lib_two", "lib_pics", "lib_own", "lib_old", "lib_mac"]) lib(id);
});

describe("Smart folders by shoot", () => {
  it("30 car and 30 kitchen clips of one day and place: one shoot folder, the topics stay tags", () => {
    const d = libraryDb();
    for (let i = 0; i < 30; i++) organizeOnProbe(d, clip("lib_one", `car${i}`, { duration: 9, capturedAt: DAY1 + i * 4 * MIN, tz: -360, country: "CR" }, "driving pov"), null);
    for (let i = 0; i < 30; i++) organizeOnProbe(d, clip("lib_one", `kit${i}`, { duration: 9, capturedAt: DAY1 + 3 * 3600_000 + i * 4 * MIN, tz: -360, country: "CR" }, "kitchen"), null);
    expect(foldersOf("lib_one")).toEqual(["12 Nov · Costa Rica"]);
    expect(count("lib_one", "12 Nov · Costa Rica")).toBe(60);
    expect(d.prepare("SELECT COUNT(*) AS n FROM asset_tags WHERE asset_id LIKE 'car%' AND tag = 'driving pov'").get()).toEqual({ n: 30 });

    // the AI reads the town off one clip: the shoot takes it; a later, different read changes nothing
    nameShoot(d, "v-kit3", "Nosara");
    nameShoot(d, "v-car1", "Playa Guiones");
    nameShoot(d, "v-car2", "kitchen"); // not a name
    expect(foldersOf("lib_one")).toEqual(["12 Nov · Nosara"]);
  });

  it("two days are two shoots; a clip with no location joins the shoot of its time, a clip in another country does not", () => {
    const d = libraryDb();
    organizeOnProbe(d, clip("lib_two", "d1", { capturedAt: DAY1, tz: -360, country: "CR" }), null);
    organizeOnProbe(d, clip("lib_two", "d2", { capturedAt: DAY1 + 24 * 3600_000, tz: -360, country: "CR" }), null);
    organizeOnProbe(d, clip("lib_two", "d2-gopro", { capturedAt: DAY1 + 25 * 3600_000 }), null); // a camera with no GPS
    organizeOnProbe(d, clip("lib_two", "d2-pa", { capturedAt: DAY1 + 26 * 3600_000, tz: -300, country: "PA" }), null); // flew to Panama
    expect(foldersOf("lib_two")).toEqual(["12 Nov · Costa Rica", "13 Nov · Costa Rica", "13 Nov · Panama"]);
    expect(inFolder("d2-gopro")).toEqual(["13 Nov · Costa Rica"]);
    // the same day after a long gap is another shoot, with a name of its own
    organizeOnProbe(d, clip("lib_two", "d1-late", { capturedAt: DAY1 + SHOOT_GAP_MS + 1, tz: -360, country: "CR" }), null);
    expect(inFolder("d1-late")).toEqual(["12 Nov · Costa Rica 2"]);
    // a camera's unset clock (1970) is no date: the clip is filed by when it was added
    organizeOnProbe(d, clip("lib_two", "unset-clock", { capturedAt: 1000 }), null);
    expect(inFolder("unset-clock")).toEqual([dayLabel(Date.now())]);
    // the day is the one where it was filmed: 20:00 in Costa Rica is the next day in UTC
    expect(dayLabel(Date.UTC(YEAR, 10, 13, 2, 0), -360)).toBe("12 Nov");
    expect(dayLabel(Date.UTC(YEAR - 1, 10, 13, 2, 0), -360)).toBe(`12 Nov ${YEAR - 1}`);
  });

  it("a transparent PNG goes to Graphics; a Meta glasses JPEG with its EXIF goes into its shoot", async () => {
    const png = path.join(dir, "logo.png");
    execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black@0.0:s=64x48,format=rgba", "-frames:v", "1", png]);
    const jpg = path.join(dir, "glasses.jpg");
    glassesPhoto(jpg, `${YEAR}:11:12 09:30:00`);
    const shot = path.join(dir, "screen.png");
    execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=64x48", "-frames:v", "1", shot]);
    await probed("lib_pics", "logo", "image", png);
    const v = await probed("lib_pics", "glasses", "image", jpg);
    await probed("lib_pics", "screen", "image", shot); // no camera in its EXIF: a screenshot or an export
    const p = JSON.parse((libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?").get(v) as { probe: string }).probe);
    expect(p).toMatchObject({ camera: true, country: "CR", tz: -360, capturedAt: Date.UTC(YEAR, 10, 12, 15, 30) });
    expect(JSON.stringify(p)).not.toMatch(/9\.98|85\.6/); // never the coordinates
    expect(inFolder("logo")).toEqual(["Graphics"]);
    expect(inFolder("screen")).toEqual(["Graphics"]);
    expect(inFolder("glasses")).toEqual(["12 Nov · Costa Rica"]);
  });

  it("a person's folders, and a shoot they renamed, are left as they are", async () => {
    const d = libraryDb();
    const picks = "col_mypicks000000";
    d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES (?, 'lib_own', NULL, 'My picks', 'manual', 1, 'local')").run(picks);
    const v = clip("lib_own", "picked", { capturedAt: DAY1, country: "CR" });
    d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES (?, 'picked', 1, 'local')").run(picks);
    organizeOnProbe(d, v, null);
    expect(inFolder("picked")).toEqual(["My picks"]);

    organizeOnProbe(d, clip("lib_own", "a", { capturedAt: DAY1, tz: -360, country: "CR" }), null);
    d.prepare("UPDATE collections SET name = 'Beach day' WHERE library_id = 'lib_own' AND shoot IS NOT NULL").run();
    nameShoot(d, "v-a", "Nosara");
    organizeOnProbe(d, clip("lib_own", "b", { capturedAt: DAY1 + 10 * MIN, tz: -360, country: "CR" }), null);
    expect(foldersOf("lib_own")).toEqual(["Beach day", "My picks"]);
    expect(inFolder("b")).toEqual(["Beach day"]);
    expect(await refileShoots(d, "lib_own")).toBe(0);
    expect(foldersOf("lib_own")).toEqual(["Beach day", "My picks"]);
    expect(inFolder("picked")).toEqual(["My picks"]);
  });

  it("the folders the AI named by topic are filed again by shoot, once; a person's folders and graphics stay", async () => {
    const d = libraryDb();
    const folder = (id: string, name: string, rule: string | null) =>
      d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, rule, created_at, created_by) VALUES (?, 'lib_old', NULL, ?, 'manual', ?, 1, 'local')").run(id, name, rule);
    const put = (f: string, a: string, byAi = 0) => d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by, by_ai) VALUES (?, ?, 1, 'local', ?)").run(f, a, byAi);
    folder("col_driving", "Driving", "Driving"); // the AI's: a rule of its own name
    folder("col_mine", "Cars I like", "Cars with open roofs"); // the person's own rule folder
    folder("col_graphics", "Graphics", null);
    for (let i = 0; i < 4; i++) {
      clip("lib_old", `drv${i}`, { capturedAt: DAY1 + i * 3600_000 * (i < 2 ? 1 : 24), country: "CR" }, "driving");
      put("col_driving", `drv${i}`, i ? 1 : 0);
    }
    put("col_mine", "drv3", 1);
    clip("lib_old", "old-photo", { capturedAt: DAY1, country: "CR", camera: true, pixFmt: "yuvj420p" }, undefined, "image");
    clip("lib_old", "old-logo", { camera: false, pixFmt: "rgba" }, undefined, "image");
    put("col_graphics", "old-photo");
    put("col_graphics", "old-logo");
    // a glasses photo uploaded before 11-19: its probe never read its camera; the refile reads its EXIF once
    const jpg = path.join(dir, "old-glasses.jpg");
    glassesPhoto(jpg, `${YEAR}:11:12 09:30:00`);
    await blobs.put("libraries/lib_old/v/v-old-glasses/source", jpg);
    clip("lib_old", "old-glasses", { duration: 0, pixFmt: "yuvj420p" }, undefined, "image");
    put("col_graphics", "old-glasses");

    expect(await refileShoots(d, "lib_old")).toBe(5);
    expect(inFolder("old-glasses")).toEqual(["12 Nov · Costa Rica"]);
    const after = { folders: foldersOf("lib_old"), drv0: inFolder("drv0"), drv2: inFolder("drv2"), drv3: inFolder("drv3"), photo: inFolder("old-photo"), logo: inFolder("old-logo") };
    expect(after).toEqual({
      folders: ["12 Nov · Costa Rica", "14 Nov · Costa Rica", "Cars I like", "Graphics"],
      drv0: ["12 Nov · Costa Rica"],
      drv2: ["14 Nov · Costa Rica"],
      drv3: ["Cars I like"], // in the person's folder: filed, so not moved into a shoot
      photo: ["12 Nov · Costa Rica"],
      logo: ["Graphics"],
    });
    // once: a second run files nothing and changes nothing
    expect(await refileShoots(d, "lib_old")).toBe(0);
    expect({ folders: foldersOf("lib_old"), drv0: inFolder("drv0"), drv2: inFolder("drv2"), drv3: inFolder("drv3"), photo: inFolder("old-photo"), logo: inFolder("old-logo") }).toEqual(after);
  });

  it("a file indexed on a Mac is filed by the date and place the Mac read; an older Mac's JPEG is footage, its PNG a graphic", async () => {
    const at = { quick: "a".repeat(64), frames: [] };
    const r = await indexOnMac("lib_mac", "local", { ...at, name: "IMG_6249.MOV", path: "/Volumes/Nowhere/IMG_6249.MOV", size: 10, capturedAt: DAY1, tz: -360, location: "+09.9800-085.6500/" });
    const pic = await indexOnMac("lib_mac", "local", { ...at, quick: "b".repeat(64), name: "IMG_0001.JPG", path: "/Volumes/Nowhere/IMG_0001.JPG", size: 11 });
    const png = await indexOnMac("lib_mac", "local", { ...at, quick: "c".repeat(64), name: "Logo.png", path: "/Volumes/Nowhere/Logo.png", size: 12 });
    const id = (x: Awaited<typeof r>) => ("assetId" in x ? x.assetId : "");
    expect(inFolder(id(r))).toEqual(["12 Nov · Costa Rica"]);
    expect(inFolder(id(png))).toEqual(["Graphics"]);
    expect(inFolder(id(pic))).toHaveLength(1);
    expect(inFolder(id(pic))[0]).not.toBe("Graphics");
  });
});
