import { useState } from "react";
import type { ScopeInput } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";

/**
 * Where a writing rule or a framework applies (api/lib/workshop/rule-workspaces.ts): All workspaces, or only the ones
 * ticked, the same choice as a plug-in's. One used in more than this workspace can be changed for this workspace alone
 * (its own version); that version can be deleted to use the shared one here again.
 */
type Scoped = { only?: string[]; changedHere?: boolean };

/** The form's side of it: the ticked workspaces, what Save sends, and the workspace a version would be for. */
export function useScope(item?: Scoped) {
  const projects = useWorkspace((s) => s.projects);
  const current = useWorkspace((s) => s.currentProjectId);
  const [only, setOnly] = useState(item?.only);
  const here = projects.find((p) => p.id === current);
  return {
    only,
    setOnly,
    /** `workspaces` for Save, when the ticks changed */
    saved: (): ScopeInput => (only === item?.only ? {} : { workspaces: only ? { only } : { all: true } }),
    /** the workspace "Save for …" makes a version for: one used in more than it, and not changed there yet */
    versionFor: item && !item.changedHere && here && projects.length > 1 && (!item.only || item.only.length > 1) ? here : undefined,
    here,
  };
}

/** The ticks; nothing to choose with one workspace. */
export function WorkspacesField({ only, onChange }: { only: string[] | undefined; onChange: (only: string[] | undefined) => void }) {
  const projects = useWorkspace((s) => s.projects);
  if (projects.length < 2) return null;
  const on = (id: string) => !only || only.includes(id);
  const box = "accent-violet-500";
  return (
    <fieldset className="flex flex-col gap-1 text-[11px] text-zinc-400">
      <legend className="mb-1">Workspaces</legend>
      <label className="flex items-center gap-2">
        <input type="checkbox" className={box} checked={!only} onChange={(e) => onChange(e.target.checked ? undefined : projects.map((p) => p.id))} />
        All workspaces
      </label>
      {projects.map((p) => (
        <label key={p.id} className="flex items-center gap-2 pl-5">
          <input type="checkbox" className={box} checked={on(p.id)} onChange={(e) => onChange(projects.filter((x) => (x.id === p.id ? e.target.checked : on(x.id))).map((x) => x.id))} />
          {p.name}
        </label>
      ))}
    </fieldset>
  );
}

/** On a row: the workspaces it is kept to, and that this workspace has its own version. */
export function ScopeTags({ item }: { item: Scoped }) {
  const projects = useWorkspace((s) => s.projects);
  const current = useWorkspace((s) => s.currentProjectId);
  const name = (id: string | null) => projects.find((p) => p.id === id)?.name;
  const only = item.only?.map(name).filter(Boolean);
  // inline-block: a tag that does not fit goes to the next line whole, never split across two
  const tag = "ml-2 inline-block rounded px-1 py-0.5 text-[10px]";
  return (
    <>
      {only?.length ? <span className={`${tag} bg-zinc-800 text-zinc-400`}>Only in {only.join(", ")}</span> : null}
      {item.changedHere ? <span className={`${tag} bg-violet-500/15 text-violet-300`}>Changed for {name(current) ?? "this workspace"}</span> : null}
    </>
  );
}
