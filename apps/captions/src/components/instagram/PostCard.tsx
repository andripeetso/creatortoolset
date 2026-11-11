import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Check, Eye, Heart, Instagram, Layers, Loader2, NotebookPen, Star } from "lucide-react";
import {
  IDEA_STATUSES,
  PROCESS_STEPS,
  FIND_FIELD_LABELS,
  fmtCount,
  fmtDate,
  fmtMmSs,
  ideaStatusOf,
  isProcessing,
  starsFromRank,
  thumbUrl,
  type FindMatch,
  type IdeaStatus,
  type InstagramPost,
} from "@/lib/instagram";
import {
  sessionPath,
  sessionStatusLabel,
  sessionStatusOf,
  type SessionRow,
  type SessionStatus,
} from "@/lib/workshop";
import { RankStars } from "./IdeaMark";

export type PostWorkshopUse = {
  id: string;
  title: string;
  href: string;
  generating?: boolean;
  status?: SessionStatus;
  projectName?: string;
};

export function workshopUsesByPost(sessions: SessionRow[]): Map<string, PostWorkshopUse[]> {
  const map = new Map<string, PostWorkshopUse[]>();
  for (const s of sessions) {
    const use: PostWorkshopUse = {
      id: s.id,
      title: s.title,
      href: sessionPath(s.id),
      generating: s.generating,
      status: sessionStatusOf(s.status),
      projectName: s.projectName,
    };
    for (const id of s.sourceIds ?? []) {
      const list = map.get(id);
      if (list) list.push(use);
      else map.set(id, [use]);
    }
  }
  return map;
}

const WORKSHOP_CHIP: Record<SessionStatus, string> = {
  draft: "bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
  writing: "bg-violet-500/15 text-violet-200 hover:bg-violet-500/25",
  production: "bg-amber-500/15 text-amber-200 hover:bg-amber-500/25",
  ready: "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25",
  editing: "bg-amber-500/15 text-amber-200 hover:bg-amber-500/25",
  toPost: "bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25",
  published: "bg-violet-500/20 text-violet-100 hover:bg-violet-500/30",
  shelved: "bg-zinc-800/60 text-zinc-500 hover:bg-zinc-700",
};

export function WorkshopUseChip({ s }: { s: PostWorkshopUse }) {
  const status = s.status ?? "draft";
  const mark = sessionStatusLabel(status);
  return (
    <Link
      to={s.href}
      onClick={(e) => e.stopPropagation()}
      title={
        s.generating
          ? `Generating in ${s.projectName ? `${s.projectName} · ${s.title}` : s.title}`
          : `${s.projectName ? `${s.projectName} · ${s.title}` : s.title} — ${mark} in workshop`
      }
      className={`inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${WORKSHOP_CHIP[status]}`}
    >
      {s.generating ? (
        <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
      ) : (
        <NotebookPen className="h-2.5 w-2.5 shrink-0" />
      )}
      <span className="truncate">{s.projectName || s.title}</span>
      <span className="shrink-0 opacity-80">{mark}</span>
    </Link>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** What the card leads with: the slide-1 hook when read, else the post description's first line. */
function headlineOf(post: InstagramPost): string {
  const hook = post.slides[0]?.vision.hook?.trim();
  if (hook) return hook;
  const line = post.caption.split("\n").find((l) => l.trim());
  return line?.trim() || "";
}

/** A number on a picture: white on black in both themes (the zinc scale flips in the light one). No backdrop blur:
 *  WebKit leaves a blurred box unpainted in every grid column but the first. */
export const MEDIA_PILL = "rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white";

/** What a thumbnail's corner says about the post: a carousel's slide count, a video's length, nothing for one picture. */
export function mediaMark(post: InstagramPost): ReactNode {
  const first = post.slides[0];
  if (post.kind === "carousel" && post.slides.length > 1) {
    return (
      <>
        <Layers className="h-3 w-3" />
        {post.slides.length}
      </>
    );
  }
  return first?.kind === "video" && first.durationS ? fmtMmSs(first.durationS) : null;
}

/** What a failed post says on its card: what went wrong in plain words, never the error itself (its page keeps that). */
function failureLabel(p: Pick<InstagramPost, "duplicateOf" | "jobs" | "error">): string {
  if (p.duplicateOf) return "Already saved";
  const media = p.jobs?.some((j) => j.type === "media" && j.status === "error") || p.error?.startsWith("Download failed");
  return media ? "Couldn’t download" : "Couldn’t read this post";
}

const statusLabel = (id: IdeaStatus) => IDEA_STATUSES.find((s) => s.id === id)!.label;

/**
 * A post in the grid. At rest it is the post: the picture, its numbers, who and when, the first line. Rating and
 * Skip / To make come up under the pointer (or the keyboard's focus); everything else is on the post's page.
 */
/** The picture's width over its height on the card. */
export function cardRatio(post: InstagramPost): number {
  const first = post.slides[0];
  if (first?.width && first?.height) return clamp(first.width / first.height, 0.5625, 1.25);
  return post.kind === "reel" ? 0.5625 : 0.8;
}

export function PostCard({
  post,
  selected,
  anySelected,
  avatarUrl,
  accountHref,
  workshop,
  matches,
  onSelect,
  onOpen,
  onOpenAccount,
  onMark,
  onRetry,
}: {
  post: InstagramPost;
  selected: boolean;
  anySelected: boolean;
  avatarUrl?: string;
  accountHref?: string;
  workshop?: PostWorkshopUse[];
  matches?: FindMatch[];
  onSelect: () => void;
  onOpen: () => void;
  onOpenAccount?: (href: string) => void;
  onMark: (patch: { ideaStatus?: IdeaStatus; rank?: number | null }) => void;
  /** A failed post: run it again from the card. None while posts can't be read: the page's amber line says so. */
  onRetry?: () => Promise<unknown>;
}) {
  // the pointer is over the card, or the keyboard's focus is inside it
  const [active, setActive] = useState(false);
  const [refused, setRefused] = useState(false);
  const first = post.slides[0];
  const ratio = cardRatio(post);
  const processing = isProcessing(post);
  const failed = post.status === "error";
  const stepLabel = PROCESS_STEPS.find((s) => s.id === post.step)?.label ?? "Working";
  const pct = Math.round(post.progress * 100);
  const headline = headlineOf(post);
  const handle = post.creator.username ? `@${post.creator.username}` : "";
  const plays = post.counts.plays;
  const likes = post.counts.likes;
  const mark = mediaMark(post);
  const stars = starsFromRank(post.rank);
  // a failed post with nothing downloaded has no picture to show: the card is its words and Try again
  const bare = failed && !first?.thumb;
  // a post a Workshop session uses is filed under To make
  const stored = ideaStatusOf(post.ideaStatus);
  const status = workshop?.length && stored === "inbox" ? "idea" : stored;
  const toggle = (to: IdeaStatus) => onMark({ ideaStatus: status === to ? "inbox" : to });

  return (
    <div
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setActive(false);
      }}
      className={`group relative overflow-hidden rounded-xl border bg-zinc-900/50 transition-colors ${
        selected ? "border-violet-500/60" : "border-zinc-800 hover:border-zinc-600"
      }`}
    >
      {bare ? null : (
        <div className="relative">
          <button
            type="button"
            onClick={onOpen}
            className="block w-full bg-zinc-800 text-left"
            style={{ aspectRatio: String(ratio) }}
            aria-label={headline || handle || "Open post"}
          >
            {first?.thumb ? (
              <img src={thumbUrl(post.id, 0)} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <span className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
                <Instagram className="h-6 w-6 text-zinc-600" />
                {!post.creator.username && (
                  <span className="line-clamp-2 break-all text-[11px] text-zinc-500">{post.shortcode || post.input}</span>
                )}
              </span>
            )}
          </button>

          <label
            className={`absolute left-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/55 transition-opacity ${
              selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label="Select post"
              className="peer h-4 w-4 cursor-pointer appearance-none rounded-[3px] border-[1.5px] border-white/75 checked:border-violet-500 checked:bg-violet-500"
            />
            <Check className="pointer-events-none absolute hidden h-3 w-3 text-white peer-checked:block" />
          </label>

          {stars && !active ? (
            <span className={`${MEDIA_PILL} absolute right-2 top-2 flex items-center gap-1`} title={stars === 1 ? "1 star" : `${stars} stars`}>
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {stars}
            </span>
          ) : null}

          {processing ? (
            <>
              <span className={`${MEDIA_PILL} absolute bottom-3 left-2 text-[11px] tabular-nums`}>
                {stepLabel} · {pct}%
              </span>
              <span className="absolute inset-x-0 bottom-0 h-1 bg-black/40">
                <span className="block h-full bg-violet-500 transition-[width]" style={{ width: `${pct}%` }} />
              </span>
            </>
          ) : active ? (
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/70 px-2.5 py-2">
              <RankStars value={post.rank} onChange={(rank) => onMark({ rank })} onMedia />
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={status === "skip"}
                  onClick={() => toggle("skip")}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium text-white/85 hover:bg-white/15 hover:text-white ${
                    status === "skip" ? "bg-white/20 text-white" : ""
                  }`}
                >
                  {statusLabel("skip")}
                </button>
                <button
                  type="button"
                  aria-pressed={status === "idea"}
                  onClick={() => toggle("idea")}
                  className={`rounded-md bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-violet-500 ${
                    status === "idea" ? "ring-2 ring-white/80" : ""
                  }`}
                >
                  {statusLabel("idea")}
                </button>
              </span>
            </div>
          ) : (
            <>
              {plays !== undefined || likes !== undefined ? (
                <span className={`${MEDIA_PILL} absolute bottom-2 left-2 flex items-center gap-1 text-[11px]`}>
                  {plays !== undefined ? (
                    <>
                      <Eye className="h-3 w-3" /> {fmtCount(plays)}
                    </>
                  ) : (
                    <>
                      <Heart className="h-3 w-3" /> {fmtCount(likes)}
                    </>
                  )}
                </span>
              ) : null}
              {mark ? (
                <span className={`${MEDIA_PILL} absolute bottom-2 right-2 flex items-center gap-1 tabular-nums`}>{mark}</span>
              ) : null}
            </>
          )}
        </div>
      )}

      <div className={`flex flex-col gap-1.5 px-3 ${bare ? "pb-3 pt-2.5" : "pb-2.5 pt-2"}`}>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
          ) : null}
          {handle ? (
            accountHref && onOpenAccount ? (
              <button
                type="button"
                onClick={() => onOpenAccount(accountHref)}
                className="truncate font-medium text-zinc-300 hover:text-violet-200"
              >
                {handle}
              </button>
            ) : (
              <span className="truncate font-medium text-zinc-300">{handle}</span>
            )
          ) : (
            <span className="truncate">Reading post…</span>
          )}
          {post.takenAt ? <span className="ml-auto shrink-0 text-zinc-600">{fmtDate(post.takenAt)}</span> : null}
        </div>
        {bare ? (
          // no picture to open it by: its words do (the clamp on a span: WebKit ignores it on a button)
          <button type="button" onClick={onOpen} className="block text-left text-[13px] leading-snug text-zinc-200">
            <span className="line-clamp-2 break-words">{headline || post.shortcode || post.input}</span>
          </button>
        ) : (
          <p className="line-clamp-2 text-[13px] leading-snug text-zinc-200">
            {headline || <span className="text-zinc-500">Saved for later</span>}
          </p>
        )}
        {failed ? (
          <>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-zinc-400">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              <span className="min-w-0 flex-1 truncate">{failureLabel(post)}</span>
              {onRetry && !post.duplicateOf ? (
                <button
                  type="button"
                  onClick={() => {
                    setRefused(false);
                    onRetry().catch(() => setRefused(true));
                  }}
                  className="shrink-0 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-200 hover:bg-zinc-800"
                >
                  Try again
                </button>
              ) : null}
            </div>
            {/* the page hides Try again while posts can't be read (its amber line says why, once); anything else: */}
            {refused ? <p className="text-[11px] leading-snug text-zinc-500">Couldn’t try again</p> : null}
          </>
        ) : null}
        {matches?.length ? (
          <div
            className="flex flex-wrap gap-1"
            title="Where the search term was found: the idea first, then on-screen text, then the transcript, then the post description"
          >
            {matches.map((m) => (
              <span
                key={`${m.term}:${m.field}`}
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  m.field === "idea"
                    ? "bg-amber-500/20 text-amber-100"
                    : m.field === "slides"
                    ? "bg-violet-500/20 text-violet-100"
                    : m.field === "transcript"
                      ? "bg-violet-500/15 text-violet-100"
                      : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {m.term} · {FIND_FIELD_LABELS[m.field]}
              </span>
            ))}
          </div>
        ) : null}
        {workshop?.length ? (
          <div className="flex flex-wrap gap-1">
            {workshop.map((s) => (
              <WorkshopUseChip key={s.id} s={s} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
