import { useState } from "react";
import { ImageOff } from "lucide-react";
import { PictureOverlay } from "@/components/assistant/Composer";
import { cn } from "@/lib/utils";

/**
 * A picture on a sent message, in both chats: a click shows it big over the page, a removed one says so. `badge` is
 * its number (the Workshop's slides), `className` its size.
 */
export function ChatPicture({ src, name, badge, className = "size-16" }: { src: string; name: string; badge?: number; className?: string }) {
  const [gone, setGone] = useState(false);
  const [big, setBig] = useState(false);
  if (gone)
    return (
      <span className={cn("flex items-center justify-center rounded-lg border bg-muted text-muted-foreground", className)} title={`${name} (removed)`}>
        <ImageOff className="size-4" aria-label="Picture removed" />
      </span>
    );
  return (
    <>
      <button type="button" onClick={() => setBig(true)} title={name} aria-label={`Show ${name}`} className="relative cursor-zoom-in">
        <img src={src} alt={name} loading="lazy" onError={() => setGone(true)} className={cn("rounded-lg border bg-muted object-cover", className)} />
        {badge !== undefined && <span className="absolute top-0.5 left-0.5 rounded bg-black/70 px-1 text-[9px] text-white tabular-nums">{badge}</span>}
      </button>
      {big && <PictureOverlay src={src} onClose={() => setBig(false)} />}
    </>
  );
}
