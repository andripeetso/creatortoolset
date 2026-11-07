import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-trash-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { purgeTrash } = await import("./trash");

afterAll(() => {
  delete process.env.LIBRARY_TRASH_DAYS;
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const blobFile = (key: string) => path.join(dir, "library", "blobs", ...key.split("/"));

/** An asset with one version, its source file, a thumb and the rows around it; trashed `daysAgo` days before `now`. */
function trashed(id: string, daysAgo: number, now: number) {
  const d = libraryDb();
  const v = `v_${id}`;
  const src = `libraries/lib_t/v/${v}/source`;
  const thumb = `libraries/lib_t/v/${v}/thumb.jpg`;
  for (const k of [src, thumb]) {
    mkdirSync(path.dirname(blobFile(k)), { recursive: true });
    writeFileSync(blobFile(k), "x");
  }
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, trashed_at) VALUES (?, 'lib_t', 'video', ?, ?, 'owner', 0, ?)").run(
    id, id, v, now - daysAgo * DAY,
  );
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, ?, 1, 'h', 'ready', 'owner', 0)").run(v, id, src);
  d.prepare("INSERT INTO derivatives (version_id, kind, storage_key, bytes) VALUES (?, 'thumb', ?, 1)").run(v, thumb);
  d.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib_t', ?, 'probe', 'done')").run(v);
  d.prepare("INSERT INTO collection_items (collection_id, asset_id, position, added_by) VALUES ('col_t', ?, 1, 'owner')").run(id);
  d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'beach', 'user')").run(id);
  d.prepare("INSERT INTO search_assets (asset_id, library_id, title, tags, description) VALUES (?, 'lib_t', ?, '', '')").run(id, id);
  d.prepare("INSERT INTO shares (token_hash, library_id, target_kind, target_id, scope, created_by, expires_at) VALUES (?, 'lib_t', 'asset', ?, 'view', 'owner', 0)").run(`h_${id}`, id);
  return { src, thumb };
}

describe("library trash purge", () => {
  it("deletes assets trashed longer than LIBRARY_TRASH_DAYS with their rows and files; newer trash stays", async () => {
    const d = libraryDb();
    const now = Date.now();
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_t', 'ws', 'T', 'local', 0)").run();
    d.prepare("INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_t', 'lib_t', 'F', 'manual', 0)").run();
    const old = trashed("ast_old", 15, now);
    const fresh = trashed("ast_fresh", 13, now);

    expect(await purgeTrash(now)).toBe(1);
    const left = (sql: string) => (d.prepare(sql).all() as { id: string }[]).map((r) => r.id);
    expect(left("SELECT id FROM assets")).toEqual(["ast_fresh"]);
    expect(left("SELECT version_id AS id FROM derivatives")).toEqual(["v_ast_fresh"]);
    expect(left("SELECT asset_id AS id FROM collection_items")).toEqual(["ast_fresh"]);
    expect(left("SELECT target_id AS id FROM shares")).toEqual(["ast_fresh"]);
    expect(left("SELECT asset_id AS id FROM search_assets")).toEqual(["ast_fresh"]);
    expect(existsSync(blobFile(old.src)) || existsSync(blobFile(old.thumb))).toBe(false);
    expect(existsSync(blobFile(fresh.src)) && existsSync(blobFile(fresh.thumb))).toBe(true);

    // a shorter setting reaches the newer one too
    process.env.LIBRARY_TRASH_DAYS = "7";
    expect(await purgeTrash(now)).toBe(1);
    expect(left("SELECT id FROM assets")).toEqual([]);
  });
});
