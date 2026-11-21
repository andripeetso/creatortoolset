import { afterEach, describe, expect, it, vi } from "vitest";
import { askMediaFolder, localFileState, localFilesOverlap, localMediaFiles, localMediaUrl, pathLine, placesState, readLocalFile } from "./local-files";

afterEach(() => vi.unstubAllGlobals());

describe("a recording's files in an app whose scheme takes one request at a time", () => {
  it("reads one file at a time: the next starts when the one before has ended, even if that one failed", async () => {
    const started: string[] = [];
    const finish: Record<string, (ok: boolean) => void> = {};
    vi.stubGlobal("fetch", (url: string) => {
      started.push(url);
      return new Promise((resolve) => {
        finish[url] = (ok) => resolve({ ok, status: ok ? 200 : 404, blob: async () => new Blob([url]) });
      });
    });
    const a = readLocalFile("ctlocal://x/screen.mp4");
    const b = readLocalFile("ctlocal://x/screen-look.json");
    const c = readLocalFile("ctlocal://x/screen-events.json");
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["ctlocal://x/screen.mp4"]); // the other two wait
    finish["ctlocal://x/screen.mp4"](true);
    expect(await (await a).text()).toBe("ctlocal://x/screen.mp4");
    await vi.waitFor(() => expect(started).toHaveLength(2));
    finish["ctlocal://x/screen-look.json"](false); // no look saved yet
    await expect(b).rejects.toThrow("404");
    await vi.waitFor(() => expect(started).toHaveLength(3));
    finish["ctlocal://x/screen-events.json"](true);
    expect((await c).size).toBeGreaterThan(0);
  });

  it("knows the app that takes requests at once by its mark", () => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    expect(localFilesOverlap()).toBe(false); // 0.14.0 and before: no mark
    vi.stubGlobal("document", { documentElement: { dataset: { macLocalFiles: "2" } } });
    expect(localFilesOverlap()).toBe(true);
    expect(localMediaFiles()).toBe(false);
    vi.stubGlobal("document", { documentElement: { dataset: { macLocalFiles: "3" } } });
    expect(localFilesOverlap()).toBe(true);
    expect(localMediaFiles()).toBe(true);
  });
});

describe("original media files from the Mac app", () => {
  it("encodes the path as base64url with no padding (the same vector as apps/mac MediaFilesTests)", () => {
    const path = "/Volumes/Footage/Põhja rannik/A001 õhtu.MOV";
    expect(localMediaUrl(path)).toBe("ctlocal://media/L1ZvbHVtZXMvRm9vdGFnZS9Qw7VoamEgcmFubmlrL0EwMDEgw7VodHUuTU9W");
    for (const p of [path, "/a/b.wav", "/x/y z/ü?.mov", "/a/b.mp4"]) {
      expect(localMediaUrl(p)).toBe(`ctlocal://media/${Buffer.from(p).toString("base64url")}`);
    }
  });

  it("asks the app for a folder, and gets nothing outside it", async () => {
    vi.stubGlobal("window", {});
    expect(await askMediaFolder("/Volumes/Footage")).toEqual([]);
    const postMessage = vi.fn(async () => ({ granted: ["/Volumes"] }));
    vi.stubGlobal("window", { webkit: { messageHandlers: { mediaAccess: { postMessage } } } });
    expect(await askMediaFolder("/Volumes/Footage")).toEqual(["/Volumes"]);
    expect(postMessage).toHaveBeenCalledWith({ ask: "/Volumes/Footage" });
  });
});

describe("what the Mac app says of a file", () => {
  it("a drive away: the 409 names the drive; 403 is not allowed; 404 not there", async () => {
    const answer = (status: number, body?: unknown) => vi.stubGlobal("fetch", async () => ({ status, json: async () => body, body: null }));
    answer(409, { state: "disk_away", disk: "Tiny Drive" });
    const a = await localFileState("ctlocal://media/x");
    expect(a).toEqual({ state: "disk_away", disk: "Tiny Drive" });
    expect(pathLine(a)).toBe("Tiny Drive isn't connected");
    answer(403);
    expect(pathLine(await localFileState("ctlocal://media/x"))).toBe("Needs your OK");
    answer(404);
    expect(pathLine(await localFileState("ctlocal://media/x"))).toBeUndefined();
  });

  it("placesState: a file that needs an OK in a folder set for this Mac is allowed and asked again; another computer's waits", async () => {
    const asked: unknown[] = [];
    let ok = false;
    vi.stubGlobal("document", { documentElement: { dataset: { macDevice: "mac1" } } });
    vi.stubGlobal("fetch", async (url: string) => ({ ok: url === "/api/devices/storage", json: async () => ({ folders: [
      { id: "f1", origin: { host: "mac1", path: "/Volumes/X/FOOTAGE" } }, { id: "f2", origin: { host: "pc2", path: "/Volumes/X/OTHER" } }] }) }));
    vi.stubGlobal("window", { webkit: { messageHandlers: { mediaAccess: { postMessage: async (b: Record<string, unknown>) => {
      asked.push(b);
      if (b.folderGrant) return { granted: (ok = true) };
      return { states: { "/Volumes/X/FOOTAGE/a.mov": ok ? "here" : "needs_ok" } };
    } } } } });
    // two asks at once (an effect run twice) share one allow, and both get the answer after it
    const both = await Promise.all([placesState(["/Volumes/X/FOOTAGE/a.mov"]), placesState(["/Volumes/X/FOOTAGE/a.mov"])]);
    expect(both).toEqual([0, 1].map(() => ({ states: { "/Volumes/X/FOOTAGE/a.mov": "here" }, disks: {} })));
    expect(asked.filter((b) => (b as { folderGrant?: unknown }).folderGrant)).toEqual([{ folderGrant: { path: "/Volumes/X/FOOTAGE", folder: "f1" } }]);
    vi.unstubAllGlobals();
  });

  it("placesState: null outside the app and from an app that doesn't answer it", async () => {
    vi.stubGlobal("window", {});
    expect(await placesState(["/a.mov"])).toBeNull();
    vi.stubGlobal("window", { webkit: { messageHandlers: { mediaAccess: { postMessage: async () => ({ granted: [] }) } } } });
    expect(await placesState(["/a.mov"])).toBeNull();
    vi.stubGlobal("window", { webkit: { messageHandlers: { mediaAccess: { postMessage: async () => ({ states: { "/a.mov": "here" } }) } } } });
    expect(await placesState(["/a.mov"])).toEqual({ states: { "/a.mov": "here" }, disks: {} });
  });
});
