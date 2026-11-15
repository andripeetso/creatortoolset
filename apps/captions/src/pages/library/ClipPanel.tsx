import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Captions, Clapperboard, Copy, Download, FileText, FolderOpen, Loader2, MessageSquare, Pencil, RotateCcw, Share2, Trash2, X } from "lucide-react";
import { CtMark } from "@/components/CtMark";
import { NEEDS, type AssetCard, type AssetDetail, type SimilarMatch, type TagCount } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { SheetTitle } from "@/components/ui/sheet";
import { canUse, useMe } from "@/lib/auth";
import { fmtBytes } from "@/lib/exports";
import { getAsset, listTags, openInCaptions, relatedAssets, rerunJobs, updateAsset, useLibraryChanges } from "@/lib/library";
import { undoable } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { canReveal, clock, day, factsOf, original, revealClip, tagSuggestions, useClipView } from "./clip";
import { ClipImage, ClipPlayer } from "./ClipPlayer";
import { ClipShare } from "./ClipShare";

/**
 * One clip, opened from the Media Library's grid, in a window (the player large on the left, a column on the right:
 * name, description, facts, its file, tags, what is said, its versions, clips that share its pictures or are close in
 * meaning, and the actions at the bottom) or in the
 * side panel (Settings → Appearance; the same parts one under another). The player starts as it opens. ←/→ step to
 * the neighbours the page gives, Space plays and pauses; Escape closes.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Props = {
  libraryId: string;
  asset: AssetCard;
  /** the second the player opens at (a line said in the clip) */
  startAt: number;
  inTrash: boolean;
  /** where Move to can take the clip: the top level (id null) and the folders, `depth` under their parents */
  moveTo: { id: string | null; name: string; depth: number }[];
  /** true: to the trash; false: back out of it */
  onTrash: (trash: boolean) => void;
  onMove: (folderId: string | null) => Promise<void>;
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

function Panel({ libraryId, asset, startAt, inTrash, moveTo, onTrash, onMove, onSaved, onError, onPrev, onNext }: Props) {
  const media = useRef<(HTMLVideoElement & HTMLAudioElement) | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [reread, setReread] = useState(0);
  const [sharing, setSharing] = useState(false);
  const [now, setNow] = useState(-1);
  const [opening, setOpening] = useState(false);
  const [same, setSame] = useState<SimilarMatch[]>([]);
  const [near, setNear] = useState<AssetCard[]>([]);
  const [copiedPath, setCopiedPath] = useState(false);
  const navigate = useNavigate();
  const me = useMe();
  const a = detail ?? asset;
  const win = useClipView() === "window";

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

  // clips close in meaning, from the vectors search by meaning keeps (none without them)
  useEffect(() => {
    if (inTrash) return;
    let live = true;
    relatedAssets(libraryId, asset.id).then(
      (r) => live && setNear(r),
      () => {},
    );
    return () => void (live = false);
  }, [libraryId, asset.id, inTrash]);

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
  // New edit opens with this take picked: the other takes, the style and the rest are chosen there, and no edit is
  // made before Create and run (EditorPage reads the pick from the navigation's state)
  const newEdit = () => navigate("/editor?new=1", { state: { pick: [{ versionId: a.versionId, title: a.title }] } });
  // the folders it is in are read again after the move: its Folder line says where it is now
  const move = (id: string | null) => void onMove(id).then(() => setReread((n) => n + 1));

  const playable = a.kind === "video" || a.kind === "audio";
  const facts = factsOf(a);
  const trash = !inTrash && !a.review && (
    <Button size="icon" variant="ghost" aria-label="Move to trash" title="Move to trash" className={cn("h-8 w-8 shrink-0", !win && "-mr-2 -mt-1")} onClick={() => onTrash(true)}>
      <Trash2 className="h-4 w-4" />
    </Button>
  );
  const file = original(a, detail);
  const inFolders = detail?.collections ?? [];
  const path = detail?.sourcePath;
  const copyPath = () =>
    path &&
    void navigator.clipboard?.writeText(path).then(() => {
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    });
  const reveal = () => path && void revealClip(libraryId, a.id).then((problem) => problem && onError(problem));
  const open = (id: string) => navigate(`/library?library=${encodeURIComponent(libraryId)}&asset=${encodeURIComponent(id)}`);

  const title = <SheetTitle className={cn("min-w-0 flex-1 break-words text-base", win && "pr-8")}>{a.title}</SheetTitle>;
  const head = (
    <div className="flex flex-col gap-3">
      {!win && (
        <div className="flex items-start gap-2">
          {title}
          {trash}
        </div>
      )}
      <DescriptionBox key={a.versionId} libraryId={libraryId} asset={a} readOnly={inTrash} onSaved={saved} onError={onError} />
      {(facts.length > 0 || inFolders.length > 0) && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
          {[...facts, ...(inFolders.length ? [[inFolders.length > 1 ? "Folders" : "Folder", inFolders.map((c) => c.name).join(", ")] as const] : [])].map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500">{k}</dt>
              <dd className="truncate tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {path && (
        // the file on this computer (the admin, on a server that has it): its folder in Finder in the Mac app, its path anywhere
        <div className="-ml-2 -mt-2 flex flex-wrap items-center">
          {canReveal() && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-zinc-500" onClick={reveal}>
              <FolderOpen className="h-3.5 w-3.5" />
              Show in Finder
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-zinc-500" title={path} onClick={copyPath}>
            <Copy className="h-3.5 w-3.5" />
            {copiedPath ? "Copied" : "Copy path"}
          </Button>
        </div>
      )}
      <TagEditor libraryId={libraryId} asset={a} readOnly={inTrash} onSaved={saved} onError={onError} />
      {a.state === "missing" && (
        <p className="text-sm text-zinc-400">
          The original is gone from its watch folder: moved, renamed, or the drive is unplugged. Nothing was deleted; it comes back
          when the file does.
        </p>
      )}
    </div>
  );

  const actions = (
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
          {/* only a take someone talks in: an edit is built on those, and B-roll is laid over them by the edit itself */}
          {a.kind === "video" && a.roll === "a" && canUse(me, "editor") && (
            <Button size="sm" variant="outline" onClick={newEdit}>
              <Clapperboard className="h-4 w-4" />
              New edit
            </Button>
          )}
          {moveTo.length > 0 && (
            <select
              aria-label="Move to"
              value=""
              onChange={(e) => e.target.value && move(e.target.value === "top" ? null : e.target.value)}
              className="h-8 rounded-md border border-zinc-500/30 bg-transparent px-2 text-sm"
            >
              <option value="">Move to…</option>
              {moveTo.map((o) => (
                <option key={o.id ?? "top"} value={o.id ?? "top"}>
                  {`${"\u00a0".repeat(3 * o.depth)}${o.name}`}
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
      {win && <span className="ml-auto">{trash}</span>}
    </div>
  );

  const said = playable && (
    <Transcript detail={detail} now={now} inTrash={inTrash} onSeek={seek} onRetry={() => rerunJobs(libraryId, a.id, ["transcribe"]).then(() => setReread((n) => n + 1), (e) => onError(message(e)))} />
  );

  // a small quiet strip, and nothing at all when no clip shares its pictures
  const similar = same.length > 0 && (
    <section aria-label="Shares pictures with" className="flex flex-col gap-1.5">
      <span className="text-xs text-zinc-500">Shares pictures with</span>
      <ul className="flex flex-wrap gap-1.5">
        {same.map((m) => (
          <li key={m.versionId}>
            <button
              type="button"
              title={`${m.title} · ${Math.round(m.overlap * 100)}% the same`}
              aria-label={`${m.title}, ${Math.round(m.overlap * 100)}% the same`}
              onClick={() => navigate(`/library?library=${encodeURIComponent(m.libraryId)}&asset=${encodeURIComponent(m.assetId)}`)}
            >
              <img src={m.thumbUrl} alt="" className="aspect-video w-16 rounded bg-zinc-900 object-cover ring-1 ring-zinc-500/20 hover:ring-zinc-400/60" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  // close in meaning: the same quiet strip, nothing when no clip is near
  const related = near.length > 0 && (
    <section aria-label="Close in meaning" className="flex flex-col gap-1.5">
      <span className="text-xs text-zinc-500">Close in meaning</span>
      <ul className="flex flex-wrap gap-1.5">
        {near.map((c) => (
          <li key={c.id}>
            <button type="button" title={c.title} aria-label={c.title} onClick={() => open(c.id)}>
              <img
                src={`/api/library/media/${c.versionId}/thumb`}
                alt=""
                className="aspect-video w-16 rounded bg-zinc-900 object-cover ring-1 ring-zinc-500/20 hover:ring-zinc-400/60"
              />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  // the clip's earlier files, each downloadable; only once there is more than one
  const versions = (detail?.versions?.length ?? 0) > 1 && detail && (
    <section aria-label="Versions" className="flex flex-col gap-1">
      <span className="text-xs text-zinc-500">Versions</span>
      <ul className="-mx-1 flex flex-col">
        {detail.versions.map((v) => (
          <li key={v.id} className="flex items-center gap-2 rounded px-1 text-sm hover:bg-zinc-500/10">
            <span className="w-5 shrink-0 tabular-nums text-zinc-500">{v.n}</span>
            <span className="min-w-0 flex-1 truncate tabular-nums">
              {day(v.createdAt)}
              <span className="text-zinc-500">{` · ${fmtBytes(v.bytes)} · ${v.createdBy}`}</span>
            </span>
            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" asChild>
              <a href={`/api/library/media/${v.id}/source`} download={`${a.title} v${v.n}`} aria-label={`Download version ${v.n}`} title={`Download version ${v.n}`}>
                <Download className="h-3.5 w-3.5" />
              </a>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );

  const jobs = detail?.jobs
    .filter((j) => (j.kind === "describe" || j.kind === "embed") && (j.state === "needs_key" || j.state === "failed"))
    .map((j) => (
      <p key={j.kind} className="text-xs text-zinc-500">
        {j.kind === "describe" ? "AI description" : "Search by meaning"}
        {/* waiting for an AI or a key: a few words, the place to add it one click away */}
        {j.state === "needs_key" ? (
          <>
            {" "}
            <Link to={NEEDS[j.kind === "describe" ? "describe" : "embed"].href} className="underline-offset-4 hover:underline">
              needs {NEEDS[j.kind === "describe" ? "describe" : "embed"].needs}
            </Link>
          </>
        ) : (
          `: ${j.error ?? "failed"}`
        )}
      </p>
    ));

  const picture = playable ? (
    <ClipPlayer asset={a} detail={detail} media={media} startAt={startAt} onPrev={onPrev} onNext={onNext} onTime={setNow} fill={win} />
  ) : a.kind === "image" ? (
    <ClipImage asset={a} fill={win} />
  ) : (
    win && (
      <div className="flex h-40 w-full items-center justify-center text-zinc-600 md:h-full">
        <FileText className="h-10 w-10" />
      </div>
    )
  );
  const share = !inTrash && <ClipShare libraryId={libraryId} assetId={a.id} versionId={a.versionId} title={a.title} open={sharing} onOpenChange={setSharing} />;

  if (win)
    return (
      // focusable first, so the window puts the focus here and Space is the player's, not the first button's
      <div tabIndex={0} className="flex h-full min-h-0 flex-col outline-none md:flex-row">
        <div className="relative flex shrink-0 items-center justify-center bg-black md:min-h-0 md:min-w-0 md:flex-1">{picture}</div>
        <aside aria-label="About this clip" className="flex min-h-0 flex-1 flex-col border-t border-border md:w-96 md:flex-none md:border-l md:border-t-0">
          {/* the name stays put beside the close button; what is under it scrolls */}
          <div className="px-5 pb-3 pt-5">{title}</div>
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-scroll px-5 pb-5">
            {head}
            {said}
            {versions}
            {similar}
            {related}
            {jobs}
          </div>
          {/* the assistant's round button sits over the window's bottom right (on a phone, and on a computer while it is in
              that corner): the actions leave it room */}
          <div className="border-t border-border p-4 max-md:pr-20 [html:has(button[data-assistant-dock][data-corner=br])_&]:pr-20">{actions}</div>
        </aside>
        {share}
      </div>
    );

  return (
    // its end scrolls clear of the assistant's button while that is in a bottom corner (it stands over the panel)
    <div tabIndex={0} className="flex flex-col gap-4 p-4 pt-12 outline-none [html:has(button[data-assistant-dock][data-corner^=b])_&]:pb-24">
      {picture}
      {head}
      {actions}
      {said}
      {versions}
      {similar}
      {related}
      {jobs}
      {share}
    </div>
  );
}

/**
 * The clip's tags: a chip each (the AI's marked), × takes one off (Undo puts it back), and a box that adds one, with the
 * library's tags that fit as suggestions (↑ ↓ pick, Enter adds, Escape closes them). Saved as the whole list (PATCH
 * tags): a tag kept keeps whose it is.
 */
function TagEditor({
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
  const [typed, setTyped] = useState("");
  const [all, setAll] = useState<TagCount[] | null>(null);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(-1);
  // an Undo after the clip closed or another opened must not put this one back on screen
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const shown = (x: AssetCard) => alive.current && onSaved(x);
  const save = (tags: string[], aiTags?: string[]) => updateAsset(libraryId, asset.id, { tags, aiTags });
  const list = open && all ? tagSuggestions(all, asset.tags, typed) : [];
  const busy = open && (typed !== "" || list.length > 0); // Escape is the box's while it has something to close

  const add = (t: string) => {
    const tag = t.trim();
    setTyped("");
    setPick(-1);
    if (!tag || asset.tags.some((x) => x.toLowerCase() === tag.toLowerCase())) return;
    save([...asset.tags, tag]).then(shown, (e) => onError(message(e)));
  };
  const remove = (t: string) =>
    save(asset.tags.filter((x) => x !== t)).then(
      (x) => {
        shown(x);
        const ai = asset.aiTags.includes(t);
        undoable("tag removed", () => getAsset(libraryId, asset.id).then((d) => (d.tags.includes(t) ? d : save([...d.tags, t], ai ? [t] : undefined))).then(shown), 1);
      },
      (e) => onError(message(e)),
    );

  const userTags = asset.tags.filter((t) => !asset.aiTags.includes(t));
  const aiTags = asset.tags.filter((t) => asset.aiTags.includes(t));
  if (readOnly && !asset.tags.length) return null;
  return (
    <section aria-label="Tags" className="flex flex-col gap-1.5">
      {asset.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {[...userTags, ...aiTags].map((t) => (
            <li key={t} className="flex items-center rounded-full border border-zinc-500/25 py-0.5 pl-2 pr-1 text-[11px] text-zinc-500">
              {asset.aiTags.includes(t) && <span className="mr-1 font-medium uppercase opacity-70">AI</span>}
              {t}
              {readOnly ? (
                <span className="w-1" />
              ) : (
                <button type="button" aria-label={`Remove ${t}`} title="Remove" className="ml-0.5 rounded-full p-0.5 hover:bg-zinc-500/20 hover:text-zinc-300" onClick={() => void remove(t)}>
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex flex-col">
          <input
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setPick(-1);
              setOpen(true);
            }}
            onFocus={() => {
              setOpen(true);
              if (!all) listTags(libraryId).then(setAll, () => setAll([]));
            }}
            onBlur={() => setOpen(false)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (!list.length) return;
                e.preventDefault();
                setPick((i) => (e.key === "ArrowDown" ? (i + 1) % list.length : i <= 0 ? list.length - 1 : i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                add(list[pick] ?? typed);
              } else if (e.key === "Escape" && busy) {
                setTyped("");
                setPick(-1);
                setOpen(false);
              }
            }}
            data-own-escape={busy ? "" : undefined}
            placeholder="Add a tag"
            aria-label="Add a tag"
            role="combobox"
            aria-expanded={list.length > 0}
            aria-controls="clip-tag-suggestions"
            aria-activedescendant={pick >= 0 ? `clip-tag-${pick}` : undefined}
            className="h-7 w-full rounded-md border border-transparent bg-transparent px-2 text-xs text-zinc-400 placeholder:text-zinc-500 hover:border-zinc-500/30 focus:border-zinc-500/40 focus:outline-none"
          />
          {list.length > 0 && (
            <ul id="clip-tag-suggestions" role="listbox" aria-label="Suggested tags" className="mt-1 flex flex-col rounded-md border border-zinc-500/25 py-1 text-xs">
              {list.map((t, i) => (
                <li
                  key={t}
                  id={`clip-tag-${i}`}
                  role="option"
                  aria-selected={i === pick}
                  // pressed before the box loses the focus, so the pick lands
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(t);
                  }}
                  className={cn("cursor-pointer px-2 py-1 text-zinc-400 hover:bg-zinc-500/10", i === pick && "bg-zinc-500/15 text-zinc-200")}
                >
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
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
      <section aria-label="What is said" className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">What is said</span>
        <div className="-mx-1 flex flex-col gap-0.5">
          {detail.transcript.segments.map((seg, i) => {
            const on = now >= seg.start && now < seg.end;
            return (
              <button
                key={i}
                type="button"
                onClick={() => onSeek(seg.start)}
                aria-current={on ? "true" : undefined}
                className={cn("flex gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-zinc-500/10", on && "bg-zinc-500/15")}
              >
                <span className="shrink-0 font-mono text-xs leading-5 text-zinc-500">{clock(seg.start)}</span>
                <span>{seg.text}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  if (!job) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
      {waiting ? job.error || "Transcribing…" : job.state === "done" ? "Nothing is said in this clip." : job.error ?? "The transcript failed."}
      {(job.state === "needs_key" || job.state === "failed") && !inTrash && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      )}
    </p>
  );
}

/**
 * The asset's description: a person's text wins over the AI's, which shows (marked AI) until someone writes one. Edit
 * opens the box; saving it empty removes the person's text. "Describe with AI" queues the describe job as the caller.
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
  const [text, setText] = useState<string | null>(null); // null: not editing
  const [queued, setQueued] = useState(false);
  const save = () =>
    updateAsset(libraryId, asset.id, { description: (text ?? "").trim() })
      .then((x) => {
        setText(null);
        onSaved(x);
      })
      .catch((e) => onError(message(e)));
  const describe = () =>
    rerunJobs(libraryId, asset.id, ["describe"])
      .then(() => setQueued(true))
      .catch((e) => onError(message(e)));

  if (text !== null)
    return (
      <section aria-label="Description" className="flex flex-col gap-1.5 text-sm">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={asset.description?.source === "ai" ? "Your own description (shown instead of the AI's)" : "Describe this clip"}
          aria-label="Description"
          className="w-full rounded-md border border-zinc-500/30 bg-transparent p-2"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={text.trim() === mine} onClick={() => void save()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setText(null)}>
            Cancel
          </Button>
        </div>
      </section>
    );

  return (
    <section aria-label="Description" className="flex flex-col gap-1 text-sm">
      {asset.description && (
        <p className={cn("leading-relaxed", asset.description.source === "ai" && "text-zinc-400")}>
          {asset.description.source === "ai" && <AiBadge />}
          {asset.description.text}
        </p>
      )}
      {!readOnly && (
        <div className="-ml-2 flex flex-wrap items-center">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-zinc-500" onClick={() => setText(mine)}>
            <Pencil className="h-3.5 w-3.5" />
            {asset.description ? "Edit" : "Add a description"}
          </Button>
          {(asset.kind === "video" || asset.kind === "image") && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-zinc-500" disabled={queued} onClick={() => void describe()}>
              <CtMark className="h-3.5 w-3.5" />
              {queued ? "Queued: the AI's description shows when it is done" : "Describe with AI"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
