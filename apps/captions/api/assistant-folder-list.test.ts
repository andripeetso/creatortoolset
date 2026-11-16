// The assistant's folder_list route (POST /api/assistant/folder-list): which folders it may look in, and the two
// setups, a server on the person's own computer that walks the folder itself and a hosted one that has their Mac do it.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { DeviceJob } from "../contracts/devices";

const dir = realpathSync(mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "assistant-folder-list-")));
process.env.DATA_DIR = path.join(dir, "data");
delete process.env.APP_SECRET;
const { assistantApp } = await import("./assistant");
const { devicesApp } = await import("./devices");
const { isOnline, pairDevice, touchDevice } = await import("./lib/devices");
const { mountPlugins } = await import("./lib/plugin");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => delete process.env.CT_MODE);

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  if (!c.req.path.startsWith("/api/devices/relay/")) c.set("user", { username: "ana", role: "admin" } as never);
  return next();
});
app.route("/api/assistant", assistantApp);
app.route("/api/devices", devicesApp);

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const list = (body: unknown) => post("/api/assistant/folder-list", body);

const shoot = path.join(dir, "Tiny Acrobatics", "SHOOT");
mkdirSync(path.join(shoot, "FOOTAGE", "MUSIC"), { recursive: true });
writeFileSync(path.join(shoot, "FOOTAGE", "MUSIC", "tiny-acrobatics-theme.m4a"), "abc");
writeFileSync(path.join(shoot, "take1.mp4"), "abc");
const keep = (folders: { host: string; path: string }[]) => {
  mkdirSync(path.join(process.env.DATA_DIR!, "storage"), { recursive: true });
  writeFileSync(
    path.join(process.env.DATA_DIR!, "storage", "ana.json"),
    JSON.stringify({ folders: folders.map((origin, i) => ({ id: `f${i}`, role: "footage", name: path.basename(origin.path), origin, make: false, createdAt: 1, reach: {} })) }),
  );
};

describe("folder_list on the person's own computer", () => {
  it("with no folder in Settings → Folders, does not search the drives and says where to set one", async () => {
    keep([]);
    const r = await list({ path: shoot, match: "song" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/no folders in Settings → Folders yet.*\/settings\/folders/);
  });

  it("looks inside a workspace folder and its subfolders, and finds the song by match", async () => {
    keep([{ host: "this-computer", path: path.join(dir, "Tiny Acrobatics") }]);
    const r = (await (await list({ path: shoot, match: "song" })).json()) as { folder: string; entries: { path: string; kind: string }[] };
    expect(r.folder).toBe(shoot);
    expect(r.entries).toEqual([{ path: "FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a", type: "file", kind: "audio", size: 3 }]);
  });

  it("refuses a folder that is not the workspace's or the chat's", async () => {
    keep([{ host: "this-computer", path: shoot }]);
    const r = await list({ path: path.join(dir, "Tiny Acrobatics") });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("not one of this workspace's");
    expect((await list({ path: `${shoot}/../..` })).status).toBe(400);
  });
});

describe("folder_list on a hosted server", () => {
  it("has the Storage folder's own Mac walk it, and only that Mac can answer", async () => {
    process.env.CT_MODE = "hosted";
    const mac = pairDevice("ana", "Ana's Mac");
    const other = pairDevice("bo", "Bo's Mac");
    keep([{ host: mac.device.id, path: "/Volumes/Tiny/SHOOT" }]);
    const as = (t: string) => ({ authorization: `Bearer ${t}` });
    const claim = async (token: string) => ((await (await post("/api/devices/relay/editor/claim", { kinds: ["folder-list"] }, as(token))).json()) as { job: DeviceJob | null }).job;
    expect(await claim(mac.token)).toBeNull(); // on, and saying it takes folder listings

    const asked = list({ path: "/Volumes/Tiny/SHOOT", match: "song", depth: 3 });
    let job: DeviceJob | null = null;
    for (let i = 0; i < 50 && !job; i++) {
      expect(await claim(other.token)).toBeNull();
      job = await claim(mac.token);
      if (!job) await new Promise((r) => setTimeout(r, 20));
    }
    expect(job).toMatchObject({ kind: "folder-list", options: { path: "/Volumes/Tiny/SHOOT", depth: "3", disk: "1" } });
    const url = `/api/devices/relay/job/folder-list/${job!.id}`;
    expect((await post(url, { entries: [] }, as(other.token))).status).toBe(404);
    const walk = { entries: [{ path: "FOOTAGE", dir: true }, { path: "FOOTAGE/MUSIC", dir: true }, { path: "FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a", size: 3 }, { path: "../escape.m4a", size: 1 }], deeper: 0 };
    expect((await post(url, walk, as(mac.token))).status).toBe(200);
    const r = (await (await asked).json()) as { entries: unknown[]; looked_at: number };
    expect(r.entries).toEqual([{ path: "FOOTAGE/MUSIC/tiny-acrobatics-theme.m4a", type: "file", kind: "audio", size: 3 }]);
    expect(r.looked_at).toBe(3);
  });

  it("says how long the Mac that holds it has been quiet, never why, instead of waiting", async () => {
    process.env.CT_MODE = "hosted";
    const mac = pairDevice("ana", "Ana's Old Mac");
    keep([{ host: mac.device.id, path: "/Volumes/Tiny/SHOOT" }]);
    const r = await list({ path: "/Volumes/Tiny/SHOOT/FOOTAGE" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("Ana's Old Mac hasn't answered yet.");
  });

  it("waits for a Mac heard from a moment ago (an update restarts the app), and it walks the folder when back", async () => {
    process.env.CT_MODE = "hosted";
    const mac = pairDevice("ana", "Ana's Restarting Mac");
    keep([{ host: mac.device.id, path: "/Volumes/Tiny/SHOOT" }]);
    const claim = async () => ((await (await post("/api/devices/relay/editor/claim", { kinds: ["folder-list"] }, { authorization: `Bearer ${mac.token}` })).json()) as { job: DeviceJob | null }).job;
    expect(await claim()).toBeNull(); // it takes folder listings
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 50_000 });
    touchDevice(mac.device.id); // last heard from 50 s ago: not on now
    vi.useRealTimers();
    expect(isOnline(mac.device.id)).toBe(false);
    const asked = list({ path: "/Volumes/Tiny/SHOOT/FOOTAGE" });
    let job: DeviceJob | null = null;
    for (let i = 0; i < 50 && !job; i++) {
      job = await claim(); // back: its first poll claims the walk that waited
      if (!job) await new Promise((r) => setTimeout(r, 20));
    }
    expect((await post(`/api/devices/relay/job/folder-list/${job!.id}`, { entries: [] }, { authorization: `Bearer ${mac.token}` })).status).toBe(200);
    expect((await asked).status).toBe(200);
  });
});

describe("folder_list with a plug-in's own folders", () => {
  it("counts a folder a plug-in keeps as the workspace's, and any Mac of theirs walks it when its computer is named in the plug-in's own words", async () => {
    process.env.CT_MODE = "hosted";
    keep([]);
    mountPlugins(new Hono(), [{ id: "tiny-storage", routes: new Hono(), storageFolders: async (u: string) => (u === "ana" ? [{ id: "p1", role: "footage", name: "SHOOT", origin: { host: "tiny-mac.local", path: "/Volumes/Tiny/SHOOT" }, make: false, createdAt: 1, reach: {} }] : []) } as never]);
    const mac = pairDevice("ana", "Ana's Studio Mac");
    const as = { authorization: `Bearer ${mac.token}` };
    const claim = async () => ((await (await post("/api/devices/relay/editor/claim", { kinds: ["folder-list"] }, as)).json()) as { job: DeviceJob | null }).job;
    expect(await claim()).toBeNull();
    const asked = list({ path: "/Volumes/Tiny/SHOOT", match: "song" });
    let job: DeviceJob | null = null;
    for (let i = 0; i < 50 && !job; i++) {
      job = await claim();
      if (!job) await new Promise((r) => setTimeout(r, 20));
    }
    expect(job).toMatchObject({ kind: "folder-list", options: { path: "/Volumes/Tiny/SHOOT" } });
    await post(`/api/devices/relay/job/folder-list/${job!.id}`, { entries: [{ path: "MUSIC", dir: true }, { path: "MUSIC/theme.m4a", size: 3 }], deeper: 0 }, as);
    expect(((await (await asked).json()) as { entries: unknown[] }).entries).toEqual([{ path: "MUSIC/theme.m4a", type: "file", kind: "audio", size: 3 }]);
    mountPlugins(new Hono(), []);
  });
});
