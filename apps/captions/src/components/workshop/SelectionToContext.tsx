import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pin } from "lucide-react";
import type { ContextField, ContextSnippet } from "@/lib/workshop";

/**
 * Wraps the reader. Any element inside carrying data-ctx (JSON: postId,
 * handle, slide?, field) makes a text selection pinnable: a chip appears
 * at the selection, and pinning keeps the text with its provenance.
 */
export function SelectionToContext({ onPin, children }: { onPin: (snippet: ContextSnippet) => void; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [chip, setChip] = useState<{ top: number; left: number; snippet: ContextSnippet } | null>(null);

  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      const root = wrap.current;
      if (!sel || !root || sel.rangeCount === 0 || sel.isCollapsed) {
        setChip(null);
        return;
      }
      const text = sel.toString().replace(/\s+/g, " ").trim();
      if (text.length < 3) {
        setChip(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const el = node instanceof Element ? node : node.parentElement;
      const host = el?.closest<HTMLElement>("[data-ctx]");
      if (!host || !root.contains(host)) {
        setChip(null);
        return;
      }
      let ctx: Partial<ContextSnippet> | null = null;
      try {
        ctx = JSON.parse(host.dataset.ctx ?? "") as Partial<ContextSnippet>;
      } catch {
        ctx = null;
      }
      if (!ctx?.postId || !ctx.field) {
        setChip(null);
        return;
      }
      const r = range.getBoundingClientRect();
      const w = root.getBoundingClientRect();
      setChip({
        top: Math.max(4, r.top - w.top + root.scrollTop - 30),
        left: Math.min(Math.max(4, r.left - w.left), Math.max(4, w.width - 170)),
        snippet: { postId: ctx.postId, handle: ctx.handle ?? "creator", slide: ctx.slide, field: ctx.field as ContextField, text: text.slice(0, 1200) },
      });
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  return (
    <div ref={wrap} className="relative">
      {children}
      {chip && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onPin(chip.snippet);
            window.getSelection()?.removeAllRanges();
            setChip(null);
          }}
          style={{ top: chip.top, left: chip.left }}
          className="absolute z-30 flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white shadow-lg hover:bg-violet-500"
        >
          <Pin className="h-3 w-3" /> Add to AI context
        </button>
      )}
    </div>
  );
}
