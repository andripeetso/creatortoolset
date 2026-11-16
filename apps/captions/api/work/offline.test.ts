import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORK_V, type WorkClaim } from "../../contracts/work";
import type { AssetPage, SearchHit } from "../../contracts/library";
import type { KeptView } from "../../contracts/storage";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-offline-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "work-offline-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb, blobs } = await import("../library/db");
const { indexAsset } = await import("../library/query");
const { pairDevice } = await import("../lib/devices");
const { LIBRARY_SOURCE, registerLibrarySlot } = await import("../library/sources");
// a second policy on the built-in library, as a plug-in adds one: refuses the clips the test names
const refuse = new Set<string>();
registerLibrarySlot("test-gate", { policies: [{ sourceId: LIBRARY_SOURCE, canSee: (_v, a) => !refuse.has(a.versionId) }] });
const { CLAIM_POLL } = await import("./routes");
CLAIM_POLL.holdMs = 0;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cookies: Record<string, string> = {};
async function login(user: string) {
  setOff(createUser(user, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user, password: "password1" }) });
  cookies[user] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const as = (user: string, url: string, body?: unknown) =>
  app.request(url, body === undefined ? { headers: { cookie: cookies[user]! } } : { method: "POST", headers: { cookie: cookies[user]!, "content-type": "application/json" }, body: JSON.stringify(body) });
const claim = async (token: string, cache?: unknown) =>
  (await app.request("/api/devices/relay/work/claim", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ v: WORK_V, steps: [], cache }) })).json() as Promise<WorkClaim>;

/** A clip of `user`'s uploaded with a proxy (`p_<id>`, its text the proxy's bytes), optionally indexed on a computer. */
async function clip(user: string, id: string, on?: string) {
  libraryDb().exec(`
    INSERT OR IGNORE INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_${user}', '${user}', 'L', 'local', 0);
    INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_${id}', 'lib_${user}', 'video', '${id}.mov', '${id}', '${user}', 0);
    INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_device) VALUES
      ('${id}', 'ast_${id}', 1, 'k_${id}', 100, 'x', 'ready', '${user}', 0, ${on ? `'${on}'` : "NULL"});
    INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('${id}', 'proxy', 'p_${id}', ${`proxy ${id}`.length});
  `);
  indexAsset(libraryDb(), `ast_${id}`);
  const f = path.join(dir, `p_${id}.mp4`);
  writeFileSync(f, `proxy ${id}`);
  await blobs.put(`p_${id}`, f);
}

let mac: ReturnType<typeof pairDevice>;
let laptop: ReturnType<typeof pairDevice>;
let theirs: ReturnType<typeof pairDevice>;
beforeAll(async () => {
  for (const u of ["tiny", "bo"]) await login(u);
  mac = pairDevice("tiny", "Studio Mac");
  laptop = pairDevice("tiny", "Laptop");
  theirs = pairDevice("bo", "Bo's Mac");
  for (const id of ["va", "vb", "vc"]) await clip("tiny", id);
  await clip("tiny", "vm", mac.device.id); // its file is on the Mac itself
  await clip("bo", "vx");
  libraryDb().exec(`
    INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_t', 'lib_tiny', 'Trips', 'manual', 0);
    INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_t', 'ast_vb', 1, 'tiny'), ('col_t', 'ast_vm', 2, 'tiny');
  `);
});

describe("Available offline", () => {
  it("is kept per person: a clip or a folder they can see, never someone else's", async () => {
    expect((await as("tiny", "/api/library/offline", { version: "va", on: true })).status).toBe(200);
    expect(await (await as("tiny", "/api/library/offline", { collection: "col_t", on: true })).json()).toEqual({ versions: ["va"], collections: ["col_t"] });
    expect((await as("tiny", "/api/library/offline", { version: "vx", on: true })).status).toBe(404);
    expect((await as("tiny", "/api/library/offline", { version: "va" })).status).toBe(400);
    expect(await (await as("bo", "/api/library/offline")).json()).toEqual({ versions: [], collections: [] });
  });

  it("each of their computers is sent the proxies to keep, without a file already on it", async () => {
    const off = (await claim(mac.token)).offline!.map((f) => f.id).sort();
    expect(off).toEqual(["va", "vb"]); // vm's file is on this Mac
    expect((await claim(laptop.token)).offline!.map((f) => f.id).sort()).toEqual(["va", "vb", "vm"]);
    expect((await claim(laptop.token)).offline!.find((f) => f.id === "va")).toEqual({ id: "va", title: "va.mov", bytes: "proxy va".length });
    expect((await claim(theirs.token)).offline).toBeUndefined(); // nothing to keep, and it keeps nothing
    expect((await claim(theirs.token, { bytes: 5, offline: ["vx"] })).offline).toEqual([]); // it lets go of what it kept
  });

  it("a computer downloads only a proxy it was told to keep", async () => {
    const get = (token: string, v: string) => app.request(`/api/devices/relay/work/offline/${v}`, { headers: { authorization: `Bearer ${token}` } });
    expect(await (await get(laptop.token, "va")).text()).toBe("proxy va");
    expect((await get(laptop.token, "vc")).status).toBe(404); // not kept offline
    expect((await get(theirs.token, "va")).status).toBe(404); // not theirs
    expect((await get("ctd_nobody", "va")).status).toBe(401);
  });
});

describe("Settings → Storage: each computer's proxies", () => {
  const rows = async (user: string) => ((await (await as(user, "/api/devices/storage/kept")).json()) as KeptView).rows.filter((r) => r.kind === "proxies");

  it("counts each computer's cache from its last claim, one row each", async () => {
    await claim(mac.token, { bytes: 900, versions: ["va", "vb", "vc"] });
    await claim(laptop.token, { bytes: 40, limit: 100, versions: ["va"] });
    expect((await rows("tiny")).sort((a, b) => b.bytes - a.bytes)).toEqual([
      { kind: "proxies", bytes: 900, items: 3, device: { id: mac.device.id, name: "Studio Mac" } },
      { kind: "proxies", bytes: 40, items: 1, device: { id: laptop.device.id, name: "Laptop" } },
    ]);
    expect((await rows("bo")).map((r) => r.device?.id)).toEqual([theirs.device.id]); // only their own computer
  });

  it("Empty tells that computer on its next claim, once; the row reads emptied until it reports again (PRD test 6, server half)", async () => {
    expect((await as("tiny", `/api/devices/storage/kept/proxies/empty?device=${mac.device.id}`, {})).status).toBe(200);
    expect((await rows("tiny")).find((r) => r.device?.id === mac.device.id)).toMatchObject({ bytes: 0, items: 0 });
    expect((await claim(laptop.token, { bytes: 40, versions: ["va"] })).empty).toBeUndefined(); // only the one picked
    const told = await claim(mac.token, { bytes: 900, versions: ["va", "vb", "vc"] });
    expect(told.empty).toBe(true);
    expect((await rows("tiny")).find((r) => r.device?.id === mac.device.id)).toMatchObject({ bytes: 0 });
    expect((await claim(mac.token, { bytes: 10, versions: ["va"] })).empty).toBeUndefined();
    expect((await rows("tiny")).find((r) => r.device?.id === mac.device.id)).toMatchObject({ bytes: 10, items: 1 });
  });
});

describe("a computer's cached proxies its owner may no longer have", () => {
  it("are named on the claim to be deleted: refused by a library policy now, gone, or in the trash", async () => {
    const drop = async (versions: string[], parts?: string[]) => (await claim(laptop.token, { bytes: 1, versions, ...(parts ? { parts } : {}) })).drop;
    expect(await drop(["va", "vb"])).toBeUndefined(); // still theirs: nothing to delete
    expect(await drop(["va", "vx", "vgone"], ["vb", "vnope"])).toEqual(["vx", "vgone", "vnope"]); // someone else's, and gone
    libraryDb().prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'ast_vb'").run();
    expect(await drop(["va"], ["vb"])).toEqual(["vb"]);
    libraryDb().prepare("UPDATE assets SET trashed_at = NULL WHERE id = 'ast_vb'").run();
    // a library policy that now refuses them the clip (a raw upload, say): deleted though it was kept offline
    refuse.add("va");
    try {
      const told = await claim(laptop.token, { bytes: 1, versions: ["va", "vb"], offline: ["va", "vb"] });
      expect(told.drop).toEqual(["va"]);
      expect(told.offline!.map((f) => f.id)).not.toContain("va");
    } finally {
      refuse.clear();
      await claim(laptop.token, { bytes: 40, versions: ["va"] }); // its report as the tests after it expect
    }
  });
});

describe("On this computer", () => {
  const list = async (user: string, q: string) => ((await (await as(user, `/api/library/lib_tiny/assets?${q}`)).json()) as AssetPage).items;

  it("marks the cards on the asking computer and narrows to them: its proxy cache and the files indexed on it", async () => {
    await claim(mac.token, { bytes: 10, versions: ["va"] });
    const all = await list("tiny", `device=${mac.device.id}`);
    expect(all.filter((c) => c.here).map((c) => c.versionId).sort()).toEqual(["va", "vm"]);
    expect((await list("tiny", `device=${mac.device.id}&here=1`)).map((c) => c.versionId).sort()).toEqual(["va", "vm"]);
    expect((await list("tiny", `device=${laptop.device.id}&here=1`)).map((c) => c.versionId)).toEqual(["va"]); // vm's file is on the Mac
    // a search narrows and marks the same way
    const hits = (await (await as("tiny", `/api/library/lib_tiny/search?q=va&device=${mac.device.id}&here=1`)).json()) as SearchHit[];
    expect(hits.map((h) => [h.asset.versionId, h.asset.here])).toEqual([["va", true]]);
  });

  it("someone else's computer is ignored", async () => {
    await claim(theirs.token, { bytes: 10, versions: ["vc"] });
    expect((await list("tiny", `device=${theirs.device.id}&here=1`)).length).toBe(4);
    expect((await list("tiny", `device=${theirs.device.id}`)).some((c) => c.here)).toBe(false);
  });
});
