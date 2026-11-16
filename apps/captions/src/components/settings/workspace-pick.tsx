import { useEffect, useId, useMemo } from "react";
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

/** The selectors mounted now, oldest first (WorkspacePick draws only the first). */
const useDrawn = create<{ ids: string[] }>(() => ({ ids: [] }));

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

/** What a page shows for a choice (`picked`: an id, ALL_WORKSPACES or none yet) among `every` workspace, the window being in `here`. */
export function shownWorkspace(mode: "list" | "one", picked: string | null, every: WorkshopProject[], here: string | null, only?: readonly string[] | null): SettingsWorkspace {
  const allowed = only ? new Set(only) : null;
  const workspaces = allowed ? every.filter((p) => allowed.has(p.id)) : every;
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
    name: (w) => (w ? (every.find((p) => p.id === w)?.name ?? "Another workspace") : "Every workspace"),
  };
}

/** `only`: the workspaces this page can show (a plug-in's page: the ones it is on in); left out, all of them. */
export function useSettingsWorkspace(mode: "list" | "one", only?: readonly string[]): SettingsWorkspace {
  const picked = usePick((s) => s.picked);
  const every = useWorkspace((s) => s.projects);
  const here = useWorkspace((s) => s.currentProjectId);
  const onlyKey = only ? only.join(" ") : null;
  return useMemo(() => shownWorkspace(mode, picked, every, here, onlyKey === null ? null : onlyKey.split(" ").filter(Boolean)), [picked, every, here, mode, onlyKey]);
}

/** The fetch options for a request that works in one workspace, whatever the window is in (the X-CT-Workspace header). */
export function inWorkspace(id: string | null | undefined, init?: RequestInit): RequestInit | undefined {
  if (!id) return init;
  const headers = new Headers(init?.headers);
  headers.set("X-CT-Workspace", id);
  return { ...init, headers };
}

/** The selector, in the page header. Nothing to choose with fewer than two workspaces, so nothing is drawn. */
export function WorkspacePick({ mode, only }: { mode: "list" | "one"; only?: readonly string[] }) {
  const w = useSettingsWorkspace(mode, only);
  // one selector per page: when two parts of a page ask for it (a tool's page and a plug-in's section on it), the first draws
  const me = useId();
  useEffect(() => {
    useDrawn.setState((s) => ({ ids: [...s.ids, me] }));
    return () => useDrawn.setState((s) => ({ ids: s.ids.filter((x) => x !== me) }));
  }, [me]);
  const first = useDrawn((s) => s.ids[0] === me);
  if (!w.many || !first) return null;
  return (
    <PageAction>
      <SettingsSelect
        label="Workspace"
        // always the last thing before Close, whatever else a page puts in the header and whichever drew first (Usage's
        // period picker), and one width whatever the workspace is called: the selector is in the same place on every
        // page, and a long name is cut short instead of pushing the title and Close out of the header
        className="order-last max-w-52 sm:w-52 [&>span]:!block [&>span]:min-w-0 [&>span]:truncate"
        value={w.all ? ALL_WORKSPACES : (w.id ?? "")}
        onValueChange={(picked) => usePick.setState({ picked })}
        options={[...(mode === "list" ? [{ value: ALL_WORKSPACES, label: "All workspaces" }] : []), ...w.workspaces.map((p) => ({ value: p.id, label: p.name }))]}
      />
    </PageAction>
  );
}

/**
 * Which workspace a row's thing belongs to: its colour dot and name, "Every workspace" for one with none (`none`: the
 * word where a thing with no workspace is used by none, a social account). Shown on a list page while it shows all
 * workspaces (`w.all`); with one workspace picked, or only one to have, it says nothing.
 */
export function WorkspaceTag({ id, none = "Every workspace" }: { id?: string | null; none?: string }) {
  const workspaces = useWorkspace((s) => s.projects);
  if (workspaces.length < 2) return null;
  const p = id ? workspaces.find((x) => x.id === id) : null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {p && <span aria-hidden className={`size-2 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(p)].dot}`} />}
      <span className="truncate">{id ? (p?.name ?? "Another workspace") : none}</span>
    </span>
  );
}

/**
 * A row menu's items for moving a thing between workspaces: every other workspace, then "Use in every workspace"
 * (`every: false` leaves that out, for a thing that belongs to one workspace or none).
 */
export function moveItems(workspaces: ReadonlyArray<{ id: string; name: string }>, current: string | null | undefined, move: (to: string | null) => unknown, every = true): Array<{ label: string; onSelect: () => unknown }> {
  if (workspaces.length < 2) return [];
  return [
    ...workspaces.filter((p) => p.id !== current).map((p) => ({ label: `Move to ${p.name}`, onSelect: () => move(p.id) })),
    ...(current && every ? [{ label: "Use in every workspace", onSelect: () => move(null) }] : []),
  ];
}
