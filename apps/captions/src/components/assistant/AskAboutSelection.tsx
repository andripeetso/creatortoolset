import { useEffect, useRef, useState } from "react";
import { MessageCircle } from "lucide-react";
import { useMe } from "@/lib/auth";
import { useAssistant } from "@/lib/assistant";
import { DOCK } from "@/lib/page-context";

/** Places the selection can't be asked about from: the chat itself and form fields (a document editor is fine). */
const NOT_HERE = `${DOCK},input,textarea,select`;
/** Keeps the pill's middle this far from the window's sides (about half its width plus a gutter). */
const EDGE = 76;

/** The highlighted text and where it is, or null when there's nothing to ask about. */
function currentSelection(): { text: string; rect: DOMRect } | null {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  // text selected inside a field shows up here too, as an empty range where the field is (focus alone can sit in
  // a dialog's field while you highlight its title)
  if (document.activeElement?.closest(NOT_HERE) && !range.toString().trim()) return null;
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  if (!el || el.closest(NOT_HERE)) return null;
  const text = sel.toString().trim();
  const rect = range.getBoundingClientRect();
  if (!text || (!rect.width && !rect.height)) return null;
  return { text, rect };
}

/**
 * "Ask assistant": a small pill over text you highlight anywhere on the page; a click (or Cmd/Ctrl+Shift+A) sends
 * it to the dock as the quote of your next message. Gone on scroll, Escape, or when the selection goes.
 */
export function AskAboutSelection() {
  const me = useMe();
  const askAbout = useAssistant((s) => s.askAbout);
  const [at, setAt] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const text = useRef("");

  useEffect(() => {
    if (!me) return;
    let timer = 0;
    const show = () => {
      const cur = currentSelection();
      if (!cur) return setAt(null);
      text.current = cur.text;
      const below = cur.rect.top < 48;
      setAt({
        x: Math.min(Math.max(cur.rect.left + cur.rect.width / 2, EDGE), innerWidth - EDGE),
        y: below ? Math.min(cur.rect.bottom + 8, innerHeight - 44) : cur.rect.top - 8,
        below,
      });
    };
    // after the browser has settled the selection a mouseup or shift+arrow made
    const later = () => {
      clearTimeout(timer);
      timer = window.setTimeout(show, 10);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.shiftKey) later();
    };
    const onChange = () => {
      if (!currentSelection()) setAt(null);
    };
    const hide = () => setAt(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return hide();
      if (e.code === "KeyA" && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
        const cur = currentSelection();
        if (!cur) return;
        e.preventDefault();
        askAbout(cur.text);
        getSelection()?.removeAllRanges();
        hide();
      }
    };
    document.addEventListener("mouseup", later);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("keydown", onKey);
    // capture: the panes that scroll are inside the page, not the window
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mouseup", later);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [me, askAbout]);

  if (!me || !at) return null;
  return (
    <button
      type="button"
      // pressing it would otherwise clear the selection (and hide it) before the click lands
      onMouseDown={(e) => e.preventDefault()}
      // and an open dialog would take it as a press outside and close
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        askAbout(text.current);
        getSelection()?.removeAllRanges();
        setAt(null);
      }}
      title="Ask the assistant about this (⌘⇧A)"
      style={{ left: at.x, top: at.y }}
      className={
        "pointer-events-auto fixed z-[70] flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover px-3 py-1.5 text-xs font-medium text-popover-foreground shadow-lg shadow-black/20 " +
        "transition-colors hover:bg-muted motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150 " +
        (at.below ? "origin-top" : "origin-bottom -translate-y-full")
      }
    >
      <MessageCircle className="size-3.5" aria-hidden />
      Ask assistant
    </button>
  );
}
