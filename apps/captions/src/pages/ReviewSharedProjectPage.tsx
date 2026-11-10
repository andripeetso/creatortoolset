import { Link, useParams } from "react-router";
import { HomeLink } from "@/components/HomeLink";
import { Picture } from "@/components/Picture";
import { Folder, Layers } from "lucide-react";
import { useCachedLoad } from "@/lib/local-cache";
import { APPROVAL, getSharedProject, thumbUrl, timecode, type ReviewAsset } from "@/lib/review";
import { cn } from "@/lib/utils";

/** A project's share link (/rp/:ptoken): every video in it, for reviewers
 *  without an account. Each opens in the normal review screen. */
export default function ReviewSharedProjectPage() {
  const { ptoken = "" } = useParams();
  // signed in (the owner checking their link), the saved copy paints at once; a reviewer's page fetches it
  const { data, error } = useCachedLoad<{ name: string; assets: ReviewAsset[] }>(`/api/review/p/${ptoken}`, () =>
    getSharedProject(ptoken),
  );

  if (!data && error) {
    return (
      <div className="flex h-dvh items-center justify-center bg-zinc-950 px-6 text-center text-sm text-zinc-400">
        <p>
          This review link is off or doesn't exist.
          <br />
          <Link to="/" className="mt-3 inline-block text-violet-400 hover:underline">
            Creator Toolset
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-200">
      <header data-titlebar className="flex h-14 items-center gap-3 px-3 sm:px-4">
        <HomeLink />
        <Folder className="h-5 w-5 shrink-0 text-violet-400" />
        <h1 className="truncate text-lg font-semibold tracking-tight">{data?.name}</h1>
        <p className="hidden text-sm text-zinc-500 sm:block">Open a video to comment on the exact frame.</p>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        {data?.assets.length === 0 && <p className="mt-16 text-center text-sm text-zinc-500">No videos here yet.</p>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {!data &&
            [0, 1, 2].map((i) => (
              <div key={i} aria-hidden="true" className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
                <div className="aspect-video bg-black" />
                <div className="h-16" />
              </div>
            ))}
          {data?.assets.map((a) => {
            const v = a.versions.at(-1);
            return (
              <Link
                key={a.id}
                to={`/rp/${ptoken}/${a.id}`}
                className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50 transition-colors hover:border-violet-500/60"
              >
                <div className="relative aspect-video bg-black">
                  {v?.status === "ready" && (
                    <Picture src={thumbUrl(a, `/api/review/p/${ptoken}/a/${a.id}`)} alt="" className="h-full w-full object-contain" />
                  )}
                  {a.versions.length > 1 && (
                    <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium">
                      <Layers className="h-3 w-3" /> V{v?.n}
                    </span>
                  )}
                  {v && v.duration > 0 && (
                    <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums">
                      {timecode(v.duration, 0)}
                    </span>
                  )}
                </div>
                <div className="px-3.5 py-3">
                  <p className="truncate text-sm font-medium text-zinc-100">{a.name}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                    <span className={cn("h-2 w-2 rounded-full", APPROVAL[a.approval.status].dot)} />
                    {APPROVAL[a.approval.status].label}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
