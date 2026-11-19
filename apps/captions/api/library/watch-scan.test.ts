import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// Look for new files on a server that reads this computer's folders itself (the Library ⋯ menu): a scan now, its count,
// and the new files still settling (a copy still being written goes in once it stops changing).

const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-watch-scan-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { watchApp, startWatchFolders } = await import("./watch");
afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", watchApp);
const scan = (user: string) => app.request("/api/library/lib_s/watch/scan", { method: "POST", headers: { "x-user": user } });

const watched = path.join(dir, "Tiny Acrobatics footage");
mkdirSync(watched, { recursive: true });
mkdirSync(path.join(process.env.DATA_DIR!, "storage"), { recursive: true });
writeFileSync(
  path.join(process.env.DATA_DIR!, "storage", "owner-s.json"),
  JSON.stringify({ schemaVersion: 3, folders: [{ id: "s", role: "footage", name: "footage", origin: { host: "this-computer", path: watched }, make: true, createdAt: 0, reach: {} }] }),
);
libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_s', 'owner-s', 'S', 'local', 0)").run();
startWatchFolders();

describe("POST /:id/watch/scan", () => {
  it("only the owner; a server that doesn't read the folders says the Mac app looks in them", async () => {
    expect((await scan("stranger")).status).toBe(404);
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    const away = await scan("owner-s");
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(away.status).toBe(409);
  });

  it("reads the folders now: a file just put there is counted as coming in, not as nothing new", async () => {
    expect(await (await scan("owner-s")).json()).toEqual({ added: 0, settling: 0 });
    writeFileSync(path.join(watched, "tiny-roll.mp4"), "x");
    expect(await (await scan("owner-s")).json()).toEqual({ added: 0, settling: 1 });
  });
});
