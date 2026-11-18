import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkClaim, WorkPackage } from "../../contracts/work";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "work-cache-"));
process.env.DATA_DIR = dir;

const { cacheReport, emptyCache, keptOffline, proxiesDir, proxyPath, partPath, setCacheAccount, setKeptOffline, touchProxy, trimCache } = await import("./cache");
const { keepOffline, startComputerWorker } = await import("./computer");
const { STEPS } = await import("../editor/worker");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
setCacheAccount("tinyacrobatics");

/** A proxy of `bytes` in the cache, last used `ago` seconds back. */
const proxy = (id: string, bytes: number, ago = 0) => {
  mkdirSync(proxiesDir(), { recursive: true });
  writeFileSync(proxyPath(id), Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ago * 1000);
  utimesSync(proxyPath(id), t, t);
};
const cached = () => cacheReport()!.versions!.sort();

beforeEach(() => {
  rmSync(proxiesDir(), { recursive: true, force: true });
  setKeptOffline([]);
  delete process.env.CT_PROXY_LIMIT;
});

describe("the proxy cache", () => {
  it("keeps everything with no limit, and reports its size, limit, offline list and versions", () => {
    proxy("va", 10, 300);
    proxy("vb", 20, 200);
    writeFileSync(partPath("vc"), Buffer.alloc(5));
    expect(trimCache()).toEqual([]);
    setKeptOffline(["va"]);
    process.env.CT_PROXY_LIMIT = "1000";
    expect(cacheReport()).toEqual({ bytes: 35, limit: 1000, offline: ["va"], versions: expect.arrayContaining(["va", "vb"]), parts: ["vc"] });
  });

  it("over the limit, the least recently used go first, never one kept offline", () => {
    proxy("oldest", 10, 400);
    proxy("older", 10, 300);
    proxy("old", 10, 200);
    proxy("new", 10, 100);
    setKeptOffline(["oldest"]);
    process.env.CT_PROXY_LIMIT = "25";
    expect(trimCache()).toEqual(["older", "old"]);
    expect(cached()).toEqual(["new", "oldest"]);
  });

  it("a proxy a step used is the last to go", () => {
    proxy("a", 10, 400);
    proxy("b", 10, 300);
    touchProxy(proxyPath("a"));
    expect(trimCache(15, new Set())).toEqual(["b"]);
    touchProxy(path.join(dir, "elsewhere.mp4")); // a file outside the cache is never touched
  });

  it("Empty empties it, unfinished downloads too, but keeps what is kept offline", () => {
    proxy("va", 10);
    proxy("vb", 10);
    writeFileSync(partPath("vc"), Buffer.alloc(5));
    writeFileSync(partPath("va"), Buffer.alloc(5));
    setKeptOffline(["va"]);
    emptyCache();
    expect(cached()).toEqual(["va"]);
    expect(existsSync(partPath("vc"))).toBe(false);
    expect(existsSync(partPath("va"))).toBe(true);
  });
});

describe("the worker and its cache", () => {
  const R = "/api/devices/relay";
  let claims: WorkClaim[] = [];
  let bodies: { cache?: unknown }[] = [];
  let got: string[] = [];
  const fake = new Hono()
    .post(`${R}/work/claim`, async (c) => (bodies.push(await c.req.json()), c.json(claims.shift() ?? { pkg: null, update: true })))
    .post(`${R}/work/:id/:what`, (c) => c.json({ ok: true }))
    .put(`${R}/work/:id/file`, (c) => c.json({ ok: true }))
    .get(`${R}/editor/job/:id/footage/:v`, (c) => (got.push(`footage ${c.req.param("v")}`), c.body("proxy")))
    .get(`${R}/work/offline/:v`, (c) => (got.push(`offline ${c.req.param("v")}`), c.body("kept!")));
  const o = { server: "http://server.test", token: "ctd_test", fetch: (u: string, i?: RequestInit) => Promise.resolve(fake.request(u, i)), beatMs: 20, downloadBeatMs: 20, retryMs: 10 };
  const EDIT = "0b6f3c2a-1d2e-4f50-8a9b-0c1d2e3f4a5b";
  const pkg: WorkPackage = {
    v: 1,
    job: { id: 11, kind: "preview", editId: EDIT, variant: "v1", actor: "tinyacrobatics", workspaceId: "ws1" },
    edit: { "edit.json": JSON.stringify({ id: EDIT, name: "Tiny Acrobatics", sources: [], createdBy: "tinyacrobatics", workspaceId: "ws1" }) },
    own: [],
    rows: {},
    files: [{ id: "va", title: "a.mov", bytes: 1000, proxy: { bytes: 5 } }],
    caches: {},
    ai: { editor: null, analyzer: null },
  };
  const saved = { ...STEPS };
  beforeEach(() => {
    bodies = [];
    got = [];
    STEPS.preview = async () => {};
  });
  afterEach(() => Object.assign(STEPS, saved));

  it("emptied: the next job downloads its proxy again (PRD test 6)", async () => {
    proxy("va", 5);
    claims = [{ pkg }, { pkg: null, empty: true }, { pkg }];
    expect(await startComputerWorker(o)).toBe("update");
    // the first job used the cached proxy; Empty removed it; the second downloaded it again
    expect(got).toEqual(["footage va"]);
    expect(bodies[0]!.cache).toMatchObject({ bytes: 5, versions: ["va"] });
    expect(bodies[2]!.cache).toMatchObject({ bytes: 0, versions: [] });
    expect(bodies[3]!.cache).toMatchObject({ bytes: 5, versions: ["va"] });
  });

  it("deletes each proxy the server says to drop, its unfinished download too, kept offline or not", async () => {
    proxy("va", 5);
    proxy("vb", 5);
    writeFileSync(partPath("va"), Buffer.alloc(2));
    writeFileSync(partPath("vc"), Buffer.alloc(2));
    setKeptOffline(["va"]);
    claims = [{ pkg: null, drop: ["va", "vc", "../vb"] }];
    expect(await startComputerWorker(o)).toBe("update");
    // the claim asked about every version it holds bytes of, the unfinished downloads apart
    expect(bodies[0]!.cache).toMatchObject({ versions: expect.arrayContaining(["va", "vb"]), parts: expect.arrayContaining(["va", "vc"]) });
    expect(cached()).toEqual(["vb"]);
    expect([partPath("va"), partPath("vc")].filter(existsSync)).toEqual([]);
    expect(bodies[1]!.cache).toMatchObject({ bytes: 5, versions: ["vb"] });
    expect(bodies[1]!.cache).not.toHaveProperty("parts");
  });

  it("one cache per account: a second account on this computer never sees the first's proxies, and the old shared folder goes", async () => {
    // the cache from before there was one per account: whose it was is unknown
    mkdirSync(path.join(dir, "proxies"), { recursive: true });
    writeFileSync(path.join(dir, "proxies", "vold.mp4"), "old");
    writeFileSync(path.join(dir, "proxies", "vold.mp4.part"), "o");
    writeFileSync(path.join(dir, "offline.json"), JSON.stringify(["vold"]));
    // a second account signs in on this computer: its worker is a new process, its account unknown until a claim answers
    vi.resetModules();
    const bo = { computer: await import("./computer"), cache: await import("./cache"), steps: (await import("../editor/worker")).STEPS };
    bo.steps.preview = async () => {};
    proxy("va", 5); // the first account's proxy of the same clip
    claims = [{ pkg: null, account: "bo" }, { pkg, account: "bo" }];
    expect(await bo.computer.startComputerWorker(o)).toBe("update");
    expect(bodies[0]!.cache).toBeUndefined(); // nothing reported before the server named the account
    expect(bodies[1]!.cache).toEqual({ bytes: 0, limit: 25 * 1024 ** 3, versions: [] }); // the first account's proxy is not its
    expect(got).toEqual(["footage va"]); // so its step downloads its own copy
    expect(bodies[2]!.cache).toMatchObject({ bytes: 5, versions: ["va"] });
    expect(bo.cache.proxiesDir()).toBe(path.join(dir, "proxies", "bo"));
    expect(proxiesDir()).toBe(path.join(dir, "proxies", "tinyacrobatics"));
    expect(existsSync(proxyPath("va")) && existsSync(bo.cache.proxyPath("va"))).toBe(true);
    for (const f of ["proxies/vold.mp4", "proxies/vold.mp4.part", "offline.json"]) expect(existsSync(path.join(dir, f))).toBe(false);
    // and Empty on one account's computer leaves the other's
    bo.cache.emptyCache();
    expect(cached()).toEqual(["va"]);
  });

  it("keeps the server's offline list, downloads a missing one while idle, and the limit never removes it", async () => {
    process.env.CT_PROXY_LIMIT = "1";
    claims = [{ pkg: null, offline: [{ id: "vk", title: "kept.mov", bytes: 5 }] }];
    expect(await startComputerWorker(o)).toBe("update");
    expect(keptOffline()).toEqual(["vk"]);
    expect(got).toEqual(["offline vk"]);
    expect(trimCache()).toEqual([]);
    expect(cached()).toEqual(["vk"]);
    // already there: nothing downloads again
    expect(await keepOffline([{ id: "vk", title: "kept.mov", bytes: 5 }], o)).toBe(false);
  });
});
