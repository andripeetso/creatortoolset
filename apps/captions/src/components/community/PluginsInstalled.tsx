import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Advanced, Card, InUse, ListRow, RowMenu, Status, type RowMenuItem } from "@/components/settings/ui";
import { folderPluginFailures, folderRowNote, offersNewVersion, type FolderPlugins } from "@/lib/folder-plugins";
import type { PluginAdd, PluginInfo } from "@/lib/plugin";
import { pluginsAuto, resumePlugins, setPluginsAuto, showPluginFolder, switchPluginOff, switchPluginOn, thisMacBridge, type PluginReply, type PluginsAuto } from "@/lib/thisMac";

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
 * answered by the Mac app in its own dialog. A plug-in that is on takes up the changes to its folder by itself (the Mac
 * app does it, once the server has nothing running); the last row, Update automatically, switches that off for all of
 * them, and a changed folder then waits for Use the new version while the copy that is on keeps running.
 * A plug-in that could not load says why in red. The switches exist only in the Mac app on the Mac that runs the
 * server; in a browser the rows are read-only. After a switch the Mac app restarts its server and reloads this window.
 */
export function FolderPluginRows({ folder, plugins }: { folder: FolderPlugins; plugins: PluginInfo[] }) {
  const mac = !!thisMacBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<Record<string, string>>({});
  // Update automatically, as the Mac app keeps it (null in a browser, and until it answers)
  const [auto, setAuto] = useState<PluginsAuto | null>(null);
  useEffect(() => {
    let live = true;
    void pluginsAuto().then((a) => live && setAuto(a));
    return () => {
      live = false;
    };
  }, []);
  const run = async (key: string, ask: () => Promise<PluginReply | null>, reloads = true) => {
    setBusy(key);
    const reply = await ask();
    // a yes is followed by the app's own reload (the one switch for all of them reloads nothing); anything else gives the row back
    if (!reply?.ok || !reloads) setBusy(null);
    if (!reloads) setAuto(await pluginsAuto());
    setSaid((s) => ({ ...s, [key]: reply && !reply.ok && reply.problem ? reply.problem : "" }));
  };
  return (
    <Card>
      {folder.paused && (
        <ListRow
          title="Plug-ins are off"
          // only when that is why: Switch All Off in This Mac pauses them too, and then nothing stopped
          status={auto?.crashed && <Status tone="attention">The app's server stopped five times with them on</Status>}
          actions={mac && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => run("resume", resumePlugins)}>Switch back on</Button>}
        />
      )}
      {folder.rows.map((row) => {
        const key = row.folder || row.id!;
        const adds = (row.running && plugins.find((p) => p.id === row.id)?.adds) || [];
        // by itself only for the folder it was switched on from: a renamed folder's change waits for the click
        const rowAuto = auto?.auto && row.id && auto.folders[row.id] === row.folder ? { waiting: auto.waiting.includes(row.id), note: auto.notes[row.id] } : undefined;
        const note = said[key] ? { tone: "broken" as const, text: said[key] } : folderRowNote(row, row.id ? folderPluginFailures.get(row.id) : undefined, folder.paused, rowAuto);
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
                    {offersNewVersion(row, rowAuto) && (
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
      {auto && (
        <ListRow
          title="Update automatically"
          subtitle="A plug-in that is on runs later changes to its folder by itself."
          status={said.auto && <Status tone="broken">{said.auto}</Status>}
          actions={
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{auto.auto ? "On" : "Off"}</span>
              <Switch aria-label="Update automatically" checked={auto.auto} disabled={busy !== null} onCheckedChange={(on) => void run("auto", () => setPluginsAuto(on), false)} />
            </div>
          }
        />
      )}
    </Card>
  );
}
