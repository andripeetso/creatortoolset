import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useWorkspace } from "@/lib/workspace";
import { compareVersions, type InstalledPack } from "@contracts/packs";
import { Card, Loading, Notice } from "./ui";
import { msg } from "./helpers";
import { ContentsSummary, ContentsView } from "./PacksShared";
import { catalogUpdates, installCatalogPack, listInstalled, removePack, setPackOn } from "./packs-api";

/** Installed packs: name, contents, on/off here and everywhere, update from the community catalog, remove. */
export function PacksInstalled() {
  const currentId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);
  const currentName = projects.find((p) => p.id === currentId)?.name ?? "this project";
  const [packs, setPacks] = useState<InstalledPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [latest, setLatest] = useState<Record<string, string>>({});

  const reload = useCallback(() => listInstalled().then(setPacks).catch((e) => setError(msg(e))), []);
  useEffect(() => {
    void reload();
    // best effort: the catalog also marks delisted packs, so the list refreshes once it answers
    void catalogUpdates()
      .then((us) => setLatest(Object.fromEntries(us.filter((u) => u.latest).map((u) => [u.id, u.latest as string]))))
      .catch(() => setLatest({}))
      .then(reload);
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
          No packs yet. <Link to="/settings/packs/browse" className="underline">Browse the community</Link>,{" "}
          <Link to="/settings/packs/file" className="underline">install a pack file</Link>, or make one from your own
          frameworks and styles in <Link to="/settings/packs/share" className="underline">Share as pack</Link>.
        </Notice>
      ) : (
        <Card>
          {packs.map((p) => (
            <PackRow
              key={p.id}
              pack={p}
              currentId={currentId}
              currentName={currentName}
              latest={latest[p.id]}
              onUpdate={(version) =>
                act(async () => {
                  const r = await installCatalogPack(p.id, p.projectId);
                  return `Updated to ${version}.${r.kept ? ` Kept ${r.kept} you edited.` : ""}`;
                })
              }
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
  latest,
  onUpdate,
  onRemove,
  onSwitch,
}: {
  pack: InstalledPack;
  currentId: string | null;
  currentName: string;
  latest?: string;
  onUpdate: (version: string) => void;
  onRemove: () => void;
  onSwitch: (on: boolean, projectId?: string) => void;
}) {
  // a pack scoped to one project only has a switch there
  const showHere = !!currentId && (!p.projectId || p.projectId === currentId);
  const hasUpdate = !!latest && compareVersions(latest, p.version) > 0;
  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{p.name}</span>
        <span className="text-xs text-muted-foreground">v{p.version}</span>
        {p.default && (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Default</span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">
        by {p.author} · {p.license}
        {p.projectId && " · this project only"}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
      {p.default && (
        <p className="mt-1 text-xs text-muted-foreground">
          {p.off.includes("*")
            ? "The team's starting pack. It's off for your account because you had your own setup before packs; switch it on to try it."
            : "The team's starting pack, on for you now. Switch it off or remove it to use a community pack instead."}
        </p>
      )}
      <div className="mt-1 text-xs text-muted-foreground">
        Adds: <ContentsSummary pack={p} />
      </div>

      {p.delisted && (
        <div className="mt-2">
          <Notice tone="error">Pulled from the community catalog: {p.delisted}. Its instructions are off.</Notice>
        </div>
      )}

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
        {hasUpdate && (
          <Button size="sm" variant="outline" onClick={() => onUpdate(latest!)}>
            Update to {latest}
          </Button>
        )}
        <ConfirmButton label="Remove" confirmLabel="Click again to remove" onConfirm={onRemove} className="ml-auto text-xs text-red-600 underline dark:text-red-300" />
      </div>
    </div>
  );
}
