import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { savedQuery } from "./collections";
import { openLibraryDb } from "./db";
import { buildAssetQuery, filterClauses, indexAsset, pageOf, parseSearch, type CardRow } from "./query";

// The library's own filters (src/pages/library/Filters.tsx): every tag picked, when a clip was filmed.
const DAY = 86_400_000;
function seed(): DatabaseSync {
  const db = openLibraryDb(":memory:");
  db.exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0)");
  const asset = (id: string, addedAt: number, probe: object | null, tags: string[]) => {
    db.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_a', 'video', ?, ?, 'owner', ?)").run(
      id,
      `Clip ${id}`,
      `v_${id}`,
      addedAt,
    );
    db.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, probe, created_by, created_at) VALUES (?, ?, 1, 'k', 1, 'h', 'ready', ?, 'owner', ?)",
    ).run(`v_${id}`, id, probe ? JSON.stringify(probe) : null, addedAt);
    for (const t of tags) db.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'user')").run(id, t);
    indexAsset(db, id);
  };
  // c1 filmed on day 1, added day 30; c2 has no filming time, added day 10; c3 filmed day 20, added day 40
  asset("c1", 30 * DAY, { duration: 1, capturedAt: 1 * DAY }, ["beach", "sunset"]);
  asset("c2", 10 * DAY, { duration: 1 }, ["beach"]);
  asset("c3", 40 * DAY, { duration: 1, capturedAt: 20 * DAY }, ["sunset"]);
  return db;
}
const ids = (db: DatabaseSync, p: Record<string, string>) => {
  const { sql, params, limit } = buildAssetQuery("lib_a", parseSearch(p));
  return pageOf(db.prepare(sql).all(...params) as unknown as CardRow[], limit).items.map((a) => a.id);
};

describe("library filters", () => {
  it("several tags: clips with all of them", () => {
    const db = seed();
    expect(ids(db, { tag: "beach" })).toEqual(["c1", "c2"]);
    expect(ids(db, { tag: "beach,sunset" })).toEqual(["c1"]);
    expect(ids(db, { tag: "beach, nope" })).toEqual([]);
    expect(parseSearch({ tag: "a,,a, b" }).tags).toEqual(["a", "b"]);
  });

  it("when it was filmed, else when it was added", () => {
    const db = seed();
    expect(ids(db, { filmedFrom: String(5 * DAY) })).toEqual(["c3", "c2"]); // c1 was filmed on day 1, though added on day 30
    expect(ids(db, { filmedTo: String(15 * DAY) })).toEqual(["c1", "c2"]);
    expect(ids(db, { filmedFrom: String(15 * DAY), filmedTo: String(25 * DAY) })).toEqual(["c3"]);
    // from/to still mean when it was added
    expect(ids(db, { from: String(25 * DAY) })).toEqual(["c3", "c1"]);
  });

  it("narrows a search the same way, through the asset alone", () => {
    const db = seed();
    const where = filterClauses(parseSearch({ tag: "sunset", filmedFrom: String(10 * DAY) }));
    const rows = db
      .prepare(`SELECT a.id FROM assets a WHERE ${where.map((w) => w.sql).join(" AND ")}`)
      .all(...where.flatMap((w) => w.params)) as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(["c3"]);
  });

  it("keeps them in a saved search", () => {
    const q = savedQuery({ q: "x", tags: ["beach", 3], filmedFrom: 5, filmedTo: "no" });
    expect(q).toEqual({ q: "x", tags: ["beach"], filmedFrom: 5 });
  });
});
