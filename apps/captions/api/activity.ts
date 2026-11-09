import { Hono } from "hono";
import type { AuthVars } from "./auth";
import type { ServerPlugin } from "./lib/plugin";
import type { SessionUser } from "./users";

// Rows for the Mac menu bar panel from plug-ins. GET /api/activity returns the rows every loaded plug-in adds with
// its `activity(user)` function, so a plug-in shows its work in the pill with no Swift code. The panel puts "working"
// rows under Active and "ready" rows under For you; a row's href is an app path the window opens.

export type ActivityState = "working" | "ready";

// What a row's button does on the Mac the app runs on: start, stop or restart (kickstart) a LaunchAgent. Only a label the
// plug-in declares in `launchAgents` passes (pluginActivity drops the rest). The Mac runs it (apps/mac LaunchAgent.swift).
export type AgentRun = "start" | "stop" | "restart";
export interface ActivityAction {
  id: string;
  title: string;
  run: AgentRun;
  label: string;
}

export interface ActivityRow {
  id: string;
  title: string;
  detail: string;
  state: ActivityState;
  // An app path such as "/editor". Never a full URL, never a protocol-relative "//" one.
  href: string;
  // Buttons on the row (the Mac's pill). Optional; a row with none has no buttons.
  actions?: ActivityAction[];
}

export type ActivityFn = (user: SessionUser) => ActivityRow[] | Promise<ActivityRow[]>;

// A Mac menu item a plug-in adds to the Go and gear menus (GET /api/activity/menu). `href` is an app path, as for rows.
export interface MenuItem {
  id: string;
  title: string;
  href: string;
}

export type MenuFn = (user: SessionUser) => MenuItem[] | Promise<MenuItem[]>;

// The Mac Go menu's tools (GET /api/activity/tools): the app's own pages by name, in menu order. A tool whose gate the
// account has switched off is left out (admins see all); visitors get none. The window gives the first five a ⌘ key by path.
export interface AppTool {
  id: string;
  title: string;
  href: string;
}

const APP_TOOLS: { id: string; title: string; href: string; gate?: string }[] = [
  { id: "home", title: "Home", href: "/" },
  { id: "workshop", title: "Workshop", href: "/workshop", gate: "workshop" },
  { id: "editor", title: "AI Editor", href: "/editor", gate: "editor" },
  { id: "finals", title: "Finals", href: "/finals", gate: "media" },
  { id: "analyzer", title: "Analyzer", href: "/analyzer", gate: "instagram" },
];

/** The Go menu's tools this account may use, in menu order. */
export function appTools(user: SessionUser): AppTool[] {
  if (user.role === "visitor") return [];
  return APP_TOOLS
    .filter((t) => !t.gate || user.role === "admin" || !user.off.includes(t.gate))
    .map(({ id, title, href }) => ({ id, title, href }));
}

const STATES: ActivityState[] = ["working", "ready"];

/** An app path the window can open: starts with one "/" and is not "//" or "/\" (a browser reads those as another host). */
const isAppPath = (href: string) => href.startsWith("/") && !/^\/[\\/]/.test(href);

/** A plug-in whose gate this account has switched off adds nothing, as its own routes refuse it (requireGate). Admins are never refused. */
const gatedOff = (plugin: ServerPlugin, user: SessionUser) =>
  user.role !== "admin" && (plugin.gates?.ids ?? []).some((id) => user.off.includes(id));

/** One plug-in's list for this account: [] when it has none, is gated off for the account, throws or runs past timeoutMs. */
async function fromPlugins<T>(plugins: ServerPlugin[], user: SessionUser, timeoutMs: number,
  pick: (plugin: ServerPlugin) => ((user: SessionUser) => T[] | Promise<T[]>) | undefined): Promise<T[][]> {
  return Promise.all(plugins.map(async (plugin) => {
    const fn = pick(plugin);
    if (!fn || gatedOff(plugin, user)) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); });
      return await Promise.race([Promise.resolve(fn(user)), timeout]);
    } catch (err) {
      console.warn(`[plug-in] ${plugin.id}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }));
}

const RUNS: AgentRun[] = ["start", "stop", "restart"];

/** A row's buttons the plug-in may show: well-formed, and for a LaunchAgent label the plug-in declared. None left = undefined. */
function cleanActions(plugin: ServerPlugin, actions: unknown): ActivityAction[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const agents = plugin.launchAgents ?? [];
  const kept = actions.filter((a): a is ActivityAction =>
    !!a && typeof a.id === "string" && typeof a.title === "string" && RUNS.includes(a.run) && agents.includes(a.label));
  return kept.length ? kept : undefined;
}

/**
 * Every plug-in's rows for this account. Visitors get none. A plug-in that throws or runs past `timeoutMs` adds
 * nothing, and its rows that are malformed are dropped, so the pill still answers. Ids gain the plug-in's id as a prefix.
 * A row's buttons that name a LaunchAgent the plug-in did not declare are dropped (the row stays).
 */
export async function pluginActivity(plugins: ServerPlugin[], user: SessionUser, timeoutMs = 3000): Promise<ActivityRow[]> {
  if (user.role === "visitor") return [];
  const out: ActivityRow[] = [];
  const results = await fromPlugins(plugins, user, timeoutMs, (p) => p.activity?.bind(p));
  plugins.forEach((plugin, i) => {
    for (const item of results[i] ?? []) {
      if (!item || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.detail !== "string") continue;
      if (!STATES.includes(item.state) || typeof item.href !== "string" || !isAppPath(item.href)) continue;
      const { actions, ...row } = item;
      const kept = cleanActions(plugin, actions);
      out.push({ ...row, id: `${plugin.id}:${row.id}`, ...(kept ? { actions: kept } : {}) });
    }
  });
  return out;
}

/**
 * Every plug-in's Mac menu items for this account (the Go and gear menus). Same gating and timeout as the rows; an item
 * needs a title and an app path. Ids gain the plug-in's id as a prefix.
 */
export async function pluginMenu(plugins: ServerPlugin[], user: SessionUser, timeoutMs = 3000): Promise<MenuItem[]> {
  if (user.role === "visitor") return [];
  const out: MenuItem[] = [];
  const results = await fromPlugins(plugins, user, timeoutMs, (p) => p.menu?.bind(p));
  plugins.forEach((plugin, i) => {
    for (const item of results[i] ?? []) {
      if (!item || typeof item.id !== "string" || typeof item.title !== "string" || !item.title.trim()) continue;
      if (typeof item.href !== "string" || !isAppPath(item.href)) continue;
      out.push({ id: `${plugin.id}:${item.id}`, title: item.title, href: item.href });
    }
  });
  return out;
}

/** GET /api/activity: the plug-in rows for the signed-in account (behind the account gate in boot.ts). GET /api/activity/menu: their menu items. GET /api/activity/tools: the Go menu's own tools. */
export function activityApp(plugins: ServerPlugin[]) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await pluginActivity(plugins, c.get("user")));
  });
  app.get("/menu", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await pluginMenu(plugins, c.get("user")));
  });
  app.get("/tools", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(appTools(c.get("user")));
  });
  return app;
}
