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

  it("gives the address a phone can reach: the one in use, never this computer's own loopback", async () => {
    const cookie = cookieOf(await login("127.0.0.1", "local-sign-in-test-secret"));
    const mint = (url: string, headers: Record<string, string> = {}) =>
      Promise.resolve(
        app.request(url, { method: "POST", headers: { cookie, ...headers } }, { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } }),
      ).then((r: Response) => r.json() as Promise<{ url: string | null }>);
    expect((await mint("http://studio.example.com/api/auth/link", { "x-forwarded-proto": "https" })).url).toBe("https://studio.example.com");
    expect((await mint(`http://${LAN}:3000/api/auth/link`)).url).toBe(`http://${LAN}:3000`);
    vi.stubEnv("HOST", "127.0.0.1"); // the Mac app with Access from other devices off
    expect((await mint("http://127.0.0.1:3000/api/auth/link")).url).toBeNull();
    vi.stubEnv("HOST", "0.0.0.0");
    expect((await mint("http://localhost:3000/api/auth/link")).url ?? "none").not.toMatch(/localhost|127\./);
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

describe("a hosted server behind a CDN is not held to the own-computer password rule", () => {
  // Cloudflare in front of a hosted server sets the same headers as this computer's own tunnel; nothing here is a tunnel
  const cdn = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "8f00-SJO" };
  it("signs a phone in with the code it scanned, and the account's own password works", async () => {
    const signIn = await from("127.0.0.1", "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...cdn }, body: JSON.stringify({ username: "admin", password: "local-sign-in-test-secret" }) });
    expect(signIn.status).toBe(200);
    const minted = await from("127.0.0.1", "/api/auth/link", { method: "POST", headers: { cookie: cookieOf(signIn), ...cdn } });
    const { path: link } = (await minted.json()) as { path: string };
    const phone = await from("127.0.0.1", link, { headers: cdn });
    expect(phone.status).toBe(302);
    expect(cookieOf(phone)).toMatch(/=/);
  });

  it("still holds a server on someone's own computer to it, through the same headers", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    const signIn = await from("127.0.0.1", "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...cdn }, body: JSON.stringify({ username: "admin", password: "local-sign-in-test-secret" }) });
    expect(signIn.status).toBe(403);
  });
});

describe("a server on this Mac signs in from other devices only once a password is set", () => {
  it("refuses another address while the password is still APP_SECRET, and lets it in after one is chosen", async () => {
    vi.stubEnv("CT_LOCAL", "1");
    const refused = await login(LAN, "local-sign-in-test-secret");
    expect(refused.status).toBe(403);
    // the words name this computer's password, the one the person chooses, never another password
    const words = ((await refused.json()) as { error: string }).error;
    expect(words).toContain("This computer's password isn't set yet");
    expect(words).not.toMatch(/Mac first|catalog/i);
    // a wrong guess from the LAN is an ordinary failure: it never learns the account is still on APP_SECRET
    expect((await login(LAN, "a-wrong-guess")).status).toBe(401);
    expect((await login("::ffff:127.0.0.1", "local-sign-in-test-secret")).status).toBe(200);
    const cookie = cookieOf(await login("127.0.0.1", "local-sign-in-test-secret"));

    // no sign-in code is made while another device would only be refused: the page asks for the password first
    expect(await (await post("127.0.0.1", "/api/auth/link", {}, cookie)).json()).toEqual({ url: null, path: null, expiresAt: null });

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
    // with the password chosen, the code is made and another device signs in with it
    const { path: link } = (await (await post("127.0.0.1", "/api/auth/link", {}, fresh)).json()) as { path: string };
    expect((await from(LAN, link)).status).toBe(302);
  });
});

describe("the routes of plug-ins from the person's folder are behind the sign-in", () => {
  const routes: [string, string][] = [
    ["GET", "/api/plugins/folder"],
    ["POST", "/api/plugins/folder/tiny/prepare"],
    ["GET", "/api/plugins/web"],
    ["GET", "/api/plugins/web/tiny/web.js"],
  ];
  it("answers none of them to a browser that is not signed in", async () => {
    for (const [method, p] of routes) expect((await from("127.0.0.1", p, { method })).status, `${method} ${p}`).toBe(401);
  });

  it("answers the owner, and on a server that is not the Mac app's own it lists and prepares nothing", async () => {
    const cookie = cookieOf(await login("127.0.0.1", "tinyacrobatics1")); // the password the test above chose
    const list = await from("127.0.0.1", "/api/plugins/folder", { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ enabled: false, rows: [] });
    expect((await from("127.0.0.1", "/api/plugins/folder/tiny/prepare", { method: "POST", headers: { cookie } })).status).toBe(403);
    expect(await (await from("127.0.0.1", "/api/plugins/web", { headers: { cookie } })).json()).toEqual({ plugins: [] });
    expect((await from("127.0.0.1", "/api/plugins/web/tiny/web.js", { headers: { cookie } })).status).toBe(404);
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

describe("the phone's code", () => {
  // the owner's password is already changed by the tests above
  const ownerCookie = async () => {
    const res = await login("127.0.0.1", "tinyacrobatics1");
    expect(res.status).toBe(200);
    return cookieOf(res);
  };

  it("is one live code per account: a new one ends the older ones, so none stack", async () => {
    const cookie = await ownerCookie();
    const mintPath = async () => {
      const res = await post("127.0.0.1", "/api/auth/link", {}, cookie);
      expect(res.status).toBe(200);
      return ((await res.json()) as { path: string }).path;
    };
    const older = await mintPath();
    const newer = await mintPath();
    expect((await from("127.0.0.1", older)).status).toBe(410);
    expect((await from("127.0.0.1", newer)).status).toBe(302);
  });

  it("gives the port this server is reached on, not a guessed one", async () => {
    const cookie = await ownerCookie();
    const res = await app.request("http://localhost:3773/api/auth/link", { method: "POST", headers: { cookie } }, { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string | null };
    // no network route in some sandboxes: then there is no address to offer, and nothing is guessed
    if (url) expect(url).toMatch(/:3773$/);
  });
});
