import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Through the real gate (api/boot.ts): a share link is public, the rest of the library is not.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-gate-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "library-gate-test-secret";
const { libraryDb } = await import("./db");
const app = (await import("../boot")).default;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "Tiny_Acrobatics_link22"; // 22 characters, base64url: the shape the server makes

// one library, one asset and one view link, straight into the database
{
  const d = libraryDb();
  // the creator owns the library: a link shows only what its creator may still see (shares.ts)
  d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_g', 'owner-g', 'G', 'local', 0)").run();
  d.prepare(
    "INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES ('g1', 'lib_g', 'video', 'Shared clip', 'g1-v1', 'owner-g', 1)",
  ).run();
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES ('g1-v1', 'g1', 1, 'libraries/lib_g/v/g1-v1/source', 1, 'h', 'ready', 'owner-g', 1)",
  ).run();
  d.prepare(
    "INSERT INTO shares (token_hash, library_id, target_kind, target_id, scope, created_by, expires_at, views) VALUES (?, 'lib_g', 'asset', 'g1', 'view', 'owner-g', ?, 0)",
  ).run(createHash("sha256").update(TOKEN).digest("hex"), Date.now() + 86_400_000);
}

describe("library share links through the account gate", () => {
  it("the shared view is public, with no account and no cookie", async () => {
    const res = await app.request(`/api/library/s/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ locked: false, name: "Shared clip", items: [{ id: "g1" }] });
  });

  it("the old /fs/<token> link redirects to the same link page, token unchanged", async () => {
    const res = await app.request(`/fs/${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(`/library/s/${TOKEN}`);
    expect((await app.request("/fs/not-a-token")).status).toBe(404);
  });

  it("an unknown link is a 404 from the share route, not a sign-in prompt", async () => {
    expect((await app.request("/api/library/s/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });

  it("the rest of the library still needs an account", async () => {
    expect((await app.request("/api/library/lib_g/assets")).status).toBe(401);
    expect((await app.request("/api/library/lib_g/shares")).status).toBe(401);
    expect((await app.request(`/api/library/s/${TOKEN}/media/g1-v1/source`)).status).toBe(404); // scope is view
  });
});
