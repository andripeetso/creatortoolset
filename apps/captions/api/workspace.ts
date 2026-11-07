import { Hono, type Context } from "hono";
import type { AuthVars } from "./auth";
import { anthropicKey } from "./ai-complete";
import { isTool } from "../contracts/tools";
import type { MemberView, WorkspaceView } from "../contracts/workspaces";
import {
  canManage,
  createInvite,
  invitesOf,
  memberIn,
  removeMember,
  renameWorkspace,
  revokeInvite,
  spentThisMonth,
  updateMember,
  ensureWorkspace,
  serverPays,
} from "./lib/workspaces";
import { findUser, setOff, type SessionUser } from "./users";

/**
 * Settings → Workspace (contracts/workspaces.ts): the team, its members, invite links and each member's AI.
 * The owner manages; a member sees who is in it and their own AI. boot.ts mounts it at /api/workspace.
 */
export const workspaceApp = new Hono<{ Variables: AuthVars }>();

const signedIn = (u: SessionUser) => u.role !== "guest" && !u.demo;

workspaceApp.use("*", async (c, next) => {
  if (!signedIn(c.get("user"))) return c.json({ error: "Not for guests" }, 403);
  await next();
});

function viewFor(u: SessionUser): WorkspaceView | null {
  const w = ensureWorkspace(u.username);
  const me = w && memberIn(w, u.username);
  if (!w || !me) return null;
  const manager = canManage(me.role);
  const members: MemberView[] = w.members.map((m) => {
    const full = manager || m.username === u.username;
    const acct = findUser(m.username);
    return full
      ? { ...m, spentUsd: spentThisMonth(m.username), lastActiveAt: acct?.usage.lastActiveAt ?? 0, off: acct?.off ?? [] }
      : { username: m.username, role: m.role, ai: "own", budgetUsd: 0, joinedAt: m.joinedAt, spentUsd: 0, lastActiveAt: 0, off: [] };
  });
  return {
    workspace: { id: w.id, name: w.name, plan: w.plan, comped: w.comped, createdAt: w.createdAt },
    me: me.role,
    members,
    invites: manager ? invitesOf(w) : [],
    budgets: serverPays(w),
    apiKey: serverPays(w) && !!anthropicKey(),
    seats: w.members.filter((m) => m.role !== "owner").length,
  };
}

/** The asker's workspace and role, when they may manage it; else the error response. */
function managed(c: Context<{ Variables: AuthVars }>) {
  const u = c.get("user");
  const w = ensureWorkspace(u.username);
  const me = w && memberIn(w, u.username);
  if (!w || !me) return { error: c.json({ error: "No workspace" }, 404) };
  if (!canManage(me.role)) return { error: c.json({ error: "Only the owner manages the team" }, 403) };
  return { w, me, u };
}

const bad = (c: Context, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
const body = async (c: Context): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
};

workspaceApp.get("/", (c) => c.json(viewFor(c.get("user"))));

workspaceApp.patch("/", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  const b = await body(c);
  try {
    if (typeof b.name === "string") renameWorkspace(m.w, b.name);
  } catch (e) {
    return bad(c, e);
  }
  return c.json(viewFor(m.u));
});

workspaceApp.post("/invites", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  const b = await body(c);
  try {
    return c.json(createInvite(m.w, { username: m.u.username, role: m.me.role }, b));
  } catch (e) {
    return bad(c, e);
  }
});

workspaceApp.delete("/invites/:id", (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  return revokeInvite(m.w, c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "No such invite" }, 404);
});

workspaceApp.patch("/members/:username", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  const name = c.req.param("username");
  const b = await body(c);
  try {
    updateMember(m.w, name, m.me.role, { ai: b.ai, budgetUsd: b.budgetUsd });
    if (Array.isArray(b.off)) {
      const acct = findUser(name);
      if (!acct) throw new Error("No such account");
      setOff(acct, b.off.filter(isTool));
    }
  } catch (e) {
    return bad(c, e);
  }
  return c.json(viewFor(m.u));
});

workspaceApp.delete("/members/:username", (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  try {
    removeMember(m.w, c.req.param("username"), m.me.role);
  } catch (e) {
    return bad(c, e);
  }
  return c.json(viewFor(m.u));
});
