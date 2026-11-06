import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { openLibraryDb } from "./db";
import { buildAssetQuery, ftsQuery, indexAsset, pageOf, parseSearch, type CardRow } from "./query";

// Seeded in memory: three assets in one library, one in another, one tagged.
function seed(): DatabaseSync {
  const db = openLibraryDb(":memory:");
  db.exec(
    "INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'ws_a', 'A', 'local', 0), ('lib_b', 'ws_b', 'B', 'local', 0)",
  );
  const asset = (id: string, library: string, kind: string, title: string, at: number) => {
    db.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)").run(
      id,
      library,
      kind,
      title,
      `v_${id}`,
      at,
    );
    db.prepare(
      "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, 'h', 'ready', 'owner', ?)",
    ).run(`v_${id}`, id, at);
    indexAsset(db, id);
  };
  asset("a1", "lib_a", "video", "Beach walk", 1000);
  asset("a2", "lib_a", "video", "Kitchen tour", 2000);
  asset("a3", "lib_a", "audio", "Voice memo beach", 3000);
  asset("a4", "lib_b", "video", "Beach in another workspace", 4000);
  db.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES ('a2', 'cooking', 'user')").run();
  indexAsset(db, "a2");
  return db;
}

const page = (db: DatabaseSync, library: string, query: Parameters<typeof parseSearch>[0] = {}) => {
  const { sql, params, limit } = buildAssetQuery(library, parseSearch(query));
  return pageOf(db.prepare(sql).all(...params) as unknown as CardRow[], limit);
};
const ids = (p: { items: { id: string }[] }) => p.items.map((a) => a.id);

describe("library asset query", () => {
  it("lists only the library's assets, newest first", () => {
    expect(ids(page(seed(), "lib_a"))).toEqual(["a3", "a2", "a1"]);
  });

  it("filters by kind", () => {
    expect(ids(page(seed(), "lib_a", { kind: "audio" }))).toEqual(["a3"]);
  });

  it("matches a title word, as a prefix", () => {
    const db = seed();
    expect(ids(page(db, "lib_a", { q: "beach" }))).toEqual(["a3", "a1"]);
    expect(ids(page(db, "lib_a", { q: "kitch" }))).toEqual(["a2"]);
  });

  it("matches a tag", () => {
    expect(ids(page(seed(), "lib_a", { q: "cooking" }))).toEqual(["a2"]);
  });

  it("keeps punctuation in the search text from breaking the match", () => {
    expect(() => page(seed(), "lib_a", { q: 'beach " - : (' })).not.toThrow();
    expect(ftsQuery('say "hi"')).toBe('"say"* """hi"""*');
  });

  it("pages by cursor with no overlap, and says when there is no next page", () => {
    const db = seed();
    const first = page(db, "lib_a", { limit: "1" });
    const second = page(db, "lib_a", { limit: "1", cursor: first.next });
    const third = page(db, "lib_a", { limit: "1", cursor: second.next });
    expect([ids(first), ids(second), ids(third)]).toEqual([["a3"], ["a2"], ["a1"]]);
    expect(third.next).toBeUndefined();
  });

  it("clamps the limit to 1..200 and defaults to 60", () => {
    expect(parseSearch({ limit: "5000" }).limit).toBe(200);
    expect(parseSearch({ limit: "0" }).limit).toBe(1);
    expect(parseSearch({}).limit).toBe(60);
  });

  it("filters by creation time and leaves out trashed assets", () => {
    const db = seed();
    expect(ids(page(db, "lib_a", { from: "1500", to: "2500" }))).toEqual(["a2"]);
    db.prepare("UPDATE assets SET trashed_at = 1 WHERE id = 'a2'").run();
    expect(ids(page(db, "lib_a"))).toEqual(["a3", "a1"]);
  });

  it("indexes an asset once however often it is reindexed", () => {
    const db = seed();
    indexAsset(db, "a1");
    indexAsset(db, "a1");
    expect(ids(page(db, "lib_a", { q: "walk" }))).toEqual(["a1"]);
  });
});
