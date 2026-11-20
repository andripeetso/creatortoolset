import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";

// The library settings PATCH (UNIFIED-PRD §2 M1–M9, §4.1): what it saves, what it stops writing, and the new-library defaults.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dir = mkdtempSync(path.join(scratch, "library-settings-"));
process.env.DATA_DIR = dir;
const { libraryDb, newLibrarySettings } = await import("./db");
const { libraryApp } = await import("./routes");
const { libraryOf } = await import("./finals");
const { releaseBudget } = await import("./shots");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// a budget change must release the looks held for it (shots.ts); the real function still runs
vi.mock("./shots", async (orig) => {
  const m = await orig<typeof import("./shots")>();
  return { ...m, releaseBudget: vi.fn(m.releaseBudget) };
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "local", role: "admin" } as never);
  return next();
});
app.route("/api/library", libraryApp);

libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_set', 'local', 'Set', 'local', '{}', 0)").run();
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_orig', 'local', 'Orig', 'local', '{\"upload\":\"originals\"}', 0)").run();
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, storage_config, settings, created_at) VALUES ('lib_place', 'local', 'Place', 'local', '{\"proxies\":{\"kind\":\"local\"}}', '{\"upload\":\"originals\"}', 0)").run();

const patch = (lib: string, settings: Record<string, unknown>) =>
  app.request(`/api/library/${lib}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings }) });
const stored = (lib: string) => JSON.parse((libraryDb().prepare("SELECT settings FROM libraries WHERE id = ?").get(lib) as { settings: string }).settings) as Record<string, unknown>;

/** A clip with a probe, in no folder, for the proxy backfill: `width`×`height` decides whether the browser needs a proxy. */
function clip(lib: string, id: string, width: number, height: number) {
  const d = libraryDb();
  const v = `ver-${id}`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at) VALUES (?, ?, 'video', ?, ?, 'local', 1)").run(id, lib, id, v);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at)
     VALUES (?, ?, 1, ?, 1000, ?, ?, 'ready', 'local', 1)`,
  ).run(v, id, `libraries/${lib}/v/${v}/source`, `sha-${id}`, JSON.stringify({ duration: 5, vcodec: "h264", acodec: "aac", width, height }));
  return v;
}
const proxyJobs = (v: string) => (libraryDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE version_id = ? AND kind = 'proxy'").get(v) as { n: number }).n;

describe("new libraries", () => {
  it("start on Smart folders with No limit; nothing asks how to import (the import rule decides)", () => {
    expect(JSON.parse(newLibrarySettings())).toEqual({ organize: "ai", lookBudget: null });
    const id = libraryOf("settings-owner");
    expect(stored(id)).toEqual({ organize: "ai", lookBudget: null });
  });
});

describe("the library settings PATCH", () => {
  it("saves what the setup and the settings pages write, and stops writing copyTo and places", async () => {
    const r = await patch("lib_set", {
      importMode: "copy", // from an app before the import rule: ignored
      proxyQuality: "high",
      transcribe: false,
      lookTalking: true,
      setupAt: "2026-11-18T09:00:00.000Z",
      defaultFolders: false,
      organize: "own",
      upload: "originals",
      finalsUpload: "proxies",
      lookBudget: 12.5,
      timelineModel: "antigravity",
      lookLevel: "detailed",
      describe: false,
      copyTo: "/Volumes/WinningFriends/Media",
      places: [{ path: "/Users/x/Movies", mode: "in-place" }],
    });
    expect(r.status).toBe(200);
    expect(stored("lib_set").importMode).toBeUndefined();
    expect(stored("lib_set")).toMatchObject({
      proxyQuality: "high",
      transcribe: false,
      lookTalking: true,
      setupAt: "2026-11-18T09:00:00.000Z",
      defaultFolders: false,
      organize: "own",
      upload: "originals",
      finalsUpload: "proxies",
      lookBudget: 12.5,
      timelineModel: "antigravity",
      lookLevel: "detailed",
      describe: false,
    });
    expect(stored("lib_set").copyTo).toBeUndefined();
    expect(stored("lib_set").places).toBeUndefined();
  });

  it("does not force describe on under Smart folders, and keeps a stored budget of null", async () => {
    await patch("lib_set", { organize: "ai" });
    expect(stored("lib_set")).toMatchObject({ organize: "ai", describe: false });
    await patch("lib_set", { lookBudget: null });
    expect(stored("lib_set").lookBudget).toBeNull();
  });

  it("takes only a Hosted media value from the list, and no unknown one", async () => {
    await patch("lib_set", { upload: "bogus", finalsUpload: "nope" });
    expect(stored("lib_set")).toMatchObject({ upload: "originals", finalsUpload: "proxies" });
    await patch("lib_set", { upload: "proxies" });
    expect(stored("lib_set").upload).toBe("proxies");
  });

  it("turning proxies on backfills a clip that needs one or every clip under Hosted proxies, never under Originals only", async () => {
    const small = clip("lib_orig", "plain", 1280, 720); // the browser plays it as it is: no proxy needed
    const big = clip("lib_orig", "uhd", 3840, 2160); // over 1080p: needs one
    await patch("lib_orig", { proxy: true });
    expect(proxyJobs(small)).toBe(0);
    expect(proxyJobs(big)).toBe(0); // Originals only keeps no proxy on the server
    const hosted = clip("lib_set", "hosted-plain", 1280, 720);
    await patch("lib_set", { proxy: true });
    expect(proxyJobs(hosted)).toBe(1); // Hosted proxies: every video gets one
  });

  it("under Hosted proxies the switch stays on, whatever the request says", async () => {
    await patch("lib_set", { upload: "all", proxy: false });
    expect(stored("lib_set")).toMatchObject({ upload: "all", proxy: true });
  });

  it("a proxy place does not backfill an originals-only library", async () => {
    const v = clip("lib_place", "placed", 3840, 2160);
    await patch("lib_place", { proxy: true });
    expect(proxyJobs(v)).toBe(0);
  });

  it("a budget change releases the looks held for it", async () => {
    vi.mocked(releaseBudget).mockClear();
    await patch("lib_set", { lookBudget: 7 });
    expect(releaseBudget).toHaveBeenCalledWith(expect.anything(), "lib_set");
  });

  it("setupAt is written once: a later or empty one leaves the first", async () => {
    await patch("lib_set", { setupAt: "2026-11-19T09:00:00.000Z" });
    await patch("lib_set", { setupAt: "" });
    expect(stored("lib_set").setupAt).toBe("2026-11-18T09:00:00.000Z");
  });

  it("organize Standard is stored as own; a PATCH without organize or budget keeps both", async () => {
    await patch("lib_set", { organize: "default" });
    expect(stored("lib_set").organize).toBe("own");
    await patch("lib_set", { organize: "ai", lookBudget: 5 });
    await patch("lib_set", { describe: true });
    expect(stored("lib_set")).toMatchObject({ organize: "ai", lookBudget: 5 });
  });
});
