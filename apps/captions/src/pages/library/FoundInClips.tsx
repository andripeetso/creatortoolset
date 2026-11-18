import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { SearchHit } from "@contracts/library";
import { cn } from "@/lib/utils";
import { clock, frameAt, frameStyle } from "./ClipCards";

const MAX_WORDS = 7;

/** A search hit's line cut to a few words: the clause naming a searched word (else the first), at most MAX_WORDS around it. */
export function shortLine(snippet: string, words: string): string {
  const asked = words.toLowerCase().split(/\s+/).filter(Boolean);
  const named = (s: string) => asked.some((w) => s.toLowerCase().includes(w));
  const parts = snippet
    .replace(/^[\s…]+|[\s…]+$/g, "")
    .split(/\.+\s+|[,;:]\s+|\s+(?:and|while|showing|then|as)\s+/i)
    .map((p) => p.trim().replace(/[.…]+$/, ""))
    .filter((p) => p && !/^sound$/i.test(p));
  const part = parts.find(named) ?? parts[0] ?? "";
  const list = part.split(/\s+/);
  if (list.length <= MAX_WORDS) return part;
  const at = Math.max(0, list.findIndex(named));
  const from = Math.max(0, Math.min(at - 2, list.length - MAX_WORDS));
  return `${from ? "…" : ""}${list.slice(from, from + MAX_WORDS).join(" ")}…`;
}

/** The moments a search found inside clips (lines said, shots seen), closed until opened: a picture of each moment, a few words, the clip. */
export function FoundInClips({ hits, words, onOpen }: { hits: SearchHit[]; words: string; onOpen: (h: SearchHit) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Found in clips" className="rounded-xl border border-zinc-500/20">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium">
        <ChevronRight className={cn("h-4 w-4 text-zinc-500 transition-transform", open && "rotate-90")} />
        Found in clips <span className="font-normal text-zinc-500">{hits.length}</span>
      </button>
      {open && (
        <div className="flex max-h-96 flex-col gap-0.5 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]">
          {hits.map((h, i) => {
            const a = h.asset;
            const sprite = a.spriteUrl && a.durationS ? a.spriteUrl : undefined;
            return (
              <button
                key={`${a.versionId}-${i}`}
                type="button"
                onClick={() => onOpen(h)}
                className="flex items-center gap-3 rounded-md p-1 text-left text-sm hover:bg-zinc-500/10"
              >
                <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-zinc-500/15">
                  {sprite ? (
                    <span className="absolute inset-0" style={frameStyle(sprite, frameAt((h.seconds ?? 0) / a.durationS!))} />
                  ) : (
                    a.thumbUrl && <img src={a.thumbUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
                  )}
                  <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 font-mono text-[10px] text-white">{clock(h.seconds ?? 0)}</span>
                </span>
                <span className="min-w-0 flex-1 truncate">{shortLine(h.snippet ?? "", words)}</span>
                <span className="max-w-[35%] shrink-0 truncate text-xs text-zinc-500">{a.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
