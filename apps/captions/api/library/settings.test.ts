import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// The library settings PATCH (UNIFIED-PRD §2 M1–M9, §4.1): what it saves, what it stops writing, and the new-library defaults.
const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dir = mkdtempSync(path.join(scratch, "library-settings-"));
process.env.DATA_DIR = dir;
const { libraryDb, newLibrarySettings } = await import("./db");
const { libraryApp } = await import("./routes");
const { libraryOf } = await import("./finals");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

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
  it("start on Smart folders; nothing asks how to import (the import rule decides)", () => {
    expect(JSON.parse(newLibrarySettings())).toEqual({ organize: "ai" });
    const id = libraryOf("settings-owner");
    expect(stored(id)).toEqual({ organize: "ai" });
  });
});

describe("Generate proxies off by default: the migration", () => {
  it("stores on for a library that never stored the switch, leaves an off one off, and stamps when every on-library's proxies start", async () => {
    const { MIGRATIONS } = await import("./schema");
    const d = libraryDb();
    const put = (id: string, settings: object) => d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, 'local', 'M', 'local', ?, 0)").run(id, JSON.stringify(settings));
    put("lib_m_absent", {});
    put("lib_m_off", { proxy: false });
    put("lib_m_on", { proxy: true });
    d.exec(MIGRATIONS.find((m) => m.includes("$.proxySince"))!);
    expect(stored("lib_m_absent")).toMatchObject({ proxy: true, proxySince: expect.any(Number) });
    expect(stored("lib_m_on")).toMatchObject({ proxy: true, proxySince: expect.any(Number) });
    expect(stored("lib_m_off")).toEqual({ proxy: false });
    expect(Math.abs(Number(stored("lib_m_on").proxySince) - Date.now())).toBeLessThan(60_000); // now, in milliseconds
    // the test libraries above this one read as they were written: off unless a test turns it on
    for (const id of ["lib_set", "lib_orig", "lib_place"]) d.prepare("UPDATE libraries SET settings = json_remove(settings, '$.proxy', '$.proxySince') WHERE id = ?").run(id);
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
      copyTo: "/Volumes/Tiny/Media",
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
      timelineModel: "antigravity",
      lookLevel: "detailed",
      describe: false,
    });
    expect(stored("lib_set").lookBudget).toBeUndefined();
    expect(stored("lib_set").copyTo).toBeUndefined();
    expect(stored("lib_set").places).toBeUndefined();
  });

  it("does not force describe on under Smart folders", async () => {
    await patch("lib_set", { organize: "ai" });
    expect(stored("lib_set")).toMatchObject({ organize: "ai", describe: false });
  });

  it("takes only a Hosted media value from the list, and no unknown one", async () => {
    await patch("lib_set", { upload: "bogus", finalsUpload: "nope" });
    expect(stored("lib_set")).toMatchObject({ upload: "originals", finalsUpload: "proxies" });
    await patch("lib_set", { upload: "proxies" });
    expect(stored("lib_set").upload).toBe("proxies");
  });

  it("turning proxies on queues nothing for the clips already here; Make for the missing does: every video under Hosted proxies, none under Originals only", async () => {
    const make = async (lib: string) => ((await (await app.request(`/api/library/${lib}/made/proxy`, { method: "POST" })).json()) as { files: number }).files;
    const big = clip("lib_orig", "uhd", 3840, 2160); // over 1080p: needs one
    await patch("lib_orig", { proxy: true });
    expect(await make("lib_orig")).toBe(0); // Originals only keeps no proxy on the server
    expect(proxyJobs(big)).toBe(0);
    const hosted = clip("lib_set", "hosted-plain", 1280, 720); // plays as it is, yet the team's copy is its proxy
    await patch("lib_set", { proxy: true });
    expect(proxyJobs(hosted)).toBe(0); // a switch never queues the files already in the library
    expect(stored("lib_set").proxySince).toBeGreaterThan(1); // from here on: this clip (created_at 1) is from before
    expect(await make("lib_set")).toBeGreaterThan(0);
    expect(proxyJobs(hosted)).toBe(1);
  });

  it("an Undo of Generate proxies off is as if it never went off: its time stays and the waiting proxies come back, never one from before the switch", async () => {
    const d = libraryDb();
    d.prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_undo', 'local', 'Undo', 'local', ?, 0)").run(JSON.stringify({ upload: "proxies", proxy: true, proxySince: 1000 }));
    const [old, fresh] = [clip("lib_undo", "undo-old", 1280, 720), clip("lib_undo", "undo-fresh", 1280, 720)];
    d.prepare("UPDATE asset_versions SET created_at = 2000 WHERE id = ?").run(fresh); // added since the switch went on; `old` (1) is from before
    d.prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor) VALUES ('lib_undo', ?, 'proxy', 'queued', 'local')").run(fresh);
    await patch("lib_undo", { proxy: false, upload: "none" });
    expect(proxyJobs(fresh)).toBe(0); // the off takes the waiting ones away
    await patch("lib_undo", { proxy: true, proxyBack: true, upload: "proxies" });
    expect(stored("lib_undo")).toMatchObject({ proxy: true, proxySince: 1000, upload: "proxies" });
    expect(stored("lib_undo").proxyBack).toBeUndefined(); // a request flag, never stored
    expect([proxyJobs(fresh), proxyJobs(old)]).toEqual([1, 0]);
    // the switch turned on by hand, no Undo: from now on, and nothing queued
    await patch("lib_undo", { proxy: false, upload: "none" });
    await patch("lib_undo", { proxy: true });
    expect(Number(stored("lib_undo").proxySince)).toBeGreaterThan(1000);
    expect(proxyJobs(fresh)).toBe(0);
  });

  it("under Hosted proxies Generate proxies still turns off: hosting never forces it (owner, 2026-11-25)", async () => {
    await patch("lib_set", { upload: "all", proxy: false });
    expect(stored("lib_set")).toMatchObject({ upload: "all", proxy: false });
  });

  it("a proxy place does not backfill an originals-only library", async () => {
    const v = clip("lib_place", "placed", 3840, 2160);
    await patch("lib_place", { proxy: true });
    expect(proxyJobs(v)).toBe(0);
  });

  it("setupAt is written once: a later or empty one leaves the first", async () => {
    await patch("lib_set", { setupAt: "2026-11-19T09:00:00.000Z" });
    await patch("lib_set", { setupAt: "" });
    expect(stored("lib_set").setupAt).toBe("2026-11-18T09:00:00.000Z");
  });

  it("organize Standard is stored as own; a PATCH without organize keeps it", async () => {
    await patch("lib_set", { organize: "default" });
    expect(stored("lib_set").organize).toBe("own");
    await patch("lib_set", { organize: "ai" });
    await patch("lib_set", { describe: true });
    expect(stored("lib_set")).toMatchObject({ organize: "ai" });
  });
});
