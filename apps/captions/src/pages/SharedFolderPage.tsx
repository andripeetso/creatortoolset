import { Fragment, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ChevronRight, Folder, Video } from "lucide-react";
import type { SharedFolder } from "@contracts/folders";
import { AppBar } from "@/components/AppBar";
import { FolderCard, FolderRow } from "@/components/browse/Folder";
import { FolderGrid, ItemCard } from "@/components/browse/Grid";
import { ViewSwitch, type BrowseView } from "@/components/browse/Bar";
import { ShareThemeSwitch } from "@/components/ShareTheme";
import { Picture } from "@/components/Picture";
import { thumbClipUrl } from "@/lib/clips";
import { timeAgo } from "@/lib/exports";
import { fmtMmSs } from "@/lib/instagram-markdown";
import { useAuth } from "@/lib/auth";

/**
 * A shared Video Notes folder (/clips/f/:token), no account needed: its clips and the folders inside it, read-only. A
 * folder inside opens here with `?f=`; a clip opens on its own page (/clips/<id>), which is public already.
 */
export default function SharedFolderPage() {
  const { token = "" } = useParams();
  const [params] = useSearchParams();
  const sub = params.get("f");
  const me = useAuth((s) => s.me);
  const [view, setView] = useState<BrowseView>("grid");
  const [data, setData] = useState<SharedFolder | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let live = true;
    setGone(false);
    fetch(`/api/clips/f/${token}${sub ? `?f=${encodeURIComponent(sub)}` : ""}`)
      .then((r) => (r.ok ? (r.json() as Promise<SharedFolder>) : null))
      .then((v) => live && (v ? setData(v) : setGone(true)))
      .catch(() => live && setGone(true));
    return () => {
      live = false;
    };
  }, [token, sub]);

  const to = (fid: string | null) => `/clips/f/${token}${fid && fid !== data?.trail[0]?.id ? `?f=${fid}` : ""}`;
  const here = data?.trail.at(-1);
  const empty = data && !data.folders.length && !data.items.length;

  return (
    <div className="relative flex min-h-screen flex-col items-center bg-background pb-10 text-foreground [--bar-bg:hsl(var(--background))]">
      <AppBar tool="Video Notes" account={!!me} className="mb-6">
        <ShareThemeSwitch />
      </AppBar>
      <main className="mx-auto w-[960px] max-w-[92vw]">
        {gone ? (
          <p className="py-24 text-center text-sm text-zinc-500">This link is off, or was never real.</p>
        ) : !data ? (
          <div aria-hidden="true" className="min-h-dvh" /> // no spinner: the page paints when its list arrives
        ) : (
          <>
            <header className="mb-5 flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-400">
                <Folder className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-lg font-semibold">{here?.name ?? data.name}</h1>
                <p className="text-xs text-zinc-500">
                  {data.items.length} {data.items.length === 1 ? "clip" : "clips"}
                  {data.folders.length > 0 && <> · {data.folders.length} {data.folders.length === 1 ? "folder" : "folders"}</>}
                  {" · shared with you"}
                </p>
              </div>
              {!empty && <ViewSwitch view={view} onChange={setView} />}
            </header>
            {data.trail.length > 1 && (
              <nav aria-label="Folder" className="mb-4 flex min-w-0 flex-wrap items-center gap-1 text-sm">
                {data.trail.slice(0, -1).map((f) => (
                  <Fragment key={f.id}>
                    <Link to={to(f.id)} className="truncate rounded px-1 text-zinc-500 hover:text-zinc-200">
                      {f.name}
                    </Link>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                  </Fragment>
                ))}
                <span className="truncate px-1 font-medium text-zinc-200">{here?.name}</span>
              </nav>
            )}
            {empty && <p className="rounded-lg border border-dashed border-zinc-800 py-16 text-center text-sm text-zinc-500">Nothing in this folder yet.</p>}
            {view === "grid" ? (
              <FolderGrid size="small">
                {data.folders.map((f) => (
                  <FolderCard key={f.id} name={f.name} to={to(f.id)} meta={f.count} covers={f.pictures.map((id) => ({ src: thumbClipUrl(id) }))} />
                ))}
                {data.items.map((c) => (
                  <ItemCard
                    key={c.id}
                    to={`/clips/${c.id}`}
                    picture={c.hasThumb ? thumbClipUrl(c.id) : undefined}
                    icon={Video}
                    name={c.name}
                    meta={timeAgo(c.createdAt)}
                    corner={c.duration > 0 ? fmtMmSs(c.duration) : undefined}
                  />
                ))}
              </FolderGrid>
            ) : (
              <div className="flex flex-col gap-1.5">
                {data.folders.map((f) => (
                  <FolderRow key={f.id} name={f.name} to={to(f.id)} meta={f.count} />
                ))}
                {data.items.map((c) => (
                  <Link
                    key={c.id}
                    to={`/clips/${c.id}`}
                    className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5 transition-colors hover:border-violet-500/50 hover:bg-zinc-900"
                  >
                    <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-800">
                      {c.hasThumb ? <Picture src={thumbClipUrl(c.id)} alt="" className="h-full w-full object-cover" /> : <Video className="h-4 w-4 text-zinc-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-zinc-200">{c.name}</p>
                      <p className="text-[11px] text-zinc-500">
                        {timeAgo(c.createdAt)}
                        {c.duration > 0 && <> · {fmtMmSs(c.duration)}</>}
                      </p>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
