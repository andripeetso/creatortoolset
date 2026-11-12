import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./lib/env";
import { secureAttr, type AuthVars } from "./auth";
import { VIEW_AS } from "./lib/view-as";
import { addMember, forgetAccount, ownedTeamWithMembers, workspaceOf } from "./lib/workspaces";
import { forgetGrants } from "./library/grants";
import { deleteUserContent, keepDaysFor } from "./retention";
import { dirBytes, keptView } from "./kept";
import type { KeptKind } from "../contracts/storage";
import { clearTries, codeRequired, lockedAnywhere, setCodeRequired } from "./lib/sign-in-code";
import { isPluginGateId, isRetiredAppId, isTool } from "../contracts/tools";
import {
  USERNAME_RE,
  adminCount,
  createUser,
  deleteUser,
  findUser,
  isRole,
  listUsers,
  passwordProblem,
  setOff,
  setPassword,
  setRole,
  setSignInCode,
} from "./users";

/**
 * Admin-only user management, usage overview and view-as. Mounted at /api/admin in hosted mode only (boot.ts); the
 * guard below additionally requires the admin role.
 */
export const adminApp = new Hono<{ Variables: AuthVars }>();

adminApp.use("*", async (c, next) => {
  if (c.get("user")?.role !== "admin") {
    return c.json({ error: "Admins only" }, 403);
  }
  return next();
});

const CAPTION_PROJECTS_DIR = path.join(env.dataDir, "projects");
const ENHANCE_PROJECTS_DIR = path.join(env.dataDir, "enhance");

/** One project on disk as the admin panel sees it ("" owner = pre-account). */
interface AdminProject {
  id: string;
  kind: "captions" | "enhance";
  name: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  bytes: number;
}

async function scanProjectDir(root: string, kind: AdminProject["kind"]): Promise<AdminProject[]> {
  const out: AdminProject[] = [];
  let dirs: string[] = [];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of dirs) {
    const dir = path.join(root, id);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8"));
    } catch {
      continue;
    }
    const bytes = await dirBytes(dir).catch(() => 0);
    out.push({
      id,
      kind,
      name: typeof meta.name === "string" ? meta.name : "untitled",
      owner: typeof meta.owner === "string" ? meta.owner : "",
      createdAt: typeof meta.createdAt === "number" ? meta.createdAt : 0,
      updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
      duration: typeof meta.duration === "number" ? meta.duration : 0,
      bytes,
    });
  }
  return out;
}

/** Caption Studio projects and Audio Enhancer sessions, as one admin list. */
async function scanProjects(): Promise<AdminProject[]> {
  const [captions, enhance] = await Promise.all([
    scanProjectDir(CAPTION_PROJECTS_DIR, "captions"),
    scanProjectDir(ENHANCE_PROJECTS_DIR, "enhance"),
  ]);
  return [...captions, ...enhance];
}

/* every project on the server, newest first — the admin Projects tab */
adminApp.get("/projects", async (c) => {
  const projects = await scanProjects();
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(projects);
});

/** Each account with what it keeps: the same count as its own Settings → Storage (api/kept.ts), so the two never disagree. */
adminApp.get("/users", async (c) => {
  const out = [];
  for (const u of listUsers()) {
    const rows = (await keptView(u)).rows;
    const n = (kind: KeptKind) => rows.find((r) => r.kind === kind)?.items ?? 0;
    out.push({
      username: u.username,
      name: u.displayName ?? "",
      role: u.role,
      off: u.off,
      createdAt: u.createdAt,
      usage: u.usage,
      code: !!u.code,
      locked: lockedAnywhere(u.username),
      projects: n("captions") + n("enhance"),
      instagramPosts: n("analyzer"),
      storageBytes: rows.reduce((sum, r) => sum + r.bytes, 0),
      keepDays: keepDaysFor(u.role),
    });
  }
  return c.json(out);
});

adminApp.post("/users", async (c) => {
  let body: { username?: string; password?: string; role?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const username = (body.username ?? "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return c.json({ error: "Username: 2–24 chars, letters/numbers/dash/underscore" }, 400);
  }
  try {
    const problem = passwordProblem(body.password ?? "");
    if (problem) throw new Error(problem);
    createUser(username, body.password ?? "", { role: isRole(body.role) ? body.role : "user" });
    // an account made here joins the admin's workspace as a member on their own AI (Settings → Team)
    const w = workspaceOf(c.get("user").username);
    if (w) addMember(w, username);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ ok: true });
});

adminApp.patch("/users/:username", async (c) => {
  const user = findUser(c.req.param("username"));
  if (!user) return c.json({ error: "No such user" }, 404);
  // `code: false` switches the account's sign-in code off (a lost phone); `unlock: true` lifts the lock on every address
  let body: { password?: string; role?: string; off?: unknown; code?: unknown; unlock?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  try {
    if (typeof body.password === "string") setPassword(user, body.password);
    if (body.code === false && user.code) setSignInCode(user, null);
    if (body.unlock === true) clearTries(user.username);
    if (body.role !== undefined) {
      if (!isRole(body.role)) return c.json({ error: "Role: user, team or admin" }, 400);
      setRole(user, body.role);
    }
    if (body.off !== undefined) {
      if (!Array.isArray(body.off) || !body.off.every((t) => isTool(t) || isPluginGateId(t) || isRetiredAppId(t))) {
        return c.json({ error: "Unknown app" }, 400);
      }
      // a retired app id has no switch in the list, so a save keeps the account's entry for it
      setOff(user, [...body.off, ...user.off.filter(isRetiredAppId)]);
    }
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ ok: true });
});

adminApp.delete("/users/:username", async (c) => {
  const target = findUser(c.req.param("username"));
  if (!target) return c.json({ error: "No such user" }, 404);
  if (target.username === c.get("user").username) {
    return c.json({ error: "You can't delete your own account" }, 400);
  }
  if (target.role === "admin" && adminCount() <= 1) {
    return c.json({ error: "Can't delete the last admin" }, 400);
  }
  const team = ownedTeamWithMembers(target.username);
  if (team) return c.json({ error: `${target.username} owns ${team.name}, which has other members: transfer ownership first` }, 409);
  await deleteUserContent(target.username);
  deleteUser(target.username);
  forgetAccount(target.username);
  forgetGrants(target.username);
  return c.json({ ok: true });
});

/**
 * Every password sign-in on this server asks for a sign-in code ({ required }). Turning it on needs the admin's own code
 * first, and signs out everyone who has none: they set one up at their next sign-in.
 */
adminApp.put("/sign-in-code", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { required?: unknown };
  if (typeof b.required !== "boolean") return c.json({ error: "required: true or false" }, 400);
  const me = findUser(c.get("user").username);
  if (b.required && !me?.code) return c.json({ error: "Switch on your own sign-in code first, in Settings → Account" }, 400);
  if (b.required && !codeRequired()) for (const u of listUsers()) if (!u.code) setSignInCode(u, null, true);
  setCodeRequired(b.required);
  return c.json({ required: codeRequired() });
});

/**
 * View-as: this admin reads the app as that account until View-as is ended. Read-only: boot.ts refuses writes while it
 * is on. The cookie is honoured for a platform admin only, so it is no way in for anyone else.
 */
adminApp.post("/view-as/:username", (c) => {
  const target = findUser(c.req.param("username"));
  if (!target) return c.json({ error: "No such user" }, 404);
  setCookie(c, VIEW_AS, target.username, { path: "/", httpOnly: true, sameSite: "Lax", secure: !!secureAttr(c) });
  return c.json({ ok: true, username: target.username });
});

adminApp.delete("/view-as", (c) => {
  deleteCookie(c, VIEW_AS, { path: "/" });
  return c.json({ ok: true });
});
