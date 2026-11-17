import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Every sound is music or a sound effect (sound-kind.ts): the person's tag, then a song, the folders, the length, and a
// listen only for what is left unclear.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-sound-kind-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { backfillSoundKinds, settleSoundKind, soundKindOf } = await import("./sound-kind");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const d = libraryDb();
d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib', 'tiny', 'Tiny Acrobatics', 'local', 0)").run();
/** An audio asset `id` (version `v-<id>`) from `from`, `seconds` long, with these tags. */
function sound(id: string, from: string, seconds: number, tags: [string, string][] = []) {
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, 'lib', 'audio', ?, ?, 'local', 1)").run(id, id, `v-${id}`);
  d.prepare(
    "INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, from_path) VALUES (?, ?, 1, 'k', 1, ?, ?, 'ready', 'local', 1, ?)",
  ).run(`v-${id}`, id, `sha-${id}`, JSON.stringify({ duration: seconds }), from);
  for (const [tag, source] of tags) d.prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, ?, ?)").run(id, tag, source);
}
const tags = (id: string) => d.prepare("SELECT tag, source FROM asset_tags WHERE asset_id = ? ORDER BY tag").all(id);

describe("soundKindOf", () => {
  it("a folder word beats the length, the nearest folder first; a song beats the folders", () => {
    expect(soundKindOf({ paths: ["/Users/tiny/Packs/SFX/long rain.wav"], seconds: 300 })).toBe("effect");
    expect(soundKindOf({ paths: ["/Users/tiny/MUSIC/sting.wav"], seconds: 2 })).toBe("music");
    expect(soundKindOf({ paths: ["/Users/tiny/Music/SoundFX/x.wav"], seconds: 60 })).toBe("effect");
    expect(soundKindOf({ paths: ["/Users/tiny/Sound effects/x.wav"], seconds: 60, song: true })).toBe("music");
  });
  it("the length decides only when it is clear", () => {
    expect([2, 60, 300].map((s) => soundKindOf({ paths: ["/Users/tiny/Downloads/x.wav"], seconds: s }))).toEqual(["effect", null, null]); // a long one can be a voice recording: only a listen tells
  });
});

describe("settleSoundKind", () => {
  it("a user tag beats everything and nothing is asked", async () => {
    sound("mine", "/Users/tiny/SFX/x.wav", 45, [["music", "user"]]);
    const listen = vi.fn();
    expect(await settleSoundKind(d, "v-mine", { song: false, seconds: 45, listen })).toBe("music");
    expect(listen).not.toHaveBeenCalled();
    expect(tags("mine")).toEqual([{ tag: "music", source: "user" }]);
  });

  it("listens only to what the rules leave unclear; with no listen the length decides", async () => {
    sound("pop", "/Users/tiny/Downloads/pop.wav", 2);
    sound("mid", "/Users/tiny/Downloads/mid.wav", 45);
    sound("mid2", "/Users/tiny/Downloads/mid2.wav", 45);
    const listen = vi.fn(async () => "effect" as const);
    expect(await settleSoundKind(d, "v-pop", { song: false, seconds: 2, listen })).toBe("effect");
    expect(listen).not.toHaveBeenCalled();
    expect(await settleSoundKind(d, "v-mid", { song: false, seconds: 45, listen })).toBe("effect");
    expect(listen).toHaveBeenCalledTimes(1);
    expect(tags("mid")).toEqual([{ tag: "sound effect", source: "ai" }]);
    expect(await settleSoundKind(d, "v-mid2", { song: false, seconds: 45 })).toBe("music");
  });

  it("someone talking gets neither tag, and the backfill leaves it alone", async () => {
    sound("talk", "/Users/tiny/Downloads/memo.m4a", 45);
    sound("old", "/Users/tiny/Foley/door.wav", 45);
    expect(await settleSoundKind(d, "v-talk", { song: false, seconds: 45, listen: async () => "speech" })).toBeNull();
    expect(await backfillSoundKinds(d)).toBe(true);
    expect(await backfillSoundKinds(d)).toBe(false);
    expect([tags("talk"), tags("old")]).toEqual([[], [{ tag: "sound effect", source: "ai" }]]);
  });
});
