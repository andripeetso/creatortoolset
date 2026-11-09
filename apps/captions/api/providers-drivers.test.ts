import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "providers-drivers-")); // users, devices, provider settings
const { aiFor } = await import("./ai-complete");
const { devicesApp } = await import("./devices");
const { streamMacClaude } = await import("./lib/mac-claude");
const { providersApp } = await import("./providers");
const { pairDevice, saveReport } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { createUser } = await import("./users");
import type { DriverCatalog, MacReport, ProviderSettings } from "../contracts/providers";
import type { SessionUser } from "./users";
import type { AuthVars } from "./auth";

/** Who is signed in for the next request (the real cookie gate lives in boot.ts). */
let who: SessionUser = { username: "alex", role: "admin", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/providers", providersApp);
app.route("/api/devices", devicesApp);

const as = (u: Partial<SessionUser> & { username: string; role: SessionUser["role"] }) => {
  who = { cloud: true, off: [], ...u };
};
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const relay = async (token: string, path: string, body: unknown = {}): Promise<Response> =>
  app.request(`/api/devices/relay${path}`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });

let alex: { device: { id: string }; token: string };
let jordan: { device: { id: string }; token: string };
let casey: { device: { id: string }; token: string };

const report = (drivers: MacReport["drivers"]): MacReport => ({ at: Date.now(), drivers, homes: [] });

beforeAll(async () => {
  createUser("alex", "password1", { role: "admin" });
  createUser("jordan", "password1", { role: "team" });
  createUser("casey", "password1", { role: "team" });
  alex = pairDevice("alex", "Alex's Mac");
  jordan = pairDevice("jordan", "Jordan's Mac");
  casey = pairDevice("casey", "Casey's Mac"); // never reports: left out of the catalog
  saveReport(alex.device.id, report([
    { driver: "claude", installed: true, version: "2.1.319", signedIn: true, plan: "max" },
    { driver: "codex", installed: true, version: "0.9.0", signedIn: false },
    { driver: "cursor", installed: false },
    { driver: "musecode", installed: false },
  ]));
  saveReport(jordan.device.id, report([{ driver: "claude", installed: true, signedIn: false }]));
});

describe("the driver catalog (GET /api/providers/drivers)", () => {
  it("lists every driver in wizard order with featured and runs, and says why a driver can't run", async () => {
    as({ username: "alex", role: "admin" });
    const catalog = (await (await app.request("/api/providers/drivers")).json()) as DriverCatalog;
    expect(catalog.drivers.map((d) => d.id)).toEqual(["codex", "claude", "cursor", "grok", "opencode", "antigravity", "musecode", "pi", "gemini", "acp"]);
    const by = (id: string) => catalog.drivers.find((d) => d.id === id)!;
    expect(by("claude")).toMatchObject({ featured: true, runs: true });
    expect(by("gemini")).toMatchObject({ featured: false, runs: true }); // behind "Show more"
    // the ACP kinds run on the Mac over stdio (pi and opencode included), and a local command runs too
    for (const id of ["cursor", "opencode", "antigravity", "pi", "acp"]) expect(by(id)).toMatchObject({ runs: true });
    expect(by("acp")).toMatchObject({ featured: false, runs: true });
    expect(by("pi")).toMatchObject({ featured: true, runs: true });
    expect(by("pi")).not.toHaveProperty("reason");
    expect(by("musecode").reason).toMatch(/No command-line tool on this Mac yet/); // shown disabled with its reason
    expect(by("claude")).not.toHaveProperty("reason");
  });

  it("gives each Mac that reported its installed and signed-in state, and leaves out one that never reported", async () => {
    as({ username: "alex", role: "admin" });
    const catalog = (await (await app.request("/api/providers/drivers")).json()) as DriverCatalog;
    const by = (id: string) => catalog.drivers.find((d) => d.id === id)!;
    // an admin sees its own Mac (and the workspace's and other admins'), not a team member's
    expect(by("claude").devices).toEqual([{ device: alex.device.id, name: "Alex's Mac", online: false, installed: true, signedIn: true, version: "2.1.319" }]);
    expect(by("codex").devices[0]).toMatchObject({ installed: true, signedIn: false });
    expect(by("cursor").devices[0]).toMatchObject({ installed: false }); // the CLI doesn't say whether it is signed in: no signedIn key
    expect(by("cursor").devices[0]).not.toHaveProperty("signedIn");
    expect(by("gemini").devices).toEqual([{ device: alex.device.id, name: "Alex's Mac", online: false, installed: false }]); // reported, not listed: not installed
    expect(JSON.stringify(catalog)).not.toContain(casey.device.id);
  });

  it("a team member sees only its own Macs", async () => {
    as({ username: "jordan", role: "team" });
    const catalog = (await (await app.request("/api/providers/drivers")).json()) as DriverCatalog;
    const claude = catalog.drivers.find((d) => d.id === "claude")!;
    expect(claude.devices).toEqual([{ device: jordan.device.id, name: "Jordan's Mac", online: false, installed: true, signedIn: false }]);
    expect(JSON.stringify(catalog)).not.toContain(alex.device.id);
  });
});

describe("a plug-in instance's endpoint", () => {
  it("reaches its Mac with the job and never appears on the providers page", async () => {
    as({ username: "alex", role: "admin" });
    const settings: ProviderSettings = {
      instances: [{ id: "claude_proxy", driver: "claude", name: "Claude (proxy)", enabled: true, device: alex.device.id, baseUrl: "https://proxy.example.test/v1" }],
      default: { instance: "claude_proxy", model: "claude-opus-5-5", effort: "xhigh" },
      jobs: {},
    };
    await saveSettings(settings, "alex");

    const provider = aiFor({ username: "alex", role: "admin" }, "captions", "Caption Studio").mac?.provider;
    expect(provider).toMatchObject({ instance: "claude_proxy", baseUrl: "https://proxy.example.test/v1" });

    const poll = relay(alex.token, "/wait").then((r) => r.json() as Promise<{ id: string; baseUrl?: string }>);
    const answer = streamMacClaude("sys", "hi", undefined, () => {}, undefined, { provider });
    const job = await poll;
    expect(job.baseUrl).toBe("https://proxy.example.test/v1");
    await relay(alex.token, `/${job.id}/done`, { text: "ok" });
    expect(await answer).toBe("ok");

    const view = await (await app.request("/api/providers")).json();
    expect(JSON.stringify(view)).not.toContain("proxy.example.test");
  });

  it("an instance without one sends no endpoint", async () => {
    as({ username: "jordan", role: "team" });
    await saveSettings({ instances: [{ id: "claude_j", driver: "claude", name: "Claude (j)", enabled: true, device: jordan.device.id }], default: { instance: "claude_j", model: "claude-opus-5-5", effort: "xhigh" }, jobs: {} }, "jordan");
    const provider = aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio").mac?.provider;
    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBeUndefined();
  });
});
