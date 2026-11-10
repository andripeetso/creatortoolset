import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "providers-limits-")); // users, devices, provider settings
const { devicesApp } = await import("./devices");
const { providersApp } = await import("./providers");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
const { createUser } = await import("./users");
import type { ProviderSettings, ProvidersView } from "../contracts/providers";
import type { SessionUser } from "./users";
import type { AuthVars } from "./auth";

/** Who is signed in for the next request (the real cookie gate lives in boot.ts). */
let who: SessionUser = { username: "tinyacrobatics", role: "admin", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/providers", providersApp);
app.route("/api/devices", devicesApp);

const as = (username: string, role: SessionUser["role"]) => {
  who = { username, role, cloud: true, off: [] };
};
const view = async (): Promise<ProvidersView> => (await (await app.request("/api/providers")).json()) as ProvidersView;
const reportFrom = (token: string, body: unknown) =>
  app.request("/api/devices/relay/limits", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

const settings = (instances: ProviderSettings["instances"], def: ProviderSettings["default"]): ProviderSettings => ({
  instances,
  default: def,
  jobs: {},
});
/** One Codex folder as the Mac reports it, the default folder unless `home` says otherwise. */
const codexFolder = (home: string, state: "ok" | "signed_out" = "ok") => ({
  driver: "codex",
  home,
  isDefault: home.endsWith("/.codex"),
  label: "default",
  state,
  windows: state === "ok" ? [{ id: "primary", label: "Monthly", kind: "monthly", usedPercent: 13, resetsAt: 1795206641000, windowMs: 2592000000 }] : [],
});

let owner: { device: { id: string }; token: string };
let editor: { device: { id: string }; token: string };

beforeAll(async () => {
  createUser("tinyacrobatics", "password1", { role: "admin" });
  createUser("editor1", "password1", { role: "team" });
  createUser("viewer1", "password1", { role: "team" });
  owner = pairDevice("tinyacrobatics", "Studio Mac");
  editor = pairDevice("editor1", "Editing Mac");
  // the workspace's Claude runs on the owner's Mac in its own folder; the editor's Codex runs on the editor's Mac
  await saveSettings(
    settings([{ id: "claude_work", driver: "claude", name: "Claude (work)", enabled: true, home: "/Users/me/.claude-work", device: owner.device.id }], { instance: "claude_work", model: "claude-opus-5-5", effort: "xhigh" }),
  );
  await saveSettings(settings([{ id: "codex_ed", driver: "codex", name: "Codex", enabled: true, device: editor.device.id }], { instance: "codex_ed", model: "gpt-5-codex", effort: "high" }), "editor1");
  // each Mac reports its folders' limits
  await reportFrom(owner.token, {
    identities: [
      { driver: "claude", home: "/Users/me/.claude-work", isDefault: false, label: "work", state: "ok", windows: [{ id: "five_hour", label: "Session", kind: "session", usedPercent: 25 }] },
      codexFolder("/Users/me/.codex"),
    ],
  });
  await reportFrom(editor.token, { identities: [codexFolder("/Users/ed/.codex")] });
});

describe("plan limits: an account sees the identities behind its own providers only", () => {
  it("a team member sees its own Codex login, never the workspace's or another person's Mac", async () => {
    as("editor1", "team");
    const v = await view();
    expect(v.limits.map((l) => l.instances)).toEqual([["editor1:codex_ed"]]);
    expect(v.limits[0]).toMatchObject({ driver: "codex", state: "ok", device: editor.device.id });
    expect(JSON.stringify(v.limits)).not.toContain("/Users/"); // no folder paths go out
  });

  it("an admin sees the workspace's identities and its own providers' (none here), not a team member's", async () => {
    as("tinyacrobatics", "admin");
    const v = await view();
    expect(v.limits.map((l) => l.instances)).toEqual([["workspace:claude_work"]]);
    expect(v.limits[0]).toMatchObject({ driver: "claude", label: "work", windows: [{ id: "five_hour", usedPercent: 25 }] });
  });

  it("an account with no providers sees no limits", async () => {
    as("viewer1", "team");
    expect((await view()).limits).toEqual([]);
  });

  it("the Mac's folder limits are not on its device record", async () => {
    as("editor1", "team");
    expect(JSON.stringify((await view()).devices)).not.toContain("windows");
  });

  it("a switched-off provider's login still shows its plan limits (Usage reads them whether or not it answers)", async () => {
    await saveSettings(settings([{ id: "codex_ed", driver: "codex", name: "Codex", enabled: false, device: editor.device.id }], { instance: "codex_ed", model: "gpt-5-codex", effort: "high" }), "editor1");
    as("editor1", "team");
    expect((await view()).limits.map((l) => l.instances)).toEqual([["editor1:codex_ed"]]);
  });

  it("a Mac that reports signed out shows as signed out, on the next report", async () => {
    await reportFrom(editor.token, { identities: [codexFolder("/Users/ed/.codex", "signed_out")] });
    as("editor1", "team");
    expect((await view()).limits[0]).toMatchObject({ state: "signed_out", windows: [] });
  });
});
