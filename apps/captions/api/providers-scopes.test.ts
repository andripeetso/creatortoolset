import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "providers-scopes-")); // users, devices, provider settings, the usage tally
const { aiFor, completeWithFallback } = await import("./ai-complete");
const { devicesApp } = await import("./devices");
const { macUsageSince, relayRoutes, streamMacClaude, MacClaudeError } = await import("./lib/mac-claude");
const { providersApp } = await import("./providers");
const { deviceForToken, deviceOf, pairDevice } = await import("./lib/devices");
const { ownSettings, parseSettings, providerSettings, saveSettings } = await import("./lib/providers");
const { createUser } = await import("./users");
import type { ProviderSettings } from "../contracts/providers";
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
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const relay = async (token: string, path: string, body: unknown = {}): Promise<Response> =>
  app.request(`/api/devices/relay${path}`, { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify(body) });

const hub = { id: "claude_work", driver: "claude" as const, name: "Claude (work)", enabled: true, home: "/Users/me/.claude-work" };
const workspace = (over: Partial<ProviderSettings> = {}): ProviderSettings => ({
  instances: [{ ...hub, device: alex.device.id }], // an admin's Mac
  default: { instance: "claude_work", model: "claude-opus-5-5", effort: "xhigh" },
  jobs: {},
  ...over,
});

let alex: { device: { id: string }; token: string };
let jordan: { device: { id: string }; token: string };
const macClaudeApp = relayRoutes(() => alex.device.id); // the admin's Mac answers the workspace's requests

beforeAll(async () => {
  createUser("alex", "password1", { role: "admin" });
  createUser("jordan", "password1", { role: "team" });
  createUser("casey", "password1", { role: "team" });
  createUser("jo", "password1", { role: "team" });
  alex = pairDevice("alex", "Alex's Mac");
  jordan = pairDevice("jordan", "Jordan's Mac");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("routing: whose providers answer an account's job", () => {
  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await saveSettings(workspace());
    await saveSettings(
      {
        instances: [{ id: "codex_jordan", driver: "codex", name: "Codex (Jordan)", enabled: true, device: jordan.device.id }],
        default: { instance: "codex_jordan", model: "gpt-5-codex", effort: "high" },
        jobs: {},
      },
      "jordan",
    );
  });

  it("an account's own providers answer first, on its own Mac", () => {
    expect(aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio").mac?.provider).toMatchObject({
      instance: "codex_jordan",
      device: jordan.device.id,
      scope: "jordan",
      model: "gpt-5-codex",
    });
  });

  it("a team member with no own providers never gets the workspace's (the owner's logins); an admin does, unnamed work never", async () => {
    // old settings that shared the workspace's AI with the team are ignored
    await saveSettings(parseSettings({ ...workspace(), shareWithTeam: true, sharedWith: ["casey"] }, "workspace"));
    expect(providerSettings()).not.toHaveProperty("sharedWith");
    expect(aiFor({ username: "casey", role: "team" }, "workshop", "Workshop")).toEqual({ only: [], off: "No AI for your account: add one in Settings → Your AI, or your Anthropic key in Settings → My API keys" });
    expect(aiFor({ username: "alex", role: "admin" }, "workshop", "Workshop").mac?.provider).toMatchObject({ scope: "workspace" });
    expect(aiFor(undefined, "notes", "Video Notes").off).toBe("This AI call names no account"); // nobody named: nobody's providers
    expect(aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio").mac?.provider).toMatchObject({ scope: "jordan" }); // own still answers
  });

  it("an own provider that is off or on a removed Mac leaves a team member with none, not the workspace's", async () => {
    await saveSettings(
      { ...structuredClone(ownSettings("jordan")!), instances: [{ ...ownSettings("jordan")!.instances[0]!, enabled: false }] },
      "jordan",
    );
    expect(aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio").off).toMatch(/No AI for your account/);
  });

  it("a share-link visitor never reaches a provider", () => {
    expect(aiFor({ username: "visitor", role: "visitor" }, "captions", "Caption Studio")).toMatchObject({ only: [] });
  });
});

describe("devices", () => {
  it("pairs a Mac: the token is shown once, and it reads the relay until the Mac is removed", async () => {
    as({ username: "jo", role: "team" });
    const r = await app.request("/api/devices", json({ name: "Jo's Mac" }));
    const { device, token } = (await r.json()) as { device: { id: string; owner: string }; token: string };
    expect(device).toMatchObject({ owner: "jo" });
    expect(token).toMatch(/^ctd_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(deviceOf(device.id))).not.toContain(token); // only the hash is kept
    expect((await relay(token, "/report", {})).status).toBe(200); // authenticates

    const del = await app.request(`/api/devices/${device.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await relay(token, "/report", {})).status).toBe(401);
    expect(deviceForToken(`Bearer ${token}`)).toBeNull();
  });

  it("a visitor can't pair; a device of another account is not listed to a team member and can't be removed by it", async () => {
    as({ username: "visitor", role: "visitor" });
    expect((await app.request("/api/devices", json({ name: "x" }))).status).toBe(403);
    as({ username: "casey", role: "team" });
    const list = (await (await app.request("/api/devices")).json()) as Array<{ id: string }>;
    expect(list.map((d) => d.id)).not.toContain(jordan.device.id);
    expect((await app.request(`/api/devices/${jordan.device.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("a Mac is handed only the requests for its own device, and another Mac's poll keeps waiting", async () => {
    const jordanPoll = relay(jordan.token, "/wait").then((r) => r.json());
    let alexDone = false;
    const alexPoll = relay(alex.token, "/wait").then((r) => {
      alexDone = true;
      return r.status === 200 ? r.json() : null;
    });
    await new Promise((r) => setTimeout(r, 5));
    const answer = streamMacClaude("sys", "for jordan", undefined, () => {}, undefined, {
      provider: { instance: "codex_jordan", driver: "codex", model: "gpt-5-codex", effort: "high", device: jordan.device.id, scope: "jordan" },
    });
    const req = (await jordanPoll) as { id: string; device: string; instance: string; scope: string };
    expect(req).toMatchObject({ device: jordan.device.id, instance: "codex_jordan", scope: "jordan" });
    await new Promise((r) => setTimeout(r, 5));
    expect(alexDone).toBe(false); // alex's Mac still waits
    await relay(jordan.token, `/${req.id}/done`, { text: "from jordan's mac" });
    expect(await answer).toBe("from jordan's mac");

    // and alex's Mac gets its own, not jordan's
    const answer2 = streamMacClaude("sys", "for alex", undefined, () => {}, undefined, { provider: { instance: "claude_work", driver: "claude", model: "claude-opus-5-5", effort: "xhigh", device: alex.device.id, scope: "workspace" } });
    const req2 = (await alexPoll) as { id: string; device: string };
    expect(req2.device).toBe(alex.device.id);
    await relay(alex.token, `/${req2.id}/done`, { text: "from alex's mac" });
    expect(await answer2).toBe("from alex's mac");
  });

  it("a Mac can't answer another Mac's request", async () => {
    const poll = relay(jordan.token, "/wait").then((r) => r.json());
    void streamMacClaude("sys", "x", undefined, () => {}, undefined, { provider: { instance: "codex_jordan", driver: "codex", model: "m", effort: "low", device: jordan.device.id } }).catch(() => {});
    const req = (await poll) as { id: string };
    expect((await relay(alex.token, `/${req.id}/done`, { text: "stolen" })).status).toBe(404);
    await relay(jordan.token, `/${req.id}/fail`, { error: "stop" });
  });

  it("an unclaimed request for an offline Mac fails with that Mac's name", async () => {
    const spare = pairDevice("jordan", "Jordan's spare Mac").device; // never polled: offline
    vi.useFakeTimers();
    const p = streamMacClaude("sys", "nobody", undefined, () => {}, undefined, {
      label: "Workshop",
      provider: { instance: "codex_jordan", driver: "codex", model: "m", effort: "low", device: spare.id, scope: "jordan" },
    }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const e = await p;
    expect(e).toBeInstanceOf(MacClaudeError);
    expect(e).toMatchObject({ kind: "unclaimed", message: "Jordan's spare Mac is offline: open the Creator Toolset Mac app on it" });
  });

  it("a usage limit on one Mac falls back only within its scope", async () => {
    // jordan's only own provider hits its limit: nothing else in jordan's scope, so it fails (the workspace's Claude never takes it)
    const opts = aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio");
    const wait = relay(jordan.token, "/wait").then((r) => r.json());
    const answer = completeWithFallback("sys", "user", undefined, (t) => t, opts).catch((e: unknown) => e);
    const req = (await wait) as { id: string };
    await relay(jordan.token, `/${req.id}/fail`, { error: "You've hit your limit", limit: true });
    const e = (await answer) as { message: string; cause?: unknown };
    expect(e.message).toMatch(/hit your limit/);
  });
});

describe("usage per scope", () => {
  it("lands under its scope; an account sees its own and an admin the workspace's", async () => {
    const before = Date.now();
    const usageOf = async (u: SessionUser) => {
      as(u);
      const v = (await (await app.request("/api/providers")).json()) as { usage: Array<{ scope: string; instance?: string; label: string }> };
      return v.usage.filter((x) => x.label === "Scope test");
    };
    // a workspace answer and jordan's own answer, each tallied under its scope
    const ws = streamMacClaude("s", "u", undefined, () => {}, undefined, { label: "Scope test", provider: { instance: "claude_work", driver: "claude", model: "m", effort: "low", device: alex.device.id, scope: "workspace" } });
    const own = streamMacClaude("s", "u", undefined, () => {}, undefined, { label: "Scope test", provider: { instance: "codex_jordan", driver: "codex", model: "m", effort: "low", device: jordan.device.id, scope: "jordan" } });
    const w = (await (await macClaudeApp.request("/wait", { method: "POST" })).json()) as { id: string };
    const s = (await (await relay(jordan.token, "/wait")).json()) as { id: string };
    await macClaudeApp.request(`/${w.id}/done`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "a", usage: { input: 1, output: 1 } }) });
    await relay(jordan.token, `/${s.id}/done`, { text: "b", usage: { input: 2, output: 2 } });
    await Promise.all([ws, own]);
    await vi.waitFor(async () => {
      const keys = Object.values(await macUsageSince(before - 60_000)).flatMap((h) => Object.keys(h["Scope test"]?.by ?? {}));
      expect(keys.sort()).toEqual(["jordan:codex_jordan", "workspace:claude_work"]);
    });
    expect((await usageOf({ username: "jordan", role: "team", cloud: true, off: [] })).map((x) => x.scope)).toEqual(["jordan"]);
    // an admin sees the workspace's and its own, not another account's
    expect((await usageOf({ username: "alex", role: "admin", cloud: true, off: [] })).map((x) => x.scope)).toEqual(["workspace"]);
  });

  it("the usage page and settings are not for a share-link visitor", async () => {
    as({ username: "visitor", role: "visitor" });
    expect((await app.request("/api/providers")).status).toBe(403);
  });
});

describe("saving settings: the device must exist and belong to the scope", () => {
  it("PUT /own refuses a device of another account", async () => {
    as({ username: "casey", role: "team" });
    const body = { instances: [{ id: "codex_casey", driver: "codex", name: "Codex", enabled: true, device: jordan.device.id }], default: { instance: "codex_casey", model: "gpt-5", effort: "low" }, jobs: {} };
    const r = await app.request("/api/providers/own", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/your own Macs/);
    expect(() => parseSettings(body, "casey")).toThrow(/your own Macs/);
  });

  it("the workspace's providers run on the Mac or an admin's Mac, not a team member's", () => {
    const body = { instances: [{ id: "codex", driver: "codex", name: "Codex", enabled: true, device: jordan.device.id }], default: { instance: "codex", model: "gpt-5", effort: "low" }, jobs: {} };
    expect(() => parseSettings(body, "workspace")).toThrow(/an admin's Mac/);
    expect(() => parseSettings({ ...body, instances: [{ ...body.instances[0], device: alex.device.id }] }, "workspace")).not.toThrow();
  });

  it("PUT /own with null drops the account's own providers", async () => {
    as({ username: "jordan", role: "team" });
    await saveSettings(workspace(), "jordan");
    const r = await app.request("/api/providers/own", { method: "PUT", headers: { "content-type": "application/json" }, body: "null" });
    expect(r.status).toBe(200);
    expect(ownSettings("jordan")).toBeNull();
  });
});

describe("the check: admins any scope, others their own", () => {
  it("a team member can't check the workspace's provider", async () => {
    as({ username: "casey", role: "team" });
    expect((await app.request("/api/providers/workspace/claude_work/check", { method: "POST" })).status).toBe(403);
  });
});

describe("a Mac's report", () => {
  it("a report is kept as its device's report", async () => {
    const r = await macClaudeApp.request("/report", json({ drivers: [], homes: [] }));
    expect(r.status).toBe(200);
    const { reportOf } = await import("./lib/devices");
    expect(reportOf(alex.device.id)).toMatchObject({ drivers: [], homes: [] });
  });
});

describe("provider instance fields", () => {
  const body = (inst: Record<string, unknown>) => ({ instances: [{ ...inst, device: alex.device.id }], default: { instance: inst.id, model: "m", effort: "low" }, jobs: {} });

  it("an old ai-providers.json parses unchanged", () => {
    const old = workspace();
    expect(parseSettings(JSON.parse(JSON.stringify(old)), "workspace")).toEqual(old);
  });

  it("the new fields round-trip through a save and a re-read", () => {
    const rich = body({
      id: "codex_work",
      driver: "codex",
      name: "Codex (work)",
      enabled: true,
      home: "/Users/me/.codex-work",
      binaryPath: "/opt/homebrew/bin/codex",
      shadowHomePath: "/Users/me/.codex-shared",
      envNames: ["OPENAI_ORG", "CODEX_TRACE"],
      accentColor: "#1f8a70",
      featured: false,
    });
    const once = parseSettings(rich, "workspace");
    expect(once.instances[0]).toMatchObject({
      binaryPath: "/opt/homebrew/bin/codex",
      shadowHomePath: "/Users/me/.codex-shared",
      envNames: ["OPENAI_ORG", "CODEX_TRACE"],
      accentColor: "#1f8a70",
      featured: false,
    });
    expect(once.instances[0]).not.toHaveProperty("launchArgs");
    expect(parseSettings(JSON.parse(JSON.stringify(once)), "workspace")).toEqual(once);
  });

  it("keeps launch arguments only for a local ACP command, and refuses one that is not text", () => {
    const acpInst = { id: "acp_local", driver: "acp", name: "Local", enabled: true, acp: { command: "/usr/local/bin/my-agent", args: [] } };
    const withHub = (inst: Record<string, unknown>) => ({ ...body(inst), instances: [{ ...hub, device: alex.device.id }, { ...inst, device: alex.device.id }] });
    expect(parseSettings(withHub({ ...acpInst, launchArgs: ["--verbose"] }), "workspace").instances[1]).toMatchObject({ launchArgs: ["--verbose"] });
    expect(() => parseSettings(withHub({ ...acpInst, launchArgs: ["--x", 3] }), "workspace")).toThrow(/launch argument/);
    expect(() => parseSettings(withHub({ ...acpInst, launchArgs: "--x" }), "workspace")).toThrow(/launch argument/);
  });

  it("drops launch arguments sent for any other kind, so an old file still loads", () => {
    const codex = parseSettings(body({ id: "codex", driver: "codex", name: "Codex", enabled: true, launchArgs: ["--profile", "work"] }), "workspace");
    expect(codex.instances[0]).not.toHaveProperty("launchArgs");
    expect(() => parseSettings(body({ id: "codex", driver: "codex", name: "Codex", enabled: true, launchArgs: ["--x", 3] }), "workspace")).not.toThrow();
  });

  it("never keeps an environment value: only the names, and a name with a value in it is refused", () => {
    const base = { id: "codex", driver: "codex", name: "Codex", enabled: true };
    const kept = parseSettings(body({ ...base, envNames: ["OPENAI_ORG"], envValues: { OPENAI_ORG: "sk-secret" }, env: { OPENAI_ORG: "sk-secret" } }), "workspace");
    expect(kept.instances[0]).toEqual({ id: "codex", driver: "codex", name: "Codex", enabled: true, device: alex.device.id, envNames: ["OPENAI_ORG"] });
    expect(JSON.stringify(kept)).not.toContain("sk-secret");
    expect(() => parseSettings(body({ ...base, envNames: ["OPENAI_ORG=sk-secret"] }), "workspace")).toThrow(/environment names/);
  });

  it("a local ACP command needs its program; other drivers can't carry one", () => {
    // a runnable Claude provider alongside, since the ACP kind is listed but not run yet
    const withHub = (inst: Record<string, unknown>) => ({ ...body(inst), instances: [{ ...hub, device: alex.device.id }, { ...inst, device: alex.device.id }] });
    const acp = { id: "acp_local", driver: "acp", name: "Local", enabled: true, acp: { command: "/usr/local/bin/my-agent", args: ["acp"] } };
    expect(parseSettings(withHub(acp), "workspace").instances[1]).toMatchObject({ acp: { command: "/usr/local/bin/my-agent", args: ["acp"] } });
    expect(() => parseSettings(withHub({ ...acp, acp: undefined }), "workspace")).toThrow(/ACP command needs/);
    expect(() => parseSettings(withHub({ id: "codex", driver: "codex", name: "Codex", enabled: true, acp: { command: "x", args: [] } }), "workspace")).toThrow(/only a local ACP command/);
  });

  it("refuses a bad colour, an environment name that is not a name, and a relative binary path", () => {
    const base = { id: "codex", driver: "codex", name: "Codex", enabled: true };
    expect(() => parseSettings(body({ ...base, accentColor: "teal" }), "workspace")).toThrow(/#rrggbb/);
    expect(() => parseSettings(body({ ...base, envNames: ["BAD NAME"] }), "workspace")).toThrow(/environment names/);
    expect(() => parseSettings(body({ ...base, binaryPath: "codex" }), "workspace")).toThrow(/full path/);
  });

  it("drops a base URL sent from the settings page: only a plug-in's instance may set one", () => {
    const parsed = parseSettings(body({ id: "codex", driver: "codex", name: "Codex", enabled: true, baseUrl: "https://evil.example" }), "workspace");
    expect(parsed.instances[0]).not.toHaveProperty("baseUrl");
  });
});
