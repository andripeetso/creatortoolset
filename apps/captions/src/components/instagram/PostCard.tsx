import { Link } from "react-router";
import { Eye, Heart, Instagram, Loader2, NotebookPen } from "lucide-react";
import {
  PROCESS_STEPS,
  FIND_FIELD_LABELS,
  fmtCount,
  fmtDate,
  fmtMmSs,
  isProcessing,
  postBadgeClass,
  postBadgeLabel,
  thumbUrl,
  type FindMatch,
  type IdeaStatus,
  type InstagramPost,
  type SavedFor,
} from "@/lib/instagram";
import {
  sessionPath,
  sessionStatusLabel,
  sessionStatusOf,
  type SessionRow,
  type SessionStatus,
} from "@/lib/workshop";
import { IdeaStatusSelect, RankStars, SavedForToggle } from "./IdeaMark";

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
  writing: "bg-sky-500/15 text-sky-200 hover:bg-sky-500/25",
  production: "bg-amber-500/15 text-amber-200 hover:bg-amber-500/25",
  ready: "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25",
  editing: "bg-orange-500/15 text-orange-200 hover:bg-orange-500/25",
  toPost: "bg-teal-400/15 text-teal-100 hover:bg-teal-400/25",
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

/** What the card leads with: the slide-1 hook when read, else the caption's first line. */
function headlineOf(post: InstagramPost): string {
  const hook = post.slides[0]?.vision.hook?.trim();
  if (hook) return hook;
  const line = post.caption.split("\n").find((l) => l.trim());
  return line?.trim() || "";
}

/**
 * Library card: the media leads, the numbers sit on it, the hook is
 * readable at a glance, and status / rating stay one click away.
 */
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
  onMark: (patch: { ideaStatus?: IdeaStatus; rank?: number | null; savedFor?: SavedFor[]; knowhow?: boolean }) => void;
}) {
  const first = post.slides[0];
  const ratio =
    first?.width && first?.height
      ? clamp(first.width / first.height, 0.5625, 1.25)
      : post.kind === "reel"
        ? 0.5625
        : 0.8;
  const processing = isProcessing(post);
  const failed = post.status === "error";
  const queued = !processing && !failed && (post.jobs?.some((j) => j.status === "pending") ?? false);
  const stepLabel = PROCESS_STEPS.find((s) => s.id === post.step)?.label ?? "Working";
  const pct = Math.round(post.progress * 100);
  const headline = headlineOf(post);
  const handle = post.creator.username ? `@${post.creator.username}` : "";
  const plays = post.counts.plays;
  const likes = post.counts.likes;
  const pill = "rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-zinc-100 backdrop-blur-sm";

  return (
    <div
      className={`group relative mb-3 break-inside-avoid overflow-hidden rounded-xl border bg-zinc-900/50 transition-colors ${
        selected ? "border-violet-500/60" : "border-zinc-800 hover:border-zinc-600"
      }`}
    >
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
          className={`absolute left-2 top-2 flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-black/55 backdrop-blur-sm transition-opacity ${
            selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onSelect}
            aria-label="Select post"
            className="h-4 w-4 accent-violet-500"
          />
        </label>

        <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
          <span className={`${pill} ${postBadgeClass(post)}`}>
            {postBadgeLabel(post)}
            {post.kind === "carousel" && post.slides.length > 1 ? ` · ${post.slides.length}` : ""}
          </span>
          {post.duplicateOf ? <span className={`${pill} !bg-amber-500/80 text-black`}>Duplicate</span> : null}
        </div>

        {processing ? (
          <div className="absolute inset-x-0 bottom-0 bg-black/75 px-2 pb-1.5 pt-1 text-[11px] text-violet-200 backdrop-blur-sm">
            <span className="flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span className="truncate">{stepLabel}</span>
              <span className="ml-auto tabular-nums">{pct}%</span>
            </span>
            <span className="mt-1 block h-1 overflow-hidden rounded bg-zinc-700">
              <span className="block h-full rounded bg-violet-500 transition-[width]" style={{ width: `${pct}%` }} />
            </span>
          </div>
        ) : (
          <>
            {plays !== undefined || likes !== undefined ? (
              <span className={`${pill} absolute bottom-2 left-2 flex items-center gap-1 text-[11px]`}>
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
            {failed ? (
              <span className={`${pill} absolute bottom-2 right-2 !bg-red-600/85`}>Failed</span>
            ) : queued ? (
              <span className={`${pill} absolute bottom-2 right-2`}>Queued</span>
            ) : first?.kind === "video" && first.durationS ? (
              <span className={`${pill} absolute bottom-2 right-2 tabular-nums`}>{fmtMmSs(first.durationS)}</span>
            ) : null}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-2">
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
        {failed ? (
          <p className="line-clamp-2 text-[12px] leading-snug text-red-300">{post.error || "Ingest failed"}</p>
        ) : (
          <p className="line-clamp-2 text-[13px] leading-snug text-zinc-200">
            {headline || <span className="text-zinc-500">Saved — jobs pending</span>}
          </p>
        )}
        {matches?.length ? (
          <div
            className="flex flex-wrap gap-1"
            title="Where the search term was found — idea first, then on-screen, then transcript, then caption"
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
                      ? "bg-sky-500/15 text-sky-100"
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
        {post.tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {post.tags.slice(0, 3).map((t) => (
              <span
                key={t.id}
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  t.kind === "format" ? "bg-sky-500/15 text-sky-200" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {t.kind === "format" ? `format: ${t.label}` : t.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
          <IdeaStatusSelect
            value={post.ideaStatus}
            inSession={!!workshop?.length}
            onChange={(ideaStatus) => onMark({ ideaStatus })}
          />
          <SavedForToggle
            value={post.savedFor}
            onChange={(savedFor) => onMark({ savedFor })}
            knowhow={post.knowhow}
            onKnowhow={(knowhow) => onMark({ knowhow })}
          />
          <RankStars value={post.rank} onChange={(rank) => onMark({ rank })} />
        </div>
      </div>
    </div>
  );
}
