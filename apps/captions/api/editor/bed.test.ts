import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Item, Timeline, TimelineSource } from "../../contracts/editor";
import type { SfxSound } from "./sfx";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-bed-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "editor-bed-test-secret";
const { asksMusic, BED_DB, cutEnd, cutMoments, layBed, laySfx, laySound, MUSIC_NOTE, SFX_NOTE } = await import("./bed");
const { SFX_DB } = await import("./sfx");
const { emptyTracks } = await import("./timeline");
type EditMeta = import("./store").EditMeta;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FPS = 30;
const src = (id: string, durS: number, w = 1920, file?: string): TimelineSource => ({ versionId: id, name: id, fps: FPS, tc: 0, dur: Math.round(durS * FPS), w, h: w ? 1080 : 0, ...(file ? { file } : {}) });
const it_ = (s: string, rec: number, len: number): Item => ({ src: s, in: 0, rec, len });

/** A 20 s cut around speech: the speaker on V1 and A1, B-roll at 4-6 s and 6-8 s (one run), a card at 12 s, B-roll to the end. */
function cut(): Timeline {
  const tracks = emptyTracks();
  tracks.V1.items = [{ ...it_("rec", 0, 20 * FPS), link: "a" }];
  tracks.A1.items = [{ ...it_("rec", 0, 20 * FPS), link: "a" }];
  tracks.V2.items = [it_("b1", 4 * FPS, 2 * FPS), it_("b2", 6 * FPS + 1, 2 * FPS), it_("card", 12 * FPS, FPS), it_("b3", 17 * FPS, 3 * FPS)];
  return { name: "v1", fps: FPS, width: 1080, height: 1920, sources: { rec: src("rec", 30), b1: src("b1", 5), b2: src("b2", 5), b3: src("b3", 5), card: src("card", 1, 1080, "cards/v1/c1.mov") }, tracks, markers: [] };
}
const sound = (id: string, type: SfxSound["type"]): SfxSound => ({ type, src: src(id, 1.5, 0) });

describe("the sound of a cut around speech", () => {
  it("marks a B-roll run where it comes in and where it leaves, a card where it comes in, never the cut's start or end", () => {
    const tl = cut();
    expect(cutEnd(tl)).toBe(20 * FPS);
    const at = cutMoments(tl).map((m) => [Math.round(m.at * 100) / 100, m.types[0]]);
    // 4-8 s is one run (a frame apart); the last run ends at the cut's end, so it has no leaving whoosh
    expect(at).toEqual([[4, "whoosh"], [8.03, "whoosh"], [12, "pop"], [17, "whoosh"]]);
    tl.tracks.V2.items[0]!.enabled = false;
    expect(cutMoments(tl)[0]!.at).toBeCloseTo((6 * FPS + 1) / FPS);
  });

  it("lays the bed on A2 from the song's start, as long as the cut or the song, under the voice, fading out", () => {
    const long = layBed(cut(), src("song", 60, 0));
    expect(long.tracks.A2.items).toEqual([{ src: "song", in: 0, len: 20 * FPS, rec: 0, gainDb: BED_DB, fade_out: 45 }]);
    expect(long.sources.song?.w).toBe(0);
    expect(layBed(cut(), src("song", 10, 0)).tracks.A2.items[0]!.len).toBe(10 * FPS);
    expect(cut().tracks.A2.items).toEqual([]); // the draft it was given is not changed
  });

  it("lays sound effects on A3 at the moments, under the voice, each from a sound of the moment's type", () => {
    const tl = laySfx(cut(), [sound("w1", "whoosh"), sound("w2", "whoosh"), sound("p1", "pop")]);
    expect(tl.tracks.A3.items.map((i) => [i.src, i.rec, i.gainDb])).toEqual([
      ["w1", 4 * FPS, SFX_DB], ["w2", Math.round(8.03 * FPS), SFX_DB], ["p1", 12 * FPS, SFX_DB], ["w1", 17 * FPS, SFX_DB],
    ]);
    expect(Object.keys(tl.sources)).toEqual(expect.arrayContaining(["w1", "w2", "p1"]));
    expect(laySfx(cut(), [sound("x", "hit")]).tracks.A3.items).toEqual([]); // no sound of a type a moment takes: none
  });

  it("hears a brief ask for music, and not one that says no music", () => {
    expect(asksMusic("calm music under the voice")).toBe(true);
    expect(asksMusic("pick a song")).toBe(true);
    expect(asksMusic("no music, just the voice")).toBe(false);
    expect(asksMusic("without any song")).toBe(false);
    expect(asksMusic("a tight cut")).toBe(false);
  });

  it("lays each part once: not on a planned cut, not over what is on A2 or A3, not again where its note says it was laid", () => {
    const edit = { sources: ["rec"], brief: "with music under it", bundle: { designSystem: "plain", grade: "none", voiceMix: "level", sfxSet: "library" } } as unknown as EditMeta;
    const planned = { timeline: { ...cut(), plan: { kind: "reel" } }, notes: [] };
    expect(laySound(edit, planned)).toBe(planned);
    const full = cut();
    full.tracks.A2.items = [it_("mine", 0, FPS)];
    full.tracks.A3.items = [it_("pop", 0, 5)];
    const kept = { timeline: full, notes: [] };
    expect(laySound(edit, kept)).toBe(kept);
    // the person took the music and the sound effects out by hand: a later run lays neither again
    const noted = { timeline: cut(), notes: [`${MUSIC_NOTE}: a song`, `${SFX_NOTE}: 3`] };
    expect(laySound(edit, noted)).toBe(noted);
  });
});
