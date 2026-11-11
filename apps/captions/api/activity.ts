import { Hono } from "hono";
import type { ActivityAction, ActivityRow, ActivityState, AgentRun } from "../contracts/activity";
import type { AuthVars } from "./auth";
import type { activeExports } from "./exports";
import type { analyzerWork } from "./instagram";
import type { notesWork } from "./clips";
import type { enhancing } from "./enhance";
import type { reviewWork } from "./review";
import type { guidesWork } from "./documents";
import type { captioningWork } from "./captions-job";
import type { LibraryWork } from "./library/activity";
import { waitingLine } from "../contracts/library";
import type { ServerPlugin } from "./lib/plugin";
import type { SessionUser } from "./users";

// What runs and what waits, for Home's Activity list and the Mac menu bar panel. GET /api/activity returns the app's own
// rows (the Media Library, AI Editor edits, exports, each tool's running work) and then the rows every loaded plug-in adds with its
// `activity(user)` function, so a plug-in shows its work with no Swift code. "working" rows are listed under Running,
// "ready" rows under Waiting on you; a row's href is an app path the window opens.

// The row types live in contracts/activity.ts (Home's list reads them too); plug-ins import them from here.
export type { ActivityAction, ActivityRow, ActivityState, AgentRun } from "../contracts/activity";

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
      const { id, title, detail, state, href, actions, progress, reason } = item;
      const kept = cleanActions(plugin, actions);
      out.push({
        id: `${plugin.id}:${id}`, title, detail, state, href,
        ...(kept ? { actions: kept } : {}),
        ...(typeof progress === "number" && progress >= 0 && progress <= 1 ? { progress } : {}),
        ...(typeof reason === "string" && reason.trim() ? { reason: reason.slice(0, 300) } : {}),
      });
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

/** The app's own background work for one account, as appRows reads it. */
export interface AppWork {
  libraries: LibraryWork[];
  /** the account's edits whose newest step is queued or running */
  edits: { id: string; name: string }[];
  exports: ReturnType<typeof activeExports>;
  /** each tool's own "what runs for this account" (left out = nothing runs there) */
  analyzer?: ReturnType<typeof analyzerWork>;
  notes?: Awaited<ReturnType<typeof notesWork>>;
  enhance?: ReturnType<typeof enhancing>;
  review?: Awaited<ReturnType<typeof reviewWork>>;
  guides?: ReturnType<typeof guidesWork>;
  captioning?: ReturnType<typeof captioningWork>;
}

const may = (user: SessionUser, tool: string) => user.role === "admin" || !user.off.includes(tool);

/** One tool's list, or none when its gate is off or reading it fails (said in the log): one tool never hides the others' rows. */
async function soft<T>(on: boolean, read: () => Promise<T[]>): Promise<T[]> {
  if (!on) return [];
  try {
    return await read();
  } catch (err) {
    console.warn(`[activity] ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Read when asked, so a test of the rows loads none of the tools. Each list is the account's own, whichever screen (or the assistant) started the work. */
async function appWork(user: SessionUser): Promise<AppWork> {
  const [{ libraryWork }, { allEdits, summaryOf }, { activeExports }] = await Promise.all([import("./library/activity"), import("./editor/store"), import("./exports")]);
  const edits = may(user, "editor")
    ? allEdits().filter((e) => !e.trashedAt && e.createdBy === user.username).map(summaryOf).filter((e) => e.last?.state === "queued" || e.last?.state === "running")
    : [];
  const u = user.username;
  const [analyzer, notes, enhance, review, guides, captioning] = await Promise.all([
    soft(may(user, "instagram"), async () => (await import("./instagram")).analyzerWork(u)),
    soft(may(user, "notes"), async () => (await import("./clips")).notesWork(u)),
    soft(may(user, "enhance"), async () => (await import("./enhance")).enhancing(u)),
    soft(may(user, "review"), async () => (await import("./review")).reviewWork(u)),
    soft(may(user, "guides"), async () => (await import("./documents")).guidesWork(u)),
    soft(may(user, "captions"), async () => (await import("./captions-job")).captioningWork(u)),
  ]);
  return { libraries: may(user, "media") ? await libraryWork(user) : [], edits, exports: activeExports(u), analyzer, notes, enhance, review, guides, captioning };
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const STEP: Record<string, [string, string]> = {
  files: ["file", "files"],
  transcript: ["transcript", "transcripts"],
  describe: ["AI description", "AI descriptions"],
  embed: ["search entry", "search entries"],
};

/**
 * The app's own rows. The Media Library: uploads, clips being prepared (a footage folder's clips still to come among
 * them), AI descriptions held back by the plan's limit (running, with the limit as the reason: nothing for the person to
 * do), and steps that wait for a key or an AI (waiting on you: a few words, opening the page that gives it). Then edits
 * with a step queued or running, the other tools' running work (Content Analyzer, Video Notes, Audio Enhancer, Review,
 * Guide Builder, the assistant's captions), then renders.
 */
export function appRows(w: AppWork): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const lib of w.libraries) {
    const add = (id: string, detail: string, more: Partial<ActivityRow> = {}) =>
      rows.push({ id: `library:${lib.id}:${id}`, title: "Media Library", detail, state: "working", href: "/library", ...more });
    const up = lib.uploading;
    if (up) add("upload", `Uploading ${count(up.files, "file")} · ${pct(up.received / Math.max(1, up.size))}`, { progress: up.received / Math.max(1, up.size) });
    const p = lib.progress;
    if (p.left > 0) add("prepare", `Preparing ${count(p.clips, "clip")} · ${pct(p.share)}`, { progress: p.share });
    for (const x of p.waiting) {
      const [one, many] = STEP[x.step] ?? ["file", "files"];
      const what = `${count(x.count, one, many)} ${x.count === 1 ? "waits" : "wait"}`;
      if (x.limit) add("limit", what, { reason: x.missing });
      else {
        const { text, href } = waitingLine(x);
        add(`key:${x.step}`, text, { state: "ready", href });
      }
    }
  }
  for (const e of w.edits) rows.push({ id: `editor:${e.id}`, title: e.name, detail: "AI Editor", state: "working", href: `/editor/${e.id}` });
  // the other tools: the thing worked on, the tool and what it does; how far, when the tool knows and it is not waiting
  const work = (id: string, title: string, tool: string, doing: string, href: string, x: { waits?: boolean; progress?: number } = {}) =>
    rows.push({ id, title, detail: `${tool} · ${x.waits ? "waits its turn" : doing}`, state: "working", href, ...(!x.waits && x.progress !== undefined ? { progress: x.progress } : {}) });
  const ANALYZER = { post: ["reading the post", "/instagram/"], account: ["pulling the account", "/instagram/accounts/"], ideas: ["finding ideas", "/instagram"] } as const;
  for (const a of w.analyzer ?? []) {
    const [doing, page] = ANALYZER[a.kind];
    work(`analyzer:${a.kind}:${a.id}`, a.name, "Content Analyzer", doing, a.kind === "ideas" ? page : `${page}${a.id}`, { waits: a.waits });
  }
  for (const n of w.notes ?? []) work(`notes:${n.id}${n.section ? ":section" : ""}`, n.name, "Video Notes", n.section ? "writing a section" : "making the note", `/clips/${n.id}`, n);
  for (const e of w.enhance ?? []) work(`enhance:${e.id}`, e.name, "Audio Enhancer", "enhancing", `/enhance/${e.id}`, e);
  for (const r of w.review ?? []) work(`review:${r.id}`, r.name, "Review", "preparing the video", `/review/${r.assetId}`, r);
  for (const g of w.guides ?? []) work(`guides:${g.id}`, g.name, "Guide Builder", "writing", "/documents");
  // the project list, not the project: it is opened once its captions are in (api/captions-job.ts)
  for (const c of w.captioning ?? []) work(`captions:${c.id}`, c.name, "Caption Studio", "captioning", "/captions?view=projects");
  for (const j of w.exports) {
    const running = j.status === "running";
    rows.push({
      id: `export:${j.id}`,
      title: j.filename,
      detail: running ? `Exporting · ${pct(j.progress)}` : "Export · waits its turn",
      state: "working",
      href: j.projectId ? `/captions?project=${encodeURIComponent(j.projectId)}` : "/captions",
      ...(running ? { progress: j.progress } : {}),
    });
  }
  return rows;
}

/** The app's rows for this account; none for visitors, and none (said in the log) when reading them fails. */
async function appActivity(user: SessionUser): Promise<ActivityRow[]> {
  if (user.role === "visitor") return [];
  try {
    return appRows(await appWork(user));
  } catch (err) {
    console.warn(`[activity] ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** GET /api/activity: the app's own rows and then the plug-in rows for the signed-in account (behind the account gate in boot.ts). GET /api/activity/menu: their menu items. GET /api/activity/tools: the Go menu's own tools. */
export function activityApp(plugins: ServerPlugin[]) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    const user = c.get("user");
    const [own, added] = await Promise.all([appActivity(user), pluginActivity(plugins, user)]);
    return c.json([...own, ...added]);
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
