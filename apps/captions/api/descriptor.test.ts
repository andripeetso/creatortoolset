import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "descriptor-"));
process.env.APP_SECRET = "local-sign-in-test-secret";

const app = (await import("./boot")).default;
const { allowedPeer, endpoints, isLan, listensEverywhere } = await import("./descriptor");
const { computerKey } = await import("./connect/keys");

afterEach(() => vi.unstubAllEnvs());

describe("the public descriptor", () => {
  it("names this server by its key id, with no sign-in", async () => {
    const r = await app.request("http://localhost/.well-known/creator-toolset/server");
    expect(r.status).toBe(200);
    const d = (await r.json()) as { serverId: string; platform: string };
    expect(d).toMatchObject({ serverId: computerKey().id, protocol: 1, capabilities: { pairing: true, dpop: true, connect: false } });
    expect(d.serverId).toMatch(/^[0-9a-f]{32}$/);
    expect(["mac", "linux", "hosted"]).toContain(d.platform);
  });
});

describe("the iPhone app's link file", () => {
  it("lets the public app claim pairing links, with no sign-in, or the builds IOS_APP_IDS names", async () => {
    const read = async () => {
      const r = await app.request("http://localhost/.well-known/apple-app-site-association");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("application/json");
      return ((await r.json()) as { applinks: { details: { appIDs: string[]; components: Record<string, string>[] }[] } }).applinks.details[0];
    };
    const d = await read();
    expect(d.appIDs).toEqual(["8DB5KKMAS3.com.creatortoolset.ios"]);
    expect(d.components[0]).toMatchObject({ "/": "/", "#": "token=*" });
    vi.stubEnv("IOS_APP_IDS", "ABCDE12345.com.example.app, FGHIJ67890.com.example.other");
    expect((await read()).appIDs).toEqual(["ABCDE12345.com.example.app", "FGHIJ67890.com.example.other"]);
  });
});

describe("endpoints", () => {
  it("lists nothing while the server listens on this computer only, and never loopback", async () => {
    vi.stubEnv("HOST", "127.0.0.1");
    expect(await endpoints("43128")).toEqual([]);
    vi.stubEnv("HOST", "0.0.0.0");
    for (const e of await endpoints("43128")) {
      expect(["lan", "tailnet"]).toContain(e.kind);
      expect(e.httpBaseUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:43128$/);
      expect(e.httpBaseUrl).not.toMatch(/\/\/127\./);
    }
  });

  it("never calls a rented box's public address, a tailnet's or loopback a network address", () => {
    expect(isLan("172.16.0.9")).toBe(true);
    expect(isLan("10.0.0.5")).toBe(true);
    expect(isLan("203.0.113.7")).toBe(false);
    expect(isLan("100.98.0.1")).toBe(false);
    expect(isLan("127.0.0.1")).toBe(false);
  });

  it("lists nothing on Cloud, in hosted mode, or on a Server with a public address (This Mac still lists its own)", async (ctx) => {
    vi.stubEnv("HOST", "");
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("DOMAIN", "");
    // a machine with no network address of its own can't show the difference
    if ((await endpoints("3000")).length === 0) ctx.skip();
    vi.stubEnv("CT_SERVER", "cloud");
    expect(await endpoints("3000")).toEqual([]);
    vi.stubEnv("CT_SERVER", "");
    vi.stubEnv("CT_MODE", "hosted");
    expect(await endpoints("3000")).toEqual([]);
    vi.stubEnv("CT_MODE", "");
    vi.stubEnv("CT_SERVER", "server");
    vi.stubEnv("PUBLIC_ORIGIN", "https://tools.example.com");
    expect(await endpoints("3000")).toEqual([]);
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("DOMAIN", "tools.example.com");
    expect(await endpoints("3000")).toEqual([]);
    // This Mac still reports its LAN/tailnet addresses even when a relay/tailnet PUBLIC_ORIGIN is set
    vi.stubEnv("CT_SERVER", "mac");
    vi.stubEnv("PUBLIC_ORIGIN", "https://mac.example.com");
    expect((await endpoints("3000")).length).toBeGreaterThan(0);
  });

  it("needs a sign-in", async () => {
    expect((await app.request("http://localhost/api/server/endpoints")).status).toBe(401);
  });

  it("knows which HOST values mean every interface", () => {
    expect([undefined, "0.0.0.0", "::"].map((h) => listensEverywhere(h))).toEqual([true, true, true]);
    expect(listensEverywhere("127.0.0.1")).toBe(false);
  });
});

describe("the private-address filter", () => {
  it("lets in loopback, private, link-local and 100.64.0.0/10 peers only", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:10.0.0.20", "10.1.2.3", "172.16.0.1", "172.31.255.255", "172.20.0.5", "169.254.1.1", "100.64.0.1", "100.127.255.254", "fd12:3456::1", "fe80::1%en0"]) {
      expect([a, allowedPeer(a)]).toEqual([a, true]);
    }
    for (const a of ["203.0.113.9", "8.8.8.8", "172.32.0.1", "100.128.0.1", "100.63.255.255", "2001:db8::1", "::ffff:203.0.113.9", "", undefined]) {
      expect([a, allowedPeer(a)]).toEqual([a, false]);
    }
  });
});
