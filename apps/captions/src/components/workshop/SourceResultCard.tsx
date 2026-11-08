import { Check, Eye, Plus } from "lucide-react";
import { WorkshopUseChip, type PostWorkshopUse } from "@/components/instagram/PostCard";
import { FIND_FIELD_LABELS, effectiveSavedFor, fmtCount, postBadgeClass, postBadgeLabel, thumbUrl, type FindHit, type InstagramPost } from "@/lib/instagram";
import type { PieceQuote } from "@/lib/workshop";
import { SOURCE_MIME } from "./ChipComposer";

/** A post's hook, or its title, or its first caption line: what a citation shows. */
export function citeTextOf(post: InstagramPost): string {
  if (post.idea?.title) return post.idea.title;
  const hook = post.slides[0]?.vision.hook?.trim();
  if (hook) return hook;
  return post.caption.split("\n").find((l) => l.trim())?.trim() || "";
}

/** The citation a post becomes when dragged into the message box or cited from a source. */
export function citeQuoteOf(post: InstagramPost): PieceQuote {
  return { postId: post.id, handle: post.creator.username, text: citeTextOf(post) || `@${post.creator.username}` };
}

function headlineOf(hit: FindHit): string {
  return citeTextOf(hit.post);
}

/** One search hit (or, when plain, one library post): thumbnail, kind, handle, hook, matched terms, add. The card itself opens Read. */
export function SourceResultCard({
  hit,
  selected,
  full,
  plain = false,
  usedIn,
  own,
  onToggle,
  onRead,
}: {
  hit: FindHit;
  selected: boolean;
  /** The session already holds the maximum number of sources. */
  full: boolean;
  /** Not a search result: no matched-terms row. */
  plain?: boolean;
  /** Other workshop sessions that already use this post. */
  usedIn?: PostWorkshopUse[];
  /** From the author's own Instagram. */
  own?: boolean;
  onToggle: () => void;
  onRead: () => void;
}) {
  const { post } = hit;
  const first = post.slides[0];
  const plays = post.counts.plays ?? post.counts.likes;
  return (
    <div
      draggable /* into the message box as an inline citation */
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData(SOURCE_MIME, JSON.stringify(citeQuoteOf(post)));
        e.dataTransfer.setData("text/plain", citeTextOf(post));
      }}
      className={`relative flex cursor-pointer gap-3 rounded-xl border p-2.5 hover:bg-muted/40 ${
        selected ? "border-violet-500/50 bg-violet-600/10" : "border-border bg-card/70"
      } ${hit.commentsOnly ? "opacity-70" : ""}`}
    >
      <button type="button" onClick={onRead} className="absolute inset-0 z-0 rounded-xl" aria-label="Read" />
      <div className="relative z-10 h-24 w-[4.5rem] shrink-0 overflow-hidden rounded-md bg-zinc-800 pointer-events-none">
        {first?.thumb ? <img src={thumbUrl(post.id, 0)} alt="" loading="lazy" className="h-full w-full object-cover" /> : null}
        <span className={`absolute left-1 top-1 rounded px-1 text-[9px] font-medium ${postBadgeClass(post)}`}>
          {postBadgeLabel(post)}
        </span>
      </div>
      <div className="relative z-10 min-w-0 flex-1 pointer-events-none">
        <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate font-medium text-foreground">@{post.creator.username}</span>
          {own ? (
            <span className="shrink-0 rounded bg-violet-600/80 px-1 text-[10px] text-white">yours</span>
          ) : null}
          {effectiveSavedFor(post.savedFor).includes("format") ? (
            <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] text-violet-800 dark:text-violet-200">format</span>
          ) : null}
          {effectiveSavedFor(post.savedFor).includes("content") ? (
            <span className="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] text-violet-800 dark:text-violet-200">content</span>
          ) : null}
          {plays !== undefined ? (
            <span className="flex shrink-0 items-center gap-0.5">
              <Eye className="h-3 w-3" /> {fmtCount(plays)}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-foreground">{headlineOf(hit) || <span className="text-muted-foreground">No caption</span>}</p>
        {plain ? null : (
        <div className="mt-1.5 flex flex-wrap items-center gap-1" title="Where each search term was found — idea, then on-screen, then transcript, then caption">
          {hit.matches.map((m) => (
            <span
              key={m.term}
              className={`rounded px-1 py-0.5 text-[10px] ${
                m.field === "idea"
                  ? "bg-amber-500/20 text-amber-800 dark:text-amber-100"
                  : m.field === "slides"
                  ? "bg-violet-500/20 text-violet-800 dark:text-violet-100"
                  : m.field === "transcript"
                    ? "bg-violet-500/15 text-violet-800 dark:text-violet-100"
                    : m.field === "caption"
                      ? "bg-muted text-foreground"
                      : "bg-muted/60 text-muted-foreground"
              }`}
            >
              {m.term} · {FIND_FIELD_LABELS[m.field]}
            </span>
          ))}
          {hit.matches.length === 0 ? <span className="text-[10px] text-zinc-600">similar wording</span> : null}
          {hit.commentsOnly ? <span className="text-[10px] text-zinc-500">only the comments mention it</span> : null}
        </div>
        )}
        {usedIn?.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1 pointer-events-auto">
            {usedIn.map((s) => (
              <WorkshopUseChip key={s.id} s={s} />
            ))}
          </div>
        ) : null}
        <div className="mt-2 pointer-events-auto">
          <button
            type="button"
            disabled={!selected && full}
            onClick={onToggle}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium disabled:opacity-50 ${
              selected ? "border border-violet-500/40 text-violet-700 hover:bg-violet-600/20 dark:text-violet-200" : "bg-violet-600 text-white hover:bg-violet-500"
            }`}
          >
            {selected ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {selected ? "Added" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
