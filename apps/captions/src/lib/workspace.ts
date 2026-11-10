import { useEffect } from "react";
import { create } from "zustand";
import type { WorkshopProject } from "./workshop";

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

/** Counts the switches: an answer that was asked for before the newest one is out of date and is dropped. */
let switches = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  currentProjectId: null,
  projects: [],
  loaded: false,
  load: async () => {
    const asked = switches;
    try {
      const ws = await json<Workspace>(await fetch("/api/workshop/workspace"));
      if (asked === switches) set({ ...ws, loaded: true });
    } catch {
      // nothing was loaded (signed out, a server restart): "loaded, no projects" would read as a brand-new account
      if (asked === switches) set({ currentProjectId: null, projects: [], loaded: false });
    }
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
      if (asked === switches) set({ ...ws, loaded: true });
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

/**
 * The colour the app wears (Settings → Appearance → Colour): the current project's while the person follows the
 * project, else the one they picked for themselves. No project, or a colour that is not one of ours, is violet.
 */
export function accentFor(followProject: boolean, own: string, project: ProjectColor | null): ProjectColor {
  if (followProject) return project ?? "violet";
  return Object.keys(PROJECT_COLORS).includes(own) ? (own as ProjectColor) : "violet";
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
    if (color === "violet") delete el.dataset.tint;
    else el.dataset.tint = color;
    try {
      localStorage.setItem("ct-tint", color);
    } catch {
      /* private mode: this visit only */
    }
  }, [color]);
}
