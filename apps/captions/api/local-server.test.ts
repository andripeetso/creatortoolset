import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// a fresh server on this Mac: the Mac app's APP_SECRET, the owner account it bootstraps
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "local-server-"));
process.env.APP_SECRET = "local-sign-in-test-secret";

const app = (await import("./boot")).default;

/** A request as if it came in on a socket from `address` (what getConnInfo reads). */
const from = (address: string, p: string, init: RequestInit = {}) =>
  app.request(p, init, { incoming: { socket: { remoteAddress: address, remotePort: 50000, remoteFamily: address.includes(":") ? "IPv6" : "IPv4" } } });
const post = (address: string, p: string, body: unknown, cookie = "") =>
  from(address, p, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const login = (address: string, password: string) => post(address, "/api/auth/login", { username: "admin", password });
const LAN = "203.0.113.7";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("one-time sign-in links", () => {
  it("signs a browser in once, then never again", async () => {
    const cookie = cookieOf(await login("127.0.0.1", "local-sign-in-test-secret"));
    const minted = await post("127.0.0.1", "/api/auth/link", {}, cookie);
    expect(minted.status).toBe(200);
    const { path: link } = (await minted.json()) as { path: string };
    expect(link).toMatch(/^\/api\/auth\/link\/[A-Za-z0-9_-]{43}$/);

    const first = await from("127.0.0.1", link);
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toBe("/");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const browser = cookieOf(first);
    const check = (await (await from("127.0.0.1", "/api/auth/check", { headers: { cookie: browser } })).json()) as { authed: boolean };
    expect(check.authed).toBe(true);

    expect((await from("127.0.0.1", link)).status).toBe(410);
  });

  it("expires after 60 s, and needs a signed-in account to make one", async () => {
    expect((await post("127.0.0.1", "/api/auth/link", {})).status).toBe(401);
    const cookie = cookieOf(await login("127.0.0.1", "local-sign-in-test-secret"));
    vi.useFakeTimers({ toFake: ["Date"] });
    const { path: link } = (await (await post("127.0.0.1", "/api/auth/link", {}, cookie)).json()) as { path: string };
    vi.setSystemTime(Date.now() + 61_000);
    expect((await from("127.0.0.1", link)).status).toBe(410);
  });
});

describe("a server on this Mac signs in from other devices only once a password is set", () => {
  it("refuses another address while the password is still APP_SECRET, and lets it in after one is chosen", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    expect((await login(LAN, "local-sign-in-test-secret")).status).toBe(403);
    // a wrong guess from the LAN is an ordinary failure: it never learns the account is still on APP_SECRET
    expect((await login(LAN, "a-wrong-guess")).status).toBe(401);
    expect((await login("::ffff:127.0.0.1", "local-sign-in-test-secret")).status).toBe(200);
    const cookie = cookieOf(await login("127.0.0.1", "local-sign-in-test-secret"));

    // a sign-in link opened from another device is refused too
    const { path: link } = (await (await post("127.0.0.1", "/api/auth/link", {}, cookie)).json()) as { path: string };
    expect((await from(LAN, link)).status).toBe(403);

    // a short password or a wrong current one changes nothing
    expect((await post("127.0.0.1", "/api/auth/password", { current: "nope", password: "tinyacrobatics1" }, cookie)).status).toBe(403);
    expect((await post("127.0.0.1", "/api/auth/password", { current: "local-sign-in-test-secret", password: "short" }, cookie)).status).toBe(400);

    const changed = await post("127.0.0.1", "/api/auth/password", { current: "local-sign-in-test-secret", password: "tinyacrobatics1" }, cookie);
    expect(changed.status).toBe(200);
    // this session carries on with its new cookie; the old one is signed out
    const fresh = cookieOf(changed);
    const authed = async (c: string) => ((await (await from("127.0.0.1", "/api/auth/check", { headers: { cookie: c } })).json()) as { authed: boolean }).authed;
    expect(await authed(fresh)).toBe(true);
    expect(await authed(cookie)).toBe(false);

    expect((await login(LAN, "tinyacrobatics1")).status).toBe(200);
  });
});

describe("the Mac app pairs itself on a server on this Mac", () => {
  it("pairs a Mac and adds no provider: nothing is connected until the person presses Connect", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    const { providerSettings } = await import("./lib/providers");
    const cookie = cookieOf(await login("127.0.0.1", "tinyacrobatics1"));
    const pair = async (name: string) => (await (await post("127.0.0.1", "/api/devices", { name }, cookie)).json()) as { device: { id: string } };
    await pair("Studio Mac");
    expect(providerSettings().instances).toEqual([]);
  });
});
