import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Many clips at once: the zip of their originals (what the caller may see, each named as it downloads alone), Redo on
// many, and the check before an upload whether the file is in the library already.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-bulk-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { bulkApp, uniqueName } = await import("./bulk");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", bulkApp);

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const call = (user: string, method: string, url: string, body?: unknown) =>
  Promise.resolve(
    app.request(url, {
      method,
      headers: { "x-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

/** a clip with its original on disk; `file: false` leaves the file out (a drive that is away) */
function seed(id: string, title: string, content: string, o: { kind?: string; file?: boolean } = {}) {
  const d = libraryDb();
  const v = `${id}-v1`;
  const key = `libraries/lib_z/v/${v}/source`;
  const bytes = Buffer.from(content);
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_z', ?, ?, ?, 'owner-z', 1000)").run(id, o.kind ?? "video", title, v);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, 'video/mp4', 'ready', 'owner-z', 1000)",
  ).run(v, id, key, bytes.length, sha(bytes));
  if (o.file === false) return;
  const at = path.join(dir, "library", "blobs", ...key.split("/"));
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, bytes);
}

beforeAll(() => {
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_z', 'owner-z', 'Z', 'local', '{\"upload\":\"all\"}', 0)").run();
  seed("c1", "Clip", "first clip bytes");
  seed("c2", "Clip", "second clip bytes");
  seed("hid", "Secret", "hidden clip bytes");
  seed("gone", "Away", "away clip bytes", { file: false });
  seed("memo", "Memo", "sound bytes", { kind: "audio" });
});

/** the names in a zip, from its local file headers (stored entries: the bytes follow each name as they are) */
function names(zip: Buffer): string[] {
  const out: string[] = [];
  for (let i = zip.indexOf("PK\x03\x04"); i >= 0; i = zip.indexOf("PK\x03\x04", i + 4)) {
    const n = zip.readUInt16LE(i + 26);
    out.push(zip.subarray(i + 30, i + 30 + n).toString());
  }
  return out;
}

describe("Download as one zip", () => {
  it("holds the originals the caller may see, two of one name both, and leaves out a refused clip and a gone file", async () => {
    registerLibrarySlot("test-bulk", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "hid" }] });
    try {
      const r = await call("owner-z", "GET", "/api/library/lib_z/zip?ids=c1,c2,hid,gone,nope");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/zip");
      const zip = Buffer.from(await r.arrayBuffer());
      expect(names(zip)).toEqual(["Clip.mp4", "Clip (2).mp4"]);
      expect(zip.includes("first clip bytes")).toBe(true);
      expect(zip.includes("second clip bytes")).toBe(true);
      expect(zip.includes("hidden clip bytes")).toBe(false);
    } finally {
      resetLibrarySlots();
    }
  });

  it("Run again skips a clip hidden while it waits on Folders left out (report.ts)", async () => {
    seed("lh2", "Waiting", "waiting clip bytes 2");
    libraryDb().prepare("UPDATE assets SET left_hidden_at = 1 WHERE id = 'lh2'").run();
    expect(await (await call("owner-z", "POST", "/api/library/lib_z/jobs", { kinds: ["transcribe"], assetIds: ["c1", "lh2"] })).json()).toEqual({ clips: 1 });
    libraryDb().prepare("DELETE FROM jobs WHERE version_id IN (SELECT id FROM asset_versions WHERE asset_id = 'lh2')").run();
    libraryDb().prepare("DELETE FROM asset_versions WHERE asset_id = 'lh2'").run();
    libraryDb().prepare("DELETE FROM assets WHERE id = 'lh2'").run();
  });

  it("leaves out a clip hidden while it waits on Folders left out (report.ts), as one in the trash", async () => {
    seed("lho", "Waiting", "waiting clip bytes");
    libraryDb().prepare("UPDATE assets SET left_hidden_at = 1 WHERE id = 'lho'").run();
    const zip = Buffer.from(await (await call("owner-z", "GET", "/api/library/lib_z/zip?ids=c1,lho")).arrayBuffer());
    expect(zip.includes("first clip bytes")).toBe(true);
    expect(zip.includes("waiting clip bytes")).toBe(false);
    libraryDb().prepare("DELETE FROM asset_versions WHERE asset_id = 'lho'").run();
    libraryDb().prepare("DELETE FROM assets WHERE id = 'lho'").run();
  });

  it("is 404 for another account, and when nothing asked for can be given", async () => {
    expect((await call("someone-else", "GET", "/api/library/lib_z/zip?ids=c1")).status).toBe(404);
    expect((await call("owner-z", "GET", "/api/library/lib_z/zip?ids=gone")).status).toBe(404);
  });

  it("names a third copy (3), whatever the case", () => {
    const taken = new Set<string>();
    expect(["a.MP4", "A.mp4", "a.mp4"].map((n) => uniqueName(n, taken))).toEqual(["a.MP4", "A (2).mp4", "a (3).mp4"]);
  });
});

describe("Redo on many clips", () => {
  const jobs = (kind: string) => (libraryDb().prepare("SELECT version_id FROM jobs WHERE kind = ? ORDER BY version_id").all(kind) as { version_id: string }[]).map((r) => r.version_id);

  it("counts first without queueing, then queues descriptions for videos only and transcripts for sound too", async () => {
    const counted = await (await call("owner-z", "POST", "/api/library/lib_z/jobs", { kinds: ["describe"], count: true })).json();
    expect(counted).toEqual({ clips: 4 });
    expect(jobs("describe")).toEqual([]);
    expect(await (await call("owner-z", "POST", "/api/library/lib_z/jobs", { kinds: ["describe"] })).json()).toEqual({ clips: 4 });
    expect(jobs("describe")).toEqual(["c1-v1", "c2-v1", "gone-v1", "hid-v1"]);
    expect(await (await call("owner-z", "POST", "/api/library/lib_z/jobs", { kinds: ["transcribe"], assetIds: ["memo", "c1"] })).json()).toEqual({ clips: 2 });
    expect(jobs("transcribe")).toEqual(["c1-v1", "memo-v1"]);
  });

  it("skips what a policy refuses, and asks for a kind it knows", async () => {
    registerLibrarySlot("test-bulk", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "hid" }] });
    try {
      expect(await (await call("owner-z", "POST", "/api/library/lib_z/jobs", { kinds: ["embed"], assetIds: ["hid", "c2"] })).json()).toEqual({ clips: 1 });
    } finally {
      resetLibrarySlots();
    }
    expect((await call("owner-z", "POST", "/api/library/lib_z/jobs", { kinds: ["proxy"] })).status).toBe(400);
    expect((await call("someone-else", "POST", "/api/library/lib_z/jobs", { kinds: ["describe"] })).status).toBe(404);
  });
});

describe("Already in the library, before an upload", () => {
  const check = (body: unknown, user = "owner-z") => call(user, "POST", "/api/library/lib_z/uploads/check", body);

  it("says by size whether to hash at all, then by the hash which clip it is", async () => {
    const first = Buffer.from("first clip bytes");
    expect(await (await check({ size: first.length })).json()).toEqual({ maybe: true });
    expect(await (await check({ size: 999_999 })).json()).toEqual({ maybe: false });
    expect(await (await check({ size: first.length, sha256: sha(first).toUpperCase() })).json()).toEqual({ duplicateOf: "c1" });
    expect(await (await check({ size: first.length, sha256: sha(Buffer.from("other")) })).json()).toEqual({});
  });

  it("does not count a clip in the trash, nor answer another account", async () => {
    const second = Buffer.from("second clip bytes");
    libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'c2'").run();
    expect(await (await check({ size: second.length, sha256: sha(second) })).json()).toEqual({});
    libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'c2'").run();
    expect((await check({ size: 4 }, "someone-else")).status).toBe(404);
    expect((await check({ size: 0 })).status).toBe(400);
  });
});
