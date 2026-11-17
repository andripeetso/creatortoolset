import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-pictures-"));
process.env.DATA_DIR = dir;
delete process.env.APP_SECRET;

// the model stands in as a picture's mean colour, and a search's colour word as that colour: no download in tests
const mean = (p: Uint8Array) => {
  const s = [0, 0, 0];
  for (let i = 0; i < p.length; i++) s[i % 3]! += p[i]!;
  const n = Math.hypot(...s) || 1;
  return Float32Array.from(s.map((x) => x / n));
};
const WORDS: Record<string, number[]> = { red: [1, 0, 0], blue: [0, 0, 1], green: [0, 1, 0] };
vi.mock("../lib/device-picture", async (real) => ({
  ...(await real<typeof import("../lib/device-picture")>()),
  picturesHere: () => true,
  pictureModelKept: () => true,
  pictureTextKept: () => true,
  pictureText: () => "ready",
  embedPictures: async (pics: Uint8Array[]) => pics.map(mean),
  embedPictureQuery: async (texts: string[]) => texts.map((t) => Float32Array.from(WORDS[t.toLowerCase()] ?? [0, 0, 0])),
  readsAsEnglish: async (t: string) => t in WORDS,
}));
// the person's own AI, as a stand-in: it writes a search in English ("sinine" is Estonian for blue)
const ai = vi.hoisted(() => ({ asked: [] as string[], answer: async (q: string): Promise<string> => ({ sinine: "Blue." })[q] ?? "nothing" }));
vi.mock("../ai-complete", async (real) => ({
  ...(await real<typeof import("../ai-complete")>()),
  aiFor: () => ({ only: ["claude"] }),
  completeWithFallback: async (_s: string, q: string, _c: unknown, parse: (t: string) => unknown) => (ai.asked.push(q), parse(await ai.answer(q))),
}));

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { blobs, libraryDb } = await import("./db");
const { relatedApp } = await import("./related");
const { SHEET_FORMAT } = await import("./shots");
const { storeStretches } = await import("./stretches");
const { alikeHits, catchUpPictures, jpegSize, pictureHits, picturesOf } = await import("./pictures");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A JPEG ffmpeg draws from `source` (a lavfi graph). */
function jpeg(name: string, source: string): string {
  const f = path.join(dir, `${name}.jpg`);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", source, "-frames:v", "1", f]);
  return f;
}

async function clip(id: string, colour?: string) {
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'local', 1)").run(id, `Tiny Acrobatics ${id}`, `v-${id}`);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, ?, 'ready', 'local', 1)").run(`v-${id}`, id, `k/${id}`, `sha-${id}`);
  if (!colour) return;
  const key = `libraries/lib_a/v/v-${id}/thumb.jpg`;
  await blobs.put(key, jpeg(id, `color=c=${colour}:s=480x270`));
  d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', ?, 1)").run(`v-${id}`, key);
}

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "local", role: "admin" } as never);
  return next();
});
app.route("/api/library", relatedApp);

beforeAll(async () => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'local', 'A', 'local', 0)").run();
  await clip("red", "red");
  await clip("orange", "orange");
  await clip("blue", "blue");
  // a long take the look read: two stretches, its sheet's tile 0 red and tile 1 blue (look.ts stretchSheet's layout)
  await clip("long");
  storeStretches(libraryDb(), "v-long", [
    { a: 0, b: 5, motion: 0.1 },
    { a: 5, b: 10, motion: 0.2 },
  ]);
  const sheet = jpeg("sheet", "color=c=white:s=1584x152,drawbox=x=268:y=4:w=256:h=144:color=red:t=fill,drawbox=x=1060:y=4:w=256:h=144:color=blue:t=fill");
  const json = path.join(dir, "sheets.json");
  writeFileSync(json, JSON.stringify({ format: SHEET_FORMAT, sheets: [{ segs: [0, 1], jpeg: readFileSync(sheet).toString("base64") }] }));
  await blobs.put("libraries/lib_a/v/v-long/looksheets.json", json);
  libraryDb().prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('v-long', 'looksheets', 'libraries/lib_a/v/v-long/looksheets.json', 1)").run();
  expect(await catchUpPictures()).toBe(4);
});

const said = (hits: { asset: { id: string }; seconds?: number }[]) => hits.map((h) => (h.seconds === undefined ? h.asset.id : `${h.asset.id}@${h.seconds}`));

describe("search by picture", () => {
  it("reads a JPEG's size and squeezes its parts to the model's square", async () => {
    const f = readFileSync(jpeg("size", "color=c=green:s=320x200"));
    expect(jpegSize(f)).toEqual({ w: 320, h: 200 });
    const [whole, half] = await picturesOf(f, ["null", "crop=160:200:0:0"]);
    expect(whole!.length).toBe(224 * 224 * 3);
    expect(Array.from(mean(half!)).map((x) => Math.round(x * 10))).toEqual([0, 10, 0]);
  });

  it("gives each card picture a vector and each of the look's stretches one from the middle of its tile, once", async () => {
    const rows = libraryDb().prepare("SELECT version_id || ':' || seg AS k FROM pictures WHERE length(vec) > 0 ORDER BY k").all() as { k: string }[];
    expect(rows.map((r) => r.k)).toEqual(["v-blue:-1", "v-long:0", "v-long:1", "v-orange:-1", "v-red:-1"]);
    expect(await catchUpPictures()).toBe(0);
  });

  it("a typed search finds the pictures that match, a shot at its start, nothing under the floor", async () => {
    // the card and the tile of the same colour score alike (JPEG noise orders them): compared as a set
    const red = said((await pictureHits("lib_a", "red", "local")).hits!);
    expect([...red.slice(0, 2)].sort()).toEqual(["long@0", "red"]);
    expect(red.slice(2)).toEqual(["orange"]);
    expect(said((await pictureHits("lib_a", "blue", "local")).hits!).sort()).toEqual(["blue", "long@5"]);
    // orange is part green; the red and blue pictures score 0, under the floor
    expect(said((await pictureHits("lib_a", "green", "local")).hits!)).toEqual(["orange"]);
  });

  it("a search not in English matches pictures by its English line from the person's own AI, once; an English one asks nothing", async () => {
    ai.asked.length = 0;
    await pictureHits("lib_a", "red", "local");
    expect(ai.asked).toEqual([]);
    // the line is being written: no pictures yet, and the page asks again
    expect(await pictureHits("lib_a", "sinine", "local")).toEqual({ hits: null, pending: true });
    await new Promise((r) => setTimeout(r, 900));
    expect(said((await pictureHits("lib_a", "sinine", "local")).hits!).sort()).toEqual(["blue", "long@5"]);
    await pictureHits("lib_a", "sinine", "local");
    expect(ai.asked).toEqual(["sinine"]);
  });

  it("with no answer from the AI (a limit, a provider down) the search goes without pictures and doesn't ask again at once", async () => {
    ai.answer = async () => {
      throw new Error("limit is reached");
    };
    expect((await pictureHits("lib_a", "punane", "local")).pending).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(await pictureHits("lib_a", "punane", "local")).toEqual({ hits: null });
  });

  it("More like this: from the clip, or from its shot at a second; switched off, nothing", async () => {
    expect(said(alikeHits("lib_a", "v-red")).slice(0, 2)).toEqual(["long@0", "orange"]);
    expect(said(alikeHits("lib_a", "v-long", 6))[0]).toBe("blue");
    const r = await app.request("/api/library/lib_a/assets/long/alike?at=6");
    expect(said(((await r.json()) as { hits: { asset: { id: string }; seconds?: number }[] }).hits)[0]).toBe("blue");
    libraryDb().prepare(`UPDATE libraries SET settings = '{"pictures":false}' WHERE id = 'lib_a'`).run();
    try {
      expect(alikeHits("lib_a", "v-red")).toEqual([]);
      expect((await pictureHits("lib_a", "red", "local")).hits).toBeNull();
    } finally {
      libraryDb().prepare("UPDATE libraries SET settings = '{}' WHERE id = 'lib_a'").run();
    }
  });

  it("stretches found again drop their shots' vectors, so the next catch-up makes them from the new sheets", async () => {
    storeStretches(libraryDb(), "v-long", [{ a: 0, b: 10, motion: 0.1 }]);
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM pictures WHERE version_id = 'v-long'").get()).toEqual({ n: 0 });
  });
});
