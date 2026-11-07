import { Hono } from "hono";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "./lib/env";
import { deleteUserContent } from "./retention";
import { forgetMyKeys } from "./my-keys";
import type { AuthVars } from "./auth";
import { guestOverview } from "./guest";
import { addMember, forgetAccount, workspaceOf } from "./lib/workspaces";
import {
  USERNAME_RE,
  adminCount,
  createUser,
  deleteUser,
  findUser,
  isRole,
  isTool,
  listUsers,
  setOff,
  setPassword,
  setRole,
} from "./users";

/**
 * Admin-only user management + usage overview. Mounted behind the
 * global auth middleware; the guard below additionally requires the
 * admin role.
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
const INSTAGRAM_DIR = path.join(env.dataDir, "instagram");

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

/** Total size of a directory tree (clips live in subdirectories). */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    try {
      if (e.isDirectory()) total += await dirBytes(path.join(dir, e.name));
      else total += (await stat(path.join(dir, e.name))).size;
    } catch {
      /* entry vanished mid-scan */
    }
  }
  return total;
}

async function scanProjectDir(
  root: string,
  kind: AdminProject["kind"],
): Promise<AdminProject[]> {
  const out: AdminProject[] = [];
  let dirs: string[] = [];
  try {
    dirs = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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

/** Per-owner live project count and bytes on disk. */
async function projectFootprints(): Promise<
  Map<string, { projects: number; bytes: number }>
> {
  const out = new Map<string, { projects: number; bytes: number }>();
  for (const p of await scanProjects()) {
    // legacy projects predate accounts — attribute them to the admin
    const owner = p.owner || (env.appSecret ? env.adminUsername : "local");
    const cur = out.get(owner) ?? { projects: 0, bytes: 0 };
    cur.projects += 1;
    cur.bytes += p.bytes;
    out.set(owner, cur);
  }
  return out;
}

/** Instagram ingests: per-owner post count and bytes on disk. */
async function instagramFootprints(): Promise<
  Map<string, { posts: number; bytes: number }>
> {
  const out = new Map<string, { posts: number; bytes: number }>();
  let ids: string[] = [];
  try {
    ids = (await readdir(INSTAGRAM_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    const dir = path.join(INSTAGRAM_DIR, id);
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf-8"));
    } catch {
      continue;
    }
    const owner =
      typeof meta.owner === "string" && meta.owner
        ? meta.owner
        : env.appSecret
          ? env.adminUsername
          : "local";
    const bytes = await dirBytes(dir).catch(() => 0);
    const cur = out.get(owner) ?? { posts: 0, bytes: 0 };
    cur.posts += 1;
    cur.bytes += bytes;
    out.set(owner, cur);
  }
  return out;
}

/* every project on the server, newest first — the admin Projects tab */
adminApp.get("/projects", async (c) => {
  const projects = await scanProjects();
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(projects);
});

/* what guests transcribed, newest first, and today's guest usage */
adminApp.get("/guests", async (c) => c.json(await guestOverview()));

adminApp.get("/users", async (c) => {
  const [footprints, ig] = await Promise.all([
    projectFootprints(),
    instagramFootprints(),
  ]);
  return c.json(
    listUsers().map((u) => ({
      username: u.username,
      role: u.role,
      off: u.off,
      createdAt: u.createdAt,
      usage: u.usage,
      projects: footprints.get(u.username)?.projects ?? 0,
      instagramPosts: ig.get(u.username)?.posts ?? 0,
      storageBytes:
        (footprints.get(u.username)?.bytes ?? 0) +
        (ig.get(u.username)?.bytes ?? 0),
    })),
  );
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
    return c.json(
      { error: "Username: 2–24 chars, letters/numbers/dash/underscore" },
      400,
    );
  }
  try {
    createUser(username, body.password ?? "", {
      role: isRole(body.role) ? body.role : "user",
      byAdmin: true,
    });
    // an account made here joins the admin's workspace as a member on their own AI (Settings → Workspace)
    const w = workspaceOf(c.get("user").username);
    if (w && username !== "demo") addMember(w, username);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ ok: true });
});

adminApp.patch("/users/:username", async (c) => {
  const user = findUser(c.req.param("username"));
  if (!user) return c.json({ error: "No such user" }, 404);
  let body: { password?: string; role?: string; off?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  try {
    if (typeof body.password === "string") setPassword(user, body.password);
    if (body.role !== undefined) {
      if (!isRole(body.role)) return c.json({ error: "Role: user, team or admin" }, 400);
      setRole(user, body.role);
    }
    if (body.off !== undefined) {
      if (!Array.isArray(body.off) || !body.off.every(isTool)) return c.json({ error: "Unknown app" }, 400);
      setOff(user, body.off);
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
  deleteUser(target.username);
  forgetAccount(target.username);
  forgetMyKeys(target.username);
  // their projects, originals, Review videos, notes and guides go with them
  await deleteUserContent(target.username);
  return c.json({ ok: true });
});
