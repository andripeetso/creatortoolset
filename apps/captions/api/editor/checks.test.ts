import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";
import { cutsOf, endsOnBlack, flashFrames, oddAt, wordSlips, withFound } from "./checks";
import { emptyTracks } from "./timeline";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-checks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const talk = (dur = 3000) => ({ versionId: "talk", name: "Talk", fps: 30, tc: 0, dur, w: 1080, h: 1920 });
function cut(pieces: { in: number; len: number }[]): Timeline {
  const tracks = emptyTracks();
  let rec = 0;
  for (const p of pieces) {
    tracks.V1.items.push({ src: "talk", in: p.in, len: p.len, rec });
    tracks.A1.items.push({ src: "talk", in: p.in, len: p.len, rec });
    rec += p.len;
  }
  return { name: "t", fps: 30, width: 1080, height: 1920, sources: { talk: talk() }, tracks, markers: [] };
}
const flat = (v: number) => new Uint8Array(12).fill(v);

describe("checks on a cut", () => {
  it("finds a frame at a cut that belongs to neither shot, and leaves a clean cut alone", () => {
    // A A A | B B B: a clean cut at 3
    expect(oddAt([flat(0), flat(0), flat(0), flat(200), flat(200), flat(200)], 3)).toEqual([]);
    // A A X | B B: frame 2 is neither A nor B
    expect(oddAt([flat(0), flat(0), flat(100), flat(200), flat(200)], 3)).toEqual([2]);
    // nothing changes at the cut: nothing to find
    expect(oddAt([flat(0), flat(0), flat(1), flat(1)], 2)).toEqual([]);
  });

  it("names a word said twice across a cut and a word a cut runs through, not words inside one piece", () => {
    const words = [
      { w: "it", s: 0.1, e: 0.3 },
      { w: "takes", s: 0.35, e: 0.6 },
      { w: "time.", s: 0.65, e: 0.95 },
      { w: "time", s: 5.0, e: 5.3 },
      { w: "to", s: 5.35, e: 5.5 },
      { w: "learn", s: 9.8, e: 10.4 },
    ];
    // piece 2 starts on the second "time"; piece 3 starts in the middle of "learn"
    const tl = cut([{ in: 0, len: 30 }, { in: 150, len: 20 }, { in: 300, len: 30 }]);
    expect(wordSlips(tl, { talk: words })).toEqual([
      { rec: 30, why: "said twice across a cut: “time | time”" },
      { rec: 50, why: "a cut runs through “learn”" },
    ]);
    // one piece going on into the next of the same take is no cut
    expect(wordSlips(cut([{ in: 0, len: 15 }, { in: 15, len: 15 }]), { talk: words })).toEqual([]);
  });

  it("files what it found on the shot it lands in, beside the look's own reason for that shot", () => {
    const shots = [{ at: 0, dur: 1 }, { at: 1, dur: 2 }];
    const c = withFound({ ok: false, fails: [{ n: 2, why: "nothing happens", at: 1, dur: 2 }], round: 1 }, [{ rec: 15, why: "a flash" }, { rec: 60, why: "ends on black" }], shots, 30);
    expect(c).toEqual({ ok: false, round: 1, fails: [{ n: 1, why: "a flash", at: 0, dur: 1 }, { n: 2, why: "nothing happens; ends on black", at: 1, dur: 2 }] });
    expect(withFound({ ok: true, fails: [], round: 1 }, [], shots, 30).ok).toBe(true);
  });

  it("looks for flashes only at the cut's own cuts", () => {
    const tl = cut([{ in: 0, len: 30 }, { in: 100, len: 30 }]);
    tl.tracks.V2.items = [{ src: "talk", in: 0, len: 20, rec: 40 }];
    expect(cutsOf(tl)).toEqual([30, 40]);
  });

  it("on a rendered file: a one-frame flash between two shots, and an end on black", async () => {
    const file = path.join(dir, "flash.mp4");
    // 1 s red, one white frame, 1 s blue, then 1 s black
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "color=red:s=64x64:r=30:d=1", "-f", "lavfi", "-i", "color=white:s=64x64:r=30:d=1", "-f", "lavfi", "-i", "color=blue:s=64x64:r=30:d=1", "-f", "lavfi", "-i", "color=black:s=64x64:r=30:d=1",
      "-filter_complex", "[1]trim=end_frame=1,setpts=PTS-STARTPTS[w];[0][w][2][3]concat=n=4:v=1[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
    // the cut put the blue at 31: frame 30 is the white one, in neither shot
    expect((await flashFrames(file, [31], 30)).map((f) => f.rec)).toEqual([30]);
    expect(await endsOnBlack(file, 3.03)).toBe(true);
    const clean = path.join(dir, "clean.mp4");
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=64x64:r=30:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", clean]);
    expect(await endsOnBlack(clean, 2)).toBe(false);
  }, 60_000);
});
