import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SFX_TYPES } from "../../contracts/sfx";
import { sfxTypeOf, tagSoundType } from "./sfx-type";

describe("sfxTypeOf", () => {
  it("reads the type from a word in the name", () => {
    expect(sfxTypeOf("Whoosh fast.wav", 0.8)).toBe("whoosh");
    expect(sfxTypeOf("impactPunch_heavy_000.m4a", 0.4)).toBe("hit");
    expect(sfxTypeOf("Door Close", 1.2)).toBe("transition");
    expect(sfxTypeOf("keyboardTyping2", 3)).toBe("typing");
    expect(sfxTypeOf("Notification chime", 0.9)).toBe("notification");
  });

  it("matches a longer type word as the start of a word, but a 3-letter one only as a whole word", () => {
    expect(sfxTypeOf("clicks_round", 2)).toBe("click");
    expect(sfxTypeOf("tap", 2)).toBe("click");
    expect(sfxTypeOf("tapestry", 5)).toBeNull();
  });

  it("falls back to the length when no word names a type", () => {
    expect(sfxTypeOf("untitled", 0.2)).toBe("click");
    expect(sfxTypeOf("untitled", 0.7)).toBe("pop");
    expect(sfxTypeOf("untitled", 5)).toBeNull();
  });

  it("only ever returns one of the shared type tags", () => {
    for (const name of ["whoosh", "x", "glitch zap", "camera flash", "book page", "error"]) {
      const t = sfxTypeOf(name, 0.5);
      expect(t === null || (SFX_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });
});

describe("tagSoundType", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE assets (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE asset_versions (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL);
    CREATE TABLE asset_tags (asset_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY (asset_id, tag));
    INSERT INTO assets VALUES ('a1', 'Whoosh'), ('a2', 'Plain'), ('a3', 'Whoosh');
    INSERT INTO asset_versions VALUES ('v1', 'a1'), ('v2', 'a2'), ('v3', 'a3');
    INSERT INTO asset_tags VALUES ('a1', 'sound effect', 'user'), ('a2', 'sound effect', 'user'), ('a3', 'sound effect', 'user'), ('a3', 'pop', 'user');
  `);
  const tags = (id: string) => (db.prepare("SELECT tag FROM asset_tags WHERE asset_id = ? ORDER BY tag").all(id) as { tag: string }[]).map((t) => t.tag);

  it("tags a sound effect with the type its name gives", () => {
    tagSoundType(db, "v1", "Whoosh", 0.8);
    expect(tags("a1")).toEqual(["sound effect", "whoosh"]);
  });

  it("leaves a type the user already set alone, and never tags a file that is not a sound effect", () => {
    tagSoundType(db, "v3", "Whoosh", 0.8);
    expect(tags("a3")).toEqual(["pop", "sound effect"]);
    db.prepare("DELETE FROM asset_tags WHERE asset_id = 'a2' AND tag = 'sound effect'").run();
    tagSoundType(db, "v2", "Plain", 0.1);
    expect(tags("a2")).toEqual([]);
  });
});
