import { useMemo } from "react";
import { create } from "zustand";
import { PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import type { WorkshopProject } from "@/lib/workshop";
import { SettingsSelect } from "./kit-controls";
import { PageAction } from "./page-action";

/**
 * Settings covers every workspace. A page whose content belongs to a workspace says so with one control, always in the
 * same place: the workspace selector in the page header (`WorkspacePick`). A page with no selector is the same in every
 * workspace.
 *
 *   mode "list"  a list of things that each belong to a workspace (folders, scheduled tasks, rules, social accounts).
 *                Starts on All workspaces; each row then carries its `WorkspaceTag`.
 *   mode "one"   single values (a library's settings, a workspace's details): the page shows one workspace's values.
 *
 * The choice is kept from page to page while Settings is open and never switches the workspace the window is in.
 * A request for the shown workspace sends it itself (`inWorkspace`); its saved copy is kept under that workspace
 * (`useCachedLoad(url, load, { workspace: w.cacheKey })`).
 */
export const ALL_WORKSPACES = "all";

const usePick = create<{ picked: string | null }>(() => ({ picked: null }));

/** Settings closed: the next time it opens it starts from the window's workspace again (SettingsPage). */
export const resetWorkspacePick = () => usePick.setState({ picked: null });

export interface SettingsWorkspace {
  /** the workspace shown; null = all of them (a list page), or the person has no workspace */
  id: string | null;
  /** every workspace is shown (list pages only) */
  all: boolean;
  /** the person's workspaces, as the switcher lists them */
  workspaces: WorkshopProject[];
  /** two or more workspaces: only then is there anything to choose or to label */
  many: boolean;
  /** for `useCachedLoad`'s `workspace` option: the shown workspace's id, "*" for all, undefined when it is the window's own */
  cacheKey: string | undefined;
  /** a workspace's name; "Every workspace" for a thing with none, "Another workspace" for one this account cannot see */
  name: (id?: string | null) => string;
}

export function useSettingsWorkspace(mode: "list" | "one"): SettingsWorkspace {
  const picked = usePick((s) => s.picked);
  const workspaces = useWorkspace((s) => s.projects);
  const here = useWorkspace((s) => s.currentProjectId);
  return useMemo(() => {
    const many = workspaces.length > 1;
    const known = (id: string | null) => (id && workspaces.some((p) => p.id === id) ? id : null);
    const own = known(here) ?? workspaces[0]?.id ?? null;
    const chosen = picked === ALL_WORKSPACES ? null : known(picked);
    // a list starts on all of them; a page of single values on the window's own
    const all = mode === "list" && many && (picked === null || picked === ALL_WORKSPACES);
    const id = all ? null : many ? (chosen ?? own) : own;
    return {
      id,
      all,
      workspaces,
      many,
      cacheKey: all ? "*" : id && id !== here ? id : undefined,
      name: (w) => (w ? (workspaces.find((p) => p.id === w)?.name ?? "Another workspace") : "Every workspace"),
    };
  }, [picked, workspaces, here, mode]);
}

/** The fetch options for a request that works in one workspace, whatever the window is in (the X-CT-Workspace header). */
export function inWorkspace(id: string | null | undefined, init?: RequestInit): RequestInit | undefined {
  if (!id) return init;
  const headers = new Headers(init?.headers);
  headers.set("X-CT-Workspace", id);
  return { ...init, headers };
}

/** The selector, in the page header. Nothing to choose with fewer than two workspaces, so nothing is drawn. */
export function WorkspacePick({ mode }: { mode: "list" | "one" }) {
  const w = useSettingsWorkspace(mode);
  if (!w.many) return null;
  return (
    <PageAction>
      <SettingsSelect
        label="Workspace"
        value={w.all ? ALL_WORKSPACES : (w.id ?? "")}
        onValueChange={(picked) => usePick.setState({ picked })}
        options={[...(mode === "list" ? [{ value: ALL_WORKSPACES, label: "All workspaces" }] : []), ...w.workspaces.map((p) => ({ value: p.id, label: p.name }))]}
      />
    </PageAction>
  );
}

/**
 * Which workspace a row's thing belongs to: its colour dot and name, "Every workspace" for one with none. Shown on a
 * list page while it shows all workspaces (`w.all`); with one workspace picked, or only one to have, it says nothing.
 */
export function WorkspaceTag({ id }: { id?: string | null }) {
  const workspaces = useWorkspace((s) => s.projects);
  if (workspaces.length < 2) return null;
  const p = id ? workspaces.find((x) => x.id === id) : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {p && <span aria-hidden className={`size-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(p)].dot}`} />}
      <span className="truncate">{id ? (p?.name ?? "Another workspace") : "Every workspace"}</span>
    </span>
  );
}

/** A row menu's items for moving a thing between workspaces: every other workspace, then "Use in every workspace". */
export function moveItems(workspaces: ReadonlyArray<{ id: string; name: string }>, current: string | null | undefined, move: (to: string | null) => unknown): Array<{ label: string; onSelect: () => unknown }> {
  if (workspaces.length < 2) return [];
  return [
    ...workspaces.filter((p) => p.id !== current).map((p) => ({ label: `Move to ${p.name}`, onSelect: () => move(p.id) })),
    ...(current ? [{ label: "Use in every workspace", onSelect: () => move(null) }] : []),
  ];
}
