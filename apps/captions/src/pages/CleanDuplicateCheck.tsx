import { useEffect, useState } from "react";
import { Loader2, ScanSearch } from "lucide-react";
import type { SimilarMatch } from "@contracts/library";
import type { SocialPlatform } from "@contracts/connectors";

/** A posted reel that shares pictures with the upload (api/library/similar.ts PostedMatch). */
interface PostedMatch {
  platform: SocialPlatform;
  handle: string;
  postId: string;
  url?: string;
  text: string;
  at: number;
  overlap: number;
  voice?: { pct: number; longestS: number };
}

/** POST /api/clean/sources/:id/duplicates answers api/library/similar.ts: the library, and the posted reels under `posted`. */
interface Result {
  matches: SimilarMatch[];
  checked: number;
  pending: number;
  posted: { matches: PostedMatch[]; checked: number; pending: number; voice: { on: boolean; checked: number; note: string } };
}

/** Duplicate check: this upload's pictures against the videos in your Media Library and your posted reels. */
export function CleanDuplicateCheck({ sourceId }: { sourceId?: string }) {
  const [result, setResult] = useState<Result>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setResult(undefined);
    setError("");
  }, [sourceId]);
  async function check() {
    if (!sourceId) return;
    setChecking(true);
    setError("");
    try {
      const res = await fetch(`/api/clean/sources/${encodeURIComponent(sourceId)}/duplicates`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The check didn't finish.");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check didn't finish.");
    } finally {
      setChecking(false);
    }
  }
  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Duplicate check</h3>
          <p className="text-xs text-zinc-500">This video's pictures, second by second, against the videos in your Media Library.</p>
        </div>
        <button
          type="button"
          disabled={!sourceId || checking}
          onClick={() => void check()}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:border-violet-500 disabled:opacity-40"
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
          {checking ? "Checking…" : "Check against my library"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-xs text-amber-300">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-4 space-y-3">
          <p className={`text-sm font-medium ${result.matches.length ? "text-amber-300" : "text-emerald-300"}`}>
            {result.matches.length ? `Shares pictures with ${result.matches.length} video${result.matches.length === 1 ? "" : "s"}` : "Nothing close in your library"}
          </p>
          <p className="text-xs text-zinc-400">
            Compared with {result.checked} video{result.checked === 1 ? "" : "s"}.
            {result.pending > 0 && ` ${result.pending} more are being fingerprinted; check again in a few minutes.`}
          </p>
          {result.matches.map((m) => (
            <a
              key={m.versionId}
              href={`/library?library=${encodeURIComponent(m.libraryId)}&asset=${encodeURIComponent(m.assetId)}`}
              className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-2 text-xs hover:border-zinc-600"
            >
              <img src={m.thumbUrl} alt="" className="h-12 w-20 shrink-0 rounded object-cover" />
              <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">{m.title}</span>
              <span className="shrink-0 tabular-nums text-zinc-400">{Math.round(m.overlap * 100)}% of this video</span>
            </a>
          ))}
          <div className="border-t border-zinc-800 pt-3">
            <h4 className="text-xs font-semibold text-zinc-300">Your posted reels</h4>
            {result.posted.matches.length ? (
              <p className="mt-1 text-sm font-medium text-amber-300">
                Shares pictures or voice with {result.posted.matches.length} posted reel{result.posted.matches.length === 1 ? "" : "s"}
              </p>
            ) : (
              <p className="mt-1 text-sm font-medium text-emerald-300">Nothing close among your posted reels</p>
            )}
            <p className="text-xs text-zinc-400">
              {result.posted.checked === 0 && result.posted.pending === 0
                ? "No posted reels to compare yet. Connect an Instagram login under Settings → Social accounts; its reels are read then."
                : `Compared with ${result.posted.checked} posted reel${result.posted.checked === 1 ? "" : "s"}.`}
              {result.posted.pending > 0 && ` ${result.posted.pending} more are being fingerprinted; check again in a few minutes.`}
            </p>
            <p className="text-xs text-zinc-400">{result.posted.voice.note}</p>
            {result.posted.matches.map((m) => (
              <a
                key={`${m.platform}:${m.postId}`}
                href={m.url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-2 text-xs hover:border-zinc-600"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">
                  @{m.handle} · {new Date(m.at).toLocaleDateString()} · {m.text || "No caption"}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-400">
                  {[m.overlap > 0 && `${Math.round(m.overlap * 100)}% of pictures`, m.voice && `${Math.round(m.voice.pct)}% of voice · ${m.voice.longestS.toFixed(1)} s run`].filter(Boolean).join(" · ")}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
