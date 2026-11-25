import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeProxy } from "./proxy";

// Real ffmpeg on small generated clips: the size rule is what the tests measure (UNIFIED-PRD §4.1, the size matrix).
const dir = mkdtempSync(path.join(tmpdir(), "proxy-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A synthetic clip: `size` is the test pattern's size, `kbps` the video rate it is encoded at (a phone clip is low). */
function clip(name: string, size: string, codec: string, kbps: number, seconds = 2): string {
  const file = path.join(dir, name);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25`, "-t", String(seconds), "-c:v", codec, "-b:v", `${kbps}k`, "-pix_fmt", "yuv420p", file]);
  return file;
}

const ffmpegHere = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The first video stream's field (or every audio stream's, one per line, with `sel` "a"). */
const probeOf = (file: string, entries: string, sel = "v:0"): string =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", sel, "-show_entries", entries, "-of", "csv=p=0", file]).toString().trim();

describe.skipIf(!ffmpegHere)("makeProxy: never bigger than its source, at every Proxy quality", () => {
  it.each(["low", "standard", "high"] as const)("a low-bitrate 720p phone clip at %s: a proxy is kept only when smaller, else none", async (quality) => {
    const src = clip(`phone-${quality}.mp4`, "1280x720", "libx264", 300);
    const out = path.join(dir, `phone-${quality}-proxy.mp4`);
    const kept = await makeProxy(src, out, false, quality, 2);
    expect(existsSync(out)).toBe(kept); // no file left behind when it is not kept
    if (kept) expect(statSync(out).size).toBeLessThan(statSync(src).size);
  }, 60_000);

  it("a 1080p clip at standard quality: the proxy is kept and is smaller than the source", async () => {
    const src = clip("hd.mp4", "1920x1080", "libx264", 12000);
    const out = path.join(dir, "hd-proxy.mp4");
    expect(await makeProxy(src, out, false, "standard", 2)).toBe(true);
    expect(statSync(out).size).toBeLessThan(statSync(src).size);
  }, 60_000);

  it("a proxy has a keyframe every second, so the editor's cuts seek fast", async () => {
    // a source with one keyframe in 10 s: the proxy must not keep that spacing
    const src = path.join(dir, "sparse.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-t", "5", "-c:v", "libx264", "-g", "300", "-b:v", "12000k", "-pix_fmt", "yuv420p", src]);
    const out = path.join(dir, "sparse-proxy.mp4");
    expect(await makeProxy(src, out, false, "standard", 5)).toBe(true);
    const keys = probeOf(out, "packet=pts_time,flags")
      .split("\n")
      .filter((l) => l.includes("K"))
      .map((l) => Number(l.split(",")[0]));
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < keys.length; i++) expect(keys[i]! - keys[i - 1]!).toBeLessThanOrEqual(1.05);
  }, 60_000);

  it("a 360p clip at high quality is never upscaled: its proxy keeps 360p", async () => {
    const src = clip("small.mp4", "640x360", "libx264", 2000);
    const out = path.join(dir, "small-high.mp4");
    expect(await makeProxy(src, out, false, "high", 2)).toBe(true);
    expect(statSync(out).size).toBeLessThan(statSync(src).size);
    expect(Number(probeOf(out, "stream=height"))).toBe(360);
  }, 60_000);

  it("every sound track of the source is kept in the proxy, in order", async () => {
    const src = path.join(dir, "two-tracks.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-t", "2", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-b:v", "12000k", "-c:a", "aac", src]);
    const out = path.join(dir, "two-tracks-proxy.mp4");
    expect(await makeProxy(src, out, false, "standard", 2)).toBe(true);
    expect(probeOf(out, "stream=index", "a").split("\n")).toHaveLength(2);
  }, 60_000);

  it.each(["low", "standard", "high"] as const)("a 4K HEVC clip at %s: its proxy is kept and smaller than the source", async (quality) => {
    const src = clip(`uhd-${quality}.mp4`, "3840x2160", "libx265", 6000);
    const out = path.join(dir, `uhd-${quality}-proxy.mp4`);
    expect(await makeProxy(src, out, false, quality, 2)).toBe(true);
    expect(statSync(out).size).toBeLessThan(statSync(src).size);
  }, 120_000);

  it("a proxy's short side is the quality's cap, never upscaled", async () => {
    const src = clip("wide.mp4", "1920x1080", "libx264", 12000);
    const out = path.join(dir, "wide-low.mp4");
    expect(await makeProxy(src, out, false, "low", 2)).toBe(true);
    expect(Number(probeOf(out, "stream=height"))).toBe(540);
  }, 60_000);

  // D1 (docs/media-library-proxies-prd.md): a proxy has its source's frames, each at its source's time
  const times = (file: string) => probeOf(file, "packet=pts_time").split("\n").map(Number).sort((a, b) => a - b);
  const sample = (name: string, rate: string, frames: number, more: string[] = []) => {
    const file = path.join(dir, name);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=${rate}`, "-frames:v", String(frames), ...more, "-c:v", "libx264", "-b:v", "12000k", "-pix_fmt", "yuv420p", file]);
    return file;
  };

  it.each([["50", "50/1", 50], ["120000/1001", "120000/1001", 120]] as const)("a %s fps clip: its proxy keeps the frame rate, the frame count and each frame's time", async (rate, probed, frames) => {
    const src = sample(`rate-${frames}.mp4`, rate, frames);
    const out = path.join(dir, `rate-${frames}-proxy.mp4`);
    expect(await makeProxy(src, out, false, "low", 1)).toBe(true);
    for (const field of ["r_frame_rate", "avg_frame_rate"]) expect(probeOf(out, `stream=${field}`)).toBe(probed);
    expect(times(src)).toHaveLength(frames);
    expect(times(out)).toEqual(times(src));
  }, 60_000);

  it("a clip of uneven frame times (a phone's): its proxy keeps every frame at its own time", async () => {
    // 30 frames a second on average, each up to 7/600 s off its even place
    const src = sample("uneven.mp4", "30", 90, ["-vf", "settb=1/600,setpts='N*20+round(7*sin(N*1.7))'", "-fps_mode", "vfr", "-video_track_timescale", "600"]);
    const out = path.join(dir, "uneven-proxy.mp4");
    expect(await makeProxy(src, out, false, "low", 3)).toBe(true);
    expect(times(src)).toHaveLength(90);
    expect(new Set(times(src).map((t, i, all) => (i ? Math.round((t - all[i - 1]!) * 600) : 20))).size).toBeGreaterThan(2); // the sample is uneven
    expect(times(out)).toEqual(times(src));
  }, 60_000);
});
