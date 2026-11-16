import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { pictureHash, samePicture } from "./look";
import { MIGRATIONS } from "./schema";
import { stretchesOf } from "./stretches";

describe("picture hash", () => {
  const frame = (f: (x: number, y: number) => number) => Uint8Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));
  it("the same picture, a little brighter, is the same; another picture is not", () => {
    const a = frame((x, y) => (x * 23 + y * 7) % 251);
    const brighter = frame((x, y) => Math.min(255, ((x * 23 + y * 7) % 251) + 3));
    const other = frame((x, y) => (x * 61 + y * 97 + 13) % 241);
    expect(samePicture(pictureHash(a), pictureHash(brighter))).toBe(true);
    expect(samePicture(pictureHash(a), pictureHash(other))).toBe(false);
  });
  it("an empty or broken hash is never the same", () => {
    expect(samePicture("", "")).toBe(false);
    expect(samePicture("zz", "0000000000000000")).toBe(false);
  });
});

describe("stretchesOf", () => {
  it("reads in order, and the person's own line wins", () => {
    const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
    mkdirSync(scratch, { recursive: true });
    const db = new DatabaseSync(path.join(mkdtempSync(path.join(scratch, "stretches-")), "l.db"));
    db.exec("PRAGMA foreign_keys = OFF");
    for (const m of MIGRATIONS) db.exec(m);
    const add = db.prepare("INSERT INTO stretches (version_id, seg, a, b, motion, action, clear, tags, text, ph, source, stamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)");
    add.run("v1", 1, 6, 12, 0.9, 5, 1, '["fight","boss"]', "a boss fight", "00ff00ff00ff00ff", "ai", "s1");
    add.run("v1", 0, 0, 6, 0.1, 0, 0, '["menu"]', "character select", "ffffffffffffffff", "ai", "s1");
    add.run("v1", 0, 0, 6, 0.1, 0, 0, "[]", "his own line", null, "user", null);
    const got = stretchesOf(db, "v1");
    expect(got.map((s) => [s.seg, s.text, s.source])).toEqual([
      [0, "his own line", "user"],
      [1, "a boss fight", "ai"],
    ]);
    expect(got[1]).toMatchObject({ action: 5, clear: true, tags: ["fight", "boss"], stamp: "s1" });
  });
});
