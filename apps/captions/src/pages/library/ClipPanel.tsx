import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Captions, Clapperboard, Download, Loader2, MessageSquare, RotateCcw, Share2, Trash2 } from "lucide-react";
import type { AssetCard, AssetDetail, Collection, SimilarMatch } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { canUse, useMe } from "@/lib/auth";
import { createEdit } from "@/lib/editor";
import { getAsset, openInCaptions, rerunJobs, updateAsset, useLibraryChanges } from "@/lib/library";
import { cn } from "@/lib/utils";
import { factsOf, original, type WithRoll } from "./clip";
import { ClipPlayer } from "./ClipPlayer";
import { ClipShare } from "./ClipShare";

/**
 * One clip, opened from the Media Library's grid (the page's side sheet holds it). In the order a creator works with
 * raw footage: the player (it starts as the panel opens), the clip's name and facts, what you do with it (share,
 * download, Caption Studio, a new edit, a folder, the trash), what is said in it (a line seeks there), its
 * description, and the clips that share its pictures. ←/→ step to the neighbours the page gives, Space plays and
 * pauses; Escape closes (the sheet's own).
 */

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Props = {
  libraryId: string;
  asset: AssetCard;
  /** the second the player opens at (a line said in the clip) */
  startAt: number;
  inTrash: boolean;
  /** the library's own folders the clip can be put in */
  folders: Collection[];
  /** true: to the trash; false: back out of it */
  onTrash: (trash: boolean) => void;
  /** not shown: Finals are not part of the Media Library any more (the page stops passing it) */
  onAddToFinals?: () => void;
  onAddToFolder: (folderId: string) => void;
  onSaved: (a: AssetCard) => void;
  onError: (e: string) => void;
  /** the clip before and after this one in the page's grid (← and →); absent at either end */
  onPrev?: () => void;
  onNext?: () => void;
};

export function ClipPanel(props: Props) {
  // a new clip is a new panel: its player, detail and state never carry over from the one before
  return <Panel key={props.asset.id} {...props} />;
}

function Panel({ libraryId, asset, startAt, inTrash, folders, onTrash, onAddToFolder, onSaved, onError, onPrev, onNext }: Props) {
  const media = useRef<(HTMLVideoElement & HTMLAudioElement) | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [reread, setReread] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [now, setNow] = useState(-1);
  const [addedTo, setAddedTo] = useState<{ id: string; name: string }[]>([]);
  const [opening, setOpening] = useState(false);
  const [making, setMaking] = useState(false);
  const [same, setSame] = useState<SimilarMatch[]>([]);
  const navigate = useNavigate();
  const me = useMe();
  const a: WithRoll = detail ?? asset;

  useEffect(() => {
    let live = true;
    getAsset(libraryId, asset.id)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => void (live = false);
  }, [libraryId, asset.id, reread]);

  // the server's work on this clip (its lighter copy, a transcript, a description) arrives through the change stream
  useLibraryChanges(() => setReread((n) => n + 1));

  // a transcript still being made: look again in three seconds (its progress line is not a change)
  const job = detail?.jobs.find((j) => j.kind === "transcribe");
  const waiting = job?.state === "queued" || job?.state === "running";
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setReread((n) => n + 1), 3000);
    return () => clearTimeout(t);
  }, [waiting, detail]);

  const printed = !!detail?.jobs.some((j) => j.kind === "fingerprint" && j.state === "done");
  useEffect(() => {
    if (!printed || inTrash) return;
    let live = true;
    fetch(`/api/library/versions/${asset.versionId}/similar`)
      .then((r) => (r.ok ? (r.json() as Promise<{ matches: SimilarMatch[] }>) : null))
      .then((r) => live && r && setSame(r.matches.filter((m) => m.assetId !== asset.id).slice(0, 6)))
      .catch(() => {});
    return () => void (live = false);
  }, [asset.versionId, asset.id, printed, inTrash]);

  // ← → for the neighbours, Space to play and pause; typing, the share dialog and a focused control keep their keys
  useEffect(() => {
    if (sharing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const go = e.key === "ArrowLeft" ? onPrev : onNext;
        if (!go || e.repeat) return;
        e.preventDefault();
        go();
      } else if (e.key === " " && !t?.closest("button, a, video, audio")) {
        const v = media.current;
        if (!v) return;
        e.preventDefault();
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sharing, onPrev, onNext]);

  const saved = (x: AssetCard) => {
    setDetail(x as AssetDetail); // the PATCH answers with the whole detail
    onSaved(x);
  };
  const seek = (s: number) => {
    const v = media.current;
    if (!v) return;
    v.currentTime = s;
    void v.play().catch(() => {});
  };
  const captions = () => {
    setOpening(true);
    openInCaptions(libraryId, a.id)
      .then(({ projectId }) => navigate(`/captions?project=${projectId}`))
      .catch((e) => onError(message(e)))
      .finally(() => setOpening(false));
  };
  // the edit is made with this clip and opens; nothing runs until its Run there
  const newEdit = () => {
    setMaking(true);
    createEdit({ sources: [a.versionId], name: a.title })
      .then(({ id }) => navigate(`/editor/${id}`))
      .catch((e) => onError(message(e)))
      .finally(() => setMaking(false));
  };
  const addToFolder = (id: string) => {
    onAddToFolder(id);
    const f = folders.find((c) => c.id === id);
    if (f) setAddedTo((all) => [...all, { id: f.id, name: f.name }]);
  };

  const playable = a.kind === "video" || a.kind === "audio";
  const file = original(a, detail);
  const inFolders = [...(detail?.collections ?? []), ...addedTo.filter((x) => !detail?.collections.some((c) => c.id === x.id))];
  const userTags = a.tags.filter((t) => !a.aiTags.includes(t));
  const aiTags = a.tags.filter((t) => a.aiTags.includes(t));

  return (
    // focusable first, so the sheet puts the focus here and Space is the player's, not the first button's
    <div tabIndex={0} className="flex flex-col gap-4 p-4 pt-12 outline-none">
      {playable ? (
        <ClipPlayer asset={a} detail={detail} media={media} startAt={startAt} onPrev={onPrev} onNext={onNext} onTime={setNow} />
      ) : a.kind === "image" ? (
        <img src={`/api/library/media/${a.versionId}/play`} alt={a.title} className="w-full rounded-lg" />
      ) : null}

      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <SheetTitle className="truncate text-base">{a.title}</SheetTitle>
            <SheetDescription className="text-xs text-zinc-500">{factsOf(a)}</SheetDescription>
          </div>
          {!inTrash && !a.review && (
            <Button size="icon" variant="ghost" aria-label="Move to trash" title="Move to trash" className="-mr-2 -mt-1 h-8 w-8 shrink-0" onClick={() => onTrash(true)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        {inFolders.length > 0 && <p className="text-xs text-zinc-500">In {inFolders.map((c) => c.name).join(", ")}</p>}
        {a.tags.length > 0 && (
          <ul aria-label="Tags" className="mt-1 flex flex-wrap gap-1">
            {[...userTags, ...aiTags].map((t) => (
              <li key={t} className="rounded-full border border-zinc-500/25 px-2 py-0.5 text-[11px] text-zinc-500">
                {a.aiTags.includes(t) && <span className="mr-1 font-medium uppercase opacity-70">AI</span>}
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>

      {a.state === "missing" && (
        <p className="text-sm text-zinc-400">
          The original is gone from its watch folder: moved, renamed, or the drive is unplugged. Nothing was deleted; it comes back
          when the file does.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {inTrash ? (
          !a.review && (
            <Button size="sm" variant="outline" onClick={() => onTrash(false)}>
              <RotateCcw className="h-4 w-4" />
              Restore
            </Button>
          )
        ) : (
          <>
            <Button size="sm" onClick={() => setSharing(true)}>
              <Share2 className="h-4 w-4" />
              Share
            </Button>
            {a.state !== "missing" && (
              <Button size="sm" variant="outline" asChild>
                <a href={file.href} download={file.name}>
                  <Download className="h-4 w-4" />
                  Download
                </a>
              </Button>
            )}
            {a.kind === "video" && (
              <Button size="sm" variant="outline" disabled={opening} onClick={captions}>
                {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Captions className="h-4 w-4" />}
                Open in Caption Studio
              </Button>
            )}
            {a.kind === "video" && canUse(me, "editor") && (
              <Button size="sm" variant="outline" disabled={making} onClick={newEdit}>
                {making ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
                New edit
              </Button>
            )}
            {folders.length > 0 && (
              <select
                aria-label="Add to folder"
                value=""
                onChange={(e) => e.target.value && addToFolder(e.target.value)}
                className="h-8 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
              >
                <option value="">Add to folder…</option>
                {folders.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {a.review && (
          // Review owns its versions and its trash (one in Review's trash opens there): the library's trash answers 409 for it
          <Button size="sm" variant="outline" asChild>
            <Link to={a.trashedAt ? "/review?trash=1" : `/review/${a.id}`}>
              <MessageSquare className="h-4 w-4" />
              Open in Review
            </Link>
          </Button>
        )}
      </div>

      {playable && <Transcript detail={detail} now={now} inTrash={inTrash} onSeek={seek} onRetry={() => rerunJobs(libraryId, a.id, ["transcribe"]).then(() => setReread((n) => n + 1), (e) => onError(message(e)))} />}

      <DescriptionBox key={a.versionId} libraryId={libraryId} asset={a} readOnly={inTrash} onSaved={saved} onError={onError} />

      {same.length > 0 && (
        <section aria-label="Shares pictures with" className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-zinc-500">Shares pictures with</span>
          <ul className="grid grid-cols-3 gap-2">
            {same.map((m) => (
              <li key={m.versionId}>
                <button
                  type="button"
                  onClick={() => navigate(`/library?library=${encodeURIComponent(m.libraryId)}&asset=${encodeURIComponent(m.assetId)}`)}
                  className="flex w-full flex-col gap-1 text-left"
                >
                  <img src={m.thumbUrl} alt="" className="aspect-video w-full rounded-md bg-zinc-900 object-cover ring-1 ring-zinc-500/20" />
                  <span className="truncate text-xs">{m.title}</span>
                  <span className="text-[11px] text-zinc-500">{Math.round(m.overlap * 100)}% the same</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail?.jobs
        .filter((j) => (j.kind === "describe" || j.kind === "embed") && (j.state === "needs_key" || j.state === "failed"))
        .map((j) => (
          <p key={j.kind} className="text-xs text-zinc-500">
            {j.kind === "describe" ? "AI description" : "Search by meaning"}: {j.error ?? "failed"}
          </p>
        ))}

      {!inTrash && <ClipShare libraryId={libraryId} assetId={a.id} versionId={a.versionId} title={a.title} open={sharing} onOpenChange={setSharing} />}
    </div>
  );
}

export const AiBadge = () => (
  <span title="Written by AI" className="mr-1 rounded bg-zinc-500/20 px-1 py-px text-[10px] font-medium uppercase text-zinc-400">
    AI
  </span>
);

/** What is said in the clip, each line a button that plays from there; the line playing now is marked. */
function Transcript({
  detail,
  now,
  inTrash,
  onSeek,
  onRetry,
}: {
  detail: AssetDetail | null;
  now: number;
  inTrash: boolean;
  onSeek: (s: number) => void;
  onRetry: () => void;
}) {
  const job = detail?.jobs.find((j) => j.kind === "transcribe");
  const waiting = job?.state === "queued" || job?.state === "running";
  if (detail?.transcript)
    return (
      <section aria-label="Transcript" className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-xl border border-zinc-500/20 p-2">
        {detail.transcript.segments.map((seg, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSeek(seg.start)}
            aria-current={now >= seg.start && now < seg.end ? "true" : undefined}
            className={cn("flex gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-500/10", now >= seg.start && now < seg.end && "bg-zinc-500/15")}
          >
            <span className="shrink-0 font-mono text-xs leading-5 text-zinc-500">{clock(seg.start)}</span>
            <span>{seg.text}</span>
          </button>
        ))}
      </section>
    );
  if (!job) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      {waiting ? (job.state === "running" && job.error) || "Transcribing…" : job.state === "done" ? "Nothing is said in this clip." : job.error ?? "The transcript failed."}
      {(job.state === "needs_key" || job.state === "failed") && !inTrash && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </p>
  );
}

/**
 * The asset's description: a person's text wins over the AI's, which shows (marked AI) until someone writes one.
 * Saving an empty box removes the person's text. "Describe with AI" queues the describe job as the caller.
 */
function DescriptionBox({
  libraryId,
  asset,
  readOnly,
  onSaved,
  onError,
}: {
  libraryId: string;
  asset: AssetCard;
  readOnly: boolean;
  onSaved: (a: AssetCard) => void;
  onError: (e: string) => void;
}) {
  const mine = asset.description?.source === "user" ? asset.description.text : "";
  const [text, setText] = useState(mine);
  const [queued, setQueued] = useState(false);
  const save = () =>
    updateAsset(libraryId, asset.id, { description: text.trim() })
      .then(onSaved)
      .catch((e) => onError(message(e)));
  const describe = () =>
    rerunJobs(libraryId, asset.id, ["describe"])
      .then(() => setQueued(true))
      .catch((e) => onError(message(e)));
  return (
    <section aria-label="Description" className="flex flex-col gap-1.5 text-sm">
      {asset.description?.source === "ai" && (
        <p className="text-zinc-400">
          <AiBadge />
          {asset.description.text}
        </p>
      )}
      {readOnly ? (
        mine && <p>{mine}</p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder={asset.description ? "Your own description (shown instead of the AI's)" : "Describe this clip"}
            aria-label="Description"
            className="w-full rounded-md border border-zinc-500/30 bg-transparent p-2"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={text.trim() === mine} onClick={() => void save()}>
              Save description
            </Button>
            {(asset.kind === "video" || asset.kind === "image") && (
              <Button size="sm" variant="ghost" disabled={queued} onClick={() => void describe()}>
                {queued ? "Queued: the AI's description shows when it is done" : "Describe with AI"}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
