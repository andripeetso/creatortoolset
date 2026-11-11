import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { installCatalogPack } from "@/lib/pack-catalog";
import { useSetup } from "@/lib/setup";
import { useWorkspace } from "@/lib/workspace";
import { compareVersions, type InstalledPack } from "@contracts/packs";
import { msg } from "../settings/helpers";
import { Card, ListRow, Row, RowMenu, saveFailed } from "@/components/settings/ui";
import { removePack, setPackOn, setPackProjects } from "./packs-api";
import { packProjects } from "./packs-helpers";
import { ProjectsPicker } from "./ProjectsPicker";

/*
 * The controls of one pack, shared by its row in Installed, its row in Discover and its detail page. The stored data:
 * `off` holds "*" when the pack is off everywhere (On) and a project id for each project that switched it off; `projectIds`
 * limits it to some projects (empty = all). Each control writes one of those and nothing else.
 */

/** Runs one change: its message is a toast, a failure is a toast too, and the list reloads after. */
export function usePackRun(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const run = async (job: () => Promise<string | undefined>) => {
    setBusy(true);
    try {
      const said = await job();
      if (said) toast(said);
    } catch (e) {
      saveFailed(msg(e));
    } finally {
      setBusy(false);
      await reload();
    }
  };
  return { busy, run };
}

/** Install a catalog pack for the projects given (none = all of them). */
export function InstallButton({ id, scope = [], reload, size = "xs" }: { id: string; scope?: string[]; reload: () => Promise<void>; size?: "xs" | "sm" }) {
  const { busy, run } = usePackRun(reload);
  return (
    <Button
      size={size}
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
  );
}

/** "Update to 1.0.1" when a newer version is listed for an installed pack, else nothing. */
export function PackUpdateButton({ id, installed, latest, reload }: { id: string; installed: InstalledPack; latest?: string | null; reload: () => Promise<void> }) {
  const { busy, run } = usePackRun(reload);
  if (!latest || compareVersions(latest, installed.version) <= 0) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={busy}
      onClick={() =>
        void run(async () => {
          const r = await installCatalogPack(id, packProjects(installed));
          return `Updated to ${latest}.${r.kept ? ` Kept ${r.kept} you edited.` : ""}`;
        })
      }
    >
      Update to {latest}
    </Button>
  );
}

/** On, everywhere: the switch that turns the pack off for every project (its "*" entry). */
export function PackOnSwitch({ id, name, installed, reload }: { id: string; name: string; installed: InstalledPack; reload: () => Promise<void> }) {
  const { busy, run } = usePackRun(reload);
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span>{installed.off.includes("*") ? "Off" : "On"}</span>
      <Switch
        aria-label={`${name} on`}
        checked={!installed.off.includes("*")}
        disabled={busy}
        onCheckedChange={(on) => void run(() => setPackOn(id, on).then(() => undefined))}
      />
    </div>
  );
}

/** Used in: all of the person's projects, or the ones ticked. */
export function PackUsedIn({ id, installed, reload }: { id: string; installed: InstalledPack; reload: () => Promise<void> }) {
  const { busy, run } = usePackRun(reload);
  return (
    <Row
      title="Used in"
      control={
        <ProjectsPicker
          value={packProjects(installed)}
          disabled={busy}
          onChange={(next) => void run(() => setPackProjects(id, next.length ? next : null).then(() => undefined))}
        />
      }
    />
  );
}

/**
 * On in the current project. Shown only when it can change something: the pack is on everywhere and the current project is
 * one it is used in. Otherwise the row is not there.
 */
export function PackHereSwitch({ id, name, installed, reload }: { id: string; name: string; installed: InstalledPack; reload: () => Promise<void> }) {
  const currentId = useWorkspace((s) => s.currentProjectId);
  const projects = useWorkspace((s) => s.projects);
  const { busy, run } = usePackRun(reload);
  const ids = packProjects(installed);
  if (!currentId || installed.off.includes("*") || (ids.length > 0 && !ids.includes(currentId))) return null;
  const current = projects.find((p) => p.id === currentId)?.name ?? "this project";
  return (
    <Row
      title={`On in ${current}`}
      control={
        <Switch
          aria-label={`${name} on in ${current}`}
          checked={!installed.off.includes(currentId)}
          disabled={busy}
          onCheckedChange={(on) => void run(() => setPackOn(id, on, currentId).then(() => undefined))}
        />
      }
    />
  );
}

/** Whether Home already shows what the pack's layout does: the same tiles switched off, in any order. */
export const homeInUse = (hidden: readonly string[] | undefined, pack: readonly string[]): boolean =>
  !!hidden && hidden.length === pack.length && pack.every((t) => hidden.includes(t));

/**
 * A pack's Home layout: Use on Home sets the account's own switches (Settings → Tools, PUT /api/setup, which takes only
 * the app's own tile ids). Nothing applies it but this press; an install or an update never does.
 */
export function PackHomeRow({ installed }: { installed: InstalledPack }) {
  const hidden = useSetup((s) => s.view?.hidden);
  const save = useSetup((s) => s.save);
  const [busy, setBusy] = useState(false);
  if (!installed.home) return null;
  const layout = installed.home.hidden;
  return (
    <Row
      title="Home layout"
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={busy || homeInUse(hidden, layout)}
          onClick={() => {
            setBusy(true);
            save({ hidden: layout })
              .catch(() => saveFailed("Home did not change. Try again."))
              .finally(() => setBusy(false));
          }}
        >
          {homeInUse(hidden, layout) ? "In use" : "Use on Home"}
        </Button>
      }
    />
  );
}

/** The actions on an installed pack's row: its update (when one is listed), On, and `…` with Remove (confirmed). */
export function InstalledPackActions({ id, name, installed, latest, reload }: { id: string; name: string; installed: InstalledPack; latest?: string | null; reload: () => Promise<void> }) {
  const { run } = usePackRun(reload);
  return (
    <>
      <PackUpdateButton id={id} installed={installed} latest={latest} reload={reload} />
      <PackOnSwitch id={id} name={name} installed={installed} reload={reload} />
      <RowMenu
        label={`More for ${name}`}
        items={[
          {
            label: "Remove",
            destructive: true,
            confirm: {
              title: `Remove ${name}?`,
              body: "Copies you haven't changed are deleted. Copies you edited stay.",
              ok: "Remove",
            },
            onSelect: () =>
              run(async () => {
                const r = await removePack(id);
                return r.kept ? `Removed. Kept ${r.kept} you edited.` : "Removed.";
              }),
          },
        ]}
      />
    </>
  );
}

/** The detail page's controls: Install (with the projects to put it in) before it is installed, the pack's own rows after. */
export function PackActions({ id, name, installed, latest, reload }: { id: string; name: string; installed?: InstalledPack; latest?: string | null; reload: () => Promise<void> }) {
  const [scope, setScope] = useState<string[]>([]);
  if (!installed) {
    return (
      <Card>
        <Row
          title="Used in"
          control={
            <>
              <ProjectsPicker value={scope} onChange={setScope} />
              <InstallButton id={id} scope={scope} reload={reload} size="sm" />
            </>
          }
        />
      </Card>
    );
  }
  return (
    <Card>
      <ListRow
        title={name}
        subtitle={`v${installed.version}`}
        actions={<InstalledPackActions id={id} name={name} installed={installed} latest={latest} reload={reload} />}
      />
      <PackUsedIn id={id} installed={installed} reload={reload} />
      <PackHereSwitch id={id} name={name} installed={installed} reload={reload} />
      <PackHomeRow installed={installed} />
    </Card>
  );
}
