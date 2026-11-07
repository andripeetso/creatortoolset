import { useEffect, useState } from "react";
import { PACK_SLOTS } from "@contracts/packs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/lib/workspace";
import { Loading, Notice } from "./ui";
import { msg, selectCls } from "./helpers";
import { ContentsSummary, ContentsView, ScopeSelect } from "./PacksShared";
import { USED_SLOTS } from "./packs-helpers";
import { getCatalogPack, installCatalogPack, listCatalog, type CatalogEntry } from "./packs-api";

const installs = (n: number) => `${n} ${n === 1 ? "install" : "installs"}`;
const OfficialBadge = () => (
  <span className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">Official</span>
);

/** Browse the community catalog: search, slot filter, cards; a card opens its detail with what it adds and Install. */
export function PacksBrowse() {
  const [q, setQ] = useState("");
  const [slot, setSlot] = useState("");
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // a short wait so typing doesn't ask the server on every key
    const t = window.setTimeout(() => {
      listCatalog(q, slot)
        .then((r) => live && (setEntries(r), setError(null)))
        .catch((e) => live && setError(msg(e)));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, slot]);

  if (open) return <PackDetail id={open} onBack={() => setOpen(null)} />;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search packs" aria-label="Search packs" className="min-w-0 flex-1 text-xs" />
        <select value={slot} onChange={(e) => setSlot(e.target.value)} className={selectCls} aria-label="Where it applies">
          <option value="">Any place</option>
          {USED_SLOTS.map((s) => (
            <option key={s} value={s}>
              {PACK_SLOTS[s]}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      {!entries && !error && <Loading />}
      {entries && entries.length === 0 && <div className="mt-3"><Notice>No packs match.</Notice></div>}
      {entries && entries.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              onClick={() => setOpen(e.id)}
              className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent/50"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">{e.name}</span>
                {e.official && <OfficialBadge />}
              </span>
              <span className="text-xs text-muted-foreground">
                v{e.version} · by {e.author} · {e.license}
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{e.description}</span>
              <span className="mt-auto pt-1 text-xs text-muted-foreground">
                {installs(e.installs ?? 0)}
                {e.niche && ` · ${e.niche}`}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function PackDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const currentId = useWorkspace((s) => s.currentProjectId);
  const [data, setData] = useState<Awaited<ReturnType<typeof getCatalogPack>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "project">("all");
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    getCatalogPack(id)
      .then((r) => live && setData(r))
      .catch((e) => live && setError(msg(e)));
    return () => {
      live = false;
    };
  }, [id]);

  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await installCatalogPack(id, scope === "project" ? (currentId ?? undefined) : undefined);
      setDone(`Installed.${r.kept ? ` Kept ${r.kept} you edited.` : ""}`);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-2 text-xs">
        ← All packs
      </Button>
      {error && <div className="mb-3"><Notice tone="error">{error}</Notice></div>}
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium text-foreground">{data.entry.name}</span>
            <span className="text-xs text-muted-foreground">v{data.pack.version}</span>
            {data.entry.official && <OfficialBadge />}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            by {data.pack.author} · {data.pack.license} · {installs(data.entry.installs ?? 0)}
            {data.versions.length > 1 && ` · versions ${data.versions.join(", ")}`}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{data.pack.description}</p>
          {data.pack.homepage && (
            <a href={data.pack.homepage} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs underline">
              Homepage
            </a>
          )}

          <div className="mt-4 rounded-lg border border-border p-3">
            <div className="text-xs font-medium text-foreground">What it adds</div>
            <div className="mt-1 text-xs text-muted-foreground">
              <ContentsSummary pack={data.pack} />
            </div>
            <div className="mt-3">
              <ContentsView pack={data.pack} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ScopeSelect value={scope} onChange={setScope} disabled={busy || !!done} />
            <Button size="sm" onClick={() => void install()} disabled={busy || !!done}>
              {busy ? "Installing…" : "Install"}
            </Button>
          </div>
          {done && <div className="mt-3"><Notice>{done}</Notice></div>}
        </>
      )}
    </>
  );
}
