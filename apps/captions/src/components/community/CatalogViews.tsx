import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { CatalogDetail, CatalogEntry, UpdateRow } from "@contracts/pack-catalog";
import { compareVersions, type InstalledPack } from "@contracts/packs";
import { cachedCatalogPack } from "@/lib/pack-catalog";
import { Notice } from "../settings/ui";
import { countLabel, kindLine, PACK_KINDS, packKinds, toolLine, type KindId } from "./packs-helpers";
import { PackPreview } from "./PackPreview";
import { OfficialBadge } from "./PacksShared";
export interface CatalogProps {
  entries: CatalogEntry[];
  installed: InstalledPack[];
  updates: UpdateRow[];
  /** The search box's text; matched on name, description, author and niche. */
  q: string;
}
function matching(entries: CatalogEntry[], q: string): CatalogEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return entries;
  return entries.filter((e) => [e.name, e.description, e.author, e.niche ?? ""].some((v) => v.toLowerCase().includes(s)));
}
/** Explore: the team's packs first, then everyone's. */
export function ExploreView({ entries, installed, updates, q }: CatalogProps) {
  const shown = matching(entries, q);
  const official = shown.filter((e) => e.official);
  const community = shown.filter((e) => !e.official);
  const none = q ? "Nothing matches." : "Nobody has published anything yet.";
  return (
    <div className="space-y-8">
      {official.length > 0 && (
        <Section title="From the Creator Toolset team">
          <Grid entries={official} installed={installed} updates={updates} />
        </Section>
      )}
      <Section title="From the community">
        {community.length > 0 ? <Grid entries={community} installed={installed} updates={updates} /> : <Notice>{none}</Notice>}
      </Section>
    </div>
  );
}
/** One section: the packs that work in that place. */
export function KindView({ kind, entries, installed, updates, q }: CatalogProps & { kind: KindId }) {
  const shown = matching(entries, q).filter((e) => packKinds(e.contains).some((k) => k.id === kind));
  return (
    <Section title={PACK_KINDS[kind]}>
      {shown.length > 0 ? (
        <Grid entries={shown} installed={installed} updates={updates} />
      ) : (
        <Notice>{q ? "Nothing matches." : "Nothing here yet."}</Notice>
      )}
    </Section>
  );
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}
function Grid({ entries, installed, updates }: { entries: CatalogEntry[]; installed: InstalledPack[]; updates: UpdateRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map((e) => {
        const mine = installed.find((p) => p.id === e.id);
        return <PackCard key={e.id} entry={e} installed={mine} latest={updates.find((u) => u.id === e.id)?.latest} />;
      })}
    </div>
  );
}
function PackCard({ entry, installed, latest }: { entry: CatalogEntry; installed?: InstalledPack; latest?: string | null }) {
  const [preview, setPreview] = useState<CatalogDetail | null>(null);
  useEffect(() => {
    let live = true;
    cachedCatalogPack(entry.id)
      .then((d) => live && setPreview(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [entry.id]);
  return (
    <Link
      to={`/community/pack/${entry.id}`}
      className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border transition-colors hover:bg-accent/40"
    >
      <div className="h-32 overflow-hidden border-b border-border bg-muted/30">
        {preview ? <PackPreview pack={preview.pack} /> : <div className="h-full animate-pulse bg-muted/50" />}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
          {entry.official && <OfficialBadge />}
        </div>
        <span className="text-[11px] text-muted-foreground">{kindLine(packKinds(entry.contains))}</span>
        <span className="text-[11px] text-muted-foreground">{toolLine(entry.contains)}</span>
        <span className="text-xs text-muted-foreground">by {entry.author}</span>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-[11px]">
          <span className="text-muted-foreground">{countLabel(entry.installs, "install")}</span>
          <CardState installed={!!installed} update={installed && latest && compareVersions(latest, installed.version) > 0 ? latest : null} />
        </div>
      </div>
    </Link>
  );
}
function CardState({ installed, update }: { installed: boolean; update: string | null }) {
  if (update) return <span className="font-medium text-amber-700 dark:text-amber-300">Update to {update}</span>;
  if (installed) return <span className="font-medium text-emerald-700 dark:text-emerald-300">Installed</span>;
  return <span className="font-medium text-violet-700 dark:text-violet-300">Install</span>;
}
