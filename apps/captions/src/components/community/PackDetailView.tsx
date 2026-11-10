import type { InstalledPack } from "@contracts/packs";
import { Link } from "react-router";
import { forgetCached, useCachedLoad } from "@/lib/local-cache";
import { CatalogError, catalogPack } from "@/lib/pack-catalog";
import type { CatalogDetail } from "@contracts/pack-catalog";
import { msg } from "../settings/helpers";
import { Card, ErrorRow, LoadingRow } from "@/components/settings/ui";
import { CaptionSample } from "./PackPreview";
import { PackActions } from "./PackActions";
import { ContentsSummary, ContentsView, OfficialBadge, WhereItGoes } from "./PacksShared";
import { countLabel, kindLine, packKinds } from "./packs-helpers";
const BACK = (
  <Link to="/community/explore" className="-ml-1 text-xs text-muted-foreground hover:text-foreground">
    ← Community
  </Link>
);
/** One pack in Community: its facts, Install or the installed controls, what it adds, its versions. */
export function PackDetailView({ id, installed, reload }: { id: string; installed?: InstalledPack; reload: () => Promise<void> }) {
  // its saved copy at once, read again when the page opens; a pack the catalog pulled loses its copy, so the reason shows
  const key = `/api/pack-catalog/public/${encodeURIComponent(id)}`;
  const { data: detail, error } = useCachedLoad<CatalogDetail>(key, () =>
    catalogPack(id).catch((e) => {
      if (!(e instanceof CatalogError && e.reason)) throw new Error(msg(e));
      forgetCached(key);
      throw new Error(`Pulled from the community: ${e.reason}`);
    }),
  );
  if (error && !detail)
    return (
      <>
        {BACK}
        <div className="mt-3">
          <Card>
            <ErrorRow title={error} />
          </Card>
        </div>
      </>
    );
  if (!detail) return <Card><LoadingRow /></Card>;
  const { entry, pack, versions } = detail;
  const styles = pack.captionStyles ?? [];
  const kinds = kindLine(packKinds(entry.contains));
  return (
    <>
      {BACK}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold text-foreground">{entry.name}</h2>
        <span className="text-xs text-muted-foreground">v{pack.version}</span>
        {entry.official && <OfficialBadge />}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        by {pack.author} · {pack.license} · {countLabel(entry.installs, "install")}
        {kinds && ` · ${kinds}`}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{pack.description}</p>
      {pack.homepage && (
        <a href={pack.homepage} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs underline">
          Homepage
        </a>
      )}
      <div className="mt-4">
        <PackActions id={id} name={entry.name} installed={installed} latest={entry.version} reload={reload} />
      </div>
      <section className="mt-5">
        <h3 className="text-xs font-medium text-foreground">Where it goes</h3>
        <div className="mt-2">
          <WhereItGoes pack={pack} />
        </div>
      </section>
      <section className="mt-5 rounded-lg border border-border p-4">
        <h3 className="text-xs font-medium text-foreground">What it adds</h3>
        <div className="mt-1 text-xs text-muted-foreground">
          <ContentsSummary pack={pack} />
        </div>
        {styles.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-3 rounded-md bg-zinc-900 p-4">
            {styles.map((st, i) => (
              <CaptionSample key={i} style={st} big />
            ))}
          </div>
        )}
        <div className="mt-3">
          <ContentsView pack={pack} />
        </div>
      </section>
      <section className="mt-5">
        <h3 className="text-xs font-medium text-foreground">Versions</h3>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {versions.map((v) => (
            <li key={v}>
              v{v}
              {v === pack.version && " (latest)"}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
