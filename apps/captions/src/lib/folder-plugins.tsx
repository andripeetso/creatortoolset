import { Component, type ComponentType, type ReactNode } from "react";
import { hostModules } from "../plugin-host.gen";
import { webPlugins } from "../plugins.gen";
import { sectionsFor } from "@/components/settings/nav";
import { replacementFor, type ReplaceSlot, type WebPlugin } from "./plugin";
import { withPluginTiles } from "./tools";

// The page halves of the plug-ins the person switched on in the Mac app (api/lib/folder-plugins.ts). Each was built by
// itself (scripts/plugin-build.mjs): its file reads the app's own modules from this page (the host list,
// src/plugin-host.gen.ts), so it draws with the app's one React and one router. They join the app's list before the
// first screen is drawn. One that fails to load, or whose pieces collide with another plug-in's, is left out and named.

/**
 * Why a plug-in's page half is not in the app, by plug-in id. Community → Installed shows it on the plug-in's row after
 * "Its pages were left out: ", so each reason starts with a small letter.
 */
export const folderPluginFailures = new Map<string, string>();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One piece of a plug-in on screen. When it throws while drawing, that piece says so and the rest of the app works. */
class PluginBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[plugins] ${this.props.name} failed while drawing`, error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <p className="p-6 text-sm text-muted-foreground">The {this.props.name} plug-in stopped working here.</p>;
  }
}

/** The plug-in with a boundary around every piece it draws: its pages, Settings and Devices sections, replaced pages and Review panels. */
export function guardWebPlugin(p: WebPlugin): WebPlugin {
  const name = p.name ?? p.id;
  const node = (n: ReactNode): ReactNode => <PluginBoundary name={name}>{n}</PluginBoundary>;
  function part<P extends object>(C: ComponentType<P>): ComponentType<P> {
    return function Guarded(props: P) {
      return node(<C {...props} />);
    };
  }
  return {
    ...p,
    routes: p.routes?.map((r) => ({ ...r, element: node(r.element) })),
    settings: p.settings?.map((s) => ({ ...s, body: node(s.body) })),
    devices: p.devices?.map((d) => ({ ...d, body: node(d.body) })),
    replaces: p.replaces && (Object.fromEntries(Object.entries(p.replaces).map(([k, C]) => [k, C && part(C)])) as WebPlugin["replaces"]),
    review: p.review && { ...p.review, panels: p.review.panels?.map((s) => ({ ...s, panel: part(s.panel) })) },
    // badges are worked out for every card the Media Library draws: one that throws adds none
    library: p.library && { ...p.library, badges: p.library.badges && safeBadges(name, p.library.badges) },
  };
}

type Badges = NonNullable<NonNullable<WebPlugin["library"]>["badges"]>;
function safeBadges(name: string, badges: Badges): Badges {
  let said = false;
  return (card) => {
    try {
      return badges(card);
    } catch (e) {
      if (!said) console.error(`[plugins] ${name} failed on a Media Library badge`, e);
      said = true;
      return [];
    }
  };
}

// What the app's own screens draw or call from a plug-in without the plug-in's boundary around it: a Home tile's icon,
// a Settings row's title, an account menu item. One that is missing (an icon name the app's icon set doesn't have
// arrives as undefined) would break the app's own screen, so the plug-in is refused with the piece named.
const drawable = (x: unknown) => typeof x === "function" || (typeof x === "object" && x !== null && "$$typeof" in x);
const text = (x: unknown) => typeof x === "string" && x.length > 0;
function shapeProblem(p: WebPlugin): string | null {
  const bad = (what: string) => `${what} (is the name right? the app may not have it)`;
  for (const t of p.tiles ?? []) {
    if (!text(t?.name) || !text(t.to) || typeof t.desc !== "string") return "a Home tile needs name, to and desc";
    if (!drawable(t.icon)) return bad(`the Home tile "${t.name}" has no icon`);
  }
  for (const s of p.settings ?? []) {
    if (!text(s?.id) || !text(s.title)) return "a Settings section needs id and title";
    if (!drawable(s.icon)) return bad(`the Settings section "${s.title}" has no icon`);
  }
  for (const d of p.devices ?? []) if (!text(d?.id) || !text(d.title)) return "a Devices or Storage section needs id and title";
  for (const a of p.accountMenu ?? []) {
    if (!text(a?.label) || !text(a.to)) return "an account menu item needs label and to";
    if (!drawable(a.icon)) return bad(`the account menu item "${a.label}" has no icon`);
  }
  for (const [kind, actions] of Object.entries(p.itemActions ?? {})) {
    if (!Array.isArray(actions)) return `itemActions.${kind} must be a list`;
    for (const a of actions) {
      if (!text(a?.label) || typeof a.onRun !== "function") return `a button on ${kind} items needs label and onRun`;
      if (a.icon !== undefined && !drawable(a.icon)) return bad(`the button "${a.label}" has an icon that is missing`);
    }
  }
  for (const [slot, C] of Object.entries(p.replaces ?? {})) if (C !== undefined && !drawable(C)) return bad(`replaces.${slot} is not a component`);
  for (const s of p.review?.panels ?? []) if (!text(s?.id) || !drawable(s.panel)) return "a Review panel needs id and panel";
  for (const a of p.review?.actions ?? []) {
    if (!text(a?.label) || typeof a.onRun !== "function") return "a Review button needs label and onRun";
    if (a.icon !== undefined && !drawable(a.icon)) return bad(`the Review button "${a.label}" has an icon that is missing`);
  }
  for (const f of p.library?.facets ?? []) if (!text(f?.key) || !text(f.label) || !Array.isArray(f.values)) return "a Media Library filter needs key, label and values";
  if (p.library?.badges !== undefined && typeof p.library.badges !== "function") return "library.badges must be a function";
  return null;
}

/**
 * Why a plug-in's page half can't join the ones already in, or null: every mistake that would otherwise throw while a
 * screen is drawn (two plug-ins replacing one page, a Settings section with a built-in section's id, a tile that names
 * no Home stage, a tile whose icon is missing), found here, on this one plug-in.
 */
export function webAdmissionProblem(admitted: WebPlugin[], candidate: WebPlugin, id: string): string | null {
  try {
    if (!candidate || typeof candidate !== "object") throw new Error("web.tsx must export defineWebPlugin({ … }) as the default");
    if (candidate.id !== id) throw new Error(`web.tsx says its id is ${String(candidate.id)}`);
    if (admitted.some((p) => p.id === id)) throw new Error(`the app already has a plug-in called ${id}`);
    // a product site in place of the app is for a server's own build, never for a folder
    if (candidate.site) throw new Error("a plug-in from the folder can't replace the app's front page (site)");
    const paths = new Set(admitted.flatMap((p) => p.routes ?? []).map((r) => r.path));
    for (const r of candidate.routes ?? []) {
      if (typeof r?.path !== "string" || !r.path.startsWith("/")) throw new Error(`the page path "${String(r?.path)}" must start with /`);
      if (paths.has(r.path)) throw new Error(`another plug-in already has the page ${r.path}`);
    }
    const shape = shapeProblem(candidate);
    if (shape) throw new Error(shape);
    for (const slot of Object.keys(candidate.replaces ?? {}) as ReplaceSlot[]) replacementFor([...admitted, candidate], slot);
    withPluginTiles([candidate]);
    sectionsFor({ hosted: true, admin: true, mac: true }, [candidate]);
    return null;
  } catch (e) {
    return message(e);
  }
}

type Listed = { id: string; name: string; css: boolean; needs: string[] };
// true once the server answered with the list (signed in): a later sign-in then has nothing to catch up on
let listed = false;

async function list(): Promise<Listed[] | null> {
  // only the Mac app's build has a host list (scripts/plugins.mjs, CT_PLUGIN_HOST=1), so only it can load a plug-in
  // from a folder. Every other build never asks: its first screen must not wait for an answer that can only be "none"
  if (!Object.keys(hostModules).length) return null;
  try {
    const r = await fetch("/api/plugins/web");
    return r.ok ? ((await r.json()) as { plugins: Listed[] }).plugins : null;
  } catch {
    return null;
  }
}

/**
 * How long all the page halves together may hold up the first screen. A page file whose own top-level code never
 * finishes (an await that never settles) would otherwise leave the window blank for good, with a healthy server
 * behind it and nothing to say why. (An object, so a test can shorten it.)
 */
// ponytail: every load of the window waits again for a plug-in that is too slow, until it is switched off or fixed;
// remember it per version if that bites
export const pageLimits = { loadMs: 10_000 };

/** The file a plug-in's page half is imported from (its own function, so a test can stand in for the server). */
export const pageFile = { load: (id: string): Promise<{ default: WebPlugin }> => import(/* @vite-ignore */ `${window.location.origin}/api/plugins/web/${id}/web.js`) };

/**
 * Adds each plug-in's page half to the app's list (webPlugins). main.tsx waits for it before the first render, so
 * every screen sees them. Signed out, the server gives no list and nothing is loaded. One that does not load in
 * time is left out and named, and the app draws without it.
 */
export async function loadFolderPlugins(): Promise<void> {
  const plugins = await list();
  if (!plugins) return;
  listed = true;
  const table = new Map<string, unknown>();
  (globalThis as { __ctHost?: unknown }).__ctHost = { get: (id: string) => table.get(id) };
  const deadline = Date.now() + pageLimits.loadMs;
  for (const p of plugins) {
    let css: HTMLLinkElement | null = null;
    // set when the time is up: a file that finishes loading after that does not join the app behind its back
    let late = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          for (const need of p.needs) {
            const load = hostModules[need];
            if (!load) throw new Error(`it needs ${need.replace(/^pkg:/, "the package ")}, which this version of the app doesn't have`);
            if (!table.has(need)) table.set(need, await load());
          }
          if (late) return;
          if (p.css) {
            css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `/api/plugins/web/${p.id}/web.css` });
            document.head.append(css);
          }
          const mod = await pageFile.load(p.id);
          if (late) return;
          const problem = webAdmissionProblem(webPlugins, mod.default, p.id);
          if (problem) throw new Error(problem);
          webPlugins.push(guardWebPlugin(mod.default));
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            late = true;
            reject(new Error("they took too long to load"));
          }, Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch (e) {
      (css as HTMLLinkElement | null)?.remove();
      folderPluginFailures.set(p.id, message(e));
      console.error(`[plugins] ${p.id}: its pages were left out`, e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * After a sign-in on a page that loaded signed out (a phone on this Mac's server): the plug-ins' pages are loaded
 * before the first render only, so the page reloads once when there are any. The Mac app's own window is signed in
 * before its page loads and never gets here.
 */
export async function reloadForFolderPlugins(): Promise<void> {
  if (listed) return;
  if ((await list())?.length) window.location.reload();
}

// ---- the rows of Community → Installed → Plug-ins (components/community/PluginsInstalled.tsx) ----

/** One folder in the person's plug-ins folder, or a plug-in that is on (GET /api/plugins/folder, api/lib/folder-plugins.ts). */
export interface FolderPluginRow {
  folder: string;
  id: string | null;
  name: string;
  about: string;
  on: boolean;
  running: boolean;
  changed: boolean;
  error?: string;
}
export interface FolderPlugins {
  enabled: boolean;
  /** The Mac app switched them all off after its server stopped five times with them on. */
  paused: boolean;
  rows: FolderPluginRow[];
}

/**
 * What the Mac app says about one changed folder while Update automatically is on (lib/thisMac.ts pluginsAuto):
 * `waiting` = its new version is ready and the server is in the middle of something, `note` = the Mac app's sentence
 * for a change that does not come in by itself (it does not build, it would run on the Mac for the first time, it
 * changes too often).
 * undefined = the switch is off (or this is no Mac app): a changed folder waits for Use the new version.
 */
export type FolderRowAuto = { waiting: boolean; note?: string };

/** Whether a changed folder's row offers Use the new version: always with the switch off, and with it on only while the change is not coming in by itself. */
export const offersNewVersion = (row: FolderPluginRow, auto: FolderRowAuto | undefined): boolean => row.changed && !!row.folder && (!auto || auto.waiting || !!auto.note);

/**
 * What a row says under its name, and whether it is trouble: why it isn't running, or that the folder has changed.
 * No tone = nothing for the person to do. A change that is coming in by itself says nothing.
 */
export function folderRowNote(row: FolderPluginRow, pageProblem: string | undefined, paused: boolean, auto?: FolderRowAuto): { tone?: "broken" | "attention"; text: string } | null {
  if (row.error) return { tone: "broken", text: row.error };
  if (row.on && !paused && pageProblem) return { tone: "broken", text: `Its pages were left out: ${pageProblem}` };
  if (!row.changed) return null;
  if (!auto) return { tone: "attention", text: "Changed since you switched it on" };
  if (auto.note) return { tone: "attention", text: auto.note };
  if (auto.waiting) return { text: "The new version starts when the running work is done" };
  return null;
}
