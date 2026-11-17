import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type PicturePackage } from "../../contracts/work";

/**
 * Search by picture on a server that makes no picture vectors (a hosted one): the uploader's computers make them on the
 * work road, each clip only once its account may read it, and send only the vectors.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-pictures-"));
// the worker's data folder is the Mac app's <relay>/work: the sheets that Mac keeps are in <relay>/looks
const dir = path.join(root, "work");
mkdirSync(dir);
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "work-pictures-test-secret";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

// the model stands in as a picture's mean colour, a search's colour word as that colour (3 numbers, not PICTURE_DIM)
const mean = (p: Uint8Array) => {
  const s = [0, 0, 0];
  for (let i = 0; i < p.length; i++) s[i % 3]! += p[i]!;
  const n = Math.hypot(...s) || 1;
  return Float32Array.from(s.map((x) => x / n));
};
const WORDS: Record<string, number[]> = { red: [1, 0, 0], blue: [0, 0, 1] };
const model = vi.hoisted(() => ({ withText: [] as boolean[] }));
vi.mock("../lib/device-picture", async (real) => ({
  ...(await real<typeof import("../lib/device-picture")>()),
  picturesHere: () => false,
  PICTURE_DIM: 3,
  pictureText: () => "ready",
  embedPictures: async (pics: Uint8Array[], withText = true) => (model.withText.push(withText), pics.map(mean)),
  embedPictureQuery: async (texts: string[]) => texts.map((t) => Float32Array.from(WORDS[t] ?? [0, 0, 0])),
  readsAsEnglish: async (t: string) => t in WORDS,
}));

const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { createUser } = await import("../users");
const app = (await import("../boot")).default;
const { pairDevice } = await import("../lib/devices");
const { blobs, libraryDb } = await import("../library/db");
const { LIBRARY_SOURCE, registerLibrarySlot } = await import("../library/sources");
const { SHEET_FORMAT } = await import("../library/shots");
const { storeStretches } = await import("../library/stretches");
const { pictureHits } = await import("../library/pictures");
const { CLAIM_POLL } = await import("./routes");
const { workWaits } = await import("./place");
const { runPictureJob } = await import("./library");
const { deviceOf } = await import("../lib/devices");
CLAIM_POLL.holdMs = 0;

afterAll(() => rmSync(root, { recursive: true, force: true }));

// a library policy (the studio has its own), switched by the test
let refused = false;
registerLibrarySlot("test-gate", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: () => !refused }] });

const db = () => libraryDb();
const pc = pairDevice("tiny", "Tiny Mac");
const call = (p: string, init: RequestInit = {}, token: string | null = pc.token) =>
  app.request(`/api/devices/relay/work/${p}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(init.headers as Record<string, string>) },
  });
const claim = async (pictures = true) =>
  ((await (await call("claim", { method: "POST", body: JSON.stringify({ v: WORK_V, steps: [], library: true, ...(pictures ? { pictures: true } : {}) }) })).json()) as { pics?: PicturePackage }).pics;
const o = { server: "http://server.test", token: pc.token, beatMs: 50, fetch: (u: string, i?: RequestInit) => Promise.resolve(app.request(u, i)) };
const vectors = () => (db().prepare("SELECT version_id || ':' || seg AS k FROM pictures WHERE length(vec) > 0 ORDER BY k").all() as { k: string }[]).map((r) => r.k);

function jpeg(name: string, source: string): Buffer {
  const f = path.join(root, `${name}.jpg`);
  execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", source, "-frames:v", "1", f]);
  return readFileSync(f);
}
// a sheet of two stretches, tile 0 red and tile 1 blue (look.ts stretchSheet's layout)
const SHEET = "color=c=white:s=1584x152,drawbox=x=268:y=4:w=256:h=144:color=red:t=fill,drawbox=x=1060:y=4:w=256:h=144:color=blue:t=fill";

async function clip(id: string, o: { colour?: string; mac?: boolean } = {}) {
  db().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_t', 'video', ?, ?, 'tiny', 1)").run(id, `Tiny Acrobatics ${id}`, `v-${id}`);
  db()
    .prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, mac_path, mac_device, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, 1, ?, 'ready', 'tiny', 1)")
    .run(`v-${id}`, id, o.mac ? `mac:${id}` : `k/${id}`, o.mac ? `/Movies/${id}.mov` : null, o.mac ? pc.device.id : null, `sha-${id}`);
  if (!o.colour) return;
  const key = `libraries/lib_t/v/v-${id}/thumb.jpg`;
  const f = path.join(root, `${id}-thumb.jpg`);
  writeFileSync(f, jpeg(id, `color=c=${o.colour}:s=480x270`));
  await blobs.put(key, f);
  db().prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', ?, 1)").run(`v-${id}`, key);
}

beforeAll(async () => {
  createUser("tiny", "password1");
  db().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_t', 'tiny', 'Tiny Acrobatics', 'local', '{}', 0)").run();
  await clip("red", { colour: "red" });
});

describe("picture vectors made on the person's own computers", () => {
  it("answers no call without the computer's token", async () => {
    expect((await call("claim", { method: "POST", body: JSON.stringify({ v: WORK_V, steps: [], pictures: true }) }, null)).status).toBe(401);
    for (const [p, method] of [["pictures/1/input", "GET"], ["pictures/1/done", "POST"], ["pictures/1/beat", "POST"], ["pictures/1/fail", "POST"]] as const)
      expect((await call(p, { method, ...(method === "POST" ? { body: "{}" } : {}) }, "ctd_nope")).status).toBe(401);
  });

  it("hands nothing to a computer that doesn't run the picture model", async () => {
    expect(await claim(false)).toBeUndefined();
  });

  it("a claim its account's library policy refuses hands nothing, and the clip isn't asked about again at once", async () => {
    refused = true;
    try {
      expect(await claim()).toBeUndefined();
    } finally {
      refused = false;
    }
    expect(await claim()).toBeUndefined();
  });

  it("makes the card picture's vector on the computer and sends only the vector; search then finds it", async () => {
    await clip("blue", { colour: "blue" });
    const blobsBefore = db().prepare("SELECT COUNT(*) AS n FROM derivatives").get();
    expect(await workWaits(deviceOf(pc.device.id)!)).toBe(true);
    const p = (await claim())!;
    expect(p).toMatchObject({ versionId: "v-blue", card: true, sheets: null });
    expect(await runPictureJob(p, o)).toBe("done");
    expect(vectors()).toEqual(["v-blue:-1"]);
    expect(model.withText).toEqual([false]); // the computer fetches no text side
    expect(db().prepare("SELECT COUNT(*) AS n FROM derivatives").get()).toEqual(blobsBefore);
    expect((await pictureHits("lib_t", "blue", "tiny")).hits!.map((h) => h.asset.id)).toEqual(["blue"]);
    expect(await claim()).toBeUndefined();
  });

  it("a hold whose policy refuses after the claim gets no pictures", async () => {
    await clip("red2", { colour: "red" });
    const p = (await claim())!;
    refused = true;
    try {
      expect((await call(`pictures/${p.id}/input`)).status).toBe(404);
    } finally {
      refused = false;
    }
    expect((await (await call(`pictures/${p.id}/done`, { method: "POST", body: JSON.stringify({ v: WORK_V, rows: [] }) })).json())).toEqual({ ok: false });
  });

  it("a file kept on a Mac: that Mac reads the sheets it keeps once the look is done; sheets of other stretches are not read", async () => {
    await clip("long", { mac: true });
    storeStretches(db(), "v-long", [
      { a: 0, b: 5, motion: 0.1 },
      { a: 5, b: 10, motion: 0.2 },
    ]);
    expect(await claim()).toBeUndefined(); // its look isn't done
    db().prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_t', 'v-long', 'look', 'done', 'tiny')").run();
    const looks = path.join(root, "looks");
    mkdirSync(looks, { recursive: true });
    const keep = (stretches: number[][]) =>
      writeFileSync(path.join(looks, "v-long.json"), JSON.stringify({ format: SHEET_FORMAT, stretches, sheets: [{ segs: [0, 1], jpeg: jpeg("sheet", SHEET).toString("base64"), ph: ["", ""] }] }));
    keep([[0, 4], [4, 10]]);
    let p = (await claim())!;
    expect(p).toMatchObject({ versionId: "v-long", card: false, sheets: "here", stretches: [[0, 5], [5, 10]] });
    expect(await runPictureJob(p, o)).toBe("done");
    // looked at, nothing read: an empty row, until the look reads the picture again
    expect(vectors().filter((k) => k.startsWith("v-long"))).toEqual([]);
    storeStretches(db(), "v-long", [
      { a: 0, b: 5, motion: 0.1 },
      { a: 5, b: 10, motion: 0.2 },
    ]);
    keep([[0, 5], [5, 10]]);
    p = (await claim())!;
    expect(await runPictureJob(p, o)).toBe("done");
    expect(vectors().filter((k) => k.startsWith("v-long"))).toEqual(["v-long:0", "v-long:1"]);
    // the red cards were refused above: only the shot
    expect((await pictureHits("lib_t", "red", "tiny")).hits!.map((h) => `${h.asset.id}@${h.seconds}`)).toEqual(["long@0"]);
  });

  it("a file kept on another Mac is not handed to this one", async () => {
    await clip("other", { colour: "red" });
    db().prepare("UPDATE asset_versions SET source_key = 'mac:other', mac_device = 'dev_elsewhere' WHERE id = 'v-other'").run();
    expect((await claim())?.versionId).not.toBe("v-other");
  });
});
