import { useRef, useState } from "react";
import { FileText, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { addProjectFiles, draftPersonas, patchProject, type Persona, type PersonaDraftUsed } from "@/lib/workshop";

const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const ACCEPT = ".txt,.md,.markdown,.pdf,.docx,.odt,.epub,text/*,application/pdf";

/** "40 posts, 212 comments, audience numbers, 2 files": what a draft was built from. */
export function usedLine(u: PersonaDraftUsed): string {
  const n = (count: number, one: string) => (count ? `${count} ${one}${count === 1 ? "" : "s"}` : "");
  const parts = [n(u.posts, "post"), n(u.comments, "comment"), u.numbers ? "audience numbers" : "", n(u.files, "file")].filter(Boolean);
  return parts.length ? `Built from ${parts.join(", ")}` : "Built from the workspace's instructions";
}

/**
 * The persona builder: "Read as a follower" opens it the first time, in a workspace with no personas. The person's AI
 * drafts them from the account (its audience numbers, comments and posts), the workspace's instructions and files, and
 * what they type or add here; they edit, then Save starts the read. Files added here are kept as context files.
 */
export function PersonaBuilder({ projectId, initial, onClose, onSaved }: { projectId: string; initial: Persona[]; onClose: () => void; onSaved: (personas: Persona[]) => void }) {
  const [personas, setPersonas] = useState<Persona[]>(initial);
  const [said, setSaid] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [used, setUsed] = useState<PersonaDraftUsed | null>(null);
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList) => setFiles((cur) => [...cur, ...[...list].filter((f) => !cur.some((c) => c.name === f.name))].slice(0, 20));

  const draft = async () => {
    setBusy("draft");
    setError(null);
    try {
      const d = await draftPersonas(projectId, said, files);
      setPersonas(d.personas);
      setUsed(d.used);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not draft personas");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const kept = personas.map((p) => ({ ...p, name: p.name.trim(), about: p.about.trim() })).filter((p) => p.name && p.about);
    if (!kept.length) return setError("Needs a persona with a name and a description");
    setBusy("save");
    setError(null);
    try {
      await patchProject(projectId, { personas: kept });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save personas");
      return setBusy(null);
    }
    if (files.length) void addProjectFiles(projectId, files.map((file) => ({ file }))).catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Could not add files"));
    onSaved(kept);
  };

  const edit = (i: number, patch: Partial<Persona>) => setPersonas((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Dialog open onOpenChange={(o) => !o && busy !== "save" && onClose()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length || busy) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <DialogHeader>
          <DialogTitle>Personas</DialogTitle>
          <DialogDescription>Each persona reads the piece on its own and says where they would stop.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="persona-said" className="text-sm font-medium">
            Who watches
          </label>
          <textarea id="persona-said" value={said} onChange={(e) => setSaid(e.target.value)} disabled={!!busy} rows={3} maxLength={4000} className={field} />
          {files.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((f) => (
                <li key={f.name} className="flex items-center gap-1 rounded-md border border-border bg-muted/40 py-0.5 pr-1 pl-2 text-xs">
                  <FileText className="size-3.5 text-muted-foreground" />
                  <span className="max-w-48 truncate">{f.name}</span>
                  <button type="button" aria-label={`Remove ${f.name}`} disabled={!!busy} onClick={() => setFiles((cur) => cur.filter((x) => x !== f))} className="text-muted-foreground hover:text-foreground">
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-2">
            <Button type="button" variant={personas.length ? "outline" : "default"} onClick={() => void draft()} disabled={!!busy}>
              {busy === "draft" ? (
                <>
                  <Spinner /> Drafting
                </>
              ) : personas.length ? (
                "Draft again"
              ) : (
                "Draft personas"
              )}
            </Button>
            <input ref={pick} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (e.target.files && addFiles(e.target.files), (e.target.value = ""))} />
            <Button type="button" variant="ghost" onClick={() => pick.current?.click()} disabled={!!busy} title="Audience research, product notes, customer messages: kept as the workspace's context files on Save">
              <Plus className="size-4" /> Add files
            </Button>
          </div>
          {used ? (
            <p className="text-xs text-muted-foreground">
              {usedLine(used)}
              {used.unread.length ? ` (could not read ${used.unread.join(", ")})` : ""}
            </p>
          ) : null}
        </div>
        {personas.map((p, i) => (
          <div key={i} className="relative flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <input aria-label="Name" value={p.name} onChange={(e) => edit(i, { name: e.target.value })} maxLength={60} disabled={!!busy} className={`${field} pr-8 font-medium`} />
            <textarea aria-label="Description" value={p.about} onChange={(e) => edit(i, { about: e.target.value })} maxLength={800} rows={4} disabled={!!busy} className={field} />
            {p.basis ? <p className="text-xs text-muted-foreground">{p.basis}</p> : null}
            <button
              type="button"
              aria-label={`Remove ${p.name || "persona"}`}
              onClick={() => setPersonas((ps) => ps.filter((_, j) => j !== i))}
              disabled={!!busy}
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
        {personas.length > 0 && personas.length < 4 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setPersonas((ps) => [...ps, { name: "", about: "" }])} disabled={!!busy} className="self-start">
            <Plus className="size-4" /> Add persona
          </Button>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy === "save"}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={busy === "draft"}>
            {busy === "save" ? <Spinner /> : null} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
