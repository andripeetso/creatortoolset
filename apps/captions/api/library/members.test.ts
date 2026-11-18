import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import type { AssetCard, AssetDetail } from "../../contracts/library";
import type { GoneAnswer, PlacesReportAnswer } from "../../contracts/places";

// A member of a team library on their own computer, through the routes the page calls: Keep on this computer under
// Upload: Off once the owner's computer sent the team's proxies, and Connect originals… (a folder of their own copies).
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-members-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the owner's one workspace, which she gave the member (Settings → Team → Access)
const BRAND = "bbbbbbbb-0000-4000-8000-000000000002";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${BRAND}.json`), JSON.stringify({ id: BRAND, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
const member = (username: string, role = "member") => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0, ...(role === "member" ? { workspaces: [BRAND] } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [member("ana", "owner"), member("bo")] }], invites: [], spend: {} }),
);

const { createUser } = await import("../users");
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { searchApp } = await import("./search");
const { pairDevice } = await import("../lib/devices");
const { homeOf } = await import("./access");
const { inRequestWorkspace } = await import("../lib/workspace-scope");
createUser("ana", "password1", { role: "admin" });
createUser("bo", "password1", { role: "user" });

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  const username = c.req.header("x-test-user") ?? "";
  c.set("user", { username, role: username === "ana" ? "admin" : "user", off: [], read: [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", libraryApp);
app.route("/api/library", searchApp);
const call = (user: string, url: string, body?: unknown) =>
  app.request(url, body === undefined ? { headers: { "x-test-user": user } } : { method: "POST", headers: { "x-test-user": user, "content-type": "application/json" }, body: JSON.stringify(body) });

const QUICK = "a".repeat(64);
const d = libraryDb();
// Upload: Off (the default); the owner's clip is indexed on her Mac, its original there
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', ?, 'Tiny', 'local', 0)").run(homeOf("ana"));
const anaMac = pairDevice("ana", "Tiny Studio Mac").device.id;
const boMac = pairDevice("bo", "Tiny Laptop").device.id;
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_jump', 'lib_t', 'video', 'jump.MP4', 'ver_jump', 'ana', 0)").run();
d.prepare(
  "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at, mac_path, mac_device, quick) VALUES ('ver_jump', 'ast_jump', 1, 'mac:ver_jump', 10, 'h', 'ready', 'ana', 0, '/Users/ana/Movies/jump.MP4', ?, ?)",
).run(anaMac, QUICK);

it("a member keeps the library on their computer under Upload: Off once the team's proxies are on the server", async () => {
  const keep = () => call("bo", "/api/library/offline", { library: "lib_t", on: true });
  expect((await keep()).status).toBe(409); // no proxy on the server yet
  // the owner's computer sent the team's proxy (report.ts teamProxies)
  d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES ('ver_jump', 'proxy', 'p_jump', 4)").run();
  const on = await keep();
  expect(on.status).toBe(200);
  expect(((await on.json()) as { libraries?: string[] }).libraries).toEqual(["lib_t"]);
});

it("Connect originals… makes the member's copy of an uploaded clip this computer's own: the card is here, with that path", async () => {
  const gone = async (q: string) => ((await (await call("bo", `/api/library/lib_t/places/gone?device=${boMac}&away=1${q}`)).json()) as GoneAnswer).gone.map((g) => g.versionId);
  expect(await gone("")).toEqual([]); // never had a place on this computer: not gone, so Find missing files has nothing
  expect(await gone("&connect=1")).toEqual(["ver_jump"]);

  const file = "/Volumes/Tiny Office/Footage/jump.MP4";
  const res = await call("bo", "/api/library/lib_t/places", { device: boMac, confirmed: [{ versionId: "ver_jump", path: file, quick: QUICK }] });
  expect(((await res.json()) as PlacesReportAnswer).confirmed).toEqual(["ver_jump"]);

  const card = ((await (await call("bo", `/api/library/lib_t/assets?device=${boMac}`)).json()) as { items: AssetCard[] }).items.find((c) => c.id === "ast_jump");
  expect(card?.placeWord?.word).toBe("here");
  expect(((await (await call("bo", `/api/library/lib_t/assets/ast_jump?device=${boMac}`)).json()) as AssetDetail).sourcePath).toBe(file);
  expect(await gone("&connect=1")).toEqual([]); // connected: not offered again
});
