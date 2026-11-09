import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Sign in with Apple / Google to a site account and linking one (sign-in.ts, users.ts, auth.ts), on a hosted server.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "sign-in-"));
process.env.APP_SECRET = "sign-in-test-secret";
process.env.CT_MODE = "hosted";
delete process.env.APPLE_SIGNIN_KEY;
delete process.env.GOOGLE_SIGNIN_CLIENT_ID;
delete process.env.GOOGLE_SIGNIN_CLIENT_SECRET;

const { createUser, findByIdentity, findUser, linkIdentity } = await import("./users");
const { signinOn } = await import("./sign-in");
const app = (await import("./boot")).default;

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

describe("sign-in to a site account (hosted mode)", () => {
  it("offers Apple and Google only on the sign-in origin, with keys set", () => {
    expect(signinOn("https://creatortoolset.com")).toEqual({ apple: false, google: false });
    expect(signinOn("http://localhost")).toEqual({ apple: false, google: false });
  });

  it("says sign-in isn't set up when the server has no keys", async () => {
    const res = await app.request("/api/account/login/google?for=site");
    expect(res.status).toBe(501);
  });

  it("links only from a signed-in account", async () => {
    expect((await app.request("/api/account/login/google?for=link")).status).toBe(401);
  });

  it("keeps one account per provider identity", () => {
    createUser("ana", "anapass12", { role: "user" });
    createUser("ben", "benpass12", { role: "user" });
    linkIdentity(findUser("ana")!, { provider: "google", sub: "g-1", email: "ana@example.test" });
    expect(findByIdentity("google", "g-1")?.username).toBe("ana");
    expect(() => linkIdentity(findUser("ben")!, { provider: "google", sub: "g-1", email: "ana@example.test" })).toThrow(/already signs in/);
  });

  it("unlinks a provider for the signed-in account only", async () => {
    expect((await app.request("/api/auth/identity/google", { method: "DELETE" })).status).toBe(401);
    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ana", password: "anapass12" }),
    });
    const cookie = cookieOf(login);
    const res = await app.request("/api/auth/identity/google", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(findUser("ana")?.identities).toBeUndefined();
    expect(findByIdentity("google", "g-1")).toBeNull();
    expect((await app.request("/api/auth/identity/nope", { method: "DELETE", headers: { cookie } })).status).toBe(404);
  });

  it("passes a callback it did not start on (a 400 or 404 here, the Mac app's own answer when that is mounted)", async () => {
    const res = await app.request("/api/auth/google/callback?state=not-ours&code=x");
    expect([400, 404]).toContain(res.status);
  });
});
