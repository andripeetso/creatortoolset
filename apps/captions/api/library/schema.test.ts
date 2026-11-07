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
