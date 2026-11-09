import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Per-collection grants: a member sees an asset only through a collection the owner granted them; default deny.
const dir = mkdtempSync(path.join(tmpdir(), "library-grants-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { grantsApp, forgetGrants, grantedTo } = await import("./grants");
const { assetRef, canSee } = await import("./sources");
const { createUser } = await import("../users");

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", grantsApp);

const call = (user: string, method: string, url: string): Promise<Response> =>
  Promise.resolve(app.request(url, { method, headers: { "x-user": user } }));

const member = { username: "member-b", role: "member" as const };
const owner = { username: "owner-a", role: "owner" as const };

beforeAll(() => {
  const d = libraryDb();
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0)").run();
  for (const id of ["finals-1", "plain-1"]) {
    d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'owner-a', 0)").run(id, id, `${id}-v1`);
    d.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'video/mp4', 'ready', 'owner-a', 0)",
    ).run(`${id}-v1`, id, `h-${id}`);
  }
  d.prepare("INSERT INTO collections (id, library_id, parent_id, name, kind, created_at) VALUES ('col_finals', 'lib_a', NULL, 'Finals', 'manual', 0)").run();
  d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_finals', 'finals-1', 1, 'owner-a')").run();
  createUser("member-b", "secret1", { role: "team" });
});

describe("per-collection grants", () => {
  it("a member sees nothing by default", async () => {
    expect(await canSee(member, assetRef("lib_a", "finals-1", "finals-1-v1"))).toBe(false);
    expect(await canSee(member, assetRef("lib_a", "plain-1", "plain-1-v1"))).toBe(false);
  });

  it("only the library's owner grants a collection", async () => {
    expect((await call("member-b", "PUT", "/api/library/collections/col_finals/grants/member-b")).status).toBe(404);
    expect(grantedTo("member-b", "finals-1")).toBe(false);
  });

  it("a grant shows the collection's assets to the member and no others", async () => {
    const put = await call("owner-a", "PUT", "/api/library/collections/col_finals/grants/member-b");
    expect(put.status).toBe(200);
    expect(((await put.json()) as { grants: string[] }).grants).toEqual(["member-b"]);

    expect(await canSee(member, assetRef("lib_a", "finals-1", "finals-1-v1"))).toBe(true);
    expect(await canSee(member, assetRef("lib_a", "plain-1", "plain-1-v1"))).toBe(false);
    expect(await canSee(owner, assetRef("lib_a", "plain-1", "plain-1-v1"))).toBe(true);
  });

  it("revoking takes it back, and a deleted account's grants go", async () => {
    const del = await call("owner-a", "DELETE", "/api/library/collections/col_finals/grants/member-b");
    expect(((await del.json()) as { grants: string[] }).grants).toEqual([]);
    expect(await canSee(member, assetRef("lib_a", "finals-1", "finals-1-v1"))).toBe(false);

    await call("owner-a", "PUT", "/api/library/collections/col_finals/grants/member-b");
    forgetGrants("member-b");
    expect(grantedTo("member-b", "finals-1")).toBe(false);
  });
});
