import { useEffect, useState } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { PointMenu } from "@/components/ui/point-menu";

type Edit = "cut" | "copy" | "paste" | "selectAll";
/** `field`: a text field (Cut, Copy, Paste, Select all); otherwise selected text on the page (Copy). */
type Field = { at: { x: number; y: number }; field: boolean; picked: boolean; locked: boolean; back: () => void };

const post = (m: Edit) =>
  (window as unknown as { webkit?: { messageHandlers?: { window?: { postMessage: (m: string) => void } } } }).webkit?.messageHandlers?.window?.postMessage(m);

/** The text field (or editable text) a right-click landed in, or null. */
function textFieldOf(t: EventTarget | null): HTMLElement | null {
  const el = t instanceof Element ? t.closest<HTMLElement>("input, textarea, [contenteditable]") : null;
  if (!el) return null;
  if (el instanceof HTMLInputElement) return el.selectionStart === null ? null : el; // a checkbox, a range: no text
  return el instanceof HTMLTextAreaElement || el.isContentEditable ? el : null;
}

/** What was selected in the field at the right-click, and a way to put the focus and that selection back. */
function fieldAt(el: HTMLElement, at: { x: number; y: number }): Field {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const [a, b] = [el.selectionStart ?? 0, el.selectionEnd ?? 0];
    return { at, field: true, picked: a !== b, locked: el.readOnly || el.disabled, back: () => (el.focus(), el.setSelectionRange(a, b)) };
  }
  const sel = window.getSelection();
  const range = sel?.rangeCount && el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  return {
    at,
    field: true,
    picked: !!range && !range.collapsed,
    locked: false,
    back: () => {
      el.focus();
      if (!range) return;
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    },
  };
}

/** Text selected on the page, when the right-click landed on it: Copy puts that selection back first. */
function selectionAt(t: EventTarget | null, at: { x: number; y: number }): Field | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount || sel.isCollapsed || !(t instanceof Node)) return null;
  const range = sel.getRangeAt(0).cloneRange();
  if (!range.intersectsNode(t)) return null; // not containsNode: a paragraph holding the whole selection counts too
  return { at, field: false, picked: true, locked: true, back: () => (sel.removeAllRanges(), sel.addRange(range)) };
}

/**
 * In the Mac app every right-click menu is the page's own: a spot with no menu of its own shows none (no Back,
 * Reload, Open Link), a text field shows Cut, Copy, Paste and Select all, and selected text Copy, which the Mac app
 * does (TitleBar.swift), in place of the system's Look Up, Translate, Spelling and the rest. A plain browser keeps its own menu.
 */
export function AppMenu() {
  const [field, setField] = useState<Field | null>(null);
  useEffect(() => {
    const mark = document.documentElement.dataset;
    if (mark.macThisMac !== "1") return;
    const on = (e: MouseEvent) => {
      if (e.defaultPrevented) return; // a menu of the page's own opened there
      const el = textFieldOf(e.target);
      const at = { x: e.clientX, y: e.clientY };
      const menu = el ? fieldAt(el, at) : selectionAt(e.target, at);
      if (menu && mark.macEdit !== "1") return; // an older Mac app does no Cut, Copy or Paste: the system's menu stays
      e.preventDefault();
      setField(menu);
    };
    document.addEventListener("contextmenu", on); // bubbling, after the page's own handlers
    return () => document.removeEventListener("contextmenu", on);
  }, []);
  if (!field) return null;
  const run = (m: Edit) => () => (field.back(), post(m));
  return (
    <PointMenu at={field.at} onClose={() => setField(null)} className="w-44">
      {field.field && <DropdownMenuItem disabled={!field.picked || field.locked} onSelect={run("cut")}>Cut</DropdownMenuItem>}
      <DropdownMenuItem disabled={!field.picked} onSelect={run("copy")}>Copy</DropdownMenuItem>
      {field.field && (
        <>
          <DropdownMenuItem disabled={field.locked} onSelect={run("paste")}>Paste</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={run("selectAll")}>Select all</DropdownMenuItem>
        </>
      )}
    </PointMenu>
  );
}
