import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Timeline } from "../../contracts/editor";
import { ffmpegCommand } from "../ffmpeg-runtime";

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "editor-segcache-"));
process.env.DATA_DIR = dir;

const { cachedSegment, segDir, segKey, trimSegments } = await import("./segcache");
const { cacheReport, emptyCache, segmentsDir, setCacheAccount } = await import("../work/cache");
const { renderPreview } = await import("./preview");
const { onComputer } = await import("../work/on-computer");
const { emptyTracks } = await import("./timeline");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => void delete process.env.CT_LOCAL);

describe("preview segment cache", () => {
  it("is kept only on the person's own Mac", () => {
    expect(segDir()).toBeNull(); // a server
    process.env.CT_LOCAL = "1";
    expect(segDir()).toBe(path.join(dir, "render-cache"));
  });

  it("a segment's key changes with its command and with its files' contents, not with where a file is", async () => {
    const a = path.join(dir, "a.bin");
    const b = path.join(dir, "b.bin");
    writeFileSync(a, "Tiny Acrobatics take");
    writeFileSync(b, "Tiny Acrobatics take");
    const t = new Date(1_700_000_000_000);
    for (const f of [a, b]) utimesSync(f, t, t);
    const k = (args: string[], f: string) => segKey(args, [f], new Map());
    const base = await k(["-i", a, "-vf", "scale=10:10"], a);
    expect(await k(["-i", b, "-vf", "scale=10:10"], b)).toBe(base);
    expect(await k(["-i", a, "-vf", "scale=20:20"], a)).not.toBe(base);
    writeFileSync(a, "Tiny Acrobatics take, cut again");
    expect(await k(["-i", a, "-vf", "scale=10:10"], a)).not.toBe(base);
  });

  it("renders a segment once, then hands it out from the cache", async () => {
    const cache = path.join(dir, "c1");
    const f = path.join(dir, "in.bin");
    writeFileSync(f, "x");
    let made = 0;
    const make = async (out: string) => void (made++, writeFileSync(out, "seg"));
    const one = await cachedSegment(cache, ["-i", f], [f], new Map(), make);
    const two = await cachedSegment(cache, ["-i", f], [f], new Map(), make);
    expect(two).toBe(one);
    expect(made).toBe(1);
    // a render that fails leaves nothing behind
    await expect(cachedSegment(cache, ["-i", f, "-x"], [f], new Map(), async () => { throw new Error("ffmpeg"); })).rejects.toThrow("ffmpeg");
    expect(readdirSync(cache)).toEqual([path.basename(one)]);
  });

  it("on a computer it is the account's, counted and emptied with its proxies in Settings → Storage", () => {
    setCacheAccount("tiny");
    mkdirSync(segmentsDir(), { recursive: true });
    writeFileSync(path.join(segmentsDir(), "a.mov"), Buffer.alloc(1000));
    expect(cacheReport()!.bytes).toBe(1000);
    emptyCache();
    expect(cacheReport()!.bytes).toBe(0);
  });

  it("on a computer whose Download location's disk is not connected none are kept, on the internal disk or anywhere", () => {
    setCacheAccount("tiny");
    onComputer.on = true;
    process.env.CT_PROXY_DIR = "/Volumes/ct-test-no-such-disk/Creator Toolset Downloads/studio";
    try {
      expect(segDir()).toBeNull();
      delete process.env.CT_PROXY_DIR;
      expect(segDir()).toBe(segmentsDir());
    } finally {
      delete process.env.CT_PROXY_DIR;
      onComputer.on = false;
    }
  });

  it("past its limit the segments used longest ago go, never one used in the last hour", async () => {
    const cache = path.join(dir, "c2");
    mkdirSync(cache);
    const now = Date.now();
    for (const [n, hoursAgo] of [["old", 5], ["mid", 3], ["new", 0]] as const) {
      writeFileSync(path.join(cache, `${n}.mov`), Buffer.alloc(100));
      const t = new Date(now - hoursAgo * 3600_000);
      utimesSync(path.join(cache, `${n}.mov`), t, t);
    }
    // a killed render's part goes once it is an hour old; one being written stays
    for (const [n, hoursAgo] of [["dead.mov.x.part", 2], ["live.mov.y.part", 0]] as const) {
      writeFileSync(path.join(cache, n), "");
      const t = new Date(now - hoursAgo * 3600_000);
      utimesSync(path.join(cache, n), t, t);
    }
    await trimSegments(cache, 150, now);
    expect(readdirSync(cache).sort()).toEqual(["live.mov.y.part", "new.mov"]);
  });

  it("a cut changed in one shot renders that shot again and takes the other from the cache, the same render", async () => {
    process.env.CT_LOCAL = "1";
    const clip = path.join(dir, "Tiny Acrobatics take.mp4");
    execFileSync(ffmpegCommand(), ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=180x320:rate=25", "-f", "lavfi", "-i", "sine=duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
    const tl = (zoom?: number): Timeline => {
      const t: Timeline = { name: "Hook", fps: 25, width: 180, height: 320, sources: { v: { versionId: "v", name: "Take", fps: 25, tc: 0, dur: 50, w: 180, h: 320 } }, tracks: emptyTracks(), markers: [] };
      t.tracks.V1.items = [{ src: "v", in: 0, len: 10, rec: 0, link: "a" }, { src: "v", in: 20, len: 10, rec: 10, link: "b", ...(zoom ? { zoom } : {}) }];
      t.tracks.A1.items = t.tracks.V1.items.map(({ src, in: i, len, rec, link }) => ({ src, in: i, len, rec, link }));
      return t;
    };
    const segs = () => readdirSync(segDir()!).filter((n) => n.endsWith(".mov")).sort();
    await renderPreview(tl(), { v: clip }, path.join(dir, "one.mp4"));
    const first = segs();
    expect(first).toHaveLength(2);
    await renderPreview(tl(1.5), { v: clip }, path.join(dir, "two.mp4"));
    const second = segs();
    expect(second).toHaveLength(3); // the punched-in shot is new, the first shot's segment is the one from before
    expect(second.filter((n) => first.includes(n))).toHaveLength(2);
    // the same cut again renders nothing
    await renderPreview(tl(1.5), { v: clip }, path.join(dir, "three.mp4"));
    expect(segs()).toEqual(second);
  }, 60_000);
});
