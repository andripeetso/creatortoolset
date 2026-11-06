import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
