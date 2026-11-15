import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthVars } from "../auth";

// A folder copied into the library folder on this computer: subfolders kept, never over another file, then read there.

const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-watch-copy-")));
process.env.DATA_DIR = path.join(dir, "data");
process.env.LIBRARY_WATCH_FOLDERS = "1";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const { libraryDb } = await import("./db");
const { watchApp, scanWatchFolders, copyInto, copyTarget, SETTLE_MS } = await import("./watch");

afterAll(() => {
  delete process.env.LIBRARY_WATCH_FOLDERS;
  delete process.env.LIBRARY_DISK_RESERVE_GB;
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: "owner-c", role: "member" } as never);
  return next();
});
app.route("/api/library", watchApp);

const card = path.join(dir, "Card 1");
const footage = path.join(dir, "Creator Toolset", "Footage");

beforeAll(() => {
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
  mkdirSync(path.join(card, "Day 2"), { recursive: true });
  writeFileSync(path.join(card, "Day 2", "Jump.mp4"), "tiny acrobatics jump");
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_c', 'owner-c', 'C', 'local', 0)").run();
});

describe("copying a folder into the library folder", () => {
  it("keeps the subfolders and the dates, never writes over another file, and takes up again where it stopped", async () => {
    const src = path.join(card, "Day 2", "Jump.mp4");
    const size = statSync(src).size;
    const taken = path.join(footage, "Card 1", "Day 2", "Jump.mp4");
    // someone else's file already has the name
    mkdirSync(path.dirname(taken), { recursive: true });
    writeFileSync(taken, "another clip");
    const copy = await copyInto(card, footage, src, size);
    expect(copy).toBe(path.join(footage, "Card 1", "Day 2", "Jump 2.mp4"));
    expect(readFileSync(taken, "utf-8")).toBe("another clip");
    expect(readFileSync(copy, "utf-8")).toBe("tiny acrobatics jump");
    expect(Math.floor(statSync(copy).mtimeMs)).toBe(Math.floor(statSync(src).mtimeMs));
    expect(readdirSync(path.dirname(copy)).filter((n) => n.startsWith("."))).toEqual([]); // no half copy left
    // the same file again (a restart before it was taken): the copy already there
    expect(await copyInto(card, footage, src, size)).toBe(copy);
    expect(readFileSync(src, "utf-8")).toBe("tiny acrobatics jump"); // the original is never touched
    rmSync(path.join(footage, "Card 1"), { recursive: true });
  });

  it("refuses a copy into the folder itself, and a folder already in the library folder", async () => {
    const data = path.join(dir, "data");
    expect(await copyTarget(card, path.join(card, "Copies"), data)).toEqual({ error: "The copy can't go inside the folder it copies" });
    mkdirSync(path.join(footage, "Trip"), { recursive: true });
    expect(await copyTarget(path.join(footage, "Trip"), footage, data)).toMatchObject({ error: expect.stringMatching(/in that folder already/) });
    expect(await copyTarget(card, footage, data)).toBe(footage);
  });

  it("a watched folder with a copy: the clip is read from the copy, and the folder is fine once its card is out", async () => {
    const r = await app.request("/api/library/watch/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: card, libraryId: "lib_c", copyTo: footage }),
    });
    expect(r.status).toBe(200);
    const t0 = Date.now();
    utimesSync(path.join(card, "Day 2", "Jump.mp4"), new Date(t0), new Date(t0));
    await scanWatchFolders(t0);
    expect(await scanWatchFolders(t0 + SETTLE_MS)).toBe(1);
    const v = libraryDb().prepare("SELECT source_path FROM asset_versions").get() as { source_path: string };
    expect(v.source_path).toBe(path.join(footage, "Card 1", "Day 2", "Jump.mp4"));
    rmSync(card, { recursive: true }); // the card is taken out
    const status = (await (await app.request("/api/library/lib_c/watch")).json()) as { folders: { found: boolean; copyTo?: string }[]; copyTo?: string };
    expect(status.folders[0]).toMatchObject({ found: true, copyTo: footage });
    expect(status.copyTo).toMatch(/Creator Toolset\/Footage$/); // the default for the next folder
    expect(existsSync(v.source_path)).toBe(true);
  });
});
