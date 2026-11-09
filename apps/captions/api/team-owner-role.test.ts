import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

// Owning a team grants nothing on the platform: the owner manages the team (invites, AI routes, budgets, a member's
// switches it may set) and nothing else. Admin routes, the server's keys and other people's AI stay with the platform
// role (users.ts role), never with the workspace role (lib/workspaces.ts canManage).
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "team-owner-role-"));
process.env.APP_SECRET = "team-owner-role-secret";
process.env.CT_MODE = "hosted";
process.env.DEEPGRAM_API_KEY = "server-deepgram";

// the team exists before anything reads it: alex owns it but is a team account, not a platform admin
// the server's admin is created at import from APP_SECRET (users.ts bootstrap): "admin" with the app secret as password
const { default: app } = await import("./boot");
const { mountPlugins } = await import("./lib/plugin");
const { keyFor } = await import("./my-keys");
const { aiFor } = await import("./ai-complete");
const { createUser, findUser } = await import("./users");

// a plug-in gate that starts switched off for every account but an admin's (mounted before the accounts are made)
mountPlugins(new Hono(), [{ id: "gated-test", gates: { ids: ["gated-test"], defaultOff: ["gated-test"] } }]);

// the team exists before anything reads it: alex owns it but is a team account, not a platform admin
createUser("alex", "secret-alex", { role: "team" });
createUser("bo", "secret-bo");
writeFileSync(
  path.join(process.env.DATA_DIR!, "workspaces.json"),
  JSON.stringify({
    workspaces: [
      {
        id: "ws-1",
        name: "Team",
        plan: "team",
        comped: false,
        createdAt: 0,
        members: [
          { username: "alex", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 },
          { username: "bo", role: "member", ai: "own", budgetUsd: 0, joinedAt: 0 },
        ],
      },
    ],
    invites: [],
    spend: {},
  }),
);

const call = (method: string, url: string, cookie?: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

async function login(username: string, password: string): Promise<string> {
  const res = await call("POST", "/api/auth/login", undefined, { username, password });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

describe("a team owner who is not a platform admin", () => {
  it("manages the team: invites and member switches", async () => {
    const cookie = await login("alex", "secret-alex");
    const ws = (await (await call("GET", "/api/workspace", cookie)).json()) as { me: string };
    expect(ws.me).toBe("owner");

    expect((await call("POST", "/api/workspace/invites", cookie, { ai: "own" })).status).toBe(200);
    expect((await call("PATCH", "/api/workspace/members/bo", cookie, { ai: "own" })).status).toBe(200);
  });

  it("reaches no platform admin route", async () => {
    const cookie = await login("alex", "secret-alex");
    expect((await call("GET", "/api/admin/users", cookie)).status).toBe(403);
    expect((await call("PATCH", "/api/admin/users/bo", cookie, { off: [] })).status).toBe(403);
  });

  it("cannot switch on a plug-in gate for a member: only a platform admin does", async () => {
    const cookie = await login("alex", "secret-alex");
    expect(findUser("bo")?.off).toContain("gated-test");
    // off lists the switched-off gates: an empty list asks to switch the gate on
    const res = await call("PATCH", "/api/workspace/members/bo", cookie, { off: [] });
    expect(res.status).toBe(200);
    expect(findUser("bo")?.off).toContain("gated-test");
  });

  it("gets no server key: the owner's key lookup is its own or nothing, while the platform admin gets the server's", () => {
    const owner = { username: "alex", role: "team" as const };
    expect(keyFor(owner, "DEEPGRAM_API_KEY").key).toBe("");
    expect(keyFor({ username: "admin", role: "admin" }, "DEEPGRAM_API_KEY").key).toBe("server-deepgram");
  });

  it("is not answered by the workspace's AI or the server's key: no route for alex's own AI", () => {
    const o = aiFor({ username: "alex", role: "team" }, "captions", "Caption Studio");
    expect(o.only).toEqual([]);
    expect(o.off).toMatch(/No AI for your account/);
    expect(o.apiKey).toBeUndefined();
  });
});
