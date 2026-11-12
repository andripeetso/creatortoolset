import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useCachedList } from "@/lib/local-cache";
import { Pencil, Plus } from "lucide-react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { PLATFORMS } from "@contracts/connectors";
import { ProjectForm } from "@/components/workshop/ProjectForm";
import { listAccounts, mineAccount, type InstagramAccount } from "@/lib/instagram";
import {
  createProject,
  deleteProject,
  foldProjectInstructions,
  patchProject,
  type ProjectFields,
  type WorkshopProject,
} from "@/lib/workshop";
import { PROJECT_ACCOUNTS_KEY, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";

const secondary =
  "flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

/** Create, edit, switch, and delete workspace projects. */
export function ProjectList() {
  const projects = useWorkspace((s) => s.projects);
  const loaded = useWorkspace((s) => s.loaded);
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const select = useWorkspace((s) => s.select);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [params, setParams] = useSearchParams();
  // `/projects?add=1` opens the New project form once, then the parameter goes
  useEffect(() => {
    if (params.get("add") !== "1") return;
    setEditing("new");
    setParams((p) => (p.delete("add"), p), { replace: true });
  }, [params, setParams]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // every project's accounts, from their saved copy (warmed at sign-in), live
  const { items: accounts, refresh } = useCachedList<InstagramAccount>(PROJECT_ACCOUNTS_KEY, () => listAccounts("", { projectId: null }));
  const loadAccounts = () => void refresh().catch(() => {});

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setEditing(null);
      loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (id: string | "new", fields: ProjectFields) =>
    run(() => (id === "new" ? createProject(fields) : patchProject(id, fields)));

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Instructions and context the AI should already know
        </p>
        <button type="button" disabled={busy || editing === "new"} onClick={() => setEditing("new")} className={secondary}>
          <Plus className="h-3.5 w-3.5" /> New project
        </button>
      </div>
      {error ? <p className="mb-3 text-xs text-red-400">{error}</p> : null}
      <div className="flex flex-col gap-2">
        {editing === "new" ? (
          <ProjectForm busy={busy} onSave={(f) => save("new", f)} onCancel={() => setEditing(null)} />
        ) : null}
        {loaded && projects.length === 0 && editing !== "new" ? (
          <p className="py-10 text-center text-sm text-zinc-600">
            No projects yet. Analyzer and Workshop both use the current one.
          </p>
        ) : null}
        {projects.map((p) =>
          editing === p.id ? (
            <ProjectForm key={p.id} initial={p} busy={busy} onSave={(f) => save(p.id, f)} onCancel={() => setEditing(null)} />
          ) : (
            <ProjectRow
              key={p.id}
              project={p}
              account={accounts.find((a) => a.id === p.accountId)}
              mineId={mineAccount(accounts)?.id}
              current={p.id === currentProjectId}
              busy={busy}
              onUse={() => void select(p.id)}
              onEdit={() => setEditing(p.id)}
              onDelete={() => void run(() => deleteProject(p.id))}
            />
          ),
        )}
      </div>
    </section>
  );
}

function ProjectRow({
  project: p,
  account,
  mineId,
  current,
  busy,
  onUse,
  onEdit,
  onDelete,
}: {
  project: WorkshopProject;
  account?: InstagramAccount;
  mineId?: string;
  current: boolean;
  busy: boolean;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const blurb = foldProjectInstructions(p);
  const handles = Object.entries(p.handles ?? {}).filter((e): e is [string, string] => Boolean(e[1]));
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${
        current ? "border-violet-500/40 bg-violet-600/10" : "border-zinc-800 bg-zinc-900/50"
      }`}
    >
      <button type="button" onClick={onUse} disabled={busy || current} className="-my-2.5 -ml-3 min-w-0 flex-1 self-stretch py-2.5 pl-3 text-left disabled:cursor-default">
        <p className="flex items-center gap-2 text-sm text-zinc-100">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(p)].dot}`} />
          <span className="truncate">{p.name}</span>
          {current ? (
            <span className="shrink-0 rounded-md bg-violet-600 px-1.5 py-0.5 text-[10px] font-medium text-white">Current</span>
          ) : null}
        </p>
        {account ? (
          <p className="mt-0.5 text-[11px] text-violet-300/80">
            {account.mine || account.id === mineId ? "My account" : "Account"} · @{account.username}
          </p>
        ) : null}
        {handles.length ? (
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {handles.map(([id, h]) => `${PLATFORMS.find((x) => x.id === id)?.label ?? id} @${h.replace(/^@/, "")}`).join(" · ")}
          </p>
        ) : null}
        {blurb ? <p className="mt-0.5 line-clamp-2 text-[11px] text-zinc-500">{blurb}</p> : null}
      </button>
      {!current ? (
        <button type="button" onClick={onUse} className={secondary} disabled={busy}>
          Use
        </button>
      ) : null}
      <button type="button" onClick={onEdit} className={secondary} disabled={busy}>
        <Pencil className="h-3 w-3" /> Edit
      </button>
      <ConfirmButton
        label="Delete"
        confirmLabel="Click again"
        disabled={busy}
        onConfirm={onDelete}
        className="rounded-md px-2 py-1.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-red-300 disabled:opacity-50"
        armedClassName="!bg-red-500/10 !text-red-200"
      />
    </div>
  );
}
