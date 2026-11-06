import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Cite: a small
 * pill where the selection ends; one click cites it into the message box.
 * Scrolling, resizing or Esc puts it away.
 */
export function SelectionPill({ at, onDismiss, children }: { at: { x: number; y: number }; onDismiss: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))}px`;
  }, [at]);
  useEffect(() => {
    const off = () => dismiss.current();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") off();
    };
    window.addEventListener("scroll", off, true);
    window.addEventListener("resize", off);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("scroll", off, true);
      window.removeEventListener("resize", off);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return createPortal(
    <div
      ref={ref}
      onPointerDown={(e) => e.preventDefault()} // keeps the selection
      className="fixed z-50 flex items-center gap-0.5 rounded-full border border-border/60 bg-popover/90 p-0.5 text-[12px] text-foreground shadow-lg backdrop-blur"
      style={{ left: at.x, top: at.y }}
    >
      {children}
    </div>,
    document.body,
  );
}

export const PILL_BUTTON = "flex items-center gap-1 rounded-full px-2 py-0.5 hover:bg-muted disabled:opacity-40";

/**
 * After Cite: "Add an optional comment…" where you clicked, then Save puts the quote (and the comment)
 * in the message box as a chip. Enter saves, Shift+Enter is a new line, Esc or a click outside cancels.
 */
export function CitePopover({ at, comment = "", onSave, onCancel }: { at: { x: number; y: number }; comment?: string; onSave: (comment: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(at.x - 12, window.innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8))}px`;
    box.current?.focus();
    box.current?.setSelectionRange(comment.length, comment.length);
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cancel.current();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, []);
  const save = () => onSave(box.current?.value.trim() ?? "");
  return createPortal(
    <div ref={ref} className="fixed z-50 flex w-80 flex-col gap-2 rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-2xl" style={{ left: at.x, top: at.y }}>
      <textarea
        ref={box}
        defaultValue={comment}
        rows={3}
        placeholder="Add an optional comment…"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
        className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-3 py-1 text-[12px] text-foreground hover:bg-muted">
          Cancel
        </button>
        <button type="button" onClick={save} className="rounded-lg bg-violet-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-violet-500">
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}
