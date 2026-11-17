import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";
import { SFX_TYPES, type SfxManifest } from "../../contracts/sfx";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "sfx-library-"));
process.env.DATA_DIR = dir;
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { sfxApp } = await import("./sfx");
const { libraryTools } = await import("../mcp-tools/library");

const sfxRoot = path.resolve(import.meta.dirname, "../../public/sfx");
const manifest = JSON.parse(readFileSync(path.join(sfxRoot, "manifest.json"), "utf8")) as SfxManifest;

afterAll(() => {
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

describe("the shipped catalog", () => {
  it("has every file, with the sha256 its manifest entry gives", () => {
    for (const s of manifest.sounds) {
      const file = path.join(sfxRoot, s.file);
      expect(existsSync(file), s.file).toBe(true);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex"), s.file).toBe(s.sha256);
    }
  });

  it("is CC0 only, from Kenney's own pages, with a licence file beside it", () => {
    for (const p of manifest.packs) {
      expect(p.license).toBe("CC0");
      expect(p.source).toMatch(/^https:\/\/kenney\.nl\/assets\//);
      expect(readFileSync(path.join(sfxRoot, p.licenseFile), "utf8")).toMatch(/CC0/);
    }
    for (const s of manifest.sounds) {
      expect(s.license, s.file).toBe("CC0");
      expect(s.author, s.file).toBe("Kenney");
      expect(s.source, s.file).toMatch(/^https:\/\/kenney\.nl\/assets\//);
    }
  });

  it("uses only the shared type tags, and a starter set of about fifty", () => {
    for (const s of manifest.sounds) expect(SFX_TYPES).toContain(s.type);
    const starter = manifest.sounds.filter((s) => s.starter).length;
    expect(starter).toBeGreaterThanOrEqual(45);
    expect(starter).toBeLessThanOrEqual(55);
  });
});

describe("installing sounds into a workspace's library", () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(async (c, next) => {
    c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
    return next();
  });
  app.route("/api/sfx", sfxApp);
  const who = { "x-user": "ana" };
  const starterCount = manifest.sounds.filter((s) => s.starter).length;
  const sources = () => (libraryDb().prepare("SELECT COUNT(*) AS n FROM asset_sources").get() as { n: number }).n;

  it("adds the starter set once, with source and licence, and adds nothing the second time", async () => {
    const first = (await (await app.request("/api/sfx/starter", { method: "POST", headers: who })).json()) as { added: number; already: number };
    expect(first.added).toBe(starterCount);
    const state = (await (await app.request("/api/sfx", { headers: who })).json()) as { count: number; starter: { installed: number; total: number } };
    expect(state.count).toBe(starterCount);
    expect(state.starter).toEqual({ installed: starterCount, total: starterCount });
    expect(sources()).toBe(starterCount);

    const again = (await (await app.request("/api/sfx/starter", { method: "POST", headers: who })).json()) as { added: number; already: number };
    expect(again.added).toBe(0);
    expect(again.already).toBe(starterCount);
    expect(sources()).toBe(starterCount);
  });

  it("removes the starter files, and keeps one the user changed", async () => {
    const one = libraryDb().prepare("SELECT id FROM assets WHERE trashed_at IS NULL ORDER BY title LIMIT 1").get() as { id: string };
    libraryDb().prepare("INSERT INTO asset_tags (asset_id, tag, source) VALUES (?, 'my tag', 'user')").run(one.id);
    const r = (await (await app.request("/api/sfx/starter", { method: "DELETE", headers: who })).json()) as { removed: number; kept: number };
    expect(r).toEqual({ removed: starterCount - 1, kept: 1 });
  });

  it("finds sounds by type and adds the first matches not yet in the library", async () => {
    const r = (await (await app.request("/api/sfx/find", { method: "POST", headers: { ...who, "content-type": "application/json" }, body: JSON.stringify({ type: "whoosh", count: 2 }) })).json()) as {
      added: { type: string; license: string; source: string }[];
    };
    expect(r.added.length).toBeGreaterThan(0);
    for (const a of r.added) {
      expect(a.type).toBe("whoosh");
      expect(a.license).toBe("CC0");
      expect(a.source).toMatch(/^https:\/\/kenney\.nl\//);
    }
  });
});

describe("the assistant's find_sound_effects tool", () => {
  const tool = libraryTools.defs.find((d) => d.name === "find_sound_effects");
  it("takes the shared type tags and says what it does in a short text", () => {
    expect(tool).toBeTruthy();
    expect(tool!.description.length).toBeLessThanOrEqual(350);
    const props = tool!.inputSchema.properties as { type: { enum: string[] } };
    expect(props.type.enum).toEqual([...SFX_TYPES]);
  });
});
