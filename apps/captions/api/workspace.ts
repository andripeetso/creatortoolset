import { Hono, type Context } from "hono";
import type { AuthVars } from "./auth";
import { isPluginGateId, isRetiredAppId, isTool, type PluginGateId, type Tool } from "../contracts/tools";
import { INVITE_DAYS, type Member, type MemberView, type WorkspaceView } from "../contracts/workspaces";
import { pluginDefaultOff } from "./lib/plugin";
import {
  canManage,
  createInvite,
  invitesOf,
  memberIn,
  removeMember,
  renameWorkspace,
  revokeInvite,
  updateInvite,
  setSignInWith,
  spentThisMonth,
  updateMember,
  workspaceOf,
} from "./lib/workspaces";
import { findUser, setOff, type SessionUser, type UserRecord } from "./users";
import { EMAIL_RE, mailOn, sendMail } from "./lib/mail";
import { originOf } from "./sign-in";
import { inviteTarget, ownedProjects } from "./lib/workshop/workspace";

/** The ids in a request's `workspaces` that are the owner's own workspaces (brands); undefined when it asks none. */
async function brandsFrom(asked: unknown, owner: string): Promise<string[] | undefined> {
  if (!Array.isArray(asked)) return undefined;
  const mine = new Set((await ownedProjects(owner)).map((p) => p.id));
  return [...new Set(asked.filter((id): id is string => typeof id === "string" && mine.has(id)))];
}

/**
 * Settings → Team (contracts/workspaces.ts): the team, its members, invite links and each member's AI. The owner
 * manages; a member sees who is in it and their own AI. boot.ts mounts it at /api/workspace, in hosted mode only.
 */
export const workspaceApp = new Hono<{ Variables: AuthVars }>();

/**
 * One member as a view. The name is read from the member's account (its display name, read-only: nothing is stored
 * here). Someone who may not manage sees the name and the role, not spend, activity or ticks.
 */
export function memberView(m: Member, acct: Pick<UserRecord, "displayName" | "usage" | "off"> | null, full: boolean, spentUsd: number): MemberView {
  const name = acct?.displayName || undefined;
  return full
    ? { ...m, name, spentUsd, lastActiveAt: acct?.usage.lastActiveAt ?? 0, off: acct?.off ?? [] }
    : { username: m.username, name, role: m.role, ai: "own", budgetUsd: 0, joinedAt: m.joinedAt, spentUsd: 0, lastActiveAt: 0, off: [] };
}

async function viewFor(u: SessionUser): Promise<WorkspaceView | null> {
  const w = workspaceOf(u.username);
  const me = w && memberIn(w, u.username);
  if (!w || !me) return null;
  const manager = canManage(me.role);
  const members: MemberView[] = w.members.map((m) => {
    const full = manager || m.username === u.username;
    return memberView(m, findUser(m.username), full, full ? spentThisMonth(m.username) : 0);
  });
  return {
    workspace: { id: w.id, name: w.name, plan: w.plan, comped: w.comped, createdAt: w.createdAt, signInWith: w.signInWith },
    me: me.role,
    members,
    invites: manager ? invitesOf(w) : [],
    seats: w.members.filter((m) => m.role !== "owner").length,
    ...(manager ? { mail: mailOn(), brands: (await ownedProjects(u.username)).map((p) => ({ id: p.id, name: p.name })) } : {}),
  };
}

/** The asker's workspace and role, when they may manage it; else the error response. */
function managed(c: Context<{ Variables: AuthVars }>) {
  const u = c.get("user");
  const w = workspaceOf(u.username);
  const me = w && memberIn(w, u.username);
  if (!w || !me) return { error: c.json({ error: "No team" }, 404) };
  if (!canManage(me.role)) return { error: c.json({ error: "Only the owner manages the team" }, 403) };
  return { w, me, u };
}

const bad = (c: Context, e: unknown) => c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
const body = async (c: Context): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
};

workspaceApp.get("/", async (c) => c.json(await viewFor(c.get("user"))));

workspaceApp.patch("/", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  const b = await body(c);
  try {
    if (typeof b.name === "string") renameWorkspace(m.w, b.name);
    if (Array.isArray(b.signInWith)) setSignInWith(m.w, m.u.username, b.signInWith);
  } catch (e) {
    return bad(c, e);
  }
  return c.json(await viewFor(m.u));
});

workspaceApp.post("/invites", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  const b = await body(c);
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (email && !EMAIL_RE.test(email)) return c.json({ error: "That email address doesn't look right" }, 400);
  if (email && !mailOn()) return c.json({ error: "Email isn't set up on this server: copy the link instead" }, 400);
  let made: ReturnType<typeof createInvite>;
  try {
    made = createInvite(m.w, { username: m.u.username, role: m.me.role }, { ...b, email: email || undefined, workspaces: await brandsFrom(b.workspaces, m.u.username) });
  } catch (e) {
    return bad(c, e);
  }
  if (email) {
    const from = findUser(m.u.username)?.displayName || m.u.username;
    const link = `${originOf(c)}/join/${made.token}`;
    const server = new URL(originOf(c)).host;
    const what = await inviteTarget(m.u.username, made.invite.workspaces, server);
    const where = what === server ? server : `${what} on ${server}`;
    try {
      await sendMail(
        email,
        `${from} invited you to ${what} on Creator Toolset`,
        `${from} invited you to work in ${where}.\n\n` +
          `Your invite (it works for ${INVITE_DAYS} days):\n${link}\n\n` +
          `New to Creator Toolset?\n` +
          `1. Download the app: https://creatortoolset.com/download\n` +
          `2. Open the invite link above and choose Open in the app, or paste the link into the app's Add server.\n` +
          `The app then adds ${server} and opens ${what === server ? "it" : what} for you: there is nothing else to set up.\n\n` +
          `Rather use a browser? Open the invite link and join there.\n`,
      );
    } catch (e) {
      revokeInvite(m.w, made.invite.id); // not sent: no link left behind that nobody has
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  return c.json(made);
});

/** The apps a request's `off` asks for. A plug-in's default-off gates only a platform admin switches: anyone else's request leaves them as `had`. */
function offFrom(asked: unknown[], had: (Tool | PluginGateId)[], admin: boolean): (Tool | PluginGateId)[] {
  const want = asked.filter((t): t is Tool | PluginGateId => typeof t === "string" && (isTool(t) || isPluginGateId(t)));
  const guarded = pluginDefaultOff();
  // a retired app id (not in the request, not an app any more) keeps its entry too
  const keep = (t: Tool | PluginGateId) => (isRetiredAppId(t) || (guarded.includes(t) && !admin) ? had.includes(t) : want.includes(t));
  return [...new Set([...want, ...had])].filter(keep);
}

workspaceApp.patch("/invites/:id", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  const b = await body(c);
  const invite = invitesOf(m.w).find((i) => i.id === c.req.param("id"));
  if (!invite) return c.json({ error: "No such invite" }, 404);
  if (b.scripts !== undefined && typeof b.scripts !== "boolean") return c.json({ error: "Scripts is on or off" }, 400);
  updateInvite(m.w, invite.id, {
    ...(Array.isArray(b.off) ? { off: offFrom(b.off, invite.off ?? [], m.u.role === "admin") } : {}),
    ...(typeof b.scripts === "boolean" ? { scripts: b.scripts } : {}),
    workspaces: await brandsFrom(b.workspaces, m.u.username),
  });
  return c.json(await viewFor(m.u));
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
    updateMember(m.w, name, m.me.role, { ai: b.ai, budgetUsd: b.budgetUsd, scripts: b.scripts, workspaces: await brandsFrom(b.workspaces, m.u.username) });
    if (Array.isArray(b.off)) {
      const acct = findUser(name);
      if (!acct) throw new Error("No such account");
      setOff(acct, offFrom(b.off, acct.off, m.u.role === "admin"));
    }
  } catch (e) {
    return bad(c, e);
  }
  return c.json(await viewFor(m.u));
});

workspaceApp.delete("/members/:username", async (c) => {
  const m = managed(c);
  if (m.error) return m.error;
  try {
    removeMember(m.w, c.req.param("username"), m.me.role);
  } catch (e) {
    return bad(c, e);
  }
  return c.json(await viewFor(m.u));
});
