import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { effectiveSavedFor, kindBadgeClass, kindLabel, thumbUrl, type InstagramPost } from "@/lib/instagram";
import type { PieceQuote } from "@/lib/workshop";
import { SOURCE_MIME } from "./ChipComposer";
import { citeQuoteOf } from "./SourceResultCard";

/**
 * The session's sources in order: click to read, arrows to reorder, × to drop. A thumbnail drags into the message
 * box as a citation, and right-click offers Cite in message (the comment box opens there, then the chip goes in).
 */
export function SelectedSourcesStrip({
  posts,
  activeId,
  onRead,
  onMove,
  onRemove,
  onCite,
}: {
  posts: InstagramPost[];
  activeId?: string | null;
  onRead: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
  onCite?: (quote: PieceQuote, at: { x: number; y: number }) => void;
}) {
  const [menu, setMenu] = useState<{ post: InstagramPost; at: { x: number; y: number } } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const off = () => setMenu(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") off();
    };
    window.addEventListener("pointerdown", off);
    window.addEventListener("scroll", off, true);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", off);
      window.removeEventListener("scroll", off, true);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  if (!posts.length) {
    return (
      <p className="rounded-lg border border-dashed border-zinc-800 px-3 py-3 text-center text-[11px] text-zinc-600">
        No sources yet — search above and add the posts worth reading.
      </p>
    );
  }
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {posts.map((p, i) => (
        <div
          key={p.id}
          className={`group relative w-[4.5rem] shrink-0 overflow-hidden rounded-md border ${
            activeId === p.id ? "border-violet-500" : "border-zinc-800"
          }`}
        >
          <button
            type="button"
            onClick={() => onRead(p.id)}
            onContextMenu={(e) => {
              if (!onCite) return;
              e.preventDefault();
              setMenu({ post: p, at: { x: e.clientX, y: e.clientY } });
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "copy";
              e.dataTransfer.setData(SOURCE_MIME, JSON.stringify(citeQuoteOf(p)));
              e.dataTransfer.setData("text/plain", citeQuoteOf(p).text);
            }}
            className="block h-24 w-full bg-zinc-800"
            title={`@${p.creator.username}`}
          >
            {p.slides[0]?.thumb ? <img src={thumbUrl(p.id, 0)} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" /> : null}
          </button>
          <span className={`absolute left-1 top-1 rounded px-1 text-[9px] font-medium ${kindBadgeClass(p.kind)}`}>{kindLabel(p.kind)}</span>
          {effectiveSavedFor(p.savedFor).includes("format") ? (
            <span className="absolute right-1 top-1 rounded bg-sky-600/85 px-1 text-[9px] font-medium text-white">F</span>
          ) : (
            <span className="absolute right-1 top-1 rounded bg-violet-600/85 px-1 text-[9px] font-medium text-white">C</span>
          )}
          <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[9px] text-zinc-200">{i + 1}</span>
          <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/70 opacity-0 transition-opacity group-hover:opacity-100">
            <button type="button" onClick={() => onMove(p.id, -1)} disabled={i === 0} className="p-1 text-zinc-300 hover:text-zinc-50 disabled:opacity-30" title="Move left">
              <ChevronLeft className="h-3 w-3" />
            </button>
            <button type="button" onClick={() => onRemove(p.id)} className="p-1 text-zinc-300 hover:text-red-300" title="Remove from session">
              <X className="h-3 w-3" />
            </button>
            <button type="button" onClick={() => onMove(p.id, 1)} disabled={i === posts.length - 1} className="p-1 text-zinc-300 hover:text-zinc-50 disabled:opacity-30" title="Move right">
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      ))}
      {menu && onCite ? (
        <div
          className="fixed z-50 rounded-lg border border-border bg-popover p-1 text-[13px] text-popover-foreground shadow-2xl"
          style={{ left: menu.at.x, top: menu.at.y }}
          onPointerDown={(e) => e.stopPropagation()} // keeps the menu open for its own click
        >
          <button
            type="button"
            onClick={() => {
              onCite(citeQuoteOf(menu.post), menu.at);
              setMenu(null);
            }}
            className="rounded-md px-2 py-1 hover:bg-muted"
          >
            Cite in message
          </button>
        </div>
      ) : null}
    </div>
  );
}
