import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

// Hosted mode (CT_MODE=hosted, with accounts): teams, invites, member roles, view-as and the admin API.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "hosted-team-"));
process.env.APP_SECRET = "hosted-team-secret";
process.env.CT_MODE = "hosted";

const { default: app } = await import("./boot");
const { env } = await import("./lib/env");
const { mountPlugins } = await import("./lib/plugin");
const { findUser } = await import("./users");

// A plug-in whose gate starts switched off for every new account (the invite path included).
mountPlugins(new Hono(), [{ id: "gated-test", gates: { ids: ["gated-test"], defaultOff: ["gated-test"] } }]);

const call = (method: string, url: string, cookie?: string, body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.request(url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

/** Signs in and returns the cookie header for the next request. */
async function login(username: string, password: string): Promise<string> {
  const res = await call("POST", "/api/auth/login", undefined, { username, password });
  expect(res.status).toBe(200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

describe("hosted team", () => {
  const admin = env.adminUsername;
  let adminCookie = "";
  let annCookie = "";
  let token = "";

  it("the admin invites a member; the link says who invited", async () => {
    adminCookie = await login(admin, env.appSecret!);
    const made = await call("POST", "/api/workspace/invites", adminCookie, { ai: "own", budgetUsd: 0 });
    expect(made.status).toBe(200);
    token = ((await made.json()) as { token: string }).token;
    expect(token).toMatch(/^[a-f0-9]{40}$/);

    const info = (await (await call("GET", `/api/auth/invite/${token}`)).json()) as { workspace: string; invitedBy: string; expired: boolean };
    expect(info).toMatchObject({ workspace: "Workspace", invitedBy: admin, expired: false });
  });

  it("joining makes a team member whose plug-in gate starts off", async () => {
    const res = await call("POST", `/api/auth/invite/${token}`, undefined, { username: "ann", password: "ann-secret-1" });
    expect(res.status).toBe(200);
    const ann = findUser("ann");
    expect(ann?.role).toBe("team");
    expect(ann?.off).toContain("gated-test");
  });

  it("an invite works once", async () => {
    const again = await call("POST", `/api/auth/invite/${token}`, undefined, { username: "bo", password: "secret2" });
    expect(again.status).toBe(404);
    expect(findUser("bo")).toBeNull();
  });

  it("a member sees the team but manages nothing and reaches no admin route", async () => {
    annCookie = await login("ann", "ann-secret-1");
    const ws = (await (await call("GET", "/api/workspace", annCookie)).json()) as { me: string; members: { username: string }[] };
    expect(ws.me).toBe("member");
    expect(ws.members.map((m) => m.username).sort()).toEqual([admin, "ann"].sort());

    expect((await call("PATCH", "/api/workspace/members/ann", annCookie, { off: [] })).status).toBe(403);
    expect((await call("GET", "/api/admin/users", annCookie)).status).toBe(403);
  });

  it("view-as: the admin reads as a member, read-only, and the admin API stays the admin's", async () => {
    const set = await call("POST", "/api/admin/view-as/ann", adminCookie);
    expect(set.status).toBe(200);
    expect(set.headers.get("set-cookie")).toContain("ct_view_as=ann");

    const viewing = `${adminCookie}; ct_view_as=ann`;
    const ws = (await (await call("GET", "/api/workspace", viewing)).json()) as { me: string };
    expect(ws.me).toBe("member");

    const write = await call("POST", "/api/workspace/invites", viewing, { ai: "own" });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe("VIEW_AS");

    expect((await call("GET", "/api/admin/users", viewing)).status).toBe(200);
    expect((await call("DELETE", "/api/admin/view-as", adminCookie)).status).toBe(200);
  });

  it("a view-as cookie is no way in for a member", async () => {
    const forged = `${annCookie}; ct_view_as=${admin}`;
    const ws = (await (await call("GET", "/api/workspace", forged)).json()) as { me: string };
    expect(ws.me).toBe("member");
    const write = await call("POST", "/api/workspace/invites", forged, { ai: "own" });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code?: string }).code).toBeUndefined();
  });

  it("an admin's save keeps a retired app id's switch on a member", async () => {
    findUser("ann")!.off = [...findUser("ann")!.off, "finals"];
    const res = await call("PATCH", "/api/admin/users/ann", adminCookie, { off: ["media"] });
    expect(res.status).toBe(200);
    expect(findUser("ann")!.off).toEqual(expect.arrayContaining(["finals", "media"]));
  });

  it("the admin lists the member, then deletes the account", async () => {
    const users = (await (await call("GET", "/api/admin/users", adminCookie)).json()) as { username: string; role: string }[];
    expect(users.find((u) => u.username === "ann")?.role).toBe("team");

    expect((await call("DELETE", "/api/admin/users/ann", adminCookie)).status).toBe(200);
    expect(findUser("ann")).toBeNull();
  });
});
