import { useState } from "react";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { installCatalogPack } from "@/lib/pack-catalog";
import { useWorkspace } from "@/lib/workspace";
import { compareVersions, type InstalledPack } from "@contracts/packs";
import { msg } from "../settings/helpers";
import { Notice } from "../settings/ui";
import { removePack, setPackOn, setPackProjects } from "./packs-api";
import { packProjects } from "./packs-helpers";
import { ProjectsPicker } from "./ProjectsPicker";
/**
 * What you can do with one pack. Not installed: install it for the projects picked. Installed: the on/off switches,
 * the projects it's in, update when a newer version is listed, remove (after a second click).
 */
export function PackActions({
  id,
  name,
  installed,
  latest,
  reload,
}: {
  id: string;
  name: string;
  installed?: InstalledPack;
  /** The newest approved version, when known. */
  latest?: string | null;
  reload: () => Promise<void>;
}) {
  const currentId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);
  const currentName = projects.find((p) => p.id === currentId)?.name ?? "this project";
  const [scope, setScope] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (job: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const said = await job();
      if (said) setNotice(said);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
      await reload();
    }
  };
  const feedback = (
    <>
      {notice && <div className="mt-2"><Notice>{notice}</Notice></div>}
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
    </>
  );
  if (!installed) {
    return (
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <ProjectsPicker value={scope} onChange={setScope} disabled={busy} />
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await installCatalogPack(id, scope);
                return `Installed.${r.kept ? ` Kept ${r.kept} you edited.` : ""}`;
              })
            }
          >
            {busy ? "Installing…" : "Install"}
          </Button>
        </div>
        {feedback}
      </div>
    );
  }
  const ids = packProjects(installed);
  const hasUpdate = !!latest && compareVersions(latest, installed.version) > 0;
  const showHere = !!currentId && (ids.length === 0 || ids.includes(currentId));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Switch
            checked={!installed.off.includes("*")}
            disabled={busy}
            onCheckedChange={(on) => void run(() => setPackOn(id, on).then(() => undefined))}
            aria-label={`${name} on everywhere`}
          />
          On everywhere
        </label>
        {currentId && showHere && (
          <label className="flex items-center gap-2 text-xs text-foreground">
            <Switch
              checked={!installed.off.includes(currentId)}
              disabled={busy}
              onCheckedChange={(on) => void run(() => setPackOn(id, on, currentId).then(() => undefined))}
              aria-label={`${name} on in ${currentName}`}
            />
            On in {currentName}
          </label>
        )}
        <ProjectsPicker
          value={ids}
          disabled={busy}
          onChange={(next) => void run(() => setPackProjects(id, next.length ? next : null).then(() => undefined))}
        />
        {hasUpdate && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await installCatalogPack(id, ids);
                return `Updated to ${latest}.${r.kept ? ` Kept ${r.kept} you edited.` : ""}`;
              })
            }
          >
            Update to {latest}
          </Button>
        )}
        <ConfirmButton
          label="Remove"
          confirmLabel="Click again to remove"
          disabled={busy}
          onConfirm={() =>
            void run(async () => {
              const r = await removePack(id);
              return r.kept ? `Removed. Kept ${r.kept} you edited.` : "Removed.";
            })
          }
          className="text-xs text-red-600 underline dark:text-red-300"
        />
      </div>
      {feedback}
    </div>
  );
}
