import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { draftPersonas, patchProject, type Persona } from "@/lib/workshop";

const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The persona builder: "Read as a follower" opens it the first time, in a workspace with no personas. The person's AI
 * drafts them from the workspace's instructions, its account and what they typed; they edit, then Save starts the read.
 */
export function PersonaBuilder({ projectId, initial, onClose, onSaved }: { projectId: string; initial: Persona[]; onClose: () => void; onSaved: (personas: Persona[]) => void }) {
  const [personas, setPersonas] = useState<Persona[]>(initial);
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState<"draft" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const draft = async () => {
    setBusy("draft");
    setError(null);
    try {
      setPersonas((await draftPersonas(projectId, said)).personas);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not draft personas");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const kept = personas.map((p) => ({ name: p.name.trim(), about: p.about.trim() })).filter((p) => p.name && p.about);
    if (!kept.length) return setError("Needs a persona with a name and a description");
    setBusy("save");
    setError(null);
    try {
      await patchProject(projectId, { personas: kept });
      onSaved(kept);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save personas");
      setBusy(null);
    }
  };

  const edit = (i: number, patch: Partial<Persona>) => setPersonas((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <Dialog open onOpenChange={(o) => !o && busy !== "save" && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Personas</DialogTitle>
          <DialogDescription>Each persona reads the piece on its own and says where they would stop.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <label htmlFor="persona-said" className="text-sm font-medium">
            Who watches
          </label>
          <textarea id="persona-said" value={said} onChange={(e) => setSaid(e.target.value)} disabled={!!busy} rows={3} maxLength={4000} className={field} />
          <Button type="button" variant={personas.length ? "outline" : "default"} onClick={() => void draft()} disabled={!!busy} className="self-start">
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
        </div>
        {personas.map((p, i) => (
          <div key={i} className="relative flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <input aria-label="Name" value={p.name} onChange={(e) => edit(i, { name: e.target.value })} maxLength={60} disabled={!!busy} className={`${field} pr-8 font-medium`} />
            <textarea aria-label="Description" value={p.about} onChange={(e) => edit(i, { about: e.target.value })} maxLength={800} rows={4} disabled={!!busy} className={field} />
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
