import { useState } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Advanced, Card, InUse, ListRow, RowMenu, Status, type RowMenuItem } from "@/components/settings/ui";
import { folderPluginFailures, folderRowNote, type FolderPlugins } from "@/lib/folder-plugins";
import type { PluginAdd, PluginInfo } from "@/lib/plugin";
import { resumePlugins, showPluginFolder, switchPluginOff, switchPluginOn, thisMacBridge, type PluginReply } from "@/lib/thisMac";

/**
 * The plug-ins this server is built with, one row each (the ones from the person's own folder are FolderPluginRows, below). "What it adds" folds the list, and each line that has a place
 * is a link: it closes Community and opens that place (Settings, Home, a page). Nothing here can be removed.
 */
export function PluginRows({ plugins }: { plugins: PluginInfo[] }) {
  return (
    <Card>
      {plugins.map((p) => (
        <div key={p.id} className="[&>*+*]:border-t [&>*+*]:border-border/50">
          <ListRow title={p.name} subtitle={p.about} status={<Status>Built into this server</Status>} />
          {p.adds.length > 0 && <Advanced summary="What it adds">{p.adds.map((a) => <AddLine key={a.text} add={a} />)}</Advanced>}
        </div>
      ))}
    </Card>
  );
}

function AddLine({ add }: { add: PluginAdd }) {
  if (!add.to) return <div className="py-2 text-sm text-muted-foreground">{add.text}</div>;
  return (
    <Link to={add.to} className="flex items-center justify-between gap-3 py-2 text-sm text-foreground underline-offset-2 hover:underline">
      <span className="min-w-0 truncate">{add.text}</span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

/**
 * The plug-ins in the person's own folder, one row each, with the same On switch as a pack's row. Switching one on is
 * answered by the Mac app in its own dialog. Changed: the copy they approved keeps running until Use the new version.
 * A plug-in that could not load says why in red. The switch exists only in the Mac app on the Mac that runs the
 * server; in a browser the rows are read-only. After a switch the Mac app restarts its server and reloads this window.
 */
export function FolderPluginRows({ folder, plugins }: { folder: FolderPlugins; plugins: PluginInfo[] }) {
  const mac = !!thisMacBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});
  const run = async (key: string, ask: () => Promise<PluginReply | null>) => {
    setBusy(key);
    const reply = await ask();
    // a yes is followed by the app's own reload; anything else gives the row back
    if (!reply?.ok) setBusy(null);
    setSaid((s) => ({ ...s, [key]: reply && !reply.ok && reply.problem ? reply.problem : "" }));
  };
  return (
    <Card>
      {folder.paused && (
        <ListRow
          title="Plug-ins are off"
          status={<Status tone="attention">The app's server stopped five times with them on</Status>}
          actions={mac && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("resume", resumePlugins)}>Switch back on</Button>}
        />
      )}
      {folder.rows.map((row) => {
        const key = row.folder || row.id!;
        const adds = (row.running && plugins.find((p) => p.id === row.id)?.adds) || [];
        const note = said[key] ? { tone: "broken" as const, text: said[key] } : folderRowNote(row, row.id ? folderPluginFailures.get(row.id) : undefined, folder.paused);
        const menu: RowMenuItem[] = row.folder ? [{ label: "Show in Finder", onSelect: () => void showPluginFolder(row.folder) }] : [];
        return (
          <div key={key} className="[&>*+*]:border-t [&>*+*]:border-border/50">
            <ListRow
              title={row.name}
              subtitle={row.about}
              status={note && <Status tone={note.tone}>{note.text.split("\n")[0]}</Status>}
              actions={
                mac ? (
                  <>
                    {row.changed && row.folder && (
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run(key, () => switchPluginOn(row.folder))}>
                        Use the new version
                      </Button>
                    )}
                    {/* the same switch as a pack's row; switching on is answered by the Mac app's own dialog */}
                    {row.id && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{row.on ? "On" : "Off"}</span>
                        <Switch
                          aria-label={`${row.name} on`}
                          checked={row.on}
                          disabled={busy !== null || (!row.on && !row.folder)}
                          onCheckedChange={(on) => void run(key, () => (on ? switchPluginOn(row.folder) : switchPluginOff(row.id!)))}
                        />
                      </div>
                    )}
                    {menu.length > 0 && <RowMenu label={`More for ${row.name}`} items={menu} />}
                  </>
                ) : (
                  row.running && <InUse>On</InUse>
                )
              }
            />
            {adds.length > 0 && <Advanced summary="What it adds">{adds.map((a) => <AddLine key={a.text} add={a} />)}</Advanced>}
          </div>
        );
      })}
    </Card>
  );
}
