import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import type { AssetCard, AssetDetail } from "../../contracts/library";

// Show in Finder on a server elsewhere, through the routes the page and the Mac app call: the list marks the card
// "here" from the asking computer's place row, and the clip's detail gives that computer's path to its own person only.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-reveal-"));
process.env.DATA_DIR = dir;
delete process.env.CT_LOCAL;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// the owner's one workspace (a Workshop project), which she gave the member (Settings → Team → Access)
const BRAND = "bbbbbbbb-0000-4000-8000-000000000001";
mkdirSync(path.join(dir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dir, "workshop", "projects", `${BRAND}.json`), JSON.stringify({ id: BRAND, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));
const member = (username: string, role = "member") => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: 0, ...(role === "member" ? { workspaces: [BRAND] } : {}) });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [{ id: "t", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [member("ana", "owner"), member("bo")] }], invites: [], spend: {} }),
);

const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { searchApp } = await import("./search");
const { pairDevice } = await import("../lib/devices");
const { inRequestWorkspace } = await import("../lib/workspace-scope");

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  const username = c.req.header("x-test-user") ?? "";
  c.set("user", { username, role: username === "ana" ? "admin" : "user", off: [], read: [] } as never);
  return next();
});
app.use(inRequestWorkspace);
app.route("/api/library", libraryApp);
app.route("/api/library", searchApp);
const get = async <T>(user: string, url: string) => {
  const res = await app.request(url, { headers: { "x-test-user": user } });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 't', 'Tiny', 'local', 0)").run();
// uploaded by the member: kept on the server's store, no source_path or mac_path
d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('ast_jump', 'lib_t', 'video', 'Tiny jump', 'ver_jump', 'bo', 0)").run();
d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('ver_jump', 'ast_jump', 1, 'libraries/lib_t/v/ver_jump/source', 10, 'h', 'ready', 'bo', 0)").run();
const anaMac = pairDevice("ana", "Tiny Studio Mac").device.id;
const boMac = pairDevice("bo", "Tiny Laptop").device.id;
const file = "/Volumes/Tiny Footage/jump.MP4";
d.prepare("INSERT INTO version_places (version_id, device, kind, path, state, confirmed_at) VALUES ('ver_jump', ?, 'original', ?, 'found', ?)").run(boMac, file, Date.now());

const card = async (user: string, device: string) =>
  (await get<{ items: AssetCard[] }>(user, `/api/library/lib_t/assets?device=${device}`)).items.find((c) => c.id === "ast_jump");
const detail = (user: string, query = "") => get<AssetDetail>(user, `/api/library/lib_t/assets/ast_jump${query}`);

it("a member's Show in Finder: the card is here on their computer, and its detail gives that computer's path to them only", async () => {
  expect((await card("bo", boMac))?.placeWord?.word).toBe("here"); // (a)
  expect((await detail("bo", `?device=${boMac}`)).sourcePath).toBe(file); // (b)
  expect((await detail("bo", `?device=${anaMac}`)).sourcePath).toBeUndefined(); // (c) another person's computer
  expect((await detail("bo")).sourcePath).toBeUndefined(); // (d) no computer named
  expect((await card("ana", anaMac))?.placeWord?.word).not.toBe("here"); // (e) the admin's Mac has no place for it
  expect((await detail("ana", `?device=${anaMac}`)).sourcePath).toBeUndefined();
});
