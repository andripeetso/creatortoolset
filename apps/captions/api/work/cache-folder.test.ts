import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "cache-folder-"));
process.env.DATA_DIR = path.join(dir, "data");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { cacheAway, cacheReport, dropProxies, emptyCache, keepProxy, NEEDS_DISK, proxiesDir, roomFor, setCacheAccount, setKeptOffline, touchProxy, trimCache } = await import("./cache");

describe("the first claim's cleanup never sweeps a folder the person picked", () => {
  it("a Download location holding footage keeps it; only the old default folder's cache goes", () => {
    const picked = path.join(dir, "picked");
    mkdirSync(picked, { recursive: true });
    writeFileSync(path.join(picked, "clip.mp4"), "footage");
    const legacy = path.join(process.env.DATA_DIR!, "proxies");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(path.join(legacy, "old.mp4"), "old cache");
    process.env.CT_PROXY_DIR = picked;
    try {
      setCacheAccount("tinyacrobatics");
      expect(readFileSync(path.join(picked, "clip.mp4"), "utf8")).toBe("footage");
      expect(existsSync(path.join(legacy, "old.mp4"))).toBe(false);
    } finally {
      delete process.env.CT_PROXY_DIR;
    }
  });
});

describe("the Download location's disk is not connected (docs/media-library-proxies-prd.md R9)", () => {
  // a folder under /Volumes whose volume is not mounted: no computer has a disk of this name
  const away = "/Volumes/ct-test-no-such-disk/Creator Toolset Downloads/studio";
  const data = process.env.DATA_DIR!;

  it("no location chosen is the default folder; one chosen is that folder", () => {
    setCacheAccount("tinyacrobatics");
    delete process.env.CT_PROXY_DIR;
    expect(cacheAway()).toBe(false);
    expect(proxiesDir()).toBe(path.join(data, "proxies", "tinyacrobatics"));
    process.env.CT_PROXY_DIR = path.join(dir, "picked");
    try {
      expect(cacheAway()).toBe(false);
      expect(proxiesDir()).toBe(path.join(dir, "picked", "tinyacrobatics"));
    } finally {
      delete process.env.CT_PROXY_DIR;
    }
  });

  it("one chosen whose disk is away: no proxy is kept, the claim says so, and nothing is written to the internal disk in its place", () => {
    setCacheAccount("tinyacrobatics");
    const made = path.join(dir, "made.mp4");
    writeFileSync(made, "proxy");
    const before = readdirSync(data, { recursive: true });
    process.env.CT_PROXY_DIR = away;
    try {
      expect(cacheAway()).toBe(true);
      expect(() => proxiesDir()).toThrow(NEEDS_DISK);
      expect(NEEDS_DISK).toBe("Needs the Download location's disk");
      // making: no room is found for a proxy and a made one is not kept
      expect(() => roomFor(1)).toThrow(NEEDS_DISK);
      expect(() => keepProxy("v1", made)).toThrow(NEEDS_DISK);
      expect(existsSync(made)).toBe(true);
      // each claim's own steps go on without it
      setKeptOffline(["v1"]);
      emptyCache();
      dropProxies(["v1"]);
      touchProxy(path.join(away, "tinyacrobatics", "v1.mp4"));
      expect(trimCache()).toEqual([]);
      expect(cacheReport()).toEqual({ bytes: 0, away: true });
      expect(readdirSync(data, { recursive: true })).toEqual(before);
      expect(existsSync("/Volumes/ct-test-no-such-disk")).toBe(false);
    } finally {
      delete process.env.CT_PROXY_DIR;
    }
    // the disk is back (here: the default folder again): the cache is there as before
    expect(cacheReport()).toMatchObject({ bytes: 0, versions: [] });
    expect(cacheReport()).not.toHaveProperty("away");
  });
});
