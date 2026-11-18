import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import type { AssetCard, WhereAnswer } from "../../contracts/library";

// the readers of "where is this file" read the place rows only (whereis.ts): filters, card words, the where route,
// the removal guard, and the fingerprint fixes (B8)
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-whereis-"));
process.env.DATA_DIR = dir;
const { blobs, libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { buildAssetQuery, markHere, pageOf } = await import("./query");
const { mayRemoveServerCopy } = await import("./whereis");
const { backfillQuick, reconnect, RETRY_QUICK_MS } = await import("./locate");
const { pairDevice, saveReport } = await import("../lib/devices");
const { whereIs } = await import("./whereis");
const { placeWordOf } = await import("../../contracts/places");
const { quickPrint } = await import("../work/files");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const q = (c: string) => c.repeat(64);
const d = () => libraryDb();
let mac = "";
let other = "";

function add(id: string, o: { lib?: string; bytes?: number; quick?: string | null; source?: string; key?: string; sha256?: string; full?: string | null; state?: string } = {}) {
  const lib = o.lib ?? "lib_w";
  d().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', ?, ?, 'tiny', 0)").run(`a_${id}`, lib, id, id);
  d()
    .prepare(
      `INSERT INTO asset_versions (id, asset_id, n, source_key, source_path, bytes, sha256, full_sha256, state, created_by, created_at, quick)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'tiny', 100, ?)`,
    )
    .run(id, `a_${id}`, o.key ?? `libraries/${lib}/v/${id}/source.mov`, o.source ?? null, o.bytes ?? 100, o.sha256 ?? "x", o.full ?? null, o.state ?? "ready", o.quick === undefined ? null : o.quick);
}
const place = (id: string, device: string, state: string, more: { kind?: string; sha256?: string; verifiedAt?: number; folder?: string } = {}) =>
  d()
    .prepare("INSERT INTO version_places (version_id, device, kind, folder_id, path, state, sha256, verified_at, gone_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, device, more.kind ?? "original", more.folder ?? "", `/Volumes/Tiny Footage/${id}.mov`, state, more.sha256 ?? null, more.verifiedAt ?? null, state === "gone" ? 1 : null);

beforeAll(() => {
  d().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_w', 'tiny', 'W', 'local', 0)").run();
  d().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_b', 'tiny-b', 'B', 's3', 0)").run();
  mac = pairDevice("tiny", "Tiny Studio Mac").device.id;
  other = pairDevice("tiny", "Tiny Laptop").device.id;
  add("verified");
  place("verified", mac, "verified");
  add("gone");
  place("gone", mac, "gone");
  add("unchecked");
  place("unchecked", mac, "unchecked");
  add("norow");
  add("proxy");
  place("proxy", mac, "verified", { kind: "proxy" });
  add("elsewhere");
  place("elsewhere", other, "found");
});

const ids = (query: Parameters<typeof buildAssetQuery>[1]) => {
  const { sql, params, limit } = buildAssetQuery("lib_w", query);
  return pageOf(d().prepare(sql).all(...params) as never, limit).items.map((c) => c.versionId).sort();
};

describe("the Library's filters and card words read the place rows", () => {
  it("On this computer: verified or found there, or its proxy cached there; Missing: gone there; no row or not checked is neither", () => {
    expect(ids({ here: true, device: mac })).toEqual(["proxy", "verified"]);
    expect(ids({ missing: true, device: mac })).toEqual(["gone"]);
    expect(ids({ here: true, device: other })).toEqual(["elsewhere"]);
    expect(ids({ missing: true, device: other })).toEqual([]);
  });

  it("each card says where its original is, seen from the asking computer; one no computer reported says nothing", async () => {
    const cards = ["verified", "gone", "unchecked", "norow", "elsewhere"].map((v) => ({ id: `a_${v}`, versionId: v }) as AssetCard);
    const by = new Map((await markHere(d(), cards, mac)).map((c) => [c.versionId, c]));
    expect(by.get("verified")).toMatchObject({ here: true, placeWord: { word: "here" } });
    expect(by.get("gone")!.placeWord).toEqual({ word: "missing", computer: "Tiny Studio Mac" });
    expect(by.get("unchecked")!.placeWord).toEqual({ word: "unchecked", computer: "Tiny Studio Mac" });
    expect(by.get("norow")!.placeWord).toBeUndefined();
    expect(by.get("elsewhere")!.placeWord).toEqual({ word: "on", computer: "Tiny Laptop" });
    expect(by.get("elsewhere")!.here).toBeUndefined();
  });

  it("a drive the computer leaves out of its disk list is away only for a row not checked: a verified row was just listed there", () => {
    saveReport(mac, { at: Date.now(), drivers: [], homes: [], machine: { disks: [{ name: "System disk", path: "/", freeGb: 10 }] } } as unknown as Parameters<typeof saveReport>[1]);
    expect(placeWordOf(whereIs("verified"), mac)).toEqual({ word: "here" });
    expect(placeWordOf(whereIs("unchecked"), mac)).toEqual({ word: "disk_away", disk: "Tiny Footage" });
    expect(placeWordOf(whereIs("gone"), mac)).toEqual({ word: "missing", computer: "Tiny Studio Mac" });
  });

  it("GET …/where answers each version the caller may see, with its word; another library's version is left out", async () => {
    add("theirs", { lib: "lib_b" });
    place("theirs", mac, "verified");
    const r = await app.request(`/api/library/lib_w/where?versions=verified,gone,theirs,nope&device=${mac}`, { headers: { "x-user": "tiny" } });
    expect(r.status).toBe(200);
    const { versions } = (await r.json()) as WhereAnswer;
    expect(Object.keys(versions).sort()).toEqual(["gone", "verified"]);
    expect(versions.verified).toMatchObject({ versionId: "verified", library: "lib_w", word: { word: "here" }, server: { original: true } });
    expect(versions.gone!.computers[0]).toMatchObject({ device: mac, name: "Tiny Studio Mac", original: { state: "gone" } });
    expect((await app.request("/api/library/lib_w/where?versions=verified", { headers: { "x-user": "stranger" } })).status).toBe(404);
    const many = Array.from({ length: 201 }, (_, i) => `v${i}`).join(",");
    expect((await app.request(`/api/library/lib_w/where?versions=${many}`, { headers: { "x-user": "tiny" } })).status).toBe(400);
  });
});

describe("removing the server's copy (D9 guard, not called before P4)", () => {
  const H = "a".repeat(64);
  it("refuses a version indexed on a Mac (sha256 \"mac:<quick>\") with no full sha256 of the server's file", () => {
    add("macq", { sha256: `mac:${q("1")}`, key: "mac:macq" });
    place("macq", mac, "verified", { sha256: q("1"), verifiedAt: 200 });
    expect(mayRemoveServerCopy("macq")).toMatchObject({ ok: false });
    add("macfull", { sha256: `mac:${q("1")}`, full: `mac:${q("1")}` });
    place("macfull", mac, "verified", { sha256: `mac:${q("1")}`, verifiedAt: 200 });
    expect(mayRemoveServerCopy("macfull")).toMatchObject({ ok: false });
  });

  it("refuses a computer's verified copy whose full sha256 is another", () => {
    add("differs", { full: H });
    place("differs", mac, "verified", { sha256: "b".repeat(64), verifiedAt: 200 });
    expect(mayRemoveServerCopy("differs")).toMatchObject({ ok: false });
  });

  it("passes a verified copy with the same full sha256, read after the server's file; a found one or an older read does not", () => {
    add("same", { full: H });
    place("same", other, "found", { sha256: H, verifiedAt: 200 });
    expect(mayRemoveServerCopy("same")).toMatchObject({ ok: false });
    place("same", mac, "verified", { sha256: H, verifiedAt: 50, folder: "f-old" });
    expect(mayRemoveServerCopy("same")).toMatchObject({ ok: false });
    place("same", mac, "verified", { sha256: H, verifiedAt: 200 });
    expect(mayRemoveServerCopy("same")).toEqual({ ok: true, device: mac });
  });
});

describe("fingerprints (B8)", () => {
  it("a read that fails is tried again later, never kept as ''", async () => {
    const file = path.join(dir, "later.mov");
    add("later", { source: file, key: "libraries/lib_w/v/later/source.mov" });
    while (await backfillQuick());
    expect((d().prepare("SELECT quick FROM asset_versions WHERE id = 'later'").get() as { quick: string | null }).quick).toBeNull();
    writeFileSync(file, Buffer.alloc(3000, 4));
    expect(await backfillQuick()).toBe(false); // waits before it tries again
    while (await backfillQuick(Date.now() + RETRY_QUICK_MS + 1));
    expect((d().prepare("SELECT quick FROM asset_versions WHERE id = 'later'").get() as { quick: string }).quick).toBe(await quickPrint(file));
  });

  it("a clip stored in a bucket gets its fingerprint from the stored copy", async () => {
    const file = path.join(dir, "stored.mov");
    writeFileSync(file, Buffer.alloc(5000, 9));
    const want = await quickPrint(file);
    const key = "libraries/lib_b/v/stored/source.mov";
    add("stored", { lib: "lib_b", key });
    // the bucket (not set up here) answers the copy it keeps: what the download cache gives
    const real = blobs.localCopy;
    blobs.localCopy = (k) => (k === key ? Promise.resolve(file) : real(k));
    try {
      while (await backfillQuick(Date.now() + RETRY_QUICK_MS + 1));
    } finally {
      blobs.localCopy = real;
    }
    expect((d().prepare("SELECT quick FROM asset_versions WHERE id = 'stored'").get() as { quick: string }).quick).toBe(want);
  });

  it("Locate keeps every file with one size and fingerprint: the one with the clip's old name is taken, two others take neither", async () => {
    d().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_l', 'tiny-l', 'L', 'local', 0)").run();
    const mk = (id: string, was: string) => {
      d().prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_l', 'video', ?, ?, 'tiny-l', 0)").run(`a_${id}`, id, id);
      d()
        .prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, quick, mac_path) VALUES (?, ?, 1, ?, 300, 'x', 'ready', 'tiny-l', 0, ?, ?)")
        .run(id, `a_${id}`, `mac:${id}`, id === "named" ? q("7") : q("8"), was);
    };
    mk("named", "/Volumes/Old/Shoot/take.mov");
    mk("twins", "/Volumes/Old/Shoot/other.mov");
    const files = [
      { path: "/Volumes/New/A/take copy.mov", size: 300, quick: q("7") },
      { path: "/Volumes/New/B/take.mov", size: 300, quick: q("7") },
      { path: "/Volumes/New/A/one.mov", size: 300, quick: q("8") },
      { path: "/Volumes/New/B/two.mov", size: 300, quick: q("8") },
    ];
    expect(await reconnect("lib_l", "tiny-l", { asked: "named", gone: ["twins"], files })).toBe(1);
    const at = (id: string) => (d().prepare("SELECT mac_path FROM asset_versions WHERE id = ?").get(id) as { mac_path: string }).mac_path;
    expect(at("named")).toBe("/Volumes/New/B/take.mov");
    expect(at("twins")).toBe("/Volumes/Old/Shoot/other.mov");
  });
});

describe("aliasDevice", () => {
  it("moves the computer an uploaded file came from with the alias", async () => {
    const { aliasDevice } = await import("./whereis");
    add("came-from");
    d().prepare("UPDATE asset_versions SET from_device = 'dev_old', mac_device = 'dev_old' WHERE id = 'came-from'").run();
    aliasDevice(["dev_old"], mac);
    expect(d().prepare("SELECT from_device, mac_device FROM asset_versions WHERE id = 'came-from'").get()).toEqual({ from_device: mac, mac_device: mac });
  });
});
