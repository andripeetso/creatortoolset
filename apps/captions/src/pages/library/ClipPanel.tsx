import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Captions, Loader2, MessageSquare, RotateCcw, Share2, Star, Trash2 } from "lucide-react";
import type { AssetCard, AssetDetail, Collection } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { createShare, getAsset, openInCaptions, rerunJobs, updateAsset } from "@/lib/library";

/**
 * One clip, opened from the Media Library's grid (the page's side sheet holds it): its name and size, what can be done
 * with it (trash or restore, Finals, a folder), its description, a share link, the player and what is said in it.
 */

const FINALS = "Finals";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ClipPanel({
  libraryId,
  asset: a,
  startAt,
  inTrash,
  folders,
  onTrash,
  onAddToFinals,
  onAddToFolder,
  onSaved,
  onError,
}: {
  libraryId: string;
  asset: AssetCard;
  /** the second the player opens at (a line said in the clip) */
  startAt: number;
  inTrash: boolean;
  /** the library's own folders the clip can be put in */
  folders: Collection[];
  /** true: to the trash; false: back out of it */
  onTrash: (trash: boolean) => void;
  onAddToFinals: () => void;
  onAddToFolder: (folderId: string) => void;
  onSaved: (a: AssetCard) => void;
  onError: (e: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-4 pt-12">
      <SheetTitle className="truncate text-base">{a.title}</SheetTitle>
      <SheetDescription className="text-xs text-zinc-500">
        {[
          a.durationS !== undefined && clock(a.durationS),
          a.width && `${a.width}×${a.height}`,
          `version ${a.versionN}`,
          a.state !== "ready" && a.state,
        ]
          .filter(Boolean)
          .join(" · ")}
      </SheetDescription>
      <div className="flex flex-wrap items-center gap-2">
        {a.review ? (
          // Review owns its versions and its trash (one in Review's trash opens there): the library's trash answers 409 for it
          <Button size="sm" variant="outline" asChild>
            <Link to={a.trashedAt ? "/review?trash=1" : `/review/${a.id}`}>
              <MessageSquare className="h-4 w-4" />
              Open in Review
            </Link>
          </Button>
        ) : inTrash ? (
          <Button size="sm" variant="outline" onClick={() => onTrash(false)}>
            <RotateCcw className="h-4 w-4" />
            Restore
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onTrash(true)}>
            <Trash2 className="h-4 w-4" />
            Move to trash
          </Button>
        )}
        {!inTrash && (
          <Button size="sm" variant="outline" onClick={onAddToFinals}>
            <Star className="h-4 w-4" />
            Add to {FINALS}
          </Button>
        )}
        {folders.length > 0 && (
          <select
            aria-label="Add to folder"
            value=""
            onChange={(e) => e.target.value && onAddToFolder(e.target.value)}
            className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
          >
            <option value="">Add to folder…</option>
            {folders.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        )}
      </div>
      {a.state === "missing" && (
        <p className="text-sm text-zinc-400">
          The original is gone from its watch folder: moved, renamed, or the drive is unplugged. Nothing was deleted; it comes back
          when the file does.
        </p>
      )}
      <DescriptionBox key={a.versionId} libraryId={libraryId} asset={a} readOnly={inTrash} onSaved={onSaved} onError={onError} />
      {!inTrash && <ShareBox libraryId={libraryId} assetId={a.id} />}
      {a.kind === "image" ? (
        <img src={`/api/library/media/${a.versionId}/play`} alt={a.title} className="w-full rounded-lg" />
      ) : (
        <Player libraryId={libraryId} asset={a} startAt={startAt} inTrash={inTrash} onError={onError} />
      )}
    </div>
  );
}

export const AiBadge = () => (
  <span title="Written by AI" className="mr-1 rounded bg-zinc-500/20 px-1 py-px text-[10px] font-medium uppercase text-zinc-400">
    AI
  </span>
);


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

/** A share link for one asset: watch only or watch and download, optional password, days to live. The link shows once. */
function ShareBox({ libraryId, assetId }: { libraryId: string; assetId: string }) {
  const [scope, setScope] = useState<"view" | "download">("view");
  const [days, setDays] = useState("7");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const make = () => {
    setFailed(null);
    createShare(libraryId, {
      target: { kind: "asset", id: assetId },
      scope,
      expiresInDays: Number(days) || 7,
      ...(password ? { password } : {}),
    })
      .then((s) => setLink(`${location.origin}${s.url}`))
      .catch((e) => setFailed(message(e)));
  };

  return (
    <section aria-label="Share link" className="flex flex-col gap-2 rounded-xl border border-zinc-500/20 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Share2 className="h-4 w-4 text-zinc-500" />
        <select
          aria-label="Link scope"
          value={scope}
          onChange={(e) => setScope(e.target.value as "view" | "download")}
          className="h-9 rounded-md border border-zinc-500/30 bg-transparent px-2"
        >
          <option value="view">Watch only</option>
          <option value="download">Watch and download</option>
        </select>
        <Input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days to live" className="h-9 w-20" />
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password (optional)" aria-label="Link password" className="h-9 w-44" />
        <Button size="sm" onClick={make}>
          Create link
        </Button>
      </div>
      {link && (
        <div className="flex items-center gap-2">
          <Input readOnly value={link} aria-label="Share link address" onFocus={(e) => e.currentTarget.select()} className="h-9 text-xs" />
          <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(link)}>
            Copy
          </Button>
        </div>
      )}
      {failed && <p className="text-xs text-red-400">{failed}</p>}
    </section>
  );
}

/**
 * The preview's player with what is said in it: the media opens at `startAt` (a #t= media fragment), a transcript line
 * seeks there. Below: the transcript's state (a key missing says so, with Retry) and Open in Caption Studio.
 */
function Player({
  libraryId,
  asset,
  startAt,
  inTrash,
  onError,
}: {
  libraryId: string;
  asset: AssetCard;
  startAt: number;
  inTrash: boolean;
  onError: (e: string) => void;
}) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [reread, setReread] = useState(0);
  const [opening, setOpening] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    getAsset(libraryId, asset.id)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => void (live = false);
  }, [libraryId, asset.id, reread]);

  // a transcript still being made: look again in three seconds
  const job = detail?.jobs.find((j) => j.kind === "transcribe");
  const waiting = job?.state === "queued" || job?.state === "running";
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setReread((n) => n + 1), 3000);
    return () => clearTimeout(t);
  }, [waiting, detail]);

  const seek = (s: number) => {
    if (!media.current) return;
    media.current.currentTime = s;
    void media.current.play().catch(() => {});
  };
  const src = `/api/library/media/${asset.versionId}/play${startAt ? `#t=${startAt}` : ""}`;
  const retry = () =>
    rerunJobs(libraryId, asset.id, ["transcribe"])
      .then(() => setReread((n) => n + 1))
      .catch((e) => onError(message(e)));
  const captions = () => {
    setOpening(true);
    openInCaptions(libraryId, asset.id)
      .then(({ projectId }) => navigate(`/captions?project=${projectId}`))
      .catch((e) => onError(message(e)))
      .finally(() => setOpening(false));
  };

  return (
    <>
      {asset.kind === "video" ? (
        <video key={src} ref={media} src={src} controls playsInline preload="metadata" className="w-full rounded-lg bg-black" />
      ) : (
        <audio key={src} ref={media} src={src} controls preload="metadata" className="w-full" />
      )}
      {asset.kind === "video" && !inTrash && (
        <Button size="sm" variant="outline" className="w-fit" disabled={opening} onClick={captions}>
          {opening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Captions className="h-4 w-4" />}
          Open in Caption Studio
        </Button>
      )}
      {detail?.transcript ? (
        <section aria-label="Transcript" className="flex max-h-80 flex-col gap-0.5 overflow-y-auto rounded-xl border border-zinc-500/20 p-2">
          {detail.transcript.segments.map((seg, i) => (
            <button key={i} type="button" onClick={() => seek(seg.start)} className="flex gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-500/10">
              <span className="shrink-0 font-mono text-xs leading-5 text-zinc-500">{clock(seg.start)}</span>
              <span>{seg.text}</span>
            </button>
          ))}
        </section>
      ) : (
        job && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            {waiting ? (job.state === "running" && job.error) || "Transcribing…" : job.state === "done" ? "Nothing is said in this clip." : job.error ?? "The transcript failed."}
            {(job.state === "needs_key" || job.state === "failed") && !inTrash && (
              <Button size="sm" variant="outline" onClick={retry}>
                Retry
              </Button>
            )}
          </p>
        )
      )}
      {detail?.jobs
        .filter((j) => (j.kind === "describe" || j.kind === "embed") && (j.state === "needs_key" || j.state === "failed"))
        .map((j) => (
          <p key={j.kind} className="text-xs text-zinc-500">
            {j.kind === "describe" ? "AI description" : "Search by meaning"}: {j.error ?? "failed"}
          </p>
        ))}
    </>
  );
}
