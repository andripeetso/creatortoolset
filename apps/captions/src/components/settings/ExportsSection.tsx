import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { listExports, saveExports, type WorkshopExport } from "@/lib/workshop";
import { OBSIDIAN_TEMPLATE } from "@/lib/workshop-markdown";
import { Card, Group, Loading, Notice, Row } from "./ui";
import { msg, selectCls } from "./helpers";

const BUILTIN_ID = "obsidian";

const newExport = (): WorkshopExport => ({
  id: crypto.randomUUID(),
  name: "Obsidian",
  target: "plugin",
  folder: "",
  filename: "{{title}}.md",
  template: OBSIDIAN_TEMPLATE,
});

/**
 * Settings → Exports: the Obsidian export is one custom export among others. Each export's name, where
 * it goes, the file name pattern and the note's template. The built-in Obsidian Markdown is kept as it is.
 */
export function ExportsSection() {
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
      },
      (e) => setError(msg(e)),
    );

  return (
    <Group
      title="Exports"
      hint={
        <>
          Where a session goes when you export it from the Workshop. A download saves the file. A plugin export queues the note for the Obsidian plugin, which writes it into your vault
          at the folder and file name below and links the session to that note. Placeholders: {"{{title}} {{status}} {{media}} {{body}} {{caption}} {{date}}"}.
        </>
      }
    >
      <div className="space-y-3">
        {list.map((e, i) =>
          e.id === BUILTIN_ID ? (
            <Card key={e.id}>
              <Row label={e.name} hint="Built in: downloads the note the way it always has." />
            </Card>
          ) : (
            <Card key={e.id} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input value={e.name} onChange={(ev) => edit(i, { name: ev.target.value })} placeholder="Name" aria-label="Export name" className="h-8 max-w-56 text-xs" />
                <select value={e.target} onChange={(ev) => edit(i, { target: ev.target.value as WorkshopExport["target"] })} className={selectCls} aria-label="Target">
                  <option value="plugin">Obsidian plugin (writes into the vault)</option>
                  <option value="download">Download</option>
                </select>
                <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remove export">
                  <Trash2 /> Remove
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input value={e.folder} onChange={(ev) => edit(i, { folder: ev.target.value })} placeholder="Folder in the vault, e.g. Scripts" aria-label="Folder" className="h-8 min-w-48 flex-1 text-xs" />
                <Input value={e.filename} onChange={(ev) => edit(i, { filename: ev.target.value })} placeholder="{{title}}.md" aria-label="File name" className="h-8 min-w-48 flex-1 text-xs" />
              </div>
              <Textarea value={e.template} onChange={(ev) => edit(i, { template: ev.target.value })} rows={8} aria-label="Template" className="font-mono text-xs" />
            </Card>
          ),
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setList([...list, newExport()])}>
          <Plus /> Add export
        </Button>
        <Button size="sm" onClick={() => void save()}>
          Save exports
        </Button>
        {saved && <span className="text-xs text-muted-foreground">Saved</span>}
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
    </Group>
  );
}
