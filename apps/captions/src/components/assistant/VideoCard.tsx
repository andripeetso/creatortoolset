import type { MouseEvent } from "react";
import { useNavigate } from "react-router";
import { ArrowUpRight } from "lucide-react";
import type { AssistantMedia } from "@contracts/assistant";

const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

/** The videos a reply shows (show_video): a small player each; the title and Open go to its page, the dock stays open. */
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
              Open <ArrowUpRight className="size-3" aria-hidden />
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}
