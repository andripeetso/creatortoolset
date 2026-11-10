import { useEffect } from "react";
import { create } from "zustand";
import type { WorkshopProject } from "./workshop";
import { useAuth } from "./auth";
import { putCached, readCached, warmCached } from "./local-cache";

/**
 * The logged-in account's current brand project. Analyzer and Workshop
 * read this so instructions, context files, and new research stay attached
 * to one project. Caption Studio clip-pools are a different store.
 */

export interface Workspace {
  currentProjectId: string | null;
  projects: WorkshopProject[];
}

interface WorkspaceState extends Workspace {
  loaded: boolean;
  load: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  reset: () => void;
}

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

/** The projects' saved copy (lib/local-cache.ts): the switcher, the tint and Projects paint from it, live on "workshop". */
export const WORKSPACE_KEY = "workshop/workspace";
/** Every project's Instagram accounts, for Projects (ProjectList.tsx; warm-cache.ts fills it at sign-in). */
export const PROJECT_ACCOUNTS_KEY = "instagram/accounts?all";
export const fetchWorkspace = async () => json<Workspace>(await fetch("/api/workshop/workspace"));
const me = () => useAuth.getState().me?.username ?? null;

/**
 * A copy of the projects into the store. A notice's refetch (`keepMine`) keeps the project this window is in while that
 * still exists: a switch in another window changes the list here, not the project. This window's own read follows the
 * server (a project made here becomes the current one).
 */
export function applyWorkspace(ws: Workspace | null, keepMine = true): void {
  if (!ws) return;
  const s = useWorkspace.getState();
  const keep = keepMine && s.loaded && ws.projects.some((p) => p.id === s.currentProjectId);
  useWorkspace.setState({ projects: ws.projects, currentProjectId: keep ? s.currentProjectId : ws.currentProjectId, loaded: true });
}

/** Before the first render (main.tsx): the last projects this account saw. */
export const seedWorkspace = () => applyWorkspace(readCached<Workspace>(me(), WORKSPACE_KEY));

/** Counts the switches: an answer that was asked for before the newest one is out of date and is dropped. */
let switches = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  currentProjectId: null,
  projects: [],
  loaded: false,
  load: async () => {
    const asked = switches;
    // on failure (signed out, a server restart) the known copy stays: "loaded, no projects" would read as a new account
    await warmCached(WORKSPACE_KEY, fetchWorkspace).catch(() => {});
    // a switch made while it ran is newer than its answer
    applyWorkspace(readCached<Workspace>(me(), WORKSPACE_KEY), asked !== switches);
  },
  select: async (id) => {
    // the switch shows at once and the server is told after: on a busy server the click used to look dead for seconds
    const before = get().currentProjectId;
    const asked = ++switches;
    set({ currentProjectId: id });
    try {
      const ws = await json<Workspace>(
        await fetch("/api/workshop/workspace", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentProjectId: id }),
        }),
      );
      if (asked !== switches) return;
      putCached(me(), WORKSPACE_KEY, ws);
      set({ ...ws, loaded: true });
    } catch (e) {
      if (asked === switches) set({ currentProjectId: before });
      throw e;
    }
  },
  reset: () => set({ currentProjectId: null, projects: [], loaded: false }),
}));

export const currentProject = (s: WorkspaceState): WorkshopProject | null =>
  s.projects.find((p) => p.id === s.currentProjectId) ?? null;

/** undefined → current workspace project. null → do not scope. */
export function scopedProjectId(explicit?: string | null): string | undefined {
  if (explicit === null) return undefined;
  if (explicit) return explicit;
  return useWorkspace.getState().currentProjectId ?? undefined;
}

export function appendProjectId(params: URLSearchParams, explicit?: string | null): void {
  const id = scopedProjectId(explicit);
  if (id) params.set("projectId", id);
}

export function projectBody(explicit?: string | null): { projectId?: string } {
  const id = scopedProjectId(explicit);
  return id ? { projectId: id } : {};
}

/**
 * Each project's colour:
 * the dot on the switcher, the Projects list and the form; `rgb` (Tailwind 600) / `text` (400) tint the home page. Same keys as the server's PROJECT_COLORS.
 */
export const PROJECT_COLORS = {
  violet: { dot: "bg-violet-500", ring: "border-violet-500/60", rgb: "124 58 237", text: "167 139 250" },
  sky: { dot: "bg-sky-500", ring: "border-sky-500/60", rgb: "2 132 199", text: "56 189 248" },
  emerald: { dot: "bg-emerald-500", ring: "border-emerald-500/60", rgb: "5 150 105", text: "52 211 153" },
  amber: { dot: "bg-amber-500", ring: "border-amber-500/60", rgb: "217 119 6", text: "251 191 36" },
  rose: { dot: "bg-rose-500", ring: "border-rose-500/60", rgb: "225 29 72", text: "251 113 133" },
  orange: { dot: "bg-orange-500", ring: "border-orange-500/60", rgb: "234 88 12", text: "251 146 60" },
  teal: { dot: "bg-teal-500", ring: "border-teal-500/60", rgb: "13 148 136", text: "45 212 191" },
  pink: { dot: "bg-pink-500", ring: "border-pink-500/60", rgb: "219 39 119", text: "244 114 182" },
} as const;
export type ProjectColor = keyof typeof PROJECT_COLORS;

/**
 * A project's colour: the one picked; a project from before colours takes the first one no other project of yours
 * has (oldest first), so two never look the same.
 */
export function projectColor(p: { id: string; color?: string } | null | undefined, all?: Array<{ id: string; color?: string; createdAt: number }>): ProjectColor {
  const keys = Object.keys(PROJECT_COLORS) as ProjectColor[];
  const valid = (c?: string): c is ProjectColor => !!c && c in PROJECT_COLORS;
  if (!p) return keys[0];
  if (valid(p.color)) return p.color;
  const list = all ?? useWorkspace.getState().projects;
  const used = new Set(list.map((x) => x.color).filter(valid));
  for (const x of [...list].sort((a, b) => a.createdAt - b.createdAt)) {
    if (valid(x.color)) continue;
    const free = keys.find((k) => !used.has(k)) ?? keys[0];
    used.add(free);
    if (x.id === p.id) return free;
  }
  return keys.find((k) => !used.has(k)) ?? keys[0];
}

/** A colour of the person's own making (Settings → Appearance → Colour → Custom): "#rrggbb". */
export const isHexColour = (c: string): c is `#${string}` => /^#[0-9a-f]{6}$/i.test(c);
/** What the app can wear: one of the project colours, or a colour of the person's own. */
export type Accent = ProjectColor | `#${string}`;

/**
 * The colour the app wears (Settings → Appearance → Colour): the current project's while the person follows the
 * project, else the one they picked for themselves (a project colour, or their own "#rrggbb"). No project, or a colour
 * that is neither, is violet.
 */
export function accentFor(followProject: boolean, own: string, project: ProjectColor | null): Accent {
  if (followProject) return project ?? "violet";
  if (isHexColour(own)) return own.toLowerCase() as Accent;
  return Object.keys(PROJECT_COLORS).includes(own) ? (own as ProjectColor) : "violet";
}

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
// how far each shade is from the picked colour (its 500): towards white below it, towards black above it
const TOWARDS: Record<(typeof SHADES)[number], number> = { 50: -0.95, 100: -0.9, 200: -0.75, 300: -0.55, 400: -0.3, 500: 0, 600: 0.14, 700: 0.3, 800: 0.44, 900: 0.56, 950: 0.72 };
// the light theme swaps the pale and the deep shades for text and for filled chips (tailwind.config.js `mirror`)
const MIRROR: Record<number, (typeof SHADES)[number]> = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600, 800: 200, 900: 100, 950: 50 };

/** The eleven shades of a picked colour, each as "r g b": the picked one is 500, lighter ones mix in white, darker ones black. */
export function shadesOf(hex: string): Record<(typeof SHADES)[number], string> {
  const base = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const shade = (t: number) => base.map((v) => Math.round(t < 0 ? v + (255 - v) * -t : v * (1 - t))).join(" ");
  return Object.fromEntries(SHADES.map((n) => [n, shade(TOWARDS[n])])) as Record<(typeof SHADES)[number], string>;
}

/**
 * The CSS that makes a picked colour the app's accent in both themes: the same variables tailwind.config.js writes for
 * each project colour, under data-tint="custom". Kept as text so index.html can paint it before the app loads.
 */
export function customTintCss(hex: string): string {
  const s = shadesOf(hex);
  const vars = (dark: boolean) =>
    [
      ...SHADES.map((n) => `--violet-${n}:${s[n]}`),
      ...([50, 100, 200, 300, 400] as const).map((n) => `--t-violet-${n}:${s[dark ? n : MIRROR[n]]}`),
      ...([800, 900, 950] as const).map((n) => `--s-violet-${n}:${s[dark ? n : MIRROR[n]]}`),
    ].join(";");
  return `:root[data-tint="custom"]{${vars(false)}}.dark[data-tint="custom"]{${vars(true)}}`;
}

/** The two tones Home's tiles take from the accent, each as "r g b": the filled one (600) and the pale one (400). */
export function accentTones(a: Accent): { rgb: string; text: string } {
  if (!isHexColour(a)) return PROJECT_COLORS[a];
  const s = shadesOf(a);
  return { rgb: s[600], text: s[400] };
}

/** Puts that colour on <html data-tint>, which every violet class follows (tailwind.config.js):
 *  the tools, buttons and the update pill take it, not only the home page. */
export function useRootTint(on: boolean, own = "violet"): void {
  const project = useWorkspace(currentProject);
  const loaded = useWorkspace((s) => s.loaded);
  // until the projects arrive, keep what index.html painted from the last visit (no violet flash)
  const color = !on || loaded ? accentFor(on, own, project ? projectColor(project) : null) : null;
  useEffect(() => {
    if (!color) return;
    const el = document.documentElement;
    const css = isHexColour(color) ? customTintCss(color) : null;
    // a colour of the person's own has no rules in the stylesheet: its variables go in a style element of its own
    let own = document.getElementById("ct-custom-tint");
    if (css) {
      if (!own) {
        own = document.createElement("style");
        own.id = "ct-custom-tint";
        document.head.appendChild(own);
      }
      own.textContent = css;
      el.dataset.tint = "custom";
    } else {
      own?.remove();
      if (color === "violet") delete el.dataset.tint;
      else el.dataset.tint = color;
    }
    try {
      // index.html paints these before the app loads, so a reload never flashes violet first
      localStorage.setItem("ct-tint", css ? "custom" : color);
      if (css) localStorage.setItem("ct-tint-css", css);
      else localStorage.removeItem("ct-tint-css");
    } catch {
      /* private mode: the colour holds for this visit */
    }
  }, [color]);
}
