import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// Plug-ins can switch gates off for new role-"user" accounts (api/lib/plugin.ts). This file is about the app's own
// switches, so it runs with no plug-ins loaded, whichever ones plugins/ holds.
vi.mock("./plugins.gen", () => ({ serverPlugins: [] }));

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "roles-"));
process.env.APP_SECRET = "roles-test-secret";
// accounts from before app switches, and from before the enhancer's engines were cut back
const legacy = (username: string, extra: object) => ({
  username, salt: "s", hash: "h", role: "user", cloud: false, enhance: true,
  createdAt: 0, usage: {}, ...extra,
});
writeFileSync(
  path.join(process.env.DATA_DIR, "users.json"),
  JSON.stringify({ users: [legacy("old", { off: ["library", "finals", "bogus"] }), legacy("plain", {})] }),
);

const { createUser, findUser } = await import("./users");
const app = (await import("./boot")).default;

async function login(username: string, role: "user" | "team" | "admin" = "user") {
  createUser(username, "password1", { role });
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "password1" }),
  });
  return { cookie: res.headers.get("set-cookie")!.split(";")[0] };
}
const status = async (url: string, headers: { cookie: string }) =>
  (await app.request(url, { headers })).status;
// users.json's `off` list; nothing in the app writes it any more
const setOff = (username: string, off: string[]) => void (findUser(username)!.off = off as never);

describe("app switches", () => {
  it("keeps only the switches that still exist, and drops the rest of old accounts", () => {
    // ids of removed apps are kept too: the reader cannot tell them from a plug-in gate that is not loaded this boot
    expect(findUser("old")).toMatchObject({ role: "user", cloud: true, off: ["library", "finals", "bogus"] });
    expect(findUser("plain")).toMatchObject({ role: "user", cloud: true, off: [] });
    expect(findUser("plain")).not.toHaveProperty("enhance");
  });

  it("gives a new account every app", async () => {
    const h = await login("u1");
    const me = (await (await app.request("/api/auth/check", { headers: h })).json()) as { user: { off: string[] } };
    expect(me.user.off).toEqual([]);
    expect(await status("/api/review", h)).toBe(200);
    expect(await status("/api/instagram/availability", h)).toBe(200);
    expect(await status("/api/enhance", h)).toBe(200);
    expect(await status("/api/library", h)).toBe(200); // the Media Library is on for every account (no library yet: an empty list)
  });

  it("keeps an app switched off in users.json closed", async () => {
    const h = await login("u2");
    setOff("u2", ["enhance", "instagram"]);
    expect(await status("/api/enhance", h)).toBe(403);
    // the Workshop reads the Analyzer's API, so one of the two keeps both open
    expect(await status("/api/instagram/availability", h)).toBe(200);
    setOff("u2", ["instagram", "workshop"]);
    expect(await status("/api/instagram/availability", h)).toBe(403);
    expect(await status("/api/workshop/sessions", h)).toBe(403);
    setOff("u2", []);
    expect(await status("/api/enhance", h)).toBe(200);
  });
});
