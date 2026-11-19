/**
 * Item 7B: the routes behind Settings for where video work runs (work/server-work.ts), at /api/work/server-work.
 *
 *   GET  /                 → ServerWorkView: this server's kind, the name members see, the person's server row in Load
 *                            balancing, the current workspace's rendering, and for an admin of a server by address the
 *                            switch with its workspaces
 *   PUT  /                 { on?: boolean, all?: true, only?: [workspace ids] } (admin, a server by address)
 *
 * The server row's preference itself saves with the computers' (PUT /api/devices/balance, key "server").
 */
import { Hono } from "hono";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerWorkView } from "../../contracts/work";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { currentWorkspaceId } from "../lib/workspace-scope";
import { ownedProjects, sharedProjects } from "../lib/workshop/workspace";
import type { Project } from "../lib/workshop/types";
import { listUsers } from "../users";
import { pluginServerName } from "../lib/plugin";
import { readServerWork, serverKind, serverWeight, serverWorks, writeServerWork, type ServerKind } from "./server-work";

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

/**
 * The server's name (M18), the one for the member page's Server row and setup's Hosted media: the name a plug-in gives
 * it (Creator Toolset Cloud's own), else the first admin's name and "'s server" (a hosted own server too, the studio);
 * none on This Mac.
 */
export function serverNameOf(kind: ServerKind): string | undefined {
  if (kind === "local") return undefined;
  const named = pluginServerName();
  if (named) return named;
  const admin = listUsers().filter((x) => x.role === "admin").sort((a, b) => a.createdAt - b.createdAt)[0];
  return admin && `${admin.displayName || admin.username}'s server`;
}

serverWorkApp.get("/", async (c) => {
  const u = c.get("user");
  if (u.role === "visitor") return c.json({ error: "Not for guests" }, 403);
  const kind = serverKind();
  const mine = [...(await ownedProjects(u.username)), ...(await sharedProjects(u.username))].map((p) => p.id);
  const ws = await currentWorkspaceId(u);
  const view: ServerWorkView = {
    kind,
    // This Mac has no server row: the server is this computer
    place: kind === "local" ? null : { allowed: [null, ...mine].some((w) => serverWorks(w, u.username)), weight: serverWeight(u.username) },
    serverName: serverNameOf(kind),
    ...(ws ? { workspace: { id: ws, rendering: serverWorks(ws, u.username) } } : {}),
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
