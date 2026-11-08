import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { listExports, saveExports, type WorkshopExport } from "@/lib/workshop";
import { OBSIDIAN_TEMPLATE } from "@/lib/workshop-markdown";
import { Card, Loading, Notice } from "@/components/settings/ui";
import { msg } from "@/components/settings/helpers";

const BUILTIN_ID = "obsidian";
const PLACEHOLDERS = "{{title}} {{status}} {{media}} {{body}} {{caption}} {{date}}";
const selectCls = "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-50";

const newExport = (): WorkshopExport => ({
  id: crypto.randomUUID(),
  name: "Obsidian",
  target: "plugin",
  folder: "",
  filename: "{{title}}.md",
  template: OBSIDIAN_TEMPLATE,
});

/** A small label over a field, with its hint under it (one line, not a paragraph in the placeholder). */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 flex-1 space-y-1">
      <span className="block text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

/**
 * The account's Workshop exports: each one's name, target, where its note goes and the template. Shown in the
 * Workshop's Export menu ("Edit exports…"). The built-in Obsidian Markdown stays as it is.
 */
export function ExportsEditor({ onSaved }: { onSaved?: () => void }) {
  const [list, setList] = useState<WorkshopExport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => void listExports().then(setList, (e) => setError(msg(e))), []);
  if (!list) return error ? <Notice tone="error">{error}</Notice> : <Loading />;

  const edit = (i: number, patch: Partial<WorkshopExport>) => {
    setList(list.map((e, j) => (j === i ? { ...e, ...patch } : e)));
    setSaved(false);
  };
  const save = () =>
    saveExports(list.filter((e) => e.id !== BUILTIN_ID)).then(
      (next) => {
        setList(next);
        setSaved(true);
        setError(null);
        onSaved?.();
      },
      (e) => setError(msg(e)),
    );

  return (
    <div className="space-y-3">
      {list.map((e, i) =>
        e.id === BUILTIN_ID ? (
          <Card key={e.id} className="px-3 py-3 text-sm">
            <span className="font-medium">{e.name}</span>
            <span className="ml-2 text-xs text-muted-foreground">Built in: downloads the note the way it always has.</span>
          </Card>
        ) : (
          <Card key={e.id} className="space-y-3 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Name">
                <Input value={e.name} onChange={(ev) => edit(i, { name: ev.target.value })} aria-label="Export name" className="h-8 max-w-56 text-xs" />
              </Field>
              <Field label="Target">
                <select value={e.target} onChange={(ev) => edit(i, { target: ev.target.value as WorkshopExport["target"] })} className={selectCls} aria-label="Target">
                  <option value="plugin">Obsidian plugin (writes into the vault)</option>
                  <option value="download">Download</option>
                </select>
              </Field>
              <Button variant="ghost" size="sm" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remove export">
                <Trash2 /> Remove
              </Button>
            </div>
            <div className="flex flex-wrap gap-3">
              <Field label="Folder" hint="In the vault. Empty writes to the vault root.">
                <Input value={e.folder} onChange={(ev) => edit(i, { folder: ev.target.value })} placeholder="e.g. Scripts" aria-label="Folder" className="h-8 text-xs" />
              </Field>
              <Field label="File name" hint={`Placeholders: ${PLACEHOLDERS}`}>
                <Input value={e.filename} onChange={(ev) => edit(i, { filename: ev.target.value })} placeholder="{{title}}.md" aria-label="File name" className="h-8 font-mono text-xs" />
              </Field>
            </div>
            <Field label="Template" hint="The note's body. The same placeholders as the file name.">
              <Textarea value={e.template} onChange={(ev) => edit(i, { template: ev.target.value })} rows={8} aria-label="Template" className="font-mono text-xs" />
            </Field>
          </Card>
        ),
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setList([...list, newExport()])}>
          <Plus /> Add export
        </Button>
        <Button size="sm" onClick={() => void save()}>
          Save exports
        </Button>
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
