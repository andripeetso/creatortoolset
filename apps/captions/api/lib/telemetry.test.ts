import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "telemetry-"));
process.env.APP_SECRET = "telemetry-secret";
vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));

const t = await import("./telemetry");
const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;

const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).startsWith("https://ping.test")) {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(null, { status: 204 });
  }
  return realFetch(url, init);
});
vi.stubGlobal("fetch", fakeFetch);
process.env.CT_PING_URL = "https://ping.test/api/ping";

const admin = `Bearer ${newApiKey(createUser("ana", "password1", { role: "admin" }), "full")}`;
const req = (method: string, p: string, body?: unknown) =>
  app.request(p, { method, headers: { authorization: admin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

afterEach(() => {
  sent.length = 0;
  delete process.env.CT_CHANNEL;
});

describe("usage and crash reports", () => {
  it("send nothing outside a release build", async () => {
    t.notePage("workshop");
    await t.sendCheckin();
    t.reportCrash("server", new Error("boom"));
    expect(sent).toEqual([]);
    expect(await (await req("GET", "/api/telemetry")).json()).toEqual({ available: false, on: false });
  });

  it("a check-in carries page counts by known names only, then starts again from zero", async () => {
    process.env.CT_CHANNEL = "release";
    for (const p of ["workshop", "workshop", "home", "my-secret-plugin"]) expect((await req("POST", "/api/telemetry/view", { page: p })).status).toBe(204);
    await t.sendCheckin();
    expect(sent).toHaveLength(1);
    const b = sent[0].body;
    expect(b.id).toMatch(/^[a-f0-9]{32}$/);
    expect(b).toMatchObject({ opened: 4, connected: false, tools: { workshop: 2, home: 1, other: 1 } });
    expect(Array.isArray(b.ai)).toBe(true);
    await t.sendCheckin();
    expect(sent[1].body).toMatchObject({ opened: 0, tools: {} });
  });

  it("a check-in carries what failed since the last one, with no account, id or file path", async () => {
    process.env.CT_CHANNEL = "release";
    const { noteFailure } = await import("./failures");
    const route = "POST /api/projects/:id/export";
    noteFailure("ana", "request", "POST /api/projects/k3x9q/export", { status: 500, error: `no file ${homedir()}/Movies/Tia.mov`, route });
    noteFailure("bo", "request", "POST /api/projects/zz81/export", { status: 500, error: `no file ${homedir()}/Movies/Tia.mov`, route });
    noteFailure("ana", "work", "Audio Enhancer", { error: "engine down" });
    await t.sendCheckin();
    expect(sent[0].body.failed).toEqual([
      { kind: "request", what: "POST /api/projects/:id/export", status: 500, count: 2 },
      { kind: "work", what: "Audio Enhancer", count: 1 },
    ]);
    expect(JSON.stringify(sent[0].body)).not.toMatch(/ana|Tia/);
    await t.sendCheckin();
    expect(sent[1].body.failed).toBeUndefined();
  });

  it("a check-in counts actions by their route, never the path asked for, and says how big the Media Library is", async () => {
    process.env.CT_CHANNEL = "release";
    await t.sendCheckin(); // what the tests before left
    await t.sendEvents();
    sent.length = 0;
    await req("PUT", "/api/telemetry/nothing-here"); // its own routes are never counted
    await req("DELETE", "/api/exports/Tia-wedding"); // a real request: counted by its route
    t.noteAction("POST", "/api/library/assets/:id/tags");
    t.noteAction("POST", "/api/library/assets/:id/tags");
    t.noteAction("GET", "/api/library/assets/:id"); // a read
    t.noteAction("GET", "/api/exports"); // a list read again and again, not an export
    t.noteAction("GET", "/api/drafts/:name/export");
    await t.sendCheckin();
    expect(sent[0].body.actions).toEqual({ "DELETE /api/exports/:id": 1, "POST /api/library/assets/:id/tags": 2, "GET /api/drafts/:name/export": 1 });
    expect(sent[0].body.library).toEqual({ clips: 0, hours: 0, gb: 0 });
  });

  it("events go in batches to /events with the time each happened, and wait for the next batch when the site is down", async () => {
    process.env.CT_CHANNEL = "release";
    await t.sendCheckin(); // what the tests before left
    await t.sendEvents();
    sent.length = 0;
    t.track("ai run", { job: "Caption Studio", model: "claude-sonnet-5-5", tokens: 1200 }, 1_000);
    t.track("export", { ok: false, seconds: 12 }, 2_000);
    fakeFetch.mockImplementationOnce(async () => new Response(null, { status: 503 }));
    await t.sendEvents();
    await t.sendEvents();
    expect(sent).toHaveLength(1);
    await t.sendCheckin();
    expect(sent[1].body.used).toEqual({
      models: { "claude-sonnet-5-5": { runs: 1, tokens: 1200, costUsd: 0 } },
      jobs: { "Caption Studio": { runs: 1, tokens: 1200, costUsd: 0 } },
      exports: { done: 0, failed: 1, seconds: 12 },
    });
    sent.length = 1;
    expect(sent[0].url).toBe("https://ping.test/api/ping/events");
    expect(sent[0].body.events).toEqual([
      { name: "ai run", at: 1_000, props: { job: "Caption Studio", model: "claude-sonnet-5-5", tokens: 1200 } },
      { name: "export", at: 2_000, props: { ok: false, seconds: 12 } },
    ]);
    await t.sendEvents();
    expect(sent).toHaveLength(1);
    sent.length = 0;
    t.track("page", { page: "home" });
    fakeFetch.mockImplementationOnce(async () => new Response(null, { status: 400 }));
    await t.sendEvents(); // refused: dropped, so it never blocks what comes after
    await t.sendEvents();
    expect(sent).toEqual([]);
  });

  it("a crash goes at once with its file paths taken out, and its repeats within the hour fold into the next count", () => {
    process.env.CT_CHANNEL = "release";
    const e = new Error(`no file ${homedir()}/Movies/a.mov`);
    t.reportCrash("server", e, 1_000);
    t.reportCrash("server", e, 2_000);
    t.reportCrash("server", e, 3_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://ping.test/api/ping/crash");
    expect(sent[0].body).toMatchObject({ where: "server", message: "no file <path>", count: 1 });
    expect(String(sent[0].body.stack)).not.toContain(homedir());
    t.reportCrash("server", e, 3_700_000);
    expect(sent[1].body.count).toBe(3);
  });

  it("the page's errors come in through its own server", async () => {
    process.env.CT_CHANNEL = "release";
    expect((await req("POST", "/api/telemetry/error", { name: "TypeError", message: "x is undefined", stack: "at a.js:1" })).status).toBe(204);
    expect(sent[0].body).toMatchObject({ where: "web", message: "TypeError: x is undefined" });
    expect((await req("POST", "/api/telemetry/error", {})).status).toBe(400);
  });

  it("the switch turns it off and on, admins only", async () => {
    process.env.CT_CHANNEL = "release";
    expect(await (await req("PUT", "/api/telemetry", { on: false })).json()).toEqual({ available: true, on: false });
    expect(existsSync(path.join(process.env.DATA_DIR!, "no-ping"))).toBe(true);
    t.notePage("home");
    await t.sendCheckin();
    expect(sent).toEqual([]);
    expect(await (await req("PUT", "/api/telemetry", { on: true })).json()).toEqual({ available: true, on: true });
    const member = `Bearer ${newApiKey(createUser("bo", "password1"), "full")}`;
    const r = await app.request("/api/telemetry", { method: "PUT", headers: { authorization: member, "content-type": "application/json" }, body: '{"on":false}' });
    expect(r.status).toBe(403);
  });
});

describe("scrub", () => {
  it("keeps the app's own code paths and takes out every other path, quoted ones with spaces too", () => {
    const { scrub } = t;
    const appDir = path.resolve(path.dirname(process.argv[1] ?? "."), "..");
    expect(scrub(`at run (${appDir}/dist/boot.js:12:3)`)).toBe("at run (<app>/dist/boot.js:12:3)");
    expect(scrub("ENOENT: no such file or directory, open '/Volumes/My Drive/Tiny Acrobat handstand.mov'")).toBe(
      "ENOENT: no such file or directory, open '<path>'",
    );
    expect(scrub(`cannot read ${homedir()}/Movies/Tia.mov now`)).toBe("cannot read <path> now");
    expect(scrub("GET /api/files/Tia.mov failed at http://127.0.0.1:3000/x")).toBe("GET <path> failed at http://127.0.0.1:3000/x");
    expect(scrub("Expected a number")).toBe("Expected a number");
    // a name with spaces, unquoted, is hidden whole
    expect(scrub("/Users/tiny/Tiny Shoot.mov: No such file or directory")).toBe("<path>: No such file or directory");
    expect(scrub("could not open /Volumes/My Drive/Tiny Shoot 3/clip one.mov now")).toBe("could not open <path> now");
    expect(scrub("the folder /Volumes/My Drive/Tiny Shoot is not connected, try again")).toBe("the folder <path>, try again");
    expect(scrub("spawn /Users/tiny/my tools/ffmpeg ENOENT")).toBe("spawn <path> ENOENT");
  });
});
