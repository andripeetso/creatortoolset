import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FileRow } from "../editor/reach";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-downloads-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "work-downloads-test-secret";

const { createUser, setOff } = await import("../users");
const app = (await import("../boot")).default;
const { atFor } = await import("../editor/reach");
const { downloadsAllow, downloadsOf, offlineOf } = await import("./offline");
const { cacheLimit, CACHE_LIMIT_DEFAULT } = await import("./cache");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

let cookie: string;
beforeAll(async () => {
  setOff(createUser("pat", "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "pat", password: "password1" }) });
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

const put = (body: unknown) =>
  app.request("/api/library/offline/downloads", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

/** A file the server holds only as a proxy, in library `lib_d` (no computer reads it). */
const copyOnly: FileRow = { id: "v1", source_key: "k", source_path: null, mac_path: null, mac_device: null, proxy: "p", library_id: "lib_d" };
const pc = { folders: [] as never[], here: () => false };

describe("Downloads (UNIFIED-PRD M13)", () => {
  it("with no entry, Automatic downloads is on; an old Keep-on-this-computer entry reads as all with proxies", () => {
    expect(downloadsOf({ versions: [], collections: [] }, "lib_d")).toEqual({ mode: "needed" });
    expect(downloadsOf({ versions: [], collections: [], libraries: ["lib_d"] }, "lib_d")).toEqual({ mode: "all", proxies: true });
  });

  it("a stored mode is the one read; none stops the server's copies", () => {
    const list = { versions: [], collections: [], downloads: { lib_d: { mode: "none" as const } } };
    expect(downloadsOf(list, "lib_d")).toEqual({ mode: "none" });
    expect(downloadsAllow("pat", "lib_d")).toBe(true); // nothing written for pat yet
  });

  it("the route refuses a body it can't read and a library the person can't read, writing nothing", async () => {
    expect((await put({ library: "lib_d", mode: "sometimes" })).status).toBe(400);
    expect((await put({ library: "lib_d", mode: "all", proxies: true })).status).toBe(404);
    expect(offlineOf("pat").downloads).toBeUndefined();
  });
});

describe("a server copy is fetched only when the server won't run the step and Downloads allows it", () => {
  const writeDownloads = (downloads: Record<string, unknown>) => {
    mkdirSync(path.join(dir, "offline"), { recursive: true });
    writeFileSync(path.join(dir, "offline", "pat.json"), JSON.stringify({ versions: [], collections: [], downloads }));
  };

  it("Downloads needed: the computer takes the copy", () => {
    writeDownloads({ lib_d: { mode: "needed" } });
    expect(atFor(copyOnly, "pc", pc.folders, "pat", false)).toEqual({ copy: "proxy" });
  });

  it("Downloads none: no copy, the step waits or goes to the server", () => {
    writeDownloads({ lib_d: { mode: "none" } });
    expect(atFor(copyOnly, "pc", pc.folders, "pat", false)).toBeNull();
  });

  it("Server rendering takes the step, so no copy whatever Downloads says", () => {
    writeDownloads({ lib_d: { mode: "all", proxies: true } });
    expect(atFor(copyOnly, "pc", pc.folders, "pat", true)).toBeNull();
  });

  it("a file read where it is never needs Downloads", () => {
    writeDownloads({ lib_d: { mode: "none" } });
    const onDisk = { ...copyOnly, source_key: "mac:v", mac_path: "/Users/tiny/a.mp4", mac_device: "pc" };
    expect(atFor(onDisk, "pc", pc.folders, "pat", false)).toEqual({ path: "/Users/tiny/a.mp4" });
  });

  it("the cache limit is 25 GB, or CT_PROXY_LIMIT when set", () => {
    delete process.env.CT_PROXY_LIMIT;
    expect(cacheLimit()).toBe(CACHE_LIMIT_DEFAULT);
    process.env.CT_PROXY_LIMIT = "1073741824";
    expect(cacheLimit()).toBe(1073741824);
    delete process.env.CT_PROXY_LIMIT;
  });
});
