import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A hosted server where every account signs in with Google, Apple or GitHub takes no passwords (auth.ts passwordsOff).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "passwords-off-"));
process.env.APP_SECRET = "passwords-off-test-secret";
process.env.CT_MODE = "hosted";

const { createUser, findUser, linkIdentity, listUsers, unlinkIdentity } = await import("./users");
const app = (await import("./boot")).default;

const login = (username: string, password: string) =>
  app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
const loginScreen = async () => (await (await app.request("/api/account/providers?login=1")).json()) as { password?: boolean };

describe("passwords on a hosted server", () => {
  it("are refused, and the login screen has no password form, once every account has a linked sign-in", async () => {
    createUser("solo", "solopass12", { role: "admin" });
    // the bootstrap admin (made from APP_SECRET when no admin existed) and any other account must be linked too
    for (const u of listUsers()) if (u.username !== "solo") unlinkIdentity(u, "google");
    expect(await loginScreen()).toMatchObject({ password: true });
    for (const u of listUsers()) linkIdentity(u, { provider: "google", sub: `g-${u.username}`, email: `${u.username}@example.com` });
    expect(await loginScreen()).toMatchObject({ password: false });
    const res = await login("solo", "solopass12");
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("come back for everyone when one account has no linked sign-in", async () => {
    createUser("newbie", "newbiepass1", { role: "user" });
    expect(await loginScreen()).toMatchObject({ password: true });
    expect((await login("newbie", "newbiepass1")).status).toBe(200);
    unlinkIdentity(findUser("solo")!, "google");
  });
});
