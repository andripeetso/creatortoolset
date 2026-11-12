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

  it("a crash goes at once with the home folder hidden, and its repeats within the hour fold into the next count", () => {
    process.env.CT_CHANNEL = "release";
    const e = new Error(`no file ${homedir()}/Movies/a.mov`);
    t.reportCrash("server", e, 1_000);
    t.reportCrash("server", e, 2_000);
    t.reportCrash("server", e, 3_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://ping.test/api/ping/crash");
    expect(sent[0].body).toMatchObject({ where: "server", message: "no file ~/Movies/a.mov", count: 1 });
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
