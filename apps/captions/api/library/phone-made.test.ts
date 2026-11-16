import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// An upload from the phone with what it made of the video itself (derived.ts Made, the iPhone's PhoneMade.swift): the
// card picture, the quick fingerprint and, to a library that keeps only proxies, a 720p copy with the original's probe.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-phone-made-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";

vi.mock("./media/probe", async (real) => ({
  ...(await real<typeof import("./media/probe")>()),
  probe: () => Promise.resolve({ duration: 5, width: 1280, height: 720, fps: 30, rotation: 0, format: "mp4", vcodec: "h264", pixFmt: "yuv420p", acodec: "aac" }),
}));

const { blobs, libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { tick } = await import("./worker");

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "owner-a", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const d = libraryDb();
for (const [id, upload] of [["lib_p", "proxies"], ["lib_all", "all"]] as const) {
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'owner-a', 'L', 'local', ?, 0)").run(
    id,
    JSON.stringify({ upload, proxy: false, describe: false, embed: false, look: false }),
  );
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const quick = (n: number) => n.toString(16).padStart(64, "0");
const PHONE_PROBE = {
  duration: 12.5,
  width: 3840,
  height: 2160,
  fps: 29.97,
  rotation: 90,
  format: "mov,mp4,m4a,3gp,3g2,mj2",
  vcodec: "hevc",
  pixFmt: "yuv420p10le",
  acodec: "aac",
  capturedAt: 1_763_000_000_000,
  location: "+59.4370+024.7536+012.3/",
};

const post = (url: string, json?: unknown) =>
  app.request(url, { method: "POST", ...(json ? { headers: { "content-type": "application/json" }, body: JSON.stringify(json) } : {}) });

/** start (with `extra`), the bytes, finish: the finish's answer, or the start's when it refused */
async function upload(lib: string, name: string, extra: Record<string, unknown>, bytes = `${lib} ${name}`) {
  const body = Buffer.from(bytes);
  const start = await post(`/api/library/${lib}/uploads`, { filename: name, size: body.length, ...extra });
  if (start.status !== 201) return { status: start.status, json: (await start.json()) as Record<string, string> };
  const { id } = (await start.json()) as { id: string };
  await app.request(`/api/library/uploads/${id}`, { method: "PATCH", headers: { "upload-offset": "0", "content-length": String(body.length) }, body });
  const fin = await post(`/api/library/uploads/${id}/finish`);
  return { status: fin.status, json: (await fin.json()) as Record<string, string>, id };
}

const jobs = (id: string) => (d.prepare("SELECT kind FROM jobs WHERE version_id = ? ORDER BY kind").all(id) as { kind: string }[]).map((j) => j.kind);
const derivative = (id: string, kind: string) =>
  d.prepare("SELECT storage_key, bytes FROM derivatives WHERE version_id = ? AND kind = ?").get(id, kind) as { storage_key: string; bytes: number } | undefined;
const version = (id: string) =>
  d.prepare("SELECT source_key, bytes, quick, probe FROM asset_versions WHERE id = ?").get(id) as { source_key: string; bytes: number; quick: string; probe: string | null };

describe("an upload with what the phone made", () => {
  it("files the card picture and the fingerprint; the server probes the original itself and never makes the picture", async () => {
    const r = await upload("lib_all", "Handstand.MOV", { quick: quick(1), thumb: JPEG.toString("base64") });
    const v = r.json.versionId;
    expect(r.status).toBe(200);
    expect(version(v).quick).toBe(quick(1));
    expect(derivative(v, "thumb")?.bytes).toBe(JPEG.length);
    expect(await blobs.stat(derivative(v, "thumb")!.storage_key)).not.toBeNull();
    expect(jobs(v)).toEqual(["probe"]);
    await tick(Date.now(), ["probe"]);
    expect(jobs(v)).toContain("wave");
    expect(jobs(v)).not.toContain("thumb");
    expect(d.prepare("SELECT made FROM uploads WHERE id = ?").get(r.id!)).toEqual({ made: null });
  });

  it("takes a 720p copy as the source and the proxy at once, with the original's probe, size and fingerprint", async () => {
    const r = await upload("lib_p", "Cartwheel.mp4", { quick: quick(2), thumb: JPEG.toString("base64"), proxy: { size: 900_000_000, probe: PHONE_PROBE } });
    const v = r.json.versionId;
    expect(r.status).toBe(200);
    const row = version(v);
    expect(row.bytes).toBe(900_000_000);
    expect(row.quick).toBe(quick(2));
    expect(derivative(v, "proxy")).toEqual({ storage_key: row.source_key, bytes: Buffer.byteLength("lib_p Cartwheel.mp4") });
    const { location, ...probe } = PHONE_PROBE;
    expect(location).toBeTruthy();
    expect(JSON.parse(row.probe!)).toEqual({ ...probe, country: "EE" }); // the country, never the coordinates
    // nothing probed or made again: no probe, no picture, no proxy; the rest from the copy
    const queued = jobs(v);
    expect(queued).not.toContain("probe");
    expect(queued).not.toContain("thumb");
    expect(queued).not.toContain("proxy");
    expect(queued).toContain("wave");
  });

  it("knows a copy of a clip the library has by the original's fingerprint and size", async () => {
    const first = await upload("lib_p", "Roll.mp4", { quick: quick(3), proxy: { size: 500_000_000, probe: PHONE_PROBE } }, "one encode");
    const again = await upload("lib_p", "Roll.mp4", { quick: quick(3), proxy: { size: 500_000_000, probe: PHONE_PROBE } }, "another encode");
    expect(again.json.duplicateOf).toBe(d.prepare("SELECT asset_id FROM asset_versions WHERE id = ?").get(first.json.versionId)!.asset_id);
  });

  it("refuses what is malformed, and an upload with none of it goes as before", async () => {
    expect((await upload("lib_p", "a.mp4", { quick: "nope" })).status).toBe(400);
    expect((await upload("lib_p", "a.mp4", { quick: quick(4), thumb: Buffer.from("not a jpeg").toString("base64") })).status).toBe(400);
    expect((await upload("lib_p", "a.mp4", { quick: quick(4), proxy: { size: 10, probe: { ...PHONE_PROBE, rotation: 45 } } })).status).toBe(400);
    expect((await upload("lib_p", "a.mp4", { quick: quick(4), proxy: { probe: PHONE_PROBE } })).status).toBe(400);
    const plain = await upload("lib_all", "Plain.mp4", {});
    expect(jobs(plain.json.versionId)).toEqual(["probe"]);
    expect(derivative(plain.json.versionId, "thumb")).toBeUndefined();
  });
});
