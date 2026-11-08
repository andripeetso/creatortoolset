import type { InstalledPack } from "@contracts/packs";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CatalogError, cachedCatalogPack } from "@/lib/pack-catalog";
import type { CatalogDetail } from "@contracts/pack-catalog";
import { msg } from "../settings/helpers";
import { Loading, Notice } from "../settings/ui";
import { CaptionSample } from "./PackPreview";
import { PackActions } from "./PackActions";
import { ContentsSummary, ContentsView, InstallEffects, OfficialBadge } from "./PacksShared";
import { countLabel, kindLine, packKinds } from "./packs-helpers";
const BACK = (
  <Link to="/community/explore" className="-ml-1 text-xs text-muted-foreground hover:text-foreground">
    ← Community
  </Link>
);
/** One pack in Community: its facts, Install or the installed controls, what it adds, its versions. */
export function PackDetailView({ id, installed, reload }: { id: string; installed?: InstalledPack; reload: () => Promise<void> }) {
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    cachedCatalogPack(id)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setError(e instanceof CatalogError && e.reason ? `Pulled from the community: ${e.reason}` : msg(e)));
    return () => {
      live = false;
    };
  }, [id]);
  if (error)
    return (
      <>
        {BACK}
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      </>
    );
  if (!detail) return <Loading />;
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
        <h3 className="text-xs font-medium text-foreground">What installing does</h3>
        <div className="mt-1">
          <InstallEffects pack={pack} />
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
