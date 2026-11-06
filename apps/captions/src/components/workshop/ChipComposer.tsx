import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { PieceQuote } from "@/lib/workshop";
import { thumbUrl } from "@/lib/instagram";

/**
 * The Workshop's message box with citations inside the text.
 * Its value is plain text where ⟦<quote id>⟧ stands for a chip; chips are cut, copied, pasted, dragged and deleted
 * like a character. The DOM is ours, not React's: React renders the empty box once.
 */

export const TOKEN = /⟦([^⟦⟧]+)⟧/g;
const MIME = "application/x-ct-composer";
/** A session source or a search card dragged in: its PieceQuote as JSON (no id yet). */
export const SOURCE_MIME = "application/x-ct-source";
const newId = () => `q${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

export interface ComposerHandle {
  focus: () => void;
  /** Put a chip where the caret was (or at the end), a space after it. */
  insertQuote: (id: string) => void;
  /** Text at the end (a paste that landed while nothing was focused). */
  appendText: (t: string) => void;
}

const ICON = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const QUOTE_ICON = ICON('<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>');
const PENCIL_ICON = ICON('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>');
const X_ICON = ICON('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** The box's DOM → its value: text, a newline per <br> or block, ⟦id⟧ per chip. */
export function serialize(root: Node): string {
  let out = "";
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n.textContent ?? "").replace(/\u00a0/g, " ");
    else if (n instanceof HTMLElement) {
      if (n.dataset.qid) out += `⟦${n.dataset.qid}⟧`;
      else if (n.tagName === "BR") out += "\n";
      else {
        const block = n.tagName === "DIV" || n.tagName === "P";
        if (block && out && !out.endsWith("\n")) out += "\n";
        out += serialize(n);
      }
    }
  });
  return out;
}

/** The value with each chip as “its words”, for the clipboard outside the box and for the queue's preview. */
export const readable = (value: string, quotes: PieceQuote[]) =>
  value.replace(TOKEN, (_, id: string) => {
    const q = quotes.find((x) => x.id === id);
    return q ? `“${q.text}”` : "";
  });

function paintChip(chip: HTMLElement, q: PieceQuote) {
  const label = q.handle ? `@${q.handle} · ${q.text}` : q.text;
  chip.title = `“${label}”${q.comment ? `\n\nYour comment: ${q.comment}` : ""}`;
  // a video shows its thumbnail, a piece's words the quote mark
  const icon = q.postId
    ? `<img src="${esc(thumbUrl(q.postId, 0))}" alt="" class="h-4 w-4 shrink-0 rounded-sm object-cover" />`
    : `<span class="shrink-0 text-violet-300">${QUOTE_ICON}</span>`;
  chip.innerHTML =
    icon +
    `<span class="truncate">${esc(label)}</span>` +
    (q.comment ? `<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300"></span>` : "") +
    `<button type="button" data-act="edit" class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Edit comment">${PENCIL_ICON}</button>` +
    `<button type="button" data-act="remove" class="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Remove citation">${X_ICON}</button>`;
}

function makeChip(q: PieceQuote): HTMLElement {
  const chip = document.createElement("span");
  chip.dataset.qid = q.id;
  chip.contentEditable = "false";
  chip.draggable = true;
  chip.className = "mx-0.5 inline-flex max-w-[16rem] cursor-grab select-none items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/10 px-1.5 py-px align-[-2px] text-[12px] leading-5 text-foreground";
  paintChip(chip, q);
  return chip;
}

/** value → nodes (a chip whose quote is gone is dropped). */
function nodesFor(value: string, quotes: PieceQuote[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const text = (t: string) =>
    t.split("\n").forEach((line, i) => {
      if (i) frag.appendChild(document.createElement("br"));
      if (line) frag.appendChild(document.createTextNode(line));
    });
  let at = 0;
  for (const m of value.matchAll(TOKEN)) {
    text(value.slice(at, m.index));
    const q = quotes.find((x) => x.id === m[1]);
    if (q) frag.appendChild(makeChip(q));
    at = m.index! + m[0].length;
  }
  text(value.slice(at));
  // a newline at the very end needs a second <br> to show as a line
  if (value.endsWith("\n")) frag.appendChild(document.createElement("br"));
  return frag;
}

function caretAtEnd(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

function rangeAt(x: number, y: number): Range | null {
  const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const p = d.caretPositionFromPoint?.(x, y);
  if (!p) return null;
  const r = document.createRange();
  r.setStart(p.offsetNode, p.offset);
  return r;
}

export const ChipComposer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (value: string) => void;
    quotes: PieceQuote[];
    placeholder: string;
    disabled?: boolean;
    onEnter: () => void;
    /** Pictures and big pastes: true when the parent took the paste. */
    onPasteFirst: (e: React.ClipboardEvent) => boolean;
    onEditQuote: (id: string, at: { x: number; y: number }) => void;
    onRemoveQuote: (id: string) => void;
    /** A video dragged in: the page keeps the citation (its chip is already in the words). */
    onAddQuote?: (q: PieceQuote) => void;
    className?: string;
  }
>(function ChipComposer({ value, onChange, quotes, placeholder, disabled, onEnter, onPasteFirst, onEditQuote, onRemoveQuote, onAddQuote, className }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const dragging = useRef<HTMLElement | null>(null);
  const [empty, setEmpty] = useState(!value);
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;

  const emit = () => {
    const v = serialize(el.current!);
    setEmpty(!v);
    onChange(v);
  };
  const remember = () => {
    const s = window.getSelection();
    if (s?.rangeCount && el.current?.contains(s.anchorNode)) saved.current = s.getRangeAt(0).cloneRange();
  };
  /** Insert nodes at the caret (or the saved one, or the end) and put the caret after them. */
  const insert = (frag: DocumentFragment, r?: Range | null) => {
    const box = el.current!;
    const range = r ?? (saved.current && box.contains(saved.current.startContainer) ? saved.current : null);
    const last = frag.lastChild;
    if (range) {
      range.deleteContents();
      range.insertNode(frag);
    } else box.appendChild(frag);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(after);
      saved.current = after.cloneRange();
    }
    emit();
  };

  // the value changed from outside (a send cleared it, Undo or Edit put words back): redraw
  useLayoutEffect(() => {
    const box = el.current;
    if (!box || serialize(box) === value) return;
    box.replaceChildren(nodesFor(value, quotesRef.current));
    setEmpty(!value);
    if (document.activeElement === box) caretAtEnd(box);
  }, [value]);
  // a comment changed: repaint the chips in place (the caret stays)
  useEffect(() => {
    el.current?.querySelectorAll<HTMLElement>("[data-qid]").forEach((c) => {
      const q = quotes.find((x) => x.id === c.dataset.qid);
      if (q) paintChip(c, q);
    });
  }, [quotes]);
  useEffect(() => {
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => {
      const box = el.current;
      if (!box) return;
      box.focus();
      if (saved.current && box.contains(saved.current.startContainer)) {
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(saved.current);
      } else caretAtEnd(box);
    },
    insertQuote: (id) => {
      const q = quotesRef.current.find((x) => x.id === id);
      if (!q || !el.current) return;
      el.current.focus();
      const frag = document.createDocumentFragment();
      frag.append(makeChip(q), document.createTextNode(" "));
      insert(frag);
    },
    appendText: (t) => {
      const box = el.current;
      if (!box) return;
      box.focus();
      caretAtEnd(box);
      document.execCommand("insertText", false, t);
    },
  }));

  const copySelection = (e: React.ClipboardEvent, cut: boolean) => {
    const s = window.getSelection();
    if (!s?.rangeCount || s.isCollapsed) return;
    const holder = document.createElement("div");
    holder.appendChild(s.getRangeAt(0).cloneContents());
    const v = serialize(holder);
    if (!TOKEN.test(v)) return; // plain words: the browser copies them as usual
    TOKEN.lastIndex = 0;
    e.preventDefault();
    e.clipboardData.setData(MIME, v);
    e.clipboardData.setData("text/plain", readable(v, quotesRef.current));
    if (cut) {
      s.getRangeAt(0).deleteContents();
      emit();
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      {empty ? <span className="pointer-events-none absolute left-2 top-1.5 text-[15px] text-muted-foreground">{placeholder}</span> : null}
      <div
        ref={el}
        role="textbox"
        aria-multiline="true"
        aria-label="Message"
        aria-disabled={disabled}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={emit}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (e.shiftKey) document.execCommand("insertLineBreak");
          else onEnter();
        }}
        onPaste={(e) => {
          if (onPasteFirst(e)) return;
          const v = e.clipboardData.getData(MIME);
          if (v) {
            e.preventDefault();
            const s = window.getSelection();
            insert(nodesFor(v, quotesRef.current), s?.rangeCount ? s.getRangeAt(0) : null);
            return;
          }
          const t = e.clipboardData.getData("text/plain");
          if (!t) return;
          e.preventDefault();
          document.execCommand("insertText", false, t);
        }}
        onCopy={(e) => copySelection(e, false)}
        onCut={(e) => copySelection(e, true)}
        onDragStart={(e) => {
          const chip = (e.target as HTMLElement).closest<HTMLElement>("[data-qid]");
          if (!chip) return;
          dragging.current = chip;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(MIME, `⟦${chip.dataset.qid}⟧`);
          e.dataTransfer.setData("text/plain", readable(`⟦${chip.dataset.qid}⟧`, quotesRef.current));
        }}
        onDragOver={(e) => {
          if (!dragging.current && !e.dataTransfer.types.includes(SOURCE_MIME)) return;
          e.preventDefault(); // a chip of ours or a dragged video may land here
          e.dataTransfer.dropEffect = dragging.current ? "move" : "copy";
        }}
        onDragEnd={() => (dragging.current = null)}
        onDrop={(e) => {
          const chip = dragging.current;
          const source = e.dataTransfer.getData(SOURCE_MIME);
          if (!chip && source) {
            // a video: an inline chip where it was dropped (the pencil adds a comment)
            e.preventDefault();
            e.stopPropagation();
            const r = rangeAt(e.clientX, e.clientY);
            if (!r || !el.current?.contains(r.startContainer)) return;
            const q = { ...(JSON.parse(source) as PieceQuote), id: newId() };
            const frag = document.createDocumentFragment();
            frag.append(makeChip(q), document.createTextNode(" "));
            insert(frag, r);
            onAddQuote?.(q);
            return;
          }
          if (!chip) return; // files and outside text: the parent and the browser handle them
          e.preventDefault();
          e.stopPropagation();
          const r = rangeAt(e.clientX, e.clientY);
          if (!r || !el.current?.contains(r.startContainer)) return;
          chip.remove();
          const frag = document.createDocumentFragment();
          frag.append(chip);
          insert(frag, r);
          dragging.current = null;
        }}
        onClick={(e) => {
          const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
          const chip = btn?.closest<HTMLElement>("[data-qid]");
          if (!btn || !chip?.dataset.qid) return;
          e.preventDefault();
          if (btn.dataset.act === "edit") {
            const r = btn.getBoundingClientRect();
            onEditQuote(chip.dataset.qid, { x: r.left, y: r.top - 150 });
          } else {
            chip.remove();
            emit();
            onRemoveQuote(chip.dataset.qid);
          }
        }}
        className={`max-h-60 min-h-[4.5rem] overflow-y-auto whitespace-pre-wrap break-words px-2 py-1.5 text-[15px] leading-relaxed text-foreground outline-none aria-disabled:opacity-60 ${className ?? ""}`}
      />
    </div>
  );
});

/**
 * What goes to the server: the chips in the order they stand become ⟦1⟧, ⟦2⟧… in the words, and the quotes in that
 * order (a chip pasted twice is one quote, both places say its number).
 */
export function numbered(value: string, quotes: PieceQuote[]): { text: string; quotes: PieceQuote[] } {
  const order: string[] = [];
  const text = value.replace(TOKEN, (_, id: string) => {
    if (!quotes.some((q) => q.id === id)) return "";
    if (!order.includes(id)) order.push(id);
    return `⟦${order.indexOf(id) + 1}⟧`;
  });
  return { text, quotes: order.map((id) => quotes.find((q) => q.id === id)!) };
}
