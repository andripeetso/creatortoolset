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

/** Why a plug-in's page half is not in the app, by plug-in id. Community → Installed shows it on the plug-in's row. */
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
  };
}

/**
 * Why a plug-in's page half can't join the ones already in, or null: every mistake that would otherwise throw while a
 * screen is drawn (two plug-ins replacing one page, a Settings section with a built-in section's id, a tile that names
 * no Home stage), found here, on this one plug-in.
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
  try {
    const r = await fetch("/api/plugins/web");
    return r.ok ? ((await r.json()) as { plugins: Listed[] }).plugins : null;
  } catch {
    return null;
  }
}

/**
 * Adds each plug-in's page half to the app's list (webPlugins). main.tsx waits for it before the first render, so
 * every screen sees them. Signed out, the server gives no list and nothing is loaded.
 */
export async function loadFolderPlugins(): Promise<void> {
  const plugins = await list();
  if (!plugins) return;
  listed = true;
  const table = new Map<string, unknown>();
  (globalThis as { __ctHost?: unknown }).__ctHost = { get: (id: string) => table.get(id) };
  for (const p of plugins) {
    let css: HTMLLinkElement | null = null;
    try {
      for (const need of p.needs) {
        const load = hostModules[need];
        if (!load) throw new Error(`It needs ${need.replace(/^pkg:/, "the package ")}, which this version of the app doesn't have`);
        if (!table.has(need)) table.set(need, await load());
      }
      if (p.css) {
        css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `/api/plugins/web/${p.id}/web.css` });
        document.head.append(css);
      }
      const mod = (await import(/* @vite-ignore */ `${window.location.origin}/api/plugins/web/${p.id}/web.js`)) as { default: WebPlugin };
      const problem = webAdmissionProblem(webPlugins, mod.default, p.id);
      if (problem) throw new Error(problem);
      webPlugins.push(guardWebPlugin(mod.default));
    } catch (e) {
      css?.remove();
      folderPluginFailures.set(p.id, message(e));
      console.error(`[plugins] ${p.id}: its pages were left out`, e);
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

/** What a row says under its name, and whether it is trouble: why it isn't running, or that the folder has changed. */
export function folderRowNote(row: FolderPluginRow, pageProblem: string | undefined, paused: boolean): { tone: "broken" | "attention"; text: string } | null {
  if (row.error) return { tone: "broken", text: row.error };
  if (row.on && !paused && pageProblem) return { tone: "broken", text: `Its pages were left out: ${pageProblem}` };
  if (row.changed) return { tone: "attention", text: "Changed since you switched it on" };
  return null;
}
