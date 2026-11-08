import { Eye, Loader2 } from "lucide-react";
import {
  fmtCount,
  thumbUrl,
  virality,
  type InstagramPost,
} from "@/lib/instagram";
import { WorkshopUseChip, type PostWorkshopUse } from "./PostCard";

function kindSummary(posts: InstagramPost[]): string {
  const n = { reel: 0, carousel: 0, post: 0 };
  for (const p of posts) n[p.kind]++;
  return (
    [
      n.reel ? `${n.reel} ${n.reel === 1 ? "reel" : "reels"}` : "",
      n.carousel ? `${n.carousel} ${n.carousel === 1 ? "carousel" : "carousels"}` : "",
      n.post ? `${n.post} ${n.post === 1 ? "post" : "posts"}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || `${posts.length}`
  );
}

const WORKSHOP_RANK: Record<string, number> = {
  published: 5,
  ready: 4,
  production: 3,
  writing: 2,
  draft: 1,
};

function workshopsForIdea(
  posts: InstagramPost[],
  workshopByPost: Map<string, PostWorkshopUse[]>,
): PostWorkshopUse[] {
  const seen = new Set<string>();
  const out: PostWorkshopUse[] = [];
  for (const p of posts) {
    for (const w of workshopByPost.get(p.id) ?? []) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w);
    }
  }
  return out.sort(
    (a, b) =>
      (b.generating ? 10 : 0) + (WORKSHOP_RANK[b.status ?? "draft"] ?? 0) -
      ((a.generating ? 10 : 0) + (WORKSHOP_RANK[a.status ?? "draft"] ?? 0)),
  );
}

/** One strong remake: the one-liner, a short description, and the posts in the pile. */
export function IdeaCard({
  title,
  description,
  posts,
  workshopByPost,
  making,
  onOpen,
  onMake,
}: {
  title: string;
  description: string;
  posts: InstagramPost[];
  workshopByPost: Map<string, PostWorkshopUse[]>;
  making?: boolean;
  onOpen: (id: string) => void;
  onMake: () => void;
}) {
  const thumbs = posts.filter((p) => p.slides[0]?.thumb).slice(0, 4);
  const plays = posts.reduce((n, p) => n + virality(p), 0);
  const workshops = workshopsForIdea(posts, workshopByPost);

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex items-start gap-3 px-3 py-3">
        <div className="flex shrink-0">
          {thumbs.length ? (
            thumbs.map((p, i) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onOpen(p.id)}
                className={`h-14 w-10 overflow-hidden rounded ring-2 ring-zinc-950 ${i > 0 ? "-ml-2" : ""}`}
                style={{ zIndex: thumbs.length - i }}
              >
                <img src={thumbUrl(p.id, 0)} alt="" className="h-full w-full object-cover" />
              </button>
            ))
          ) : (
            <div className="h-14 w-10 rounded bg-zinc-800" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug text-zinc-100">{title}</p>
          <p className="mt-0.5 text-[13px] leading-snug text-zinc-400">{description}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
            <span>{kindSummary(posts)}</span>
            {plays > 0 ? (
              <span className="inline-flex items-center gap-0.5">
                <Eye className="h-3 w-3" /> {fmtCount(plays)}
              </span>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          disabled={making || !posts.length}
          onClick={onMake}
          className="mt-0.5 shrink-0 rounded-lg bg-violet-600 px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-violet-500 disabled:opacity-50"
        >
          {making ? <Loader2 className="h-4 w-4 animate-spin" /> : "Do this"}
        </button>
      </div>
      {workshops.length ? (
        <div className="flex flex-wrap gap-1 px-3 pb-3">
          {workshops.map((s) => (
            <WorkshopUseChip key={s.id} s={s} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
