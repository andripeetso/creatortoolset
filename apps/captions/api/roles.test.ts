import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "roles-"));
process.env.APP_SECRET = "roles-test-secret";
// accounts from before app switches, and from before the enhancer's engines were cut back
const legacy = (username: string, extra: object) => ({
  username, salt: "s", hash: "h", role: "user", cloud: false, enhance: true,
  createdAt: 0, usage: {}, ...extra,
});
writeFileSync(
  path.join(process.env.DATA_DIR, "users.json"),
  JSON.stringify({ users: [legacy("old", { off: ["media", "finals", "clean", "bogus"] }), legacy("plain", {})] }),
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
const setOff = (admin: { cookie: string }, username: string, off: unknown) =>
  app.request(`/api/admin/users/${username}`, {
    method: "PATCH",
    headers: { ...admin, "content-type": "application/json" },
    body: JSON.stringify({ off }),
  });

describe("app switches", () => {
  it("keeps only the switches that still exist, and drops the rest of old accounts", () => {
    expect(findUser("old")).toMatchObject({ role: "user", cloud: true, off: ["clean"] });
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
    expect(await status("/api/library", h)).toBe(404); // no Finals any more
  });

  it("lets an admin switch apps off and back on", async () => {
    const admin = await login("boss", "admin");
    const h = await login("u2");
    expect((await setOff(admin, "u2", ["enhance", "clean", "instagram"])).status).toBe(200);
    expect(await status("/api/enhance", h)).toBe(403);
    const clean = await app.request("/api/clean/sources/from-captions", { method: "POST", headers: h });
    expect(clean.status).toBe(403);
    // the Workshop reads the Analyzer's API, so one of the two keeps both open
    expect(await status("/api/instagram/availability", h)).toBe(200);
    await setOff(admin, "u2", ["instagram", "workshop"]);
    expect(await status("/api/instagram/availability", h)).toBe(403);
    expect(await status("/api/workshop/sessions", h)).toBe(403);
    await setOff(admin, "u2", []);
    expect(await status("/api/enhance", h)).toBe(200);
  });

  it("refuses unknown apps and non-admins", async () => {
    const admin = await login("boss2", "admin");
    expect((await setOff(admin, "u1", ["editor"])).status).toBe(400);
    const h = await login("u3");
    expect((await setOff(h, "u3", [])).status).toBe(403);
    expect(findUser("u3")?.off).toEqual([]);
  });
});
