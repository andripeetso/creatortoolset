import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Switch } from "@/components/ui/switch";
import { useWorkspace } from "@/lib/workspace";
import type { InstalledPack } from "@contracts/packs";
import { Card, Loading, Notice } from "./ui";
import { msg } from "./helpers";
import { ContentsSummary, ContentsView } from "./PacksShared";
import { listInstalled, removePack, setPackOn } from "./packs-api";

/** Installed packs: name, contents, on/off here and everywhere, remove. Installing a newer file of the same pack updates it. */
export function PacksInstalled() {
  const currentId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);
  const currentName = projects.find((p) => p.id === currentId)?.name ?? "this project";
  const [packs, setPacks] = useState<InstalledPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => listInstalled().then(setPacks).catch((e) => setError(msg(e))), []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (run: () => Promise<string | void>) => {
    setError(null);
    setNotice(null);
    try {
      const said = await run();
      if (said) setNotice(said);
    } catch (e) {
      setError(msg(e));
    }
    await reload();
  };

  if (!packs) return error ? <Notice tone="error">{error}</Notice> : <Loading />;

  return (
    <>
      {error && <div className="mb-3"><Notice tone="error">{error}</Notice></div>}
      {notice && <div className="mb-3"><Notice>{notice}</Notice></div>}
      {packs.length === 0 ? (
        <Notice>
          No packs yet. <Link to="/settings/packs/file" className="underline">Install a pack file</Link>, or make one from your
          own frameworks and styles in <Link to="/settings/packs/share" className="underline">Share as pack</Link>.
        </Notice>
      ) : (
        <Card>
          {packs.map((p) => (
            <PackRow
              key={p.id}
              pack={p}
              currentId={currentId}
              currentName={currentName}
              onRemove={() =>
                act(async () => {
                  const r = await removePack(p.id);
                  return r.kept ? `Removed. Kept ${r.kept} you edited.` : "Removed.";
                })
              }
              onSwitch={(on, projectId) => act(() => setPackOn(p.id, on, projectId).then(() => undefined))}
            />
          ))}
        </Card>
      )}
    </>
  );
}

function PackRow({
  pack: p,
  currentId,
  currentName,
  onRemove,
  onSwitch,
}: {
  pack: InstalledPack;
  currentId: string | null;
  currentName: string;
  onRemove: () => void;
  onSwitch: (on: boolean, projectId?: string) => void;
}) {
  // a pack scoped to one project only has a switch there
  const showHere = !!currentId && (!p.projectId || p.projectId === currentId);
  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{p.name}</span>
        <span className="text-xs text-muted-foreground">v{p.version}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        by {p.author} · {p.license}
        {p.projectId && " · this project only"}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
      <div className="mt-1 text-xs text-muted-foreground">
        Adds: <ContentsSummary pack={p} />
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground underline">What it adds</summary>
        <div className="mt-2">
          <ContentsView pack={p} />
        </div>
      </details>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Switch checked={!p.off.includes("*")} onCheckedChange={(on) => onSwitch(on)} aria-label={`${p.name} on everywhere`} />
          On everywhere
        </label>
        {showHere && (
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Switch
              checked={!p.off.includes(currentId!)}
              onCheckedChange={(on) => onSwitch(on, currentId!)}
              aria-label={`${p.name} on in ${currentName}`}
            />
            On in {currentName}
          </label>
        )}
        <ConfirmButton label="Remove" confirmLabel="Click again to remove" onConfirm={onRemove} className="ml-auto text-xs text-red-600 underline dark:text-red-300" />
      </div>
    </div>
  );
}
