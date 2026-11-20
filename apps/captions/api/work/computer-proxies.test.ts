import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { ServerPlugin } from "../lib/plugin";

// A plug-in's proxies made on its account's computer (contracts/work.ts ComputerProxy): the claim asks for the ones the
// computer lacks and never tells it to drop them; the computer reads only a file inside the item's `under` folder and
// keeps the proxy in its cache, never sent.
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "computer-proxies-"));
process.env.DATA_DIR = dir;
const { ffmpegCommand } = await import("../ffmpeg-runtime");
const { keptProxies, madeProxies, proxyPath, setCacheAccount } = await import("./cache");
const { makeKept } = await import("./computer");
const { claimExtras } = await import("./offline");
const { mountPlugins } = await import("../lib/plugin");
const { pairDevice } = await import("../lib/devices");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const censored = path.join(dir, "share", ".ba-archive", "censored");
const originals = path.join(dir, "share", "originals");
mkdirSync(censored, { recursive: true });
mkdirSync(originals, { recursive: true });
const clip = (file: string) =>
  execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=2:size=1920x1080:rate=30", "-c:v", "libx264", "-b:v", "12000k", "-pix_fmt", "yuv420p", file]);
const master = path.join(censored, "master.mp4");
const original = path.join(originals, "original.mp4");
clip(master);
clip(original);
setCacheAccount("tiny");

describe("a plug-in's proxies made on the computer", () => {
  it("is made from a file inside its folder and kept in the cache; one outside, or with .., is never read", async () => {
    expect(await makeKept([{ id: "ext_outside", path: original, under: censored }])).toBe(false);
    expect(await makeKept([{ id: "ext_dots", path: `${censored}/../../originals/original.mp4`, under: censored }])).toBe(false);
    expect(existsSync(proxyPath("ext_outside")) || existsSync(proxyPath("ext_dots"))).toBe(false);
    expect(await makeKept([{ id: "ext_master", path: master, under: censored }])).toBe(true);
    expect(existsSync(proxyPath("ext_master"))).toBe(true);
    expect(keptProxies()).not.toContain("ext_master"); // a cache file like any proxy: the size limit counts it
    expect(madeProxies().ext_master).toEqual({ w: 1280, h: 720 }); // its size goes in the cache report
    // made once: not again while it is there
    expect(await makeKept([{ id: "ext_master", path: master, under: censored }])).toBe(false);
  }, 60_000);

  it("leaves the disk its free-space floor: with too little free even after trimming, no proxy is written and the original plays", async () => {
    process.env.CT_PROXY_FLOOR = String(Number.MAX_SAFE_INTEGER); // no disk has this much free
    try {
      expect(await makeKept([{ id: "ext_full", path: master, under: censored }])).toBe(false);
      expect(existsSync(proxyPath("ext_full"))).toBe(false);
      expect(madeProxies().ext_full).toBeUndefined(); // not skipped for good: made once there is room
      expect(existsSync(proxyPath("ext_master"))).toBe(true); // and nothing was trimmed for a proxy that could never fit
    } finally {
      delete process.env.CT_PROXY_FLOOR;
    }
  }, 60_000);

  it("only for a heavy file when asked so: a light one is recorded as skipped and never asked again", async () => {
    const light = path.join(censored, "light.mp4");
    execFileSync(ffmpegCommand(), ["-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=1:size=1280x720:rate=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", light]);
    expect(await makeKept([{ id: "src_light", path: light, under: censored, heavyOnly: true }])).toBe(true);
    expect(existsSync(proxyPath("src_light"))).toBe(false);
    expect(madeProxies().src_light).toEqual({ skip: true });
    expect(await makeKept([{ id: "src_light", path: light, under: censored, heavyOnly: true }])).toBe(false);
  }, 60_000);

  it("the claim asks only for the ones the computer lacks, and never tells it to drop the plug-in's", async () => {
    const mac = pairDevice("tiny", "Studio Mac").device;
    const plugin = {
      id: "tiny-studio",
      routes: new Hono(),
      computerProxies: {
        make: async () => [
          { id: "ext_master", path: master, under: censored },
          { id: "ext_next", path: master, under: censored },
        ],
        keeps: async (_owner: string, id: string) => id.startsWith("ext_"),
      },
    } as unknown as ServerPlugin;
    mountPlugins(new Hono(), [plugin]);
    const extras = await claimExtras(mac.id, undefined, ["ext_master", "a-version-that-is-gone"]);
    expect(extras.drop).toEqual(["a-version-that-is-gone"]);
    expect(extras.make?.map((m) => m.id)).toEqual(["ext_next"]);
  });
});
