import { Link } from "react-router";
import type { CatalogEntry, UpdateRow } from "@contracts/pack-catalog";
import type { InstalledPack } from "@contracts/packs";
import { Card, EmptyRow, ListRow, Section } from "@/components/settings/ui";
import type { HomeTile } from "@contracts/tools";
import { PACK_KINDS, firstSentence, kindsFor, packKinds, reachesTool, type KindId } from "./packs-helpers";
import { OfficialBadge } from "./PacksShared";
import { InstallButton, InstalledPackActions } from "./PackActions";

export interface CatalogProps {
  entries: CatalogEntry[];
  installed: InstalledPack[];
  updates: UpdateRow[];
  /** The search box's text; matched on name, description, author and niche. */
  q: string;
  reload: () => Promise<void>;
}

function matching(entries: CatalogEntry[], q: string): CatalogEntry[] {
  const s = q.trim().toLowerCase();
  if (!s) return entries;
  return entries.filter((e) => [e.name, e.description, e.author, e.niche ?? ""].some((v) => v.toLowerCase().includes(s)));
}

/** Explore: the team's packs first, then everyone's. */
export function ExploreView({ entries, installed, updates, q, reload }: CatalogProps) {
  const shown = matching(entries, q);
  const official = shown.filter((e) => e.official);
  const community = shown.filter((e) => !e.official);
  return (
    <>
      {official.length > 0 && (
        <Section title="Official packs">
          <PackList entries={official} installed={installed} updates={updates} reload={reload} empty="" />
        </Section>
      )}
      <Section title="Community packs">
        <PackList entries={community} installed={installed} updates={updates} reload={reload} empty={q ? "No packs found" : "No packs"} />
      </Section>
    </>
  );
}

/** One section: the packs that work in that place. */
export function KindView({ kind, entries, installed, updates, q, reload }: CatalogProps & { kind: KindId }) {
  const shown = matching(entries, q).filter((e) => packKinds(e.contains).some((k) => k.id === kind));
  return (
    <Section title={PACK_KINDS[kind]}>
      <PackList entries={shown} installed={installed} updates={updates} reload={reload} empty={q ? "No packs found" : "No packs"} />
    </Section>
  );
}

/** A tool's packs: the ones that reach it, each row saying what kind of thing it adds there. */
export function ToolView({ tool, entries, installed, updates, q, reload }: CatalogProps & { tool: HomeTile }) {
  const shown = matching(entries, q).filter((e) => reachesTool(e.contains, tool));
  return (
    <Section title="Packs">
      <PackList entries={shown} installed={installed} updates={updates} reload={reload} tool={tool} empty={q ? "No packs found" : "No packs"} />
    </Section>
  );
}

function PackList({ entries, installed, updates, reload, empty, tool }: Omit<CatalogProps, "q"> & { entries: CatalogEntry[]; empty: string; tool?: HomeTile }) {
  if (entries.length === 0) return empty ? <Card><EmptyRow title={empty} /></Card> : null;
  return (
    <Card>
      {entries.map((e) => {
        const mine = installed.find((p) => p.id === e.id);
        return <CatalogRow key={e.id} entry={e} installed={mine} latest={updates.find((u) => u.id === e.id)?.latest} reload={reload} tool={tool} />;
      })}
    </Card>
  );
}

/** A pack in Discover: the same row as in Installed (update, On, `…` Remove), or Install before it is installed. */
function CatalogRow({ entry, installed, latest, reload, tool }: { entry: CatalogEntry; installed?: InstalledPack; latest?: string | null; reload: () => Promise<void>; tool?: HomeTile }) {
  // in a tool's section, what kind of thing it adds there: "Writing frameworks, Writing guides · by Tiny"
  const kinds = tool ? kindsFor(entry.contains, tool).map((k) => k.label).join(", ") : "";
  return (
    <ListRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Link to={`/community/pack/${entry.id}`} className="truncate underline-offset-2 hover:underline">
            {entry.name}
          </Link>
          {entry.official && <OfficialBadge />}
        </span>
      }
      subtitle={kinds ? `${kinds} · by ${entry.author}` : `by ${entry.author}`}
      status={firstSentence(entry.description)}
      actions={installed ? <InstalledPackActions id={entry.id} name={entry.name} installed={installed} latest={latest} reload={reload} /> : <InstallButton id={entry.id} reload={reload} />}
    />
  );
}
