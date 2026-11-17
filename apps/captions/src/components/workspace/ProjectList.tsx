import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useCachedList } from "@/lib/local-cache";
import { Loader2, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ConnectorsSection } from "@/components/settings/ConnectorsSection";
import { PLATFORMS } from "@contracts/connectors";
import type { LibraryUpload } from "@contracts/library";
import { setWorkspaceUpload } from "@/lib/library";
import { UploadRow } from "@/pages/library/UploadSelect";
import { ProjectForm, type KeptFile } from "@/components/workshop/ProjectForm";
import { listAccounts, type InstagramAccount } from "@/lib/instagram";
import {
  addProjectFiles,
  createProject,
  deleteProject,
  foldProjectInstructions,
  patchProject,
  workspaceContents,
  type ProjectFields,
  type WorkshopProject,
} from "@/lib/workshop";
import { PROJECT_ACCOUNTS_KEY, PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { useMe } from "@/lib/auth";
import { confirmDialog } from "@/lib/dialogs";

/**
 * Create, edit, switch, and delete workspaces (the switcher's Manage workspaces window). `current`: the Content
 * Workshop's tab, only the workspace this window is in, to edit; making, switching and deleting are the switcher's.
 */
export function ProjectList({ current: only }: { current?: boolean } = {}) {
  const all = useWorkspace((s) => s.projects);
  const loaded = useWorkspace((s) => s.loaded);
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const select = useWorkspace((s) => s.select);
  const projects = only ? all.filter((p) => p.id === currentProjectId) : all;
  const me = useMe()?.username;
  const [editing, setEditing] = useState<string | "new" | null>(null);
  // the workspace just created: step 2, its accounts, in a window of its own (skippable)
  const [made, setMade] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  // `/projects?add=1` opens the New project form once, `?edit=<id>` that project's own (a chat's menu asks for the
  // current one; a platform sign-in comes back there); then the parameter goes
  // `?accounts=<id>` reopens step 2, where a sign-in started there comes back to
  useEffect(() => {
    const edit = params.get("add") === "1" ? "new" : params.get("edit");
    const accounts = params.get("accounts");
    if ((!edit && !accounts) || only) return;
    if (edit) setEditing(edit);
    if (accounts) setMade(accounts);
    setParams((p) => (p.delete("add"), p.delete("edit"), p.delete("accounts"), p), { replace: true });
  }, [params, setParams, only]);
  const [busy, setBusy] = useState(false);
  // a new workspace's upload choice (Off by default), kept on its library once it exists
  const [upload, setUpload] = useState<LibraryUpload>("none");
  const [finalsUpload, setFinalsUpload] = useState<LibraryUpload>("all");
  const [error, setError] = useState<string | null>(null);
  // every project's accounts, from their saved copy (warmed at sign-in), live
  const { items: accounts, refresh } = useCachedList<InstagramAccount>(PROJECT_ACCOUNTS_KEY, () => listAccounts("", { projectId: null }));
  const loadAccounts = () => void refresh().catch(() => {});

  const closed = () => (setEditing(null), setMade(null));
  const run = async <T,>(fn: () => Promise<T>, after: (v: T) => void = closed) => {
    setBusy(true);
    setError(null);
    try {
      after(await fn());
      loadAccounts();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // the files dropped on its instructions are kept as its own Knowledge once it exists; a new one opens on its own form
  // first, so a file that fails is said there and the project is never made twice
  const save = (id: string | "new", fields: ProjectFields, files: KeptFile[]) =>
    id === "new"
      ? run(async () => {
          const p = await createProject(fields);
          setEditing(null);
          setMade(p.id);
          if (upload !== "none" || finalsUpload !== "all") await setWorkspaceUpload(p.id, { upload, finalsUpload });
          setUpload("none");
          setFinalsUpload("all");
          if (files.length) await addProjectFiles(p.id, files);
        }, () => {})
      : run(async () => {
          await patchProject(id, fields);
          if (files.length) await addProjectFiles(id, files);
        });
  // making one: only its form shows
  const making = editing === "new";

  return (
    <section>
      {!making && !only && (
        <div className="mb-3 flex justify-end">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing("new")}>
            <Plus /> New workspace
          </Button>
        </div>
      )}
      {error ? <p role="alert" className="mb-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex flex-col gap-2">
        {editing === "new" ? (
          <ProjectForm busy={busy} onSave={(f, files) => save("new", f, files)} onCancel={() => setEditing(null)}>
            <UploadRow value={upload} onChange={setUpload} />
            <UploadRow finals value={finalsUpload} onChange={setFinalsUpload} />
          </ProjectForm>
        ) : null}
        {loaded && projects.length === 0 && editing !== "new" ? (
          <p className="py-10 text-center text-sm text-muted-foreground">{only ? "No workspace" : "No workspaces"}</p>
        ) : null}
        {projects.map((p) =>
          editing === p.id ? (
            <ProjectForm key={p.id} initial={p} busy={busy} onSave={(f, files) => save(p.id, f, files)} onCancel={() => setEditing(null)} />
          ) : making ? null : (
            <ProjectRow
              key={p.id}
              project={p}
              account={accounts.find((a) => a.id === p.accountId)}
              current={p.id === currentProjectId}
              busy={busy}
              onUse={() => void select(p.id)}
              // a workspace the team's owner gave this person (Settings → Team) is used, never changed
              onEdit={me && p.owner !== me ? undefined : () => setEditing(p.id)}
              onDelete={only || (me && p.owner !== me) ? undefined : () => void run(() => askDelete(p))}
              badge={!only}
            />
          ),
        )}
      </div>
      {made ? <AccountsStep project={projects.find((p) => p.id === made)} id={made} busy={busy} error={error} onClose={() => setMade(null)} /> : null}
    </section>
  );
}

const listed = new Intl.ListFormat("en-GB");

/** Deleting a workspace deletes everything in it: the confirm names what goes, counted by the list the delete itself uses. */
async function askDelete(p: WorkshopProject): Promise<void> {
  const { items, ownFiles } = await workspaceContents(p.id);
  const body = [
    items.length ? `This also deletes its ${listed.format(items.map((i) => `${i.n} ${i.what}`))}.` : "",
    ownFiles ? "Memory shared by all workspaces and the files in your folders stay." : "Memory shared by all workspaces stays.",
    "This can't be undone.",
  ];
  if (await confirmDialog({ title: `Delete ${p.name}?`, body: body.filter(Boolean).join(" "), ok: "Delete workspace", danger: true })) await deleteProject(p.id);
}

/** Step 2 of a new workspace: its social accounts, on their own. Nothing has to be added: Done closes it either way. */
function AccountsStep({ project, id, busy, error, onClose }: { project?: WorkshopProject; id: string; busy: boolean; error: string | null; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[min(720px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="border-b border-border px-6 py-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">{project?.name ? `${project.name}: social accounts` : "Social accounts"}</DialogTitle>
          <DialogDescription>Step 2 of 2</DialogDescription>
        </div>
        <div className="min-h-0 flex-auto overflow-y-auto px-6 py-4">
          <ConnectorsSection projectId={id} back={`/projects?accounts=${id}`} />
          {busy ? <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving files</p> : null}
          {error ? <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
        <div className="flex justify-end border-t border-border px-6 py-3">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({
  project: p,
  account,
  current,
  busy,
  onUse,
  onEdit,
  onDelete,
  badge,
}: {
  project: WorkshopProject;
  account?: InstagramAccount;
  current: boolean;
  busy: boolean;
  onUse: () => void;
  /** Absent: no Edit (someone else's workspace, given to this person). */
  onEdit?: () => void;
  /** Absent: no Delete (the Workshop's tab; the switcher's window deletes). */
  onDelete?: () => void;
  /** The Current badge, for the list of them all. */
  badge: boolean;
}) {
  const blurb = foldProjectInstructions(p);
  const handles = Object.entries(p.handles ?? {}).filter((e): e is [string, string] => Boolean(e[1]));
  return (
    <div className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 sm:px-4 ${current ? "border-ring/60 bg-accent/40" : "border-border/60 bg-card/40"}`}>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PROJECT_COLORS[projectColor(p)].dot}`} />
          <span className="truncate">{p.name}</span>
          {current && badge ? <span className="shrink-0 text-xs font-normal text-muted-foreground">Current</span> : null}
        </p>
        {account ? <p className="mt-0.5 text-xs text-muted-foreground">Instagram @{account.username}</p> : null}
        {handles.length ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {handles.map(([id, h]) => `${PLATFORMS.find((x) => x.id === id)?.label ?? id} @${h.replace(/^@/, "")}`).join(" · ")}
          </p>
        ) : null}
        {blurb ? <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{blurb}</p> : null}
      </div>
      {!current ? (
        <Button size="sm" variant="outline" onClick={onUse} disabled={busy}>
          Use
        </Button>
      ) : null}
      {onEdit ? (
        <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
          <Pencil /> Edit
        </Button>
      ) : null}
      {onDelete ? (
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy} className="text-muted-foreground hover:text-red-600 dark:hover:text-red-400">
          Delete
        </Button>
      ) : null}
    </div>
  );
}
