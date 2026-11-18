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

describe.skipIf(!ffmpegHere)("makeProxy: never bigger than its source, at every Proxy quality", () => {
  it.each(["low", "standard", "high"] as const)("a low-bitrate 720p phone clip at %s: a proxy is kept only when smaller, else none", async (quality) => {
    const src = clip(`phone-${quality}.mp4`, "1280x720", "libx264", 300);
    const out = path.join(dir, `phone-${quality}-proxy.mp4`);
    const kept = await makeProxy(src, out, false, quality, 2);
    if (kept) expect(statSync(out).size).toBeLessThan(statSync(src).size);
    else expect(existsSync(out)).toBe(false);
  }, 60_000);

  it("a 1080p clip at standard quality: the proxy is kept and is smaller than the source", async () => {
    const src = clip("hd.mp4", "1920x1080", "libx264", 12000);
    const out = path.join(dir, "hd-proxy.mp4");
    expect(await makeProxy(src, out, false, "standard", 2)).toBe(true);
    expect(statSync(out).size).toBeLessThan(statSync(src).size);
  }, 60_000);

  it("a proxy's short side is the quality's cap, never upscaled", async () => {
    const src = clip("wide.mp4", "1920x1080", "libx264", 12000);
    const out = path.join(dir, "wide-low.mp4");
    expect(await makeProxy(src, out, false, "low", 2)).toBe(true);
    const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", out]).toString().trim();
    expect(Number(probe)).toBe(540);
  }, 60_000);
});
