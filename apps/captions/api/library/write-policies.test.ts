import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Every library write asks the policies (sources.ts) and the account's library role. A refused asset or piece is a 404
// and changes nothing, for the owner too; a member (no library of their own) gets 404 even on a collection granted to them.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-write-policies-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { collectionApp } = await import("./collections");
const { searchApp } = await import("./search");
const { shareApp } = await import("./shares");
const { indexAsset } = await import("./query");
const { registerLibrarySlot, resetLibrarySlots } = await import("./sources");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", shareApp);
app.route("/api/library", collectionApp);
app.route("/api/library", searchApp);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const call = (user: string, method: string, url: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(url, {
      method,
      headers: { "x-user": user, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const data = async (r: Promise<Response>): Promise<any> => (await r).json();

function seed(id: string, title: string) {
  const d = libraryDb();
  const v = `${id}-v1`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_w', 'video', ?, ?, 'owner-w', 1000)").run(id, title, v);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, ?, 4, ?, 'video/mp4', 'ready', 'owner-w', 1000)",
  ).run(v, id, `libraries/lib_w/v/${v}/source`, sha256(id));
  indexAsset(d, id);
  return v;
}

const titleOf = (id: string) => (libraryDb().prepare("SELECT title FROM assets WHERE id = ?").get(id) as { title: string }).title;
const jobCount = () => (libraryDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
const sharesOf = (user: string) => (libraryDb().prepare("SELECT COUNT(*) AS n FROM shares WHERE created_by = ?").get(user) as { n: number }).n;

beforeAll(() => {
  const d = libraryDb();
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_w', 'owner-w', 'W', 'local', 0)").run();
  seed("vis1", "Visible");
  seed("hid1", "Hidden by a plug-in");
  seed("gr1", "Granted to a member");
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES ('col_mix', 'lib_w', NULL, 'Mixed', 'manual', 0, 'owner-w')").run();
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at, created_by) VALUES ('col_g', 'lib_w', NULL, 'Granted', 'manual', 0, 'owner-w')").run();
  d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_mix', 'hid1', 1, 'owner-w'), ('col_mix', 'vis1', 2, 'owner-w'), ('col_g', 'gr1', 1, 'owner-w')").run();
  d.prepare("INSERT INTO library_grants (collection_id, username, granted_by, created_at) VALUES ('col_g', 'member-w', 'owner-w', 0)").run();
  d.prepare("INSERT INTO pieces (id, library_id, collection_id, label, created_by, created_at) VALUES ('pc_hid', 'lib_w', NULL, 'Has hidden', 'owner-w', 0), ('pc_vis', 'lib_w', NULL, 'Visible only', 'owner-w', 0)").run();
  d.prepare("INSERT INTO piece_items (id, piece_id, version_id, label, position) VALUES ('pci_hid', 'pc_hid', 'hid1-v1', NULL, 1), ('pci_vis', 'pc_vis', 'vis1-v1', NULL, 1)").run();
});

describe("library writes ask the policies: a plug-in refuses an item", () => {
  it("the refused asset is 404 for the owner on edit and jobs, and nothing changes", async () => {
    registerLibrarySlot("test-wp", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "hid1" }] });
    try {
      const before = jobCount();
      expect((await call("owner-w", "PATCH", "/api/library/lib_w/assets/hid1", { title: "Renamed" })).status).toBe(404);
      expect((await call("owner-w", "POST", "/api/library/lib_w/assets/hid1/jobs", { kinds: ["describe"] })).status).toBe(404);
      expect(titleOf("hid1")).toBe("Hidden by a plug-in");
      expect(jobCount()).toBe(before);

      // a control: the same owner can still edit an asset the policy lets through
      expect((await call("owner-w", "PATCH", "/api/library/lib_w/assets/vis1", { title: "Renamed" })).status).toBe(200);
      expect(titleOf("vis1")).toBe("Renamed");
    } finally {
      resetLibrarySlots();
    }
  });

  it("a refused item keeps its collection and piece unchanged", async () => {
    registerLibrarySlot("test-wp", { policies: [{ sourceId: "library", canSee: (_v, a) => a.assetId !== "hid1" }] });
    try {
      expect(await data(call("owner-w", "POST", "/api/library/lib_w/collections/col_mix/items", { assetIds: ["hid1"] }))).toEqual({ added: 0 });
      expect(await data(call("owner-w", "DELETE", "/api/library/lib_w/collections/col_mix/items", { assetIds: ["hid1"] }))).toEqual({ removed: 0 });
      expect((await call("owner-w", "PATCH", "/api/library/lib_w/pieces/pc_hid", { label: "Renamed" })).status).toBe(404);
      expect((await call("owner-w", "PATCH", "/api/library/lib_w/pieces/pc_hid/items/pci_hid", { label: "Renamed" })).status).toBe(404);
      expect((await call("owner-w", "DELETE", "/api/library/lib_w/pieces/pc_hid/items/pci_hid")).status).toBe(404);
      expect((await call("owner-w", "POST", "/api/library/lib_w/pieces/pc_hid/items/pci_hid/postings", { platform: "instagram" })).status).toBe(404);
      expect((await call("owner-w", "POST", "/api/library/lib_w/shares", { target: { kind: "piece", id: "pc_hid" }, scope: "view" })).status).toBe(404);
      expect((await call("owner-w", "POST", "/api/library/lib_w/shares", { target: { kind: "asset", id: "hid1" }, scope: "view" })).status).toBe(404);
      const hidden = libraryDb().prepare("SELECT COUNT(*) AS n FROM pieces WHERE id = 'pc_hid' AND label = 'Has hidden'").get() as { n: number };
      expect(hidden.n).toBe(1);
    } finally {
      resetLibrarySlots();
    }
  });
});

describe("library writes for a member with a grant", () => {
  it("a granted member can see the asset but every write is 404, the grant does not make a library member", async () => {
    const m = "member-w";
    expect((await call(m, "PATCH", "/api/library/lib_w/assets/gr1", { title: "Mine now" })).status).toBe(404);
    expect((await call(m, "POST", "/api/library/lib_w/assets/gr1/jobs", { kinds: ["describe"] })).status).toBe(404);
    expect((await call(m, "POST", "/api/library/lib_w/shares", { target: { kind: "asset", id: "gr1" }, scope: "view" })).status).toBe(404);
    expect((await call(m, "POST", "/api/library/lib_w/collections/col_g/items", { assetIds: ["vis1"] })).status).toBe(404);
    expect((await call(m, "DELETE", "/api/library/lib_w/assets/gr1")).status).toBe(404);
    expect((await call(m, "POST", "/api/library/lib_w/pieces", { label: "Mine" })).status).toBe(404);
    expect((await call(m, "POST", "/api/library/lib_w/pieces/pc_vis/items", { versionId: "gr1-v1" })).status).toBe(404);
    expect((await call(m, "PATCH", "/api/library/lib_w/pieces/pc_vis", { label: "Mine" })).status).toBe(404);
    expect(titleOf("gr1")).toBe("Granted to a member");
    expect(sharesOf(m)).toBe(0);
  });
});
