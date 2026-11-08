import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Settings → Account's name, through the real app.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "profile-"));
process.env.APP_SECRET = "profile-test-secret";

const { createUser } = await import("./users");
const app = (await import("./boot")).default;

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const send = (url: string, method: string, body: unknown, cookie = "") =>
  app.request(url, { method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });

describe("your own account", () => {
  it("sets the name the app calls you; the username underneath stays", async () => {
    createUser("tinyboss", "bosspass1", { role: "admin" });
    const cookie = cookieOf(await send("/api/auth/login", "POST", { username: "tinyboss", password: "bosspass1" }));

    expect((await app.request("/api/auth/account")).status).toBe(401);
    expect((await send("/api/auth/account", "PATCH", { name: "  Tiny\u0007 Boss " }, cookie)).status).toBe(200);
    const check = (await (await app.request("/api/auth/check", { headers: { cookie } })).json()) as { user: unknown };
    expect(check.user).toMatchObject({ username: "tinyboss", name: "Tiny Boss" });

    await send("/api/auth/account", "PATCH", { name: "" }, cookie);
    expect(await (await app.request("/api/auth/account", { headers: { cookie } })).json()).toEqual({ username: "tinyboss", name: "" });
  });
});
