import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowUpRight, Check } from "lucide-react";
import type { AssistantMedia } from "@contracts/assistant";
import { confirmDialog } from "@/lib/dialogs";
import { usePlayFrom, type Local } from "@/lib/play-here";
import type { ReviewView } from "@/lib/review";

type Cut = NonNullable<AssistantMedia["cut"]>;

/** Approve on that Review video and version; a cut with unblurred faces asks its owner first, as Review does. The answer is
 *  why it did not go to Finals, when it did not (an owner's Approve sends it there). */
async function approveCut(cut: Cut): Promise<string | undefined> {
  const post = async (asFilmed: boolean) => {
    const r = await fetch(`/api/review/assets/${cut.asset}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", version: cut.n, ...(asFilmed ? { asFilmed } : {}) }),
    });
    return { r, j: (await r.json().catch(() => null)) as { error?: string; code?: string; finals?: { error?: string } } | null };
  };
  let { r, j } = await post(false);
  if (r.status === 409 && j?.code === "not_blurred") {
    if (!(await confirmDialog({ title: j.error ?? "Approve it as filmed?", ok: "Approve as filmed" }))) throw new Error("");
    ({ r, j } = await post(true));
  }
  if (!r.ok) throw new Error(j?.error || "Could not approve");
  return j?.finals?.error;
}

/** A ready cut's own buttons (owner, 2026-11-20): Open in Review, Open in Editor (that version's timeline), Approve. */
function CutButtons({ media, cut, open }: { media: AssistantMedia; cut: Cut; open: (e: MouseEvent, href: string) => void }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  const approve = async () => {
    setState("busy");
    setError("");
    try {
      const notInFinals = await approveCut(cut);
      setState("done");
      if (notInFinals) setError(`Not in Finals: ${notInFinals}`);
    } catch (e) {
      setState("idle");
      setError((e as Error).message);
    }
  };
  const btn = "rounded-full px-3 py-1.5 text-center text-xs font-medium transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] disabled:opacity-60";
  // the links keep their words whole; Approve takes the rest, on a line of its own when the chat is too narrow
  const outline = "shrink-0 whitespace-nowrap border hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)]";
  return (
    <div className="space-y-1 px-3 pb-2.5">
      <div className="flex flex-wrap gap-2">
        <a href={media.href} onClick={(e) => open(e, media.href)} className={`${btn} ${outline}`}>
          Open in Review
        </a>
        {cut.editor && (
          <a href={cut.editor} onClick={(e) => open(e, cut.editor!)} className={`${btn} ${outline}`}>
            Open in Editor
          </a>
        )}
        <button type="button" disabled={state !== "idle"} onClick={() => void approve()} className={`${btn} flex min-w-0 flex-1 basis-28 items-center justify-center gap-1 bg-[var(--tint)] text-white hover:opacity-90`}>
          <Check className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{state === "done" ? "Approved" : cut.next ? `Approve · add ${cut.next}` : "Approve"}</span>
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** A ready cut's version as Review has it, for its file on this computer (`local`, managers only); ?quiet marks nothing seen. */
async function cutLocal(cut: Cut): Promise<Local | undefined> {
  const r = await fetch(`/api/review/assets/${cut.asset}?quiet`);
  const view = r.ok ? ((await r.json()) as ReviewView) : null;
  const v = view?.asset.versions.find((x) => x.n === cut.n);
  return v?.local ? { path: v.local, bytes: v.bytes } : undefined;
}

/** One card's player: a ready cut plays from its file on this computer when it is here (lib/play-here.ts), else as sent. */
function CardVideo({ media: v }: { media: AssistantMedia }) {
  const play = usePlayFrom(v.src, v.cut && (() => cutLocal(v.cut!)));
  return (
    <video
      data-chat-video
      src={play.src}
      onError={play.onError}
      poster={v.poster}
      controls
      playsInline
      preload="metadata"
      // one at a time: starting this one pauses the others in the chat
      onPlay={(e) => document.querySelectorAll<HTMLVideoElement>("video[data-chat-video]").forEach((x) => x !== e.currentTarget && x.pause())}
      className="mx-auto block max-h-80 max-w-full bg-black"
    />
  );
}

const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

/**
 * The videos a reply shows (show_video, a ready cut): a small player each; the title and Open go to its page, the dock
 * stays open. A ready cut has its buttons under it (CutButtons) instead of Open.
 */
export function VideoCards({ media }: { media?: AssistantMedia[] }) {
  const navigate = useNavigate();
  if (!media?.length) return null;
  const open = (e: MouseEvent, href: string) => {
    // a modified click still opens a tab
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <ul className="my-1.5 space-y-2">
      {media.map((v) => (
        <li key={v.id} className="overflow-hidden rounded-xl border border-border bg-background/60 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
          <CardVideo media={v} />
          <div className="flex items-center gap-2 px-3 py-2">
            <a href={v.href} onClick={(e) => open(e, v.href)} className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline" title={v.title}>
              {v.title}
            </a>
            {v.duration ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{clock(v.duration)}</span> : null}
            {!v.cut && (
              <a
                href={v.href}
                onClick={(e) => open(e, v.href)}
                className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
              >
                Open <ArrowUpRight className="size-3" aria-hidden />
              </a>
            )}
          </div>
          {v.cut && <CutButtons media={v} cut={v.cut} open={open} />}
        </li>
      ))}
    </ul>
  );
}
