import type { InstalledPack } from "@contracts/packs";
import { Link } from "react-router";
import type { UpdateRow } from "@contracts/pack-catalog";
import { Advanced, Card, EmptyRow, ErrorRow, ListRow, LoadingRow, Row, Section, Status } from "@/components/settings/ui";
import type { PluginInfo } from "@/lib/plugin";
import { ContentsView } from "./PacksShared";
import { firstSentence, packContents } from "./packs-helpers";
import { InstalledPackActions, PackHereSwitch, PackUsedIn } from "./PackActions";
import { FolderPluginRows, PluginRows, type FolderPlugins } from "./PluginsInstalled";

/**
 * Installed: the plug-ins (the ones this server is built with, and on the Mac app's own server the ones in the person's
 * plug-ins folder, each with its switch), then the packs the person has
 * switched on. Each pack is one row: its name, who made it, one line, the On switch and `…` (Remove). "What it adds" folds.
 */
export function InstalledView({
  plugins,
  folderPlugins,
  installed,
  updates,
  reload,
  error,
}: {
  plugins: PluginInfo[];
  folderPlugins: FolderPlugins | null;
  installed: InstalledPack[] | null;
  updates: UpdateRow[];
  reload: () => Promise<void>;
  error: string | null;
}) {
  // a plug-in from the person's folder has its own row (with its switch); the rest are built into this server
  const fromFolder = folderPlugins?.rows ?? [];
  const builtIn = plugins.filter((p) => !fromFolder.some((r) => r.id === p.id));
  return (
    <>
      {(builtIn.length > 0 || fromFolder.length > 0) && (
        <Section title="Plug-ins">
          {builtIn.length > 0 && <PluginRows plugins={builtIn} />}
          {folderPlugins && fromFolder.length > 0 && <FolderPluginRows folder={folderPlugins} plugins={plugins} />}
        </Section>
      )}
      <Section title="Packs">
        {!installed ? (
          <Card>{error ? <ErrorRow title="Your packs did not load" detail={error} retry={reload} /> : <LoadingRow />}</Card>
        ) : installed.length === 0 ? (
          <Card>
            <EmptyRow title="No packs yet" description="Packs add writing frameworks, caption styles and guides to your tools. Explore has what people have made." />
          </Card>
        ) : (
          <Card>
            {installed.map((p) => (
              <div key={p.id} className="[&>*+*]:border-t [&>*+*]:border-border/50">
                <PackRow pack={p} latest={updates.find((u) => u.id === p.id)?.latest} reload={reload} />
              </div>
            ))}
          </Card>
        )}
      </Section>
    </>
  );
}

function PackRow({ pack: p, latest, reload }: { pack: InstalledPack; latest?: string | null; reload: () => Promise<void> }) {
  const contents = packContents(p);
  const hasContents = contents.slots.length + contents.frameworks.length + contents.captionStyles.length > 0;
  const heldDesign = p.held?.designSystems;
  return (
    <>
      <ListRow
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{p.name}</span>
            <span className="shrink-0 text-xs font-normal text-muted-foreground">v{p.version}</span>
          </span>
        }
        subtitle={`by ${p.author}`}
        status={
          p.delisted ? <Status tone="broken">Pulled from the community: {p.delisted}. Its instructions are off.</Status> : firstSentence(p.description)
        }
        actions={<InstalledPackActions id={p.id} name={p.name} installed={p} latest={latest} reload={reload} />}
      />
      <Advanced summary="What it adds">
        {!p.delisted && p.description.trim() !== firstSentence(p.description) && (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">{p.description.trim()}</p>
        )}
        <PackUsedIn id={p.id} installed={p} reload={reload} />
        <PackHereSwitch id={p.id} name={p.name} installed={p} reload={reload} />
        {p.default && p.off.includes("*") && <Row title="Off for you: you had your own setup before packs." />}
        {heldDesign && (
          <Row
            title={`${heldDesign.items.length} design ${heldDesign.items.length === 1 ? "system" : "systems"} kept with this pack`}
            status={<Status tone="attention">{heldDesign.needs === "plug-in" ? "Needs a plug-in on this server to install." : "Needs an admin to install."}</Status>}
          />
        )}
        {hasContents && (
          <div className="px-3 py-3 sm:px-4">
            <ContentsView pack={p} />
          </div>
        )}
        <Row title="Where it goes, versions" control={<Link to={`/community/pack/${p.id}`} className="text-xs text-foreground underline-offset-2 hover:underline">Open pack</Link>} />
      </Advanced>
    </>
  );
}
