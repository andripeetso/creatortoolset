import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { LibrarySummary } from "../../contracts/library";
import type { AuthVars } from "../auth";

// Setup's Done, as the page sends it (src/pages/library/Setup.tsx): the answers saved must come back in the library the
// page reads, setupAt above all, or the page keeps showing the setup (the 11-19 "Done does nothing").

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-setup-done-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "tiny", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_done', 'tiny', 'Tiny', 'local', ?, 0)").run(JSON.stringify({ organize: "ai" }));

describe("setup's Done", () => {
  it("comes back with setupAt and every answer, in the PATCH reply and in the list the page loads", async () => {
    const answers = { organize: "ai", proxy: false, proxyQuality: "high", transcribe: true, defaultFolders: false, setupAt: "2026-11-19T09:00:00.000Z", upload: "none", finalsUpload: "none" };
    const r = await app.request("/api/library/lib_done", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: answers }) });
    expect(r.status).toBe(200);
    const saved = ((await r.json()) as LibrarySummary).settings;
    expect(saved).toMatchObject({ setupAt: "2026-11-19T09:00:00.000Z", proxy: false, proxyQuality: "high", defaultFolders: false, upload: "none", finalsUpload: "none" });
    const list = (await (await app.request("/api/library")).json()) as { libraries: LibrarySummary[] };
    expect(list.libraries.find((l) => l.id === "lib_done")?.settings.setupAt).toBe("2026-11-19T09:00:00.000Z");
  });

  it("a library never set up has no setupAt", async () => {
    libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES ('lib_new', 'tiny', 'New', 'local', '{}', 0)").run();
    const r = await app.request("/api/library/lib_new", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { proxy: true } }) });
    expect(((await r.json()) as LibrarySummary).settings).not.toHaveProperty("setupAt");
  });
});
