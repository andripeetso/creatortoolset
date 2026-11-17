/**
 * Item 7B: the routes behind Settings for where video work runs (work/server-work.ts), at /api/work/server-work.
 *
 *   GET  /                 → ServerWorkView: this server's kind, the person's server row in Load balancing, and for
 *                            an admin of a server by address the switch with its workspaces
 *   PUT  /                 { on?: boolean, all?: true, only?: [workspace ids] } (admin, a server by address)
 *   GET  /workspace/:id    → { allowed, server } (the workspace's owner)
 *   PUT  /workspace/:id    { server: boolean } (the workspace's owner)
 *
 * The server row's preference itself saves with the computers' (PUT /api/devices/balance, key "server").
 */
import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerWorkView } from "../../contracts/work";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { ownedProject, ownedProjects, sharedProjects } from "../lib/workshop/workspace";
import type { Project } from "../lib/workshop/types";
import { writeJsonAtomic } from "../library/media/run";
import { readServerWork, serverAllows, serverKind, serverWeight, serverWorks, writeServerWork } from "./server-work";

export const serverWorkApp = new Hono<{ Variables: AuthVars }>();

const PROJECTS = () => path.join(env.dataDir, "workshop", "projects");

/** Every workspace on this server, oldest first (the admin's list). */
async function allProjects(): Promise<Project[]> {
  const names = await readdir(PROJECTS()).catch(() => [] as string[]);
  const out: Project[] = [];
  for (const n of names.filter((x) => x.endsWith(".json"))) {
    const p = await readFile(path.join(PROJECTS(), n), "utf8").then((t) => JSON.parse(t) as Project, () => null);
    if (p?.id && p.name) out.push(p);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

async function adminView(): Promise<NonNullable<ServerWorkView["admin"]>> {
  const s = readServerWork() ?? { on: false };
  return {
    on: s.on,
    offByUpdate: !!s.offByUpdate,
    all: !s.projectIds,
    workspaces: (await allProjects()).map((p) => ({ id: p.id, name: p.name, owner: p.owner, on: !s.projectIds || s.projectIds.includes(p.id) })),
  };
}

serverWorkApp.get("/", async (c) => {
  const u = c.get("user");
  if (u.role === "visitor") return c.json({ error: "Not for guests" }, 403);
  const kind = serverKind();
  const mine = [...(await ownedProjects(u.username)), ...(await sharedProjects(u.username))].map((p) => p.id);
  const view: ServerWorkView = {
    kind,
    // This Mac has no server row: the server is this computer
    place: kind === "local" ? null : { allowed: [null, ...mine].some((w) => serverWorks(w, u.username)), weight: serverWeight(u.username) },
  };
  if (kind === "server" && u.role === "admin") view.admin = await adminView();
  return c.json(view);
});

serverWorkApp.put("/", async (c) => {
  const u = c.get("user");
  if (u.role !== "admin") return c.json({ error: "Only an admin changes this" }, 403);
  if (serverKind() !== "server") return c.json({ error: "This server has no such switch" }, 400);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const cur = readServerWork() ?? { on: false };
  // the admin's own choice: the update's notice has done its job
  const next = { ...cur, offByUpdate: false };
  if (typeof b?.on === "boolean") next.on = b.on;
  if (b?.all === true) delete next.projectIds;
  else if (Array.isArray(b?.only)) {
    const known = new Set((await allProjects()).map((p) => p.id));
    if (!b.only.every((id) => typeof id === "string" && known.has(id))) return c.json({ error: "Unknown workspace" }, 400);
    next.projectIds = b.only as string[];
  } else if (typeof b?.on !== "boolean") return c.json({ error: "Send { on }, { all: true } or { only: [workspace ids] }." }, 400);
  writeServerWork(next);
  return c.json(await adminView());
});

serverWorkApp.get("/workspace/:id", async (c) => {
  const u = c.get("user");
  const p = await ownedProject(c.req.param("id"), u);
  if (!p) return c.json({ error: "Not found" }, 404);
  // on This Mac there is nothing to choose: the server is this computer
  return c.json({ allowed: serverKind() !== "local" && serverAllows(p.id, u.username), server: p.serverWork !== false });
});

serverWorkApp.put("/workspace/:id", async (c) => {
  const u = c.get("user");
  const p = await ownedProject(c.req.param("id"), u);
  if (!p) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as { server?: unknown } | null;
  if (typeof b?.server !== "boolean") return c.json({ error: "Send { server: true or false }" }, 400);
  const { serverWork: _, ...rest } = p;
  await writeJsonAtomic(path.join(PROJECTS(), `${p.id}.json`), { ...rest, ...(b.server ? {} : { serverWork: false }), updatedAt: Date.now() });
  return c.json({ allowed: serverKind() !== "local" && serverAllows(p.id, u.username), server: b.server });
});
