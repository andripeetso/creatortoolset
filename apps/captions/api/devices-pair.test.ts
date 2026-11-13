import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "devices-pair-"));
process.env.APP_SECRET = "devices-pair-test-secret";

const { createUser } = await import("./users");
const app = (await import("./boot")).default;
const { PAIR_CODE_MS } = await import("./lib/devices");

createUser("ana", "password1");
createUser("nico", "password1");
const cookieOf = async (username: string) => {
  const r = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  return r.headers.get("set-cookie")!.split(";")[0]!;
};
const ana = await cookieOf("ana");
const nico = await cookieOf("nico");

const mint = async (cookie: string) => (await (await app.request("/api/devices/code", { method: "POST", headers: { cookie } })).json()) as { code: string; expiresAt: number };
/**
 * Each swap comes from its own address unless one is named, so the lock on wrong codes stays out of the other tests. It
 * comes in through a proxy on this machine, which names the caller's address (auth.ts clientAddress).
 */
let n = 0;
const viaProxy = { incoming: { socket: { remoteAddress: "127.0.0.1", remotePort: 50000, remoteFamily: "IPv4" } } };
const swap = (code: string, extra: Record<string, string> = {}) =>
  app.request("/api/devices/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}`, ...extra },
    body: JSON.stringify({ code, name: "Tiny Linux box" }),
  }, viaProxy);
const list = async (cookie: string) => (await (await app.request("/api/devices", { headers: { cookie } })).json()) as { id: string }[];

describe("pairing a computer with a one-time code", () => {
  it("swaps the code for a token of the account that made it, once", async () => {
    const { code } = await mint(ana);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const r = await swap(code.toLowerCase().replace(/-/g, " "));
    expect(r.status).toBe(200);
    const { device, token } = (await r.json()) as { device: { id: string; owner: string }; token: string };
    expect(device.owner).toBe("ana");
    expect((await app.request("/api/devices/relay/report", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect((await swap(code)).status).toBe(400);
  });

  it("needs a signed-in account to make a code", async () => {
    expect((await app.request("/api/devices/code", { method: "POST" })).status).toBe(401);
  });

  it("expires", async () => {
    const { code } = await mint(ana);
    vi.useFakeTimers({ now: Date.now() + PAIR_CODE_MS + 1, toFake: ["Date"] });
    try {
      expect((await swap(code)).status).toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one live code per account: a new one ends the older", async () => {
    const old = await mint(ana);
    await mint(ana);
    expect((await swap(old.code)).status).toBe(400);
  });

  it("another account can't take the computer: a swap with its cookie still pairs it to the code's account, which it can't see or remove", async () => {
    const { code } = await mint(ana);
    await mint(nico); // another account's code leaves this one alone
    const r = await swap(code, { cookie: nico });
    const { device } = (await r.json()) as { device: { id: string; owner: string } };
    expect(device.owner).toBe("ana");
    expect((await list(nico)).map((d) => d.id)).not.toContain(device.id);
    expect((await app.request(`/api/devices/${device.id}`, { method: "DELETE", headers: { cookie: nico } })).status).toBe(404);
    expect((await list(ana)).map((d) => d.id)).toContain(device.id);
  });

  it("removing the computer in Devices ends its token", async () => {
    const { code } = await mint(ana);
    const { device, token } = (await (await swap(code)).json()) as { device: { id: string }; token: string };
    const report = () => app.request("/api/devices/relay/report", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    expect((await report()).status).toBe(200);
    expect((await app.request(`/api/devices/${device.id}`, { method: "DELETE", headers: { cookie: ana } })).status).toBe(200);
    expect((await report()).status).toBe(401);
  });

  it("locks an address out after five wrong codes, even for a right one", async () => {
    const from = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 4; i++) expect((await swap("AAAA-AAAA-AAAA", from)).status).toBe(400);
    expect((await swap("AAAA-AAAA-AAAA", from)).status).toBe(400); // the fifth sets the lock
    const { code } = await mint(ana);
    expect((await swap(code, from)).status).toBe(429);
    expect((await swap(code)).status).toBe(200); // another address is not held back
  });
});
