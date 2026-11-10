import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProviderSettings, ProvidersView } from "../contracts/providers";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

// Scratch on the external SSD, not the Mac's disk (like the other provider tests).
const scratch = process.env.CT_SCRATCH_DIR ?? "/Volumes/WinningFriends/ct-wt/scratch";
mkdirSync(scratch, { recursive: true });
process.env.DATA_DIR = mkdtempSync(path.join(scratch, "provider-checks-"));
process.env.APP_SECRET = "test-secret";

const { providersApp } = await import("./providers");
const { ownSettings, providerChecks, saveSettings, noteCallOutcome } = await import("./lib/providers");
const { createUser } = await import("./users");

let who: SessionUser = { username: "ana", role: "team", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/providers", providersApp);

const view = async (): Promise<ProvidersView> => (await (await app.request("/api/providers")).json()) as ProvidersView;
const KEY = "ana:claude_ana";
const savedAt = Date.now() - 60_000;

beforeAll(async () => {
  createUser("ana", "password1", { role: "team" });
  const set: ProviderSettings = {
    instances: [{ id: "claude_ana", driver: "claude", name: "Claude", enabled: true, device: "mac-ana", lastCheck: { ok: true, at: savedAt, ms: 3300 } }],
    default: { instance: "claude_ana", model: "", effort: "xhigh" },
    jobs: {},
  };
  await saveSettings(set, "ana");
});

describe("a saved check outlives this process", () => {
  it("the page shows the AI's saved result when this process has no result in memory (a restart)", async () => {
    delete providerChecks()[KEY];
    expect((await view()).checks[KEY]).toMatchObject({ ok: true, at: savedAt, ms: 3300 });
  });

  it("an in-memory result from this process wins over the saved one", async () => {
    providerChecks()[KEY] = { ok: false, at: Date.now(), ms: 0, error: "Timed out" };
    expect((await view()).checks[KEY]).toMatchObject({ ok: false, error: "Timed out" });
    delete providerChecks()[KEY];
  });
});

describe("a real call's outcome is the AI's check, written only when it changes or is old", () => {
  it("an answer that matches the saved result within ten minutes is not written again", async () => {
    delete providerChecks()[KEY];
    await noteCallOutcome("ana", "claude_ana", true);
    expect(ownSettings("ana")?.instances[0]?.lastCheck?.at).toBe(savedAt);
  });

  it("a failure is written at once, with its plain reason, and the same failure again is not", async () => {
    await noteCallOutcome("ana", "claude_ana", false, "Claude took over 20 minutes");
    const first = ownSettings("ana")?.instances[0]?.lastCheck;
    expect(first?.ok).toBe(false);
    expect(providerChecks()[KEY]).toMatchObject({ ok: false, error: "Claude took over 20 minutes" });
    await noteCallOutcome("ana", "claude_ana", false, "Claude took over 20 minutes");
    expect(ownSettings("ana")?.instances[0]?.lastCheck?.at).toBe(first?.at);
  });

  it("the same answer is written again once the saved one is over ten minutes old", async () => {
    providerChecks()[KEY] = { ok: false, at: Date.now() - 11 * 60_000, ms: 0, error: "Claude took over 20 minutes" };
    await noteCallOutcome("ana", "claude_ana", false, "Claude took over 20 minutes");
    expect(Date.now() - (providerChecks()[KEY]?.at ?? 0)).toBeLessThan(60_000);
  });
});
