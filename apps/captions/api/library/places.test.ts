import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import type { GoneAnswer, MovesAnswer, PlacesAnswer, PlacesReportAnswer } from "../../contracts/places";
import type { Disk, StorageFolder } from "../../contracts/storage";

// Here or away: a clip's original is at its root + root path for every computer, plus each computer's own places.
// ana owns the team and its library; bo was given its workspace (Settings → Team → Access); zed is on no team.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-places-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FIRST = "cccccccc-0000-4000-8000-000000000001";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${FIRST}.json`), JSON.stringify({ id: FIRST, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
const member = (username: string, workspaces?: string[]) => ({ username, role: "member", ai: "own", budgetUsd: 0, joinedAt: 0, ...(workspaces ? { workspaces } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Team", plan: "team", comped: false, createdAt: 0, members: [{ ...member("ana"), role: "owner" }, member("bo", [FIRST])] }], invites: [], spend: {} }),
);

const { libraryDb, openLibraryDb } = await import("./db");
const { MIGRATIONS } = await import("./schema");
const { libraryApp } = await import("./routes");
const { searchApp } = await import("./search");
const { placesFor, backfillRoots } = await import("./places");
const { indexOnMac } = await import("./on-mac");
const { reconnect } = await import("./locate");
const { markHere } = await import("./query");
const { fileFor } = await import("../editor/reach");
const { pairDevice, saveReport } = await import("../lib/devices");
const { LIBRARY_SOURCE, registerLibrarySlot } = await import("./sources");

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user", off: [], read: [] } as never);
  return next();
});
// in boot.ts's order: the library's routes before search's
app.route("/api/library", libraryApp);
app.route("/api/library", searchApp);
const call = async <T>(user: string, url: string, body?: unknown): Promise<{ status: number; json: T }> => {
  const r = await app.request(url, { method: body ? "POST" : "GET", headers: { "x-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: (await r.json()) as T };
};

const q = (c: string) => c.repeat(64);
const share = (at: string, o: Partial<Disk> = {}): Disk => ({ name: "footage", path: at, freeGb: 1, network: true, server: "office-nas", fs: "smb", share: "footage", ...o });
const boot: Disk = { name: "Macintosh HD", path: "/", freeGb: 1, uuid: "aaaa0000-0000-4000-8000-00000000000a" };
const travel: Disk = { name: "Travel SSD", path: "/Volumes/Travel SSD", freeGb: 1, uuid: "bbbb0000-0000-4000-8000-00000000000b" };
const report = (id: string, disks: Disk[]) => saveReport(id, { at: 0, drivers: [], homes: [], machine: { cpus: 8, memGb: 16, disks } });

// ana's Mac has the share at its usual path; bo's mounts it at another (a stale one was in the way), by another name
const anaMac = pairDevice("ana", "Studio").device.id;
const boMac = pairDevice("bo", "Laptop").device.id;
report(anaMac, [boot, share("/Volumes/footage")]);
report(boMac, [share("/Volumes/footage-1", { server: "Office-NAS.local", share: "Footage" }), travel]);
const ROOT = "smb://office-nas/footage";

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib', 't', 'Library', 'local', 0)").run();
const add = (id: string, o: { bytes: number; quick: string | null; mac?: string; device?: string; root?: string; rel?: string; key?: string }) => {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES (?, 'lib', 'video', ?, 'ana', 0)").run(`a_${id}`, id);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device, quick, root, root_rel)
     VALUES (?, ?, 1, ?, ?, 'x', 'ready', 'ana', 0, ?, ?, ?, ?, ?)`,
  ).run(id, `a_${id}`, o.key ?? `mac:${id}`, o.bytes, o.mac ?? null, o.device ?? null, o.quick, o.root ?? null, o.rel ?? null);
  d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ?").run(id, `a_${id}`);
};
const version = (id: string) => d.prepare("SELECT mac_path, mac_device, quick, root, root_rel FROM asset_versions WHERE id = ?").get(id) as Record<string, string | null>;
const place = (id: string, device: string) => d.prepare("SELECT path, gone_at FROM version_places WHERE version_id = ? AND device = ?").get(id, device) as { path: string; gone_at: number | null } | undefined;

add("june", { bytes: 100, quick: q("1"), mac: "/Volumes/footage/2025/June/a.mov", device: anaMac });
add("july", { bytes: 200, quick: q("2"), mac: "/Volumes/footage/2025/July/b.mov", device: anaMac, root: ROOT, rel: "2025/July/b.mov" });
add("noprint", { bytes: 300, quick: null, mac: "/Volumes/footage/2025/c.mov", device: anaMac, root: ROOT, rel: "2025/c.mov" });
add("home", { bytes: 400, quick: q("4"), mac: "/Users/ana/Movies/d.mov", device: anaMac });
add("upload", { bytes: 500, quick: q("5"), key: "libraries/lib/v/upload/source.mov" });

describe("placesFor", () => {
  const v = { root: ROOT, root_rel: "2025/a.mov", mac_path: "/Volumes/footage/2025/a.mov", mac_device: "m1" };
  const other = share("/Volumes/footage-1", { server: "office-nas._smb._tcp.local", share: "FOOTAGE" });
  it("tries its own place first, then the root on its disks at whatever path it is mounted", () => {
    expect(placesFor(v, { id: "m2", disks: [other] })).toEqual(["/Volumes/footage-1/2025/a.mov"]);
    expect(placesFor(v, { id: "m2", disks: [other] }, "/Users/b/copy.mov")).toEqual(["/Users/b/copy.mov", "/Volumes/footage-1/2025/a.mov"]);
  });
  it("leaves out a root whose share is away, and the origin path is the origin computer's only", () => {
    expect(placesFor(v, { id: "m2", disks: [{ ...other, away: true }] })).toEqual([]);
    expect(placesFor(v, { id: "m1", disks: [] })).toEqual([v.mac_path]);
    expect(placesFor({ ...v, root: null, root_rel: null }, { id: "m2", disks: [other] })).toEqual([]);
  });
  it("translates the origin path through a Settings → Folders folder another computer found", () => {
    const folder: StorageFolder = { id: "f", role: "footage", name: "footage", origin: { host: "m1", path: "/Volumes/footage" }, make: false, createdAt: 0, reach: { pc: { path: "/mnt/footage", at: 0 } } };
    expect(placesFor({ ...v, root: null }, { id: "pc" }, null, [folder])).toEqual(["/mnt/footage/2025/a.mov"]);
  });
});

describe("the places routes", () => {
  it("gives each computer its own way to the same file, and a root its owner's disks know is filled in later", async () => {
    // june came before roots: the backfill reads ana's Mac's disks
    while (backfillRoots());
    expect(version("june")).toMatchObject({ root: ROOT, root_rel: "2025/June/a.mov" });
    expect(version("home")).toMatchObject({ root: `vol:${boot.uuid!.toUpperCase()}`, root_rel: "Users/ana/Movies/d.mov" });
    const ana = await call<PlacesAnswer>("ana", `/api/library/lib/places?device=${anaMac}&versions=june,home,upload,nope`);
    expect(ana.json.versions.june).toMatchObject({ tries: ["/Volumes/footage/2025/June/a.mov"], bytes: 100, quick: q("1"), root: { key: ROOT, name: "footage", server: "office-nas" }, proxy: null });
    expect(ana.json.versions.upload).toMatchObject({ tries: [], proxy: { bytes: 500 } });
    expect(Object.keys(ana.json.versions).sort()).toEqual(["home", "june", "upload"]);
    const bo = await call<PlacesAnswer>("bo", `/api/library/lib/places?device=${boMac}&versions=june,home`);
    expect(bo.json.versions.june!.tries).toEqual(["/Volumes/footage-1/2025/June/a.mov"]);
    // ana's own disk: bo has no way to it, and the line names it by ana's Mac's disk
    expect(bo.json.versions.home).toMatchObject({ tries: [], root: { name: "Macintosh HD" } });
  });

  it("answers only the caller's own computer, and nothing to someone without the library", async () => {
    expect((await call("bo", `/api/library/lib/places?device=${anaMac}&versions=june`)).status).toBe(403);
    expect((await call("bo", `/api/library/lib/places`, { device: anaMac, confirmed: [], gone: [] })).status).toBe(403);
    expect((await call("zed", `/api/library/lib/places?device=${boMac}&versions=june`)).status).toBe(404);
    expect((await call("zed", `/api/library/lib/places/moves`)).status).toBe(404);
  });

  it("takes what a computer read: a place of its own, the fingerprint it never had, and refuses another file", async () => {
    const r = await call<PlacesReportAnswer>("bo", "/api/library/lib/places", {
      device: boMac,
      confirmed: [
        { versionId: "june", path: "/Volumes/footage-1/2025/June/a.mov" },
        { versionId: "noprint", path: "/Volumes/footage-1/2025/c.mov", quick: q("3") },
        { versionId: "july", path: "/Volumes/footage-1/2025/July/b.mov", quick: q("9") },
        { versionId: "home", path: "/Users/bo/d.mov" }, // not a path bo's Mac was given, and no fingerprint
      ],
      gone: [],
    });
    expect(r.json).toEqual({ confirmed: ["june", "noprint"], refused: ["july", "home"] });
    expect(place("june", boMac)).toEqual({ path: "/Volumes/footage-1/2025/June/a.mov", gone_at: null });
    expect(version("noprint").quick).toBe(q("3"));
    // the origin path stays ana's
    expect(version("june").mac_path).toBe("/Volumes/footage/2025/June/a.mov");
    // ana's Mac sends back the path it was given, written as it indexed it (decomposed): the same path
    add("nfd", { bytes: 700, quick: q("7"), mac: "/Users/ana/Movies/Cafe\u0301.mov", device: anaMac, root: ROOT, rel: "elsewhere.mov" });
    const nfd = await call<PlacesReportAnswer>("ana", "/api/library/lib/places", { device: anaMac, confirmed: [{ versionId: "nfd", path: "/Users/ana/Movies/Cafe\u0301.mov" }], gone: [] });
    expect(nfd.json).toEqual({ confirmed: ["nfd"], refused: [] });
  });

  it("a file moved on the share moves for everybody, logged once per folder change; a copy elsewhere is the finder's alone", async () => {
    // the library's owner reads them at their new folder on the share: moved for everybody, the origin path follows
    const r = await call<PlacesReportAnswer>("ana", "/api/library/lib/places", {
      device: anaMac,
      confirmed: [
        { versionId: "june", path: "/Volumes/footage/Archive/2025/June/a.mov", quick: q("1") },
        { versionId: "july", path: "/Volumes/footage/Archive/2025/July/b.mov", quick: q("2") },
      ],
      gone: [],
    });
    expect(r.json.confirmed).toEqual(["june", "july"]);
    expect(version("june").root_rel).toBe("Archive/2025/June/a.mov");
    expect(version("july").root_rel).toBe("Archive/2025/July/b.mov");
    expect(version("june").mac_path).toBe("/Volumes/footage/Archive/2025/June/a.mov");
    // bo's Mac finds them at the new root path with no search
    const tried = await call<PlacesAnswer>("bo", `/api/library/lib/places?device=${boMac}&versions=june`);
    expect(tried.json.versions.june!.tries).toContain("/Volumes/footage-1/Archive/2025/June/a.mov");
    const bos = await call<PlacesReportAnswer>("bo", "/api/library/lib/places", {
      device: boMac,
      confirmed: [
        { versionId: "june", path: "/Volumes/footage-1/Archive/2025/June/a.mov" },
        { versionId: "july", path: "/Volumes/footage-1/Archive/2025/July/b.mov" },
        { versionId: "home", path: "/Volumes/Travel SSD/Movies/d.mov", quick: q("4") },
      ],
      gone: [],
    });
    expect(bos.json.confirmed).toEqual(["june", "july", "home"]);
    // bo's copy on the travel disk is a place of bo's; the clip stays where it is for everybody else
    expect(place("home", boMac)?.path).toBe("/Volumes/Travel SSD/Movies/d.mov");
    expect(version("home").root_rel).toBe("Users/ana/Movies/d.mov");
    const bo = await call<MovesAnswer>("bo", "/api/library/lib/places/moves");
    expect(bo.json.moves.map(({ kind, from, to, count, root }) => ({ kind, from, to, count, root: root?.name }))).toEqual([
      { kind: "found", from: "/Users/ana", to: "/Volumes/Travel SSD", count: 1, root: "Travel SSD" },
      { kind: "moved", from: "2025", to: "Archive/2025", count: 2, root: "footage" },
    ]);
    // ana sees the move, not bo's copy
    expect((await call<MovesAnswer>("ana", "/api/library/lib/places/moves")).json.moves.map((m) => m.kind)).toEqual(["moved"]);
  });

  it("a member who may only read moves nothing for anybody: their verified copy on the share is their own place", async () => {
    add("aug", { bytes: 700, quick: q("7"), mac: "/Volumes/footage/2025/Aug/g.mov", device: anaMac, root: ROOT, rel: "2025/Aug/g.mov" });
    const r = await call<PlacesReportAnswer>("bo", "/api/library/lib/places", {
      device: boMac,
      confirmed: [{ versionId: "aug", path: "/Volumes/footage-1/Moved/g.mov", quick: q("7") }],
      gone: [],
    });
    expect(r.json.confirmed).toEqual(["aug"]);
    expect(version("aug").root_rel).toBe("2025/Aug/g.mov");
    expect(place("aug", boMac)?.path).toBe("/Volumes/footage-1/Moved/g.mov");
    const found = { kind: "found", from: "/Volumes/footage-1/2025/Aug", to: "/Volumes/footage-1/Moved" };
    const bo = await call<MovesAnswer>("bo", "/api/library/lib/places/moves");
    expect(bo.json.moves.map(({ kind, from, to }) => ({ kind, from, to }))).toContainEqual(found);
    const ana = await call<MovesAnswer>("ana", "/api/library/lib/places/moves");
    expect(ana.json.moves.map(({ kind, from, to }) => ({ kind, from, to }))).not.toContainEqual(found);
    expect((await call<PlacesAnswer>("ana", `/api/library/lib/places?device=${anaMac}&versions=aug`)).json.versions.aug!.tries).toContain("/Volumes/footage/2025/Aug/g.mov");
  });

  it("gone marks only the caller's computer, lists what it can search for, and a confirm brings it back", async () => {
    await call("bo", "/api/library/lib/places", { device: boMac, confirmed: [], gone: ["july", "upload"] });
    expect(place("july", boMac)?.gone_at).toBeTruthy();
    expect(place("july", anaMac)?.gone_at).toBeNull();
    // no way to the upload on bo's Mac: nothing to mark
    expect(place("upload", boMac)).toBeUndefined();
    const gone = await call<GoneAnswer>("bo", `/api/library/lib/places/gone?device=${boMac}`);
    expect(gone.json.gone).toEqual([
      { versionId: "july", bytes: 200, quick: q("2"), root: ROOT, rootRel: "Archive/2025/July/b.mov", path: "/Volumes/footage-1/Archive/2025/July/b.mov", name: "b.mov" },
    ]);
    // a gone place is not tried first any more: the root is
    expect((await call<PlacesAnswer>("bo", `/api/library/lib/places?device=${boMac}&versions=july`)).json.versions.july!.tries).toEqual([
      "/Volumes/footage-1/Archive/2025/July/b.mov",
    ]);
    await call("bo", "/api/library/lib/places", { device: boMac, confirmed: [{ versionId: "july", path: "/Volumes/footage-1/Archive/2025/July/b.mov" }], gone: [] });
    expect(place("july", boMac)?.gone_at).toBeNull();
  });
});

describe("indexing and reading by places", () => {
  it("indexing a file the library has makes it the computer's place, an upload's too, and still answers duplicateOf", async () => {
    const frames: string[] = [];
    const r = await indexOnMac("lib", "bo", { name: "e.mov", path: "/Volumes/Travel SSD/e.mov", size: 500, quick: q("5"), device: boMac, frames });
    expect(r).toEqual({ duplicateOf: "a_upload" });
    expect(place("upload", boMac)?.path).toBe("/Volumes/Travel SSD/e.mov");
    // a new file gets its root from the computer's disks, and its place
    const fresh = (await indexOnMac("lib", "ana", { name: "f.mov", path: "/Volumes/footage/2026/f.mov", size: 600, quick: q("6"), device: anaMac, frames })) as { versionId: string };
    expect(version(fresh.versionId)).toMatchObject({ root: ROOT, root_rel: "2026/f.mov" });
    expect(place(fresh.versionId, anaMac)?.path).toBe("/Volumes/footage/2026/f.mov");
  });

  it("indexing a file the library has as a clip the caller may not see names no clip and records no place", async () => {
    add("secret", { bytes: 800, quick: q("8"), key: "libraries/lib/v/secret/source.mov" });
    registerLibrarySlot("test-refuses", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: (v, a) => !(v.username === "bo" && a.assetId === "a_secret") }] });
    const r = await indexOnMac("lib", "bo", { name: "s.mov", path: "/Volumes/Travel SSD/s.mov", size: 800, quick: q("8"), device: boMac, frames: [] });
    expect(r).toEqual({ duplicate: true });
    expect(place("secret", boMac)).toBeUndefined();
    // the owner still gets the clip's id
    expect(await indexOnMac("lib", "ana", { name: "s.mov", path: "/Volumes/footage/s.mov", size: 800, quick: q("8"), device: anaMac, frames: [] })).toEqual({ duplicateOf: "a_secret" });
  });

  it("a member's computer that has the share reads the original there, and its cards say so", () => {
    const row = { id: "june", source_key: "mac:june", source_path: null, mac_path: "/Volumes/footage/Archive/2025/June/a.mov", mac_device: anaMac, proxy: null };
    expect(fileFor(row, boMac, [], () => false)).toEqual({ path: "/Volumes/footage-1/Archive/2025/June/a.mov" });
    const cards = (["june", "home", "upload", "noprint"] as const).map((v) => ({ id: `a_${v}`, versionId: v }) as never);
    expect(markHere(d, cards, boMac).filter((c: { here?: true }) => c.here).map((c: { versionId: string }) => c.versionId)).toEqual(["june", "home", "upload", "noprint"]);
    // the share away: only what bo's Mac read elsewhere, or read there and not looked for since
    report(boMac, [share("/Volumes/footage-1", { away: true }), travel]);
    d.prepare("DELETE FROM version_places WHERE device = ? AND version_id = 'noprint'").run(boMac);
    expect(markHere(d, cards, boMac).filter((c: { here?: true }) => c.here).map((c: { versionId: string }) => c.versionId)).toEqual(["june", "home", "upload"]);
    expect(fileFor({ ...row, id: "noprint" }, boMac, [], () => false)).toBeNull();
    report(boMac, [share("/Volumes/footage-1", { server: "Office-NAS.local", share: "Footage" }), travel]);
  });

  it("Locate gives a teammate their own way to the owner's clip, never the owner's path", async () => {
    const n = await reconnect("lib", "bo", { asked: "july", gone: [], files: [{ path: "/Volumes/Travel SSD/b.mov", size: 200, quick: q("2") }], device: boMac });
    expect(n).toBe(1);
    expect(place("july", boMac)?.path).toBe("/Volumes/Travel SSD/b.mov");
    expect(version("july").mac_path).toBe("/Volumes/footage/Archive/2025/July/b.mov");
  });
});

describe("reconnecting", () => {
  it("the Where filter's countries have their own address, so the places route only ever answers a computer", async () => {
    expect((await call<{ places: unknown[] }>("ana", "/api/library/lib/countries")).status).toBe(200);
    expect((await call("ana", "/api/library/lib/places")).status).toBe(403);
  });

  it("Look for new files' check finds a file the library has by its fingerprint, an upload's too, and names the version", async () => {
    const r = await call("ana", "/api/library/lib/uploads/check", { size: 500, sha256: `mac:${q("5")}`, quick: q("5") });
    expect(r.json).toEqual({ duplicateOf: "a_upload", versionId: "upload" });
    // the same fingerprint at another size is another file
    expect((await call("ana", "/api/library/lib/uploads/check", { size: 501, sha256: `mac:${q("5")}`, quick: q("5") })).json).toEqual({});
  });

  it("Missing here lists the clips this computer last found gone; a clip whose share is away is not missing", async () => {
    const missing = async () => (await call<{ items: { id: string }[] }>("bo", `/api/library/lib/assets?device=${boMac}&missing=1`)).json.items.map((i) => i.id);
    expect(await missing()).toEqual([]);
    await call("bo", "/api/library/lib/places", { device: boMac, confirmed: [], gone: ["june"] });
    expect(await missing()).toEqual(["a_june"]);
    // only the caller's own computer narrows anything
    expect((await call<{ items: unknown[] }>("bo", `/api/library/lib/assets?device=${anaMac}&missing=1`)).json.items.length).toBeGreaterThan(1);
  });

  it("a pressed search also gets the clips whose share isn't connected on that computer, with where it read them last", async () => {
    const ids = async (q: string) => (await call<GoneAnswer>("bo", `/api/library/lib/places/gone?device=${boMac}${q}`)).json.gone.map((g) => g.versionId).sort();
    expect(await ids("")).toEqual(["june"]);
    report(boMac, [share("/Volumes/footage-1", { away: true }), travel]);
    const away = (await call<GoneAnswer>("bo", `/api/library/lib/places/gone?device=${boMac}&away=1`)).json.gone;
    expect(away.map((g) => g.versionId)).toEqual(expect.arrayContaining(["june", "july", "home"]));
    expect(away.find((g) => g.versionId === "home")).toMatchObject({ path: "/Volumes/Travel SSD/Movies/d.mov", name: "d.mov" });
    // one with no place there and indexed elsewhere: no path, its title for a name
    expect(away.find((g) => g.versionId === "nfd")).toMatchObject({ path: "", name: "nfd" });
    report(boMac, [share("/Volumes/footage-1", { server: "Office-NAS.local", share: "Footage" }), travel]);
  });

  it("Locate lists a teammate's clip by their own computer's way to it, and only with their own computer", async () => {
    const files = async (device: string) => (await call<{ files: { id: string; path: string }[] }>("bo", `/api/library/lib/locate?versionId=june&device=${device}&only=1`)).json.files;
    expect(await files(boMac)).toEqual([{ id: "june", path: "/Volumes/footage-1/Archive/2025/June/a.mov", bytes: 100 }]);
    expect(await files(anaMac)).toEqual([]);
  });
});

it("migration 27 keeps where each clip was indexed as that computer's place", () => {
  const file = path.join(dir, "before.db");
  const old = new DatabaseSync(file);
  const at = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE version_places")); // migration 27, whatever came after it
  for (const m of MIGRATIONS.slice(0, at)) old.exec(m);
  old.exec(`PRAGMA user_version = ${at};
    INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('l', 'w', 'L', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('a', 'l', 'video', 'x', 'u', 0), ('b', 'l', 'video', 'y', 'u', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device)
      VALUES ('va', 'a', 1, 'mac:va', 1, 'x', 'ready', 'u', 7, '/Volumes/footage/a.mov', 'mac_1'), ('vb', 'b', 1, 'k', 1, 'x', 'ready', 'u', 8, NULL, NULL);`);
  old.close();
  const db = openLibraryDb(file);
  expect(db.prepare("SELECT version_id, device, path, confirmed_at, gone_at FROM version_places").all()).toEqual([
    { version_id: "va", device: "mac_1", path: "/Volumes/footage/a.mov", confirmed_at: 7, gone_at: null },
  ]);
  db.close();
});
