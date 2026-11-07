import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// a fresh server: only the booted admin, no workspaces.json yet
process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "signup-"));
process.env.APP_SECRET = "signup-test-secret";
process.env.TRUST_PROXY = "1"; // the tests vary the address through the proxy's header

const app = (await import("./boot")).default;
const { createInvite, workspaceOf } = await import("./lib/workspaces");

const signup = (body: unknown, ip: string) =>
  app.request("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.1, ${ip}` },
    body: JSON.stringify(body),
  });
const check = async () => (await (await app.request("/api/auth/check")).json()) as { signup: boolean };

afterEach(() => vi.unstubAllEnvs());

describe("Create account (ALLOW_SIGNUP)", () => {
  it("is off by default: no button, and the route says so", async () => {
    expect((await check()).signup).toBe(false);
    expect((await signup({ username: "tinyacrobatics", password: "password1" }, "203.0.113.1")).status).toBe(404);
  });

  it("makes an account with its own free workspace, signs it in, and the first-run calls work", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "1");
    expect((await check()).signup).toBe(true);
    const res = await signup({ username: " TinyAcrobatics ", password: "password1" }, "203.0.113.2");
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { username: string; role: string; logins: number } };
    expect(user).toMatchObject({ username: "tinyacrobatics", role: "user", logins: 1 }); // logins 1 = setup opens
    const mine = workspaceOf("tinyacrobatics")!;
    expect(mine).toMatchObject({ plan: "free", members: [{ username: "tinyacrobatics", role: "owner" }] });
    expect(workspaceOf("admin")?.id).not.toBe(mine.id);

    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    // setup step 1: the first project
    const made = await app.request("/api/workshop/projects", json("POST", { name: "Tiny Acrobatics", notes: "Parents of babies under one." }));
    expect(made.status).toBe(201);
    // setup step 4: one of their own keys, never sent back
    expect((await app.request("/api/my-keys/DEEPGRAM_API_KEY", json("PUT", { value: "dg-secret-9876" }))).status).toBe(200);
    const keys = (await (await app.request("/api/my-keys", { headers: { cookie } })).json()) as Array<{ env: string; set: boolean; last4?: string }>;
    expect(keys.find((k) => k.env === "DEEPGRAM_API_KEY")).toMatchObject({ set: true, last4: "9876" });
    expect(JSON.stringify(keys)).not.toContain("dg-secret");
    expect(statSync(path.join(process.env.DATA_DIR!, "my-keys", "tinyacrobatics.json")).mode & 0o777).toBe(0o600);
  });

  it("keeps the invite rules: taken, reserved or bad names and short passwords are refused", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "1");
    for (const body of [
      { username: "tinyacrobatics", password: "password1" },
      { username: "guest-0123456789ab", password: "password1" },
      // the demo account visitors read through (and that the server's keys serve when the demo is switched on)
      { username: "demo", password: "password1" },
      { username: "a b", password: "password1" },
      { username: "tinyfan", password: "short" },
    ]) {
      expect((await signup(body, "203.0.113.3")).status).toBe(400);
    }
  });

  it("limits sign-ups per address, failed tries included", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "1");
    for (let i = 0; i < 5; i++) expect((await signup({ username: "x", password: "" }, "203.0.113.4")).status).toBe(400);
    expect((await signup({ username: "tinyfan", password: "password1" }, "203.0.113.4")).status).toBe(429);
    expect((await signup({ username: "tinyfan", password: "password1" }, "203.0.113.5")).status).toBe(200);
  });

  it("without TRUST_PROXY, a forged X-Forwarded-For doesn't reset the limit", async () => {
    vi.stubEnv("ALLOW_SIGNUP", "1");
    vi.stubEnv("TRUST_PROXY", "");
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await signup({ username: "x", password: "" }, `198.51.100.${i}`)).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
  });

  it("an invite link makes new accounts under the same limit (any account can mint links for its own workspace)", async () => {
    const w = workspaceOf("tinyacrobatics")!;
    const { token } = createInvite(w, { username: "tinyacrobatics", role: "owner" }, { ai: "own" });
    const join = (username: string) =>
      app.request(`/api/auth/invite/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ username, password: "" }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await join(`fan${i}`)).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
  });
});
