import { createContext, useContext, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowUpRight, Check, ChevronRight } from "lucide-react";
import type { AssistantMedia } from "@contracts/assistant";
import { confirmDialog } from "@/lib/dialogs";

/** Request changes under a ready cut: the chat box takes the cursor, asking this (the dock provides it). */
export const AskChanges = createContext<((ask: string) => void) | null>(null);

type Cut = NonNullable<AssistantMedia["cut"]>;

/** Approve on that Review video and version; a cut with unblurred faces asks its owner first, as Review does. */
async function approveCut(cut: Cut): Promise<void> {
  const post = async (asFilmed: boolean) => {
    const r = await fetch(`/api/review/assets/${cut.asset}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "approved", version: cut.n, ...(asFilmed ? { asFilmed } : {}) }),
    });
    return { r, j: (await r.json().catch(() => null)) as { error?: string; code?: string } | null };
  };
  let { r, j } = await post(false);
  if (r.status === 409 && j?.code === "not_blurred") {
    if (!(await confirmDialog({ title: j.error ?? "Approve it as filmed?", ok: "Approve as filmed" }))) throw new Error("");
    ({ r, j } = await post(true));
  }
  if (!r.ok) throw new Error(j?.error || "Could not approve");
}

/** A ready cut's own buttons, Approve left and Request changes right, as on the Review page. */
function CutButtons({ cut }: { cut: Cut }) {
  const ask = useContext(AskChanges);
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState("");
  const approve = async () => {
    setState("busy");
    setError("");
    try {
      await approveCut(cut);
      setState("done");
    } catch (e) {
      setState("idle");
      setError((e as Error).message);
    }
  };
  const btn = "flex-1 rounded-full px-3 py-1.5 text-xs font-medium transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] disabled:opacity-60";
  return (
    <div className="space-y-1 px-3 pb-2.5">
      <div className="flex gap-2">
        <button type="button" disabled={state !== "idle"} onClick={() => void approve()} className={`${btn} flex items-center justify-center gap-1 bg-[var(--tint)] text-white hover:opacity-90`}>
          <Check className="size-3.5" aria-hidden />
          {state === "done" ? "Approved" : cut.next ? `Approve · add ${cut.next}` : "Approve"}
        </button>
        <button type="button" disabled={!ask} onClick={() => ask?.(`What should change in v${cut.n}?`)} className={`${btn} border hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)]`}>
          Request changes
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

/**
 * The videos a reply shows (show_video, a ready cut): a small player each; the title and Open go to its page, the dock
 * stays open. A ready cut opens with Review › and has Approve and Request changes under it.
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
          <video
            data-chat-video
            src={v.src}
            poster={v.poster}
            controls
            playsInline
            preload="metadata"
            // one at a time: starting this one pauses the others in the chat
            onPlay={(e) => document.querySelectorAll<HTMLVideoElement>("video[data-chat-video]").forEach((x) => x !== e.currentTarget && x.pause())}
            className="mx-auto block max-h-80 max-w-full bg-black"
          />
          <div className="flex items-center gap-2 px-3 py-2">
            <a href={v.href} onClick={(e) => open(e, v.href)} className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:underline" title={v.title}>
              {v.title}
            </a>
            {v.duration ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{clock(v.duration)}</span> : null}
            <a
              href={v.href}
              onClick={(e) => open(e, v.href)}
              className="flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors hover:border-[color-mix(in_srgb,var(--tint)_50%,transparent)] hover:text-[var(--tint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)]"
            >
              {v.cut ? (
                <>
                  Review <ChevronRight className="size-3" aria-hidden />
                </>
              ) : (
                <>
                  Open <ArrowUpRight className="size-3" aria-hidden />
                </>
              )}
            </a>
          </div>
          {v.cut && <CutButtons cut={v.cut} />}
        </li>
      ))}
    </ul>
  );
}
