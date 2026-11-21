import { Hono, type MiddlewareHandler } from "hono";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "../auth";
import type { SessionUser } from "../users";
import { writeJsonAtomic } from "../library/media/run";
import { env } from "./env";
import type { ServerPlugin } from "./plugin";
import { getWorkspace, ownedProjects, workspaceScope } from "./workshop/workspace";

/**
 * Which workspaces each installed plug-in works in (owner, 2026-11-15: "either to be used in all workspaces or some
 * workspaces"). One record for every plug-in: <data dir>/plugin-workspaces.json, the choice per plug-in per account, each
 * account choosing for its own workspaces (a workspace given to someone follows its owner's choice). A plug-in off in a
 * workspace has no tiles, pages, routes or tools there (the gate check, src/lib/auth.ts canUse) and does no work of its
 * own for files there.
 *
 * With no choice saved:
 * - a plug-in that changes parts of the app for the whole server (serverWide) is on in every workspace, and that can't
 *   change: turning it off in one workspace would hand that workspace to the built-in path, without the plug-in's checks;
 * - one that works by itself (a start hook or a device job: it acts on new files or edits) is off in every workspace when
 *   newly installed. One already installed when this came in stays on in the workspace its account works in today and is
 *   off in the others (written down the first time it is asked, so it stays put);
 * - any other is on in every workspace.
 */

export type WorkspaceChoice = { all: true } | { only: string[] };
interface Store {
  /** the plug-ins loaded when this file was first written: installed before a choice per workspace existed */
  before?: string[];
  /** plug-in id → account → choice */
  choices: Record<string, Record<string, WorkspaceChoice>>;
}

const ALL: WorkspaceChoice = { all: true };
const file = () => path.join(env.dataDir, "plugin-workspaces.json");

function read(): Store {
  try {
    const s = JSON.parse(readFileSync(file(), "utf8")) as Store;
    return { before: s.before, choices: s.choices ?? {} };
  } catch {
    return { choices: {} };
  }
}

let saving: Promise<void> = Promise.resolve();
function write(change: (s: Store) => void): Promise<void> {
  saving = saving.then(async () => {
    const s = read();
    change(s);
    await mkdir(path.dirname(file()), { recursive: true });
    await writeJsonAtomic(file(), s);
  });
  return saving;
}

/** Whether a plug-in changes parts of the app for everyone on the server (a replaced page or route, a library source, AI providers, hooks into Finals or the Workshop): then it is on in every workspace. */
export function serverWide(p: ServerPlugin): boolean {
  const tools = p.tools as { replaces?: string[] } | undefined;
  return !!(
    p.replaces || p.answers?.length || p.library || p.libraryRoutes || p.openRoutes || p.publicRoutes?.length || p.adminRoutes ||
    p.finals || p.workshop || p.providers || p.connectors || p.uploadRelays?.length || p.uploadsTo || p.playCopies || p.editor?.footageTarget || tools?.replaces?.length
  );
}
/** Why a server-wide plug-in is on in every workspace, by what it runs: "It runs this server's AI Editor and Finals" (no full stop). */
export function serverWideWhy(p: ServerPlugin): string {
  const answered: Record<string, string> = { "/api/instagram": "Content Analyzer", "/api/media": "Media Library", "/api/enhance": "Enhancer", "/api/review": "Review" };
  const tools = p.tools as { replaces?: string[] } | undefined;
  const parts = [
    ...(p.replaces || p.editor?.footageTarget ? ["Editor"] : []),
    ...(p.answers ?? []).map((a) => answered[a.path] ?? "pages"),
    ...(p.library || p.libraryRoutes ? ["Media Library"] : []),
    ...(p.finals ? ["Finals"] : []),
    ...(p.workshop ? ["Content Workshop"] : []),
    ...(p.providers ? ["AI providers"] : []),
    ...(p.connectors ? ["social accounts"] : []),
    ...(p.uploadRelays?.length || p.uploadsTo ? ["uploads"] : []),
    ...(p.playCopies ? ["Review and Finals playback"] : []),
    ...(tools?.replaces?.length ? ["assistant tools"] : []),
    ...(p.publicRoutes?.length || p.openRoutes || p.adminRoutes ? ["pages for the whole server"] : []),
  ];
  const list = [...new Set(parts)];
  const named = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : (list[0] ?? "parts of the app");
  return `It runs this server's ${named}, so it is on in every workspace`;
}

/** Whether a plug-in does work by itself, on files or edits nobody asked it about: then a new install starts off everywhere. */
export const worksByItself = (p: ServerPlugin): boolean => !!(p.start || p.deviceJobs?.length);

let plugins: ServerPlugin[] = [];

/**
 * At boot: remember the loaded plug-ins (the first time, as the ones installed before), and refuse a plug-in's
 * gatedRoutes in a workspace where it is off (its /api/x/<id> routes: mountPlugins with pluginGuard). Before its routes.
 */
export function guardPlugins(app: Hono<any, any, any>, loaded: ServerPlugin[]): void {
  plugins = loaded;
  // written at once, before any request can ask: a plug-in missing from it later is a new install
  if (!read().before) {
    mkdirSync(path.dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify({ ...read(), before: loaded.map((p) => p.id) }));
  }
  for (const p of loaded) {
    if (serverWide(p)) continue;
    for (const { path: base } of p.gatedRoutes ?? []) for (const at of [base, `${base}/*`]) app.use(at, offHereGuard(p));
  }
}

/** Tests: the loaded plug-ins and the first-boot list, without a server. */
export const setPluginsForTest = async (loaded: ServerPlugin[], before?: string[]) => {
  plugins = loaded;
  await saving;
  if (before) await write((s) => void (s.before = before));
};

/** An account's choice for one plug-in, with the defaults above (and the one-time move for a plug-in that was already on). */
export async function choiceOf(p: ServerPlugin, owner: string): Promise<WorkspaceChoice> {
  if (serverWide(p)) return ALL;
  const s = read();
  const saved = s.choices[p.id]?.[owner];
  if (saved) return saved;
  if (!worksByItself(p)) return ALL;
  if (!s.before?.includes(p.id)) return { only: [] };
  // installed before: on where the account works today. An account with no workspace yet keeps nothing apart: settled
  // when it has one. The account's own pick, not a chat's workspace this call may run in.
  const own = await ownedProjects(owner);
  if (!own.length) return ALL;
  const { currentProjectId } = await workspaceScope.exit(() => getWorkspace({ username: owner } as SessionUser));
  const today: WorkspaceChoice = { only: [own.some((w) => w.id === currentProjectId) ? currentProjectId! : own[0]!.id] };
  await write((st) => void ((st.choices[p.id] ??= {})[owner] ??= today));
  return read().choices[p.id]![owner]!;
}

/** A removed plug-in leaves no choice behind, and installed again it is a new install (its defaults above). */
export const forgetPluginWorkspaces = (id: string): Promise<void> =>
  write((s) => {
    delete s.choices[id];
    if (s.before) s.before = s.before.filter((x) => x !== id);
  });

/** Whether a plug-in works in `workspace` (one of `owner`'s); with no workspace, nothing is kept apart: on. */
export async function pluginOnIn(p: ServerPlugin, owner: string, workspace: string | null | undefined): Promise<boolean> {
  if (!workspace) return true;
  const c = await choiceOf(p, owner);
  return "all" in c || c.only.includes(workspace);
}

const nameOf = (p: ServerPlugin) => p.name ?? p.id;

/**
 * Whether a plug-in can be off in any workspace: not when it changes the whole server, nor when it never had a choice
 * saved and starts on everywhere. Read without waiting, so a request to it is not held up.
 */
const mayBeOff = (p: ServerPlugin): boolean => !serverWide(p) && (worksByItself(p) || Object.keys(read().choices[p.id] ?? {}).length > 0);

/** Why a plug-in can't be used in the workspace this request or chat works in, or null when it can. */
export async function offHere(user: SessionUser, p: ServerPlugin): Promise<string | null> {
  if (!mayBeOff(p)) return null;
  const { currentProjectId, projects } = await getWorkspace(user);
  const w = projects.find((x) => x.id === currentProjectId);
  if (!w || (await pluginOnIn(p, w.owner, w.id))) return null;
  return `${nameOf(p)} is off in the workspace ${w.name}. Turn it on for ${w.name} in ${nameOf(p)}'s settings (Community → Installed → ${nameOf(p)} → Settings), or use it in a workspace where it is on.`;
}

/** The guard for a plug-in's /api/x/<id> routes (mountPlugins); none for one on in every workspace. */
export const pluginGuard = (p: ServerPlugin): MiddlewareHandler | undefined => (serverWide(p) ? undefined : offHereGuard(p));

export const offHereGuard = (p: ServerPlugin): MiddlewareHandler => async (c, next) => {
  const user = c.get("user") as SessionUser | undefined;
  if (!user || !mayBeOff(p)) return next();
  const why = await offHere(user, p);
  if (why) return c.json({ error: why, code: "OFF_HERE" }, 403);
  await next();
};

/**
 * For the app's workspace switcher: per workspace, the plug-ins off there, by id and by their gate ids (what the page
 * hides its tiles, pages and buttons by), so a switch hides them at once.
 */
export async function pluginsOffIn(projects: { id: string; owner: string }[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const w of projects) {
    const off: string[] = [];
    for (const p of plugins) if (!(await pluginOnIn(p, w.owner, w.id))) off.push(p.id, ...(p.gates?.ids ?? []));
    if (off.length) out[w.id] = [...new Set(off)];
  }
  return out;
}

/** What the plug-in's settings page shows: the choice and the person's own workspaces, each on or off. */
export interface PluginWorkspacesView {
  id: string;
  name: string;
  /** set when it is on in every workspace and that can't change: why */
  fixed?: string;
  all: boolean;
  workspaces: { id: string; name: string; on: boolean }[];
}

async function viewOf(p: ServerPlugin, username: string): Promise<PluginWorkspacesView> {
  const c = await choiceOf(p, username);
  const own = await ownedProjects(username);
  return {
    id: p.id,
    name: nameOf(p),
    ...(serverWide(p) ? { fixed: serverWideWhy(p) } : {}),
    all: "all" in c,
    workspaces: own.map((w) => ({ id: w.id, name: w.name, on: "all" in c || c.only.includes(w.id) })),
  };
}

/** GET/PUT /api/plugins/:id/workspaces: { all: true } or { only: [workspace ids] }, the account's own workspaces only. */
export const pluginWorkspacesApp = new Hono<{ Variables: AuthVars }>();
pluginWorkspacesApp.get("/:id/workspaces", async (c) => {
  const p = plugins.find((x) => x.id === c.req.param("id"));
  return p ? c.json(await viewOf(p, c.get("user").username)) : c.json({ error: "No such plug-in" }, 404);
});
pluginWorkspacesApp.put("/:id/workspaces", async (c) => {
  const user = c.get("user");
  if (user.role === "visitor") return c.json({ error: "Sign in to change this" }, 403);
  const p = plugins.find((x) => x.id === c.req.param("id"));
  if (!p) return c.json({ error: "No such plug-in" }, 404);
  if (serverWide(p)) return c.json({ error: `${serverWideWhy(p)}.` }, 400);
  const b = (await c.req.json().catch(() => null)) as { all?: unknown; only?: unknown } | null;
  const own = new Set((await ownedProjects(user.username)).map((w) => w.id));
  let choice: WorkspaceChoice;
  if (b?.all === true) choice = ALL;
  else if (Array.isArray(b?.only) && b.only.every((id) => typeof id === "string" && own.has(id))) choice = { only: [...new Set(b.only as string[])] };
  else return c.json({ error: "Send { all: true } or { only: [ids of your workspaces] }." }, 400);
  await write((s) => void ((s.choices[p.id] ??= {})[user.username] = choice));
  return c.json(await viewOf(p, user.username));
});
