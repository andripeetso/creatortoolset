import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "workspaces-"));
process.env.APP_SECRET = "test-secret-123"; // cookies on; boots the "admin" account
const { authApp } = await import("./auth");
const { workspaceApp } = await import("./workspace");
const { aiFor } = await import("./ai-complete");
const { createUser, findUser } = await import("./users");
const { addSpend, workspaceOf } = await import("./lib/workspaces");
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import type { WorkspaceView } from "../contracts/workspaces";

let who: SessionUser = { username: "admin", role: "admin", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.route("/api/auth", authApp);
app.use("/api/workspace/*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/workspace", workspaceApp);

const as = (username: string, role: SessionUser["role"] = "team") => {
  who = { username, role, cloud: true, off: [] };
};
const send = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(url, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const view = async () => (await (await send("GET", "/api/workspace")).json()) as WorkspaceView | null;
const invite = async (body: unknown) => (await send("POST", "/api/workspace/invites", body)).json() as Promise<{ token: string; error?: string }>;

beforeAll(() => {
  createUser("robin", "password1", { role: "team" });
  createUser("lee", "password1", { role: "user" });
  createUser("demo", "password1", { role: "user", byAdmin: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  as("admin", "admin");
});

describe("workspaces: the team, its members and invites", () => {
  it("the first load makes one workspace from the accounts: the admin owns it, the rest are members on their own AI", async () => {
    const v = (await view())!;
    expect(v.me).toBe("owner");
    expect(v.workspace).toMatchObject({ plan: "team", comped: true });
    expect(v.members.map((m) => [m.username, m.role, m.ai])).toEqual([
      ["admin", "owner", "own"],
      ["robin", "member", "own"],
      ["lee", "member", "own"],
    ]); // the demo account is no member
    expect(v.seats).toBe(2);
    expect(v.budgets).toBe(true); // the platform admin's workspace: the server's key can pay a budget
  });

  it("someone else's own workspace is told it has no API budget to give", async () => {
    createUser("sam", "password1", { role: "user" });
    as("sam", "user");
    expect(await view()).toMatchObject({ me: "owner", budgets: false, apiKey: false });
  });

  it("an invite link makes a new account, signs it in, and joins it with the invite's AI; the link works once", async () => {
    const { token } = await invite({ ai: "budget", budgetUsd: 5 });
    expect(token).toMatch(/^[a-f0-9]{40}$/);
    expect(await (await send("GET", `/api/auth/invite/${token}`)).json()).toMatchObject({ workspace: "Workspace", invitedBy: "admin", expired: false, signedInAs: null });
    const res = await send("POST", `/api/auth/invite/${token}`, { username: "nina", password: "secret12" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/^cap_auth=/);
    expect(findUser("nina")?.role).toBe("team"); // a team's member keeps files as long as the team
    expect((await view())!.members.find((m) => m.username === "nina")).toMatchObject({ role: "member", ai: "budget", budgetUsd: 5 });
    expect((await send("POST", `/api/auth/invite/${token}`, { username: "nina2", password: "secret12" })).status).toBe(404);
  });

  it("a signed-in account joins with its own login; an expired link is refused", async () => {
    expect((await send("DELETE", "/api/workspace/members/lee")).status).toBe(200);
    const { token } = await invite({});
    const login = await send("POST", "/api/auth/login", { username: "lee", password: "password1" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    expect(await (await send("GET", `/api/auth/invite/${token}`, undefined, { cookie })).json()).toMatchObject({ signedInAs: "lee", member: false });
    expect((await send("POST", `/api/auth/invite/${token}`, {}, { cookie })).status).toBe(200);
    expect(workspaceOf("lee")?.members.some((m) => m.username === "lee")).toBe(true);

    const late = await invite({});
    vi.useFakeTimers({ now: Date.now() + 8 * 86_400_000, toFake: ["Date"] });
    expect((await send("POST", `/api/auth/invite/${late.token}`, { username: "late", password: "secret12" })).status).toBe(410);
    expect(findUser("late")).toBeNull();
  });

  it("owner or member, nothing between: a member sees the team but can't change it or invite; the owner does", async () => {
    as("robin");
    const mine = (await view())!;
    expect(mine.me).toBe("member");
    expect(mine.invites).toEqual([]);
    expect(mine.members.find((m) => m.username === "nina")).toMatchObject({ ai: "own", budgetUsd: 0, spentUsd: 0 }); // others' details hidden
    expect((await send("PATCH", "/api/workspace", { name: "Mine now" })).status).toBe(403);
    expect((await send("PATCH", "/api/workspace/members/nina", { budgetUsd: 8 })).status).toBe(403);
    expect((await send("POST", "/api/workspace/invites", {})).status).toBe(403);

    as("admin", "admin");
    expect((await send("PATCH", "/api/workspace/members/robin", { role: "owner" })).status).toBe(200); // a role is never patched
    expect((await view())!.members.find((m) => m.username === "robin")?.role).toBe("member");
    expect((await send("PATCH", "/api/workspace/members/nina", { budgetUsd: 8 })).status).toBe(200);
    expect((await send("DELETE", "/api/workspace/members/admin")).status).toBe(400); // nobody removes the owner
  });

  it("the owner switches apps for a member", async () => {
    as("admin", "team");
    await send("PATCH", "/api/workspace/members/nina", { off: ["stories"] });
    expect(findUser("nina")!.off.sort()).toEqual(["stories"]);
    await send("PATCH", "/api/workspace/members/nina", { off: ["clean"] });
    expect(findUser("nina")!.off).toEqual(["clean"]);
  });
});

describe("AI for members: their own, or a monthly API budget, never the owner's logins", () => {
  it("a member on a budget runs on the API key, billed to them, until the month's budget is used; never the Workshop", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    const nina = { username: "nina", role: "team" as const };
    expect(aiFor(nina, "captions", "Caption Studio")).toMatchObject({ only: ["anthropic"], bill: "nina", mac: { label: "Caption Studio" } });
    expect(aiFor(nina, "workshop", "Workshop").off).toMatch(/runs on your own AI/);
    addSpend("nina", 8);
    expect(aiFor(nina, "captions", "Caption Studio").off).toMatch(/budget for this month is used up/);
  });

  it("a member on their own AI with none connected gets no AI", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    expect(aiFor({ username: "lee", role: "team" }, "captions", "Caption Studio").off).toMatch(/No AI provider/);
  });
});

describe("a budget member's API answer is billed to them, end to end", () => {
  it("aiFor → completeWithFallback → the Anthropic call → their month's spend", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-key");
    const { completeWithFallback } = await import("./ai-complete");
    const { spentThisMonth } = await import("./lib/workspaces");
    as("admin", "admin");
    await send("PATCH", "/api/workspace/members/lee", { ai: "budget", budgetUsd: 50 });
    const before = spentThisMonth("lee");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1000, output_tokens: 1000 } }), { status: 200 }),
    );
    try {
      const out = await completeWithFallback("system", "user", undefined, (t) => t, aiFor({ username: "lee", role: "team" }, "captions", "Caption Studio"));
      expect(out).toBe("ok");
      expect(fetchMock.mock.calls[0]![0]).toMatch(/\/v1\/messages$/);
    } finally {
      fetchMock.mockRestore();
    }
    expect(spentThisMonth("lee") - before).toBeCloseTo((1000 * 4 + 1000 * 20) / 1e6, 6); // Opus 5.5: $4 in, $20 out per million
  });
});
