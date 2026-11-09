import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "library-similar-posted-"));
process.env.DATA_DIR = dir;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { phashPerSecond } = await import("./fingerprint");
const { similarToPosted, voiceOverlap } = await import("./similar");
const { printPosts } = await import("../lib/connectors/prints");
const { findAccount, publicAccount, saveAccounts } = await import("../lib/connectors/store");

const ff = (args: string[]) => execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const clip = path.join(dir, "clip.mp4");
const copy = path.join(dir, "copy.mp4");
const other = path.join(dir, "other.mp4");
let clipHashes: string[] = [];

beforeAll(async () => {
  // three seconds each, made here: nothing large is committed
  ff(["-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  ff(["-i", clip, "-vf", "scale=160:120", "-c:v", "libx264", "-crf", "38", "-pix_fmt", "yuv420p", copy]);
  ff(["-f", "lavfi", "-i", "mandelbrot=size=320x240:rate=10", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", other]);
  clipHashes = await phashPerSecond(clip);
});

/** Tiny Acrobatics' posted reels: the first has a media URL (a local file stands in for the CDN), one has none. */
const posts = () => [
  { id: "reel-copy", url: "https://www.instagram.com/reel/CopyRoll/", at: 3, text: "Roll again", mediaUrl: copy },
  { id: "reel-other", url: "https://www.instagram.com/reel/Other/", at: 2, text: "Something else", mediaUrl: other },
  { id: "post-photo", url: "https://www.instagram.com/p/Photo/", at: 1, text: "A photo" },
];

describe("posted reels in the duplicate check", () => {
  it("counts a posted reel with a media URL as pending until it is fingerprinted", () => {
    saveAccounts("tiny-owner", [{ platform: "instagram", platformId: "17001", handle: "tinyacrobatics", via: "login", token: "t", posts: posts() }]);
    const r = similarToPosted("tiny-owner", clipHashes);
    expect(r).toEqual({ matches: [], checked: 0, pending: 2, voice: { on: false, checked: 0, note: "Pictures only." } });
  });

  it("fingerprints the posts with a media URL once, and finds the copy among them", async () => {
    const key = "instagram:17001";
    expect(await printPosts("tiny-owner", key)).toBe(2);
    expect(await printPosts("tiny-owner", key)).toBe(0); // already done: not read again
    const r = similarToPosted("tiny-owner", clipHashes);
    expect(r.matches.map((m) => m.postId)).toEqual(["reel-copy"]);
    expect(r.matches[0]).toMatchObject({ platform: "instagram", handle: "tinyacrobatics", url: "https://www.instagram.com/reel/CopyRoll/", overlap: 1 });
    expect(r.checked).toBe(2);
    expect(r.pending).toBe(0);
  });

  it("keeps fingerprints and media URLs out of the browser view", () => {
    const stored = findAccount("tiny-owner", "instagram:17001")!;
    expect(stored.prints?.["reel-copy"]?.length).toBeGreaterThan(0);
    const view = publicAccount(stored);
    expect(view).not.toHaveProperty("prints");
    expect(view.posts?.every((p) => !("mediaUrl" in p))).toBe(true);
    expect(view.posts?.map((p) => p.id)).toEqual(["reel-copy", "reel-other", "post-photo"]);
  });

  it("sees only the caller's own accounts", () => {
    expect(similarToPosted("tiny-other", clipHashes)).toEqual({ matches: [], checked: 0, pending: 0, voice: { on: false, checked: 0, note: "Pictures only." } });
  });

  it("marks a post that cannot be read so it is not tried again", async () => {
    saveAccounts("tiny-owner", [{ platform: "instagram", platformId: "17002", handle: "tinybroken", via: "login", token: "t", posts: [{ id: "reel-gone", at: 4, text: "Gone", mediaUrl: path.join(dir, "missing.mp4") }] }]);
    expect(await printPosts("tiny-owner", "instagram:17002")).toBe(1);
    expect(findAccount("tiny-owner", "instagram:17002")?.prints).toEqual({ "reel-gone": [] });
    expect(await printPosts("tiny-owner", "instagram:17002")).toBe(0);
    expect(similarToPosted("tiny-owner", clipHashes).pending).toBe(0);
  });
});

describe("voice in the posted reels check", () => {
  const said = ["we", "roll", "the", "mat", "on", "the", "floor", "again", "today"];
  const clipWords = said.map((w, i) => ({ w, s: i * 0.5, e: i * 0.5 + 0.4 }));

  it("shares the voice of the clip's words that the reel says in a row", () => {
    // "we roll the mat on the floor" is 7 of the clip's 9 words, in one run from 0 s to 3.4 s
    const r = voiceOverlap(clipWords, ["x", "we", "roll", "the", "mat", "on", "the", "floor", "y"]);
    expect(r.pct).toBeCloseTo(77.8, 1);
    expect(r.longestS).toBeCloseTo(3.4, 5);
    expect(voiceOverlap(clipWords, ["completely", "different", "words", "about", "other", "things", "entirely"]).pct).toBe(0);
  });

  it("flags a reel that says the same words even when its pictures differ, and says so", async () => {
    saveAccounts("tiny-voice", [
      { platform: "instagram", platformId: "17003", handle: "tinyvoice", via: "login", token: "t", posts: [
        { id: "reel-talk", at: 2, text: "Same words", mediaUrl: "talk.mp4" },
        { id: "reel-quiet", at: 1, text: "Other words", mediaUrl: "quiet.mp4" },
      ] },
    ]);
    const speak = async (src: string) => (src === "talk.mp4" ? said : ["something", "else", "entirely", "this", "time", "round"]);
    expect(await printPosts("tiny-voice", "instagram:17003", async () => [], speak)).toBe(2);
    const r = similarToPosted("tiny-voice", clipHashes, { words: clipWords });
    expect(r.matches.map((m) => m.postId)).toEqual(["reel-talk"]);
    expect(r.matches[0]).toMatchObject({ overlap: 0, voice: { pct: 100 } });
    expect(r.voice).toEqual({ on: true, checked: 2, note: "Voice compared with 2 posted reels." });
    expect(publicAccount(findAccount("tiny-voice", "instagram:17003")!)).not.toHaveProperty("voices");
  });

  it("says the picture-only reason when the clip has no speech", () => {
    expect(similarToPosted("tiny-voice", clipHashes, { why: "Add your Deepgram key." }).voice).toEqual({ on: false, checked: 0, note: "Add your Deepgram key." });
  });

  it("leaves a reel's speech unset without a key, so a later pull with one fills it", async () => {
    saveAccounts("tiny-nokey", [{ platform: "instagram", platformId: "17004", handle: "tinynokey", via: "login", token: "t", posts: [{ id: "reel-x", at: 1, text: "X", mediaUrl: "x.mp4" }] }]);
    await printPosts("tiny-nokey", "instagram:17004", async () => []);
    expect(findAccount("tiny-nokey", "instagram:17004")?.voices).toBeUndefined();
  });
});
