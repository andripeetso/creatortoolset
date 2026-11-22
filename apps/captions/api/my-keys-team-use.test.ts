import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AuthVars } from "./auth";

// Team use (Settings → API keys → Server keys): the admin's own team uses the server's keys; another account's team never
const dir = mkdtempSync(path.join(tmpdir(), "team-use-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "test-secret-123"; // accounts on; boots the "admin" account
process.env.DEEPGRAM_API_KEY = "server-dg";
const member = (username: string, role: "owner" | "member", ai = "own") => ({ username, role, ai, budgetUsd: ai === "budget" ? 5 : 0, joinedAt: 0 });
const team = (id: string, owner: string, ...others: ReturnType<typeof member>[]) => ({ id, name: id, plan: "team", comped: false, createdAt: 0, members: [member(owner, "owner"), ...others] });
writeFileSync(
  path.join(dir, "workspaces.json"),
  JSON.stringify({ workspaces: [team("ws-admin", "admin", member("kim", "member"), member("bea", "member", "budget")), team("ws-lee", "lee", member("jo", "member"))], invites: [], spend: {} }),
);

const { createUser } = await import("./users");
const { keyFor, teamAiKey } = await import("./my-keys");
const { addSpend, setTeamAi, workspaceOf } = await import("./lib/workspaces");
const { serviceKeysApp } = await import("./service-keys");
for (const u of ["kim", "bea", "lee", "jo"]) createUser(u, "password1");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "admin", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/", serviceKeysApp);
const put = (p: string, body: unknown) => app.request(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const teamUse = (on: boolean) => app.request("/team-use", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) });

it("a member of the admin's team gets the server's keys only while Team use is on; another account's team never does", async () => {
  expect(keyFor("kim", "DEEPGRAM_API_KEY").key).toBe("");
  expect((await teamUse(true)).status).toBe(200);
  expect(keyFor("kim", "DEEPGRAM_API_KEY").key).toBe("server-dg");
  expect(keyFor("jo", "DEEPGRAM_API_KEY").key).toBe("");
  expect(keyFor("lee", "DEEPGRAM_API_KEY").key).toBe("");
  // the Anthropic key is never a key route: a team budget is its only way (teamAiKey)
  process.env.ANTHROPIC_API_KEY = "server-ai";
  expect(keyFor("kim", "ANTHROPIC_API_KEY").key).toBe("");
  await teamUse(false);
  expect(keyFor("kim", "DEEPGRAM_API_KEY").key).toBe("");
});

it("an Anthropic key pasted in Server keys pays only the team budgets, never anyone's key route", async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await teamUse(true);
  expect(teamAiKey("bea", "notes").key).toBe("");
  expect((await put("/ANTHROPIC_API_KEY", { value: "sk-pasted-1234" })).status).toBe(200);
  expect(teamAiKey("bea", "notes").key).toBe("sk-pasted-1234");
  expect(teamAiKey("kim", "notes").key).toBe(""); // no budget: their own AI
  expect(keyFor({ username: "admin", role: "admin" }, "ANTHROPIC_API_KEY").key).toBe("");
  await teamUse(false);
  expect(teamAiKey("bea", "notes").key).toBe("");
});

it("the team's limits: a tool the admin left out, and a team budget used up, refuse the key with what is missing", async () => {
  await teamUse(true);
  const w = workspaceOf("bea")!;
  setTeamAi(w, { aiTools: ["notes"] });
  const key = teamAiKey("bea", "notes").key; // the Anthropic key pasted above
  expect(key).toMatch(/^sk-/);
  expect(teamAiKey("bea", "captions")).toEqual({ key: "", missing: "Caption Studio can't use the server's key: ask the admin" });
  expect(teamAiKey("bea", "workshop").key).toBe(""); // never on the server's key
  setTeamAi(w, { aiTools: null, budgetUsd: 3 });
  expect(teamAiKey("bea", "captions").key).toBe(key);
  addSpend("kim", 2); // the team total is its members' sum: kim's spend counts against bea's call too
  addSpend("bea", 1);
  expect(teamAiKey("bea", "captions")).toEqual({ key: "", missing: "Team budget used up this month: ask the admin" });
  setTeamAi(w, { budgetUsd: null });
  expect(teamAiKey("bea", "captions").key).toBe(key); // bea's own $5 still has $4 left
  setTeamAi(w, { budgetUsd: 0 }); // 0 stops all spending on the server's key
  expect(teamAiKey("bea", "notes").missing).toBe("Team budget used up this month: ask the admin");
  expect(() => setTeamAi(w, { budgetUsd: -1 })).toThrow(/budget/);
  setTeamAi(w, { budgetUsd: null });
  await teamUse(false);
});
