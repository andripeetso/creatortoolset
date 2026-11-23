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

  it("narrows to vertical or horizontal clips as shown, after the file's rotation and the library's turn", () => {
    const db = seed();
    const probe = (v: string, p: object) => db.prepare("UPDATE asset_versions SET probe = ? WHERE id = ?").run(JSON.stringify(p), v);
    probe("v_a1", { width: 1920, height: 1080, rotation: 90 }); // a phone's tall clip, stored on its side
    probe("v_a2", { width: 1920, height: 1080, rotation: 90, turn: 90 }); // turned back to wide
    probe("v_a3", { width: 0, height: 0, rotation: 0 }); // sound: neither
    expect(ids(page(db, "lib_a", { orientation: "vertical" }))).toEqual(["a1"]);
    expect(ids(page(db, "lib_a", { orientation: "horizontal" }))).toEqual(["a2"]);
    expect(ids(page(db, "lib_a", { orientation: "sideways" }))).toEqual(["a3", "a2", "a1"]);
  });

  it("says which clips are read in place from a computer's folder (Show in Finder), and leaves finished work out", () => {
    const db = seed();
    db.prepare("UPDATE asset_versions SET source_path = '/Users/someone/Footage/beach.mov' WHERE id = 'v_a1'").run();
    db.prepare("UPDATE assets SET filed_roll = 'none' WHERE id = 'a3'").run();
    const cards = page(db, "lib_a").items as { id: string; onComputer?: true }[];
    expect(cards.map((c) => [c.id, !!c.onComputer])).toEqual([["a2", false], ["a1", true]]);
    expect(JSON.stringify(cards)).not.toContain("/Users/someone"); // never the path itself
    // sent from a Mac and kept on the server: still on that Mac
    db.prepare("UPDATE asset_versions SET from_path = '/Users/someone/Desktop/jump.mp4' WHERE id = 'v_a2'").run();
    expect((page(db, "lib_a").items as { id: string; onComputer?: true }[]).map((c) => [c.id, !!c.onComputer])).toEqual([["a2", true], ["a1", true]]);
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

describe("library asset query, sorted by the server", () => {
  // five clips: a tie on the time added, a tie on length, a name with a colon, a picture (no length), one never read (no probe)
  function sorted(): DatabaseSync {
    const db = openLibraryDb(":memory:");
    db.exec("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', 'ws_s', 'S', 'local', 0)");
    const add = (id: string, kind: string, title: string, at: number, probe: object | null, bytes = 1) => {
      db.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib_s', ?, ?, ?, 'owner', ?)").run(id, kind, title, `v_${id}`, at);
      db.prepare(
        "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, state, probe, created_by, created_at) VALUES (?, ?, 1, 'k', ?, 'h', 'ready', ?, 'owner', ?)",
      ).run(`v_${id}`, id, bytes, probe ? JSON.stringify(probe) : null, at);
    };
    add("c1", "video", "beach: morning", 1000, { duration: 30, capturedAt: 700_000_000_000 }, 300);
    add("c2", "video", "Apple orchard", 2000, { duration: 10 }, 100);
    add("c3", "video", "cliff walk", 2000, { duration: 30, capturedAt: 1_700_000_000_000 }, 300);
    add("c4", "image", "Dune", 3000, { duration: 0, capturedAt: 500 }, 50);
    add("c5", "video", "attic", 4000, null, 200);
    // c2 has no filming date in the file: Date filmed takes its modified time on a computer, not when it was added
    db.prepare("INSERT INTO version_places (version_id, device, path, mtime) VALUES ('v_c2', 'mac1', '/c2.mov', 1600000000000)").run();
    // c4's camera had no clock set (1970): no date; the modified time it was uploaded with is
    db.prepare("UPDATE asset_versions SET modified_at = 1650000000000 WHERE id = 'v_c4'").run();
    return db;
  }
  /** every page at one clip a page, walked by cursor */
  const walk = (sort: string) => {
    const db = sorted();
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const p = page(db, "lib_s", { sort, limit: "1", ...(cursor ? { cursor } : {}) });
      out.push(...ids(p));
      cursor = p.next;
    } while (cursor && out.length < 10);
    return out;
  };

  it.each([
    ["new", ["c5", "c4", "c3", "c2", "c1"]],
    ["old", ["c1", "c2", "c3", "c4", "c5"]],
    ["name", ["c2", "c5", "c1", "c3", "c4"]],
    ["longest", ["c3", "c1", "c2", "c5", "c4"]],
    ["shortest", ["c2", "c1", "c3", "c4", "c5"]],
    ["filmed", ["c3", "c4", "c2", "c1", "c5"]],
    // the list's Size and Kind columns (11-19)
    ["biggest", ["c3", "c1", "c5", "c2", "c4"]],
    ["smallest", ["c4", "c2", "c5", "c1", "c3"]],
    ["kind", ["c4", "c1", "c2", "c3", "c5"]],
    ["kind-za", ["c5", "c3", "c2", "c1", "c4"]],
  ])("%s: one page at a time gives the same order as one big page, nothing skipped or repeated", (sort, order) => {
    expect(ids(page(sorted(), "lib_s", { sort }))).toEqual(order);
    expect(walk(sort)).toEqual(order);
  });

  it("a card carries when it was added and its file's size, for the list's columns", () => {
    const c1 = page(sorted(), "lib_s", { sort: "old" }).items[0]!;
    expect({ id: c1.id, addedAt: c1.addedAt, bytes: c1.bytes }).toEqual({ id: "c1", addedAt: 1000, bytes: 300 });
  });

  it("an unknown order is newest first", () => {
    expect(parseSearch({ sort: "best" }).sort).toBeUndefined();
    expect(ids(page(sorted(), "lib_s", { sort: "best" }))).toEqual(["c5", "c4", "c3", "c2", "c1"]);
  });
});
