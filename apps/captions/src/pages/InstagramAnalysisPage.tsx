import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft, Loader2, ScanSearch } from "lucide-react";
import { canUse, useAuth, useMe } from "@/lib/auth";
import { toolsetHomePath } from "@/lib/mobile";
import { useWorkspace } from "@/lib/workspace";
import {
  analyzerHome,
  fmtAge,
  fmtCount,
  fmtDate,
  getAnalysis,
  kindLabel,
  type InstagramAnalysis,
} from "@/lib/instagram";
import { AppBar } from "@/components/AppBar";
import { ProjectSwitcher } from "@/components/workspace/ProjectSwitcher";

const label =
  "mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500";

export default function InstagramAnalysisPage() {
  const home = toolsetHomePath();
  const base = analyzerHome();
  const me = useMe();
  const required = useAuth((s) => s.required);
  const allowed = canUse(me, "instagram");
  const currentProjectId = useWorkspace((s) => s.currentProjectId);
  const [data, setData] = useState<InstagramAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    getAnalysis()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load analysis"));
  }, [allowed, currentProjectId]);

  return (
    <div className="relative flex min-h-dvh flex-col items-center bg-zinc-950 pb-[max(2.5rem,env(safe-area-inset-bottom))] text-zinc-200">
      <AppBar tool="Content Analyzer" to={base} trail="Analysis" account={!!me}>
        {me ? (
          <ProjectSwitcher />
        ) : required ? (
          <Link to={home} className="rounded-md px-2 py-1.5 text-xs text-zinc-500 hover:text-zinc-200">
            Sign in
          </Link>
        ) : null}
      </AppBar>

      <div className="mb-8 mt-10 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-600">
          <ScanSearch className="h-6 w-6 text-white" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Analysis</h1>
          <p className="text-sm text-zinc-500">Hooks, velocity, cadence, mix, and caption reposts.</p>
        </div>
      </div>

      <div className="mx-auto w-[960px] max-w-[96vw]">
        <Link to={base} className="mb-4 flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200">
          <ArrowLeft className="h-3.5 w-3.5" /> Library
        </Link>

        {error ? (
          <p className="text-sm text-red-400">{error}</p>
        ) : !data ? (
          <p className="flex items-center gap-2 py-12 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading your library…
          </p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Opening hooks">
              {data.hooks.length === 0 ? (
                <Empty>Run On-screen text on posts to group first-slide hooks.</Empty>
              ) : (
                data.hooks.map((h) => (
                  <div key={h.hook} className="flex items-start justify-between gap-3 border-t border-zinc-800/80 py-2 first:border-0 first:pt-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">{h.hook}</p>
                      <p className="text-[11px] text-zinc-500">
                        {h.count} {h.count === 1 ? "post" : "posts"}
                        {h.avgRank ? ` · avg rank ${h.avgRank}` : ""}
                        {h.avgVirality ? ` · ${fmtCount(h.avgVirality)} plays` : ""}
                      </p>
                    </div>
                    {h.postIds[0] ? (
                      <Link to={`${base}/${h.postIds[0]}`} className="shrink-0 text-[11px] text-violet-300 hover:text-violet-200">
                        Open
                      </Link>
                    ) : null}
                  </div>
                ))
              )}
            </Panel>

            <Panel title="Count velocity">
              {data.velocity.length === 0 ? (
                <Empty>Refresh numbers on a post twice to see plays per day.</Empty>
              ) : (
                data.velocity.map((v) => (
                  <Link
                    key={v.id}
                    to={`${base}/${v.id}`}
                    className="flex items-start justify-between gap-3 border-t border-zinc-800/80 py-2 first:border-0 first:pt-0 hover:text-zinc-100"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">
                        @{v.username} · {v.caption || "Untitled"}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {fmtCount(v.firstPlays)} → {fmtCount(v.lastPlays)} over {fmtAge(v.elapsedMs)}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-violet-200">
                      {v.playsPerDay > 0 ? "+" : ""}
                      {fmtCount(v.playsPerDay)}/day
                    </span>
                  </Link>
                ))
              )}
            </Panel>

            <Panel title="Posting cadence">
              {data.cadence.length === 0 ? (
                <Empty>Run Catalog on an account to measure how often they post.</Empty>
              ) : (
                data.cadence.map((c) => (
                  <Link
                    key={c.accountId}
                    to={`${base}/accounts/${c.accountId}`}
                    className="flex items-start justify-between gap-3 border-t border-zinc-800/80 py-2 first:border-0 first:pt-0 hover:text-zinc-100"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">@{c.username}</p>
                      <p className="text-[11px] text-zinc-500">
                        {c.count} in catalog
                        {c.medianGapDays !== undefined ? ` · median ${c.medianGapDays}d apart` : ""}
                        {c.lastPostedAt ? ` · last ${fmtDate(c.lastPostedAt)}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                      {c.postsPerWeek !== undefined ? `${c.postsPerWeek}/wk` : "—"}
                    </span>
                  </Link>
                ))
              )}
            </Panel>

            <Panel title="Mix and performance">
              {(data.mix ?? []).length === 0 ? (
                <Empty>Run Catalog on an account to see reels vs carousels vs statics.</Empty>
              ) : (
                data.mix.map((m) => (
                  <Link
                    key={m.accountId}
                    to={`${base}/accounts/${m.accountId}`}
                    className="flex items-start justify-between gap-3 border-t border-zinc-800/80 py-2 first:border-0 first:pt-0 hover:text-zinc-100"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm text-zinc-200">@{m.username}</p>
                      <p className="text-[11px] text-zinc-500">
                        {m.reels} reels · {m.carousels} carousels · {m.posts} static
                        {m.byKind.map((k) =>
                          k.avgPlays !== undefined
                            ? ` · ${kindLabel(k.kind)} avg ${fmtCount(k.avgPlays)}`
                            : "",
                        )}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                      {m.medianPlays !== undefined ? `median ${fmtCount(m.medianPlays)}` : "—"}
                    </span>
                  </Link>
                ))
              )}
            </Panel>

            <Panel title="Reposts / variations">
              {(data.duplicates ?? []).length === 0 ? (
                <Empty>Similar captions in a catalog show up here after you run Catalog.</Empty>
              ) : (
                data.duplicates.map((d, i) => (
                  <Link
                    key={`${d.accountId}-${d.members.map((m) => m.shortcode).join("-")}-${i}`}
                    to={`${base}/accounts/${d.accountId}`}
                    className="block border-t border-zinc-800/80 py-2 first:border-0 first:pt-0 hover:text-zinc-100"
                  >
                    <p className="text-sm text-zinc-200">
                      @{d.username} · {d.kind === "repost" ? "Repost" : "Variation"} ·{" "}
                      {Math.round(d.score * 100)}%
                    </p>
                    <p className="truncate text-[11px] text-zinc-500">
                      {d.members.map((m) => m.captionPreview || m.shortcode).join(" · ")}
                      {d.libraryHits[0]
                        ? ` · also @${d.libraryHits[0].username}`
                        : ""}
                    </p>
                  </Link>
                ))
              )}
            </Panel>

            {data.commentKinds && Object.keys(data.commentKinds).length > 0 && (
              <Panel title="What commenters say">
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {(
                    [
                      ["question", "questions"],
                      ["pushback", "pushback"],
                      ["story", "stories"],
                      ["praise", "praise"],
                      ["keyword", "keyword replies"],
                    ] as const
                  )
                    .filter(([k]) => data.commentKinds?.[k])
                    .map(([k, label]) => (
                      <span
                        key={k}
                        className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300"
                      >
                        {data.commentKinds?.[k]} {label}
                      </span>
                    ))}
                </div>
                {data.topQuestions?.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {data.topQuestions.map((q, i) => (
                      <li key={i} className="text-xs text-zinc-300">
                        <span className="text-violet-300">?</span> {q.text}
                        {q.likes > 0 && <span className="ml-1.5 text-[11px] text-zinc-500">♥ {q.likes}</span>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>No open questions in the comments pulled so far.</Empty>
                )}
              </Panel>
            )}

            <Panel title="Comment themes">
              {data.commentThemes.length === 0 ? (
                <Empty>Pull comments on a few posts to see repeating words.</Empty>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {data.commentThemes.map((t) => (
                    <span
                      key={t.label}
                      className="rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-300"
                    >
                      {t.label} · {t.count}
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-4">
      <h2 className={label}>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-600">{children}</p>;
}
