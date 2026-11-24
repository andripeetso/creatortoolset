import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { openLibraryDb } from "./db";
import { MIGRATIONS } from "./schema";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-schema-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const version = (db: ReturnType<typeof openLibraryDb>) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;

describe("library schema", () => {
  it("runs the migrations, and opening the database again is a no-op", () => {
    const file = path.join(dir, "library.db");
    const db = openLibraryDb(file);
    expect(version(db)).toBe(MIGRATIONS.length);
    db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, ?, ?)").run("lib_1", "ws_1", "Library", "local", 1);
    db.close();

    const again = openLibraryDb(file); // a second run must not re-create tables (that would throw) or drop rows
    expect(version(again)).toBe(MIGRATIONS.length);
    expect(again.prepare("SELECT COUNT(*) AS n FROM libraries").get()).toEqual({ n: 1 });
    again.close();
  });

  it("a database already at the shoot folders' step (batch 4) gets the strip size columns on the next boot, its rows kept", () => {
    const file = path.join(dir, "at-shoots.db");
    const shoots = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN shoot"));
    const strips = MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN cell_w"));
    // the strip sizes come after the shoot folders, never before them (a server that ran batch 4 must still run them)
    expect(shoots).toBeGreaterThan(0);
    expect(strips).toBeGreaterThan(shoots);
    // a database as batch 4 left it: every step up to and including the shoot folders, none after
    const old = new DatabaseSync(file);
    old.exec("PRAGMA foreign_keys = OFF;");
    for (let i = 0; i <= shoots; i++) old.exec(MIGRATIONS[i]!);
    old.exec(`PRAGMA user_version = ${shoots + 1}`);
    old.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, ?, ?)").run("lib_b4", "ws_1", "Library", "local", 1);
    const columns = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(derivatives)").all() as { name: string }[]).map((c) => c.name);
    expect(columns(old)).not.toContain("cell_w");
    old.close();

    const db = openLibraryDb(file);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(columns(db)).toEqual(expect.arrayContaining(["cell_w", "cell_h"]));
    expect(db.prepare("SELECT COUNT(*) AS n FROM libraries").get()).toEqual({ n: 1 });
    db.close();
  });

  it("the stopped step rebuilds jobs: every row and column kept, Stop's old failed rows stopped, the numbering carried on", () => {
    const file = path.join(dir, "before-stopped.db");
    const at = MIGRATIONS.findIndex((m) => m.includes("CREATE TABLE jobs_new"));
    expect(at).toBeGreaterThan(0);
    const old = new DatabaseSync(file);
    old.exec("PRAGMA foreign_keys = OFF;");
    for (let i = 0; i < at; i++) old.exec(MIGRATIONS[i]!);
    old.exec(`PRAGMA user_version = ${at}`);
    const add = old.prepare("INSERT INTO jobs (id, library_id, version_id, kind, state, error, held_by, done_at) VALUES (?, 'lib', ?, 'describe', ?, ?, ?, ?)");
    add.run(1, "v1", "failed", "Stopped", null, null);
    add.run(2, "v2", "failed", "Could not read the file", null, null);
    add.run(3, "v3", "done", null, "mac-1", 9);
    add.run(9, "v9", "queued", null, null, null);
    old.exec("DELETE FROM jobs WHERE id = 9"); // the highest id gone: it is never given again
    expect(() => add.run(4, "v4", "stopped", null, null, null)).toThrow();
    old.close();

    const db = openLibraryDb(file);
    expect(db.prepare("SELECT id, state, error, held_by, done_at FROM jobs ORDER BY id").all()).toEqual([
      { id: 1, state: "stopped", error: null, held_by: null, done_at: null },
      { id: 2, state: "failed", error: "Could not read the file", held_by: null, done_at: null },
      { id: 3, state: "done", error: null, held_by: "mac-1", done_at: 9 },
    ]);
    db.prepare("INSERT INTO jobs (library_id, version_id, kind, state) VALUES ('lib', 'v5', 'describe', 'stopped')").run();
    expect(db.prepare("SELECT MAX(id) AS id FROM jobs").get()).toEqual({ id: 10 });
    db.close();
  });

  it("migration 5 allows bunny storage, and still refuses unknown kinds", () => {
    const db = openLibraryDb(path.join(dir, "bunny.db"));
    const insert = db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES (?, ?, ?, ?, ?)");
    expect(() => insert.run("lib_b", "ws_1", "Library", "bunny", 1)).not.toThrow();
    expect(() => insert.run("lib_f", "ws_1", "Library", "ftp", 1)).toThrow();
    db.close();
  });

  it("migration 3 allows only local and s3 storage and keeps the libraries and the rows that point at them", () => {
    const file = path.join(dir, "old.db");
    const old = new DatabaseSync(file); // a database from before migration 3
    old.exec("PRAGMA foreign_keys = ON");
    for (const m of MIGRATIONS.slice(0, 2)) old.exec(m);
    old.exec("PRAGMA user_version = 2");
    old.exec(`INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_1', 'ws_1', 'Tiny Acrobatics', 'local', 1);
      INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_1', 'lib_1', 'video', 'Roll', 'u', 1);
      INSERT INTO collections (id, library_id, name, kind, created_at) VALUES ('col_1', 'lib_1', 'Finals', 'manual', 1);`);
    old.close();

    const db = openLibraryDb(file);
    expect(version(db)).toBe(MIGRATIONS.length);
    expect(db.prepare("SELECT id, name FROM libraries").all()).toEqual([{ id: "lib_1", name: "Tiny Acrobatics" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_2', 'w', 'x', 'ftp', 1)").run()).toThrow();
    // the assets' foreign key now points at the rebuilt table
    expect(() => db.prepare("INSERT INTO assets (id, library_id, kind, title, created_by, created_at) VALUES ('ast_2', 'lib_none', 'video', 'x', 'u', 1)").run()).toThrow();
    db.close();
  });
});
