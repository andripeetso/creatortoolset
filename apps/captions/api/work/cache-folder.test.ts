import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "cache-folder-"));
process.env.DATA_DIR = path.join(dir, "data");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const { setCacheAccount } = await import("./cache");

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
