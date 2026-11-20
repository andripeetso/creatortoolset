import { useEffect, useImperativeHandle, useRef, type CSSProperties, type Ref } from "react";
import type { TextLayer, TextStyle } from "@contracts/design";
import { lineHeightOf } from "@/lib/design/draw";
import { faceOf, weightsOf } from "@/lib/design/fonts";
import { caseOf, diffText, editRuns, pieceFont, retext, styleAt, styleRange } from "@/lib/design/runs";

/** What the canvas can ask of the words being typed: that the typing ends (and they are kept). */
export interface TypedHandle {
  end: () => void;
}

/** Where focus may go while the words are still being typed: the style panel, which styles the letters picked in them. */
const STYLE_PANEL = 'aside[aria-label="Design"]';

/** The words as typed: the text nodes, and a line break the browser put in as one ("\n"). */
function* parts(root: Node): Generator<Text | HTMLBRElement> {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) yield n as Text;
    // the break painted after a last empty line only shows it: it is no letter
    else if (n.nodeName === "BR" && !(n as HTMLElement).dataset.end) yield n as HTMLBRElement;
  }
}
const textIn = (root: Node) => [...parts(root)].map((n) => (n.nodeType === Node.TEXT_NODE ? (n as Text).data : "\n")).join("");

/** A place in the box (a node and an offset in it, as a selection gives) as a letter of the words. */
function offsetOf(root: Node, node: Node, off: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, off);
  let n = 0;
  for (const p of parts(root)) {
    if (!r.intersectsNode(p)) continue;
    if (p.nodeType === Node.TEXT_NODE) n += p === r.endContainer ? r.endOffset : (p as Text).data.length;
    else n += 1;
  }
  return n;
}
/** A letter of the words as a place in the box. */
function placeOf(root: Node, at: number): [Node, number] {
  let n = 0;
  for (const p of parts(root)) {
    if (p.nodeType === Node.TEXT_NODE) {
      const len = (p as Text).data.length;
      if (at <= n + len) return [p, at - n];
      n += len;
    } else {
      if (at <= n) return [p.parentNode!, [...p.parentNode!.childNodes].indexOf(p)];
      n += 1;
    }
  }
  return [root, root.childNodes.length];
}

/** Each run's letters as a span in its own style, beside the box's (the layer's own): as near as a browser's own text gets to the canvas. */
function paint(root: HTMLElement, l: TextLayer, scale: number, z: number, picked: { start: number; end: number } | null) {
  const cuts = new Set([0, l.text.length, ...(l.runs ?? []).flatMap((r) => [r.start, r.end]), ...(picked ? [picked.start, picked.end] : [])]);
  const at = [...cuts].filter((n) => n >= 0 && n <= l.text.length).sort((a, b) => a - b);
  const lh = l.lineHeight ?? 1.15;
  const spans: Node[] = [];
  for (let k = 0; k < at.length - 1; k++) {
    const [a, b] = [at[k]!, at[k + 1]!];
    const span = document.createElement("span");
    span.textContent = l.text.slice(a, b);
    if (picked && a >= picked.start && b <= picked.end) span.dataset.sel = "";
    const s = styleAt(l, a);
    const own = l.runs?.find((r) => r.start <= a && r.end >= b);
    if (own) {
      const face = faceOf(s.font, s.weight, s.italic);
      Object.assign(span.style, {
        fontFamily: `"${face.family}", "Inter"`,
        fontWeight: String(face.css),
        fontStyle: face.slant ? "italic" : "normal",
        fontSize: `${s.size * scale * z}px`,
        lineHeight: `${s.size * scale * z * lh}px`,
        color: s.color,
        textDecorationLine: [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || "none",
        letterSpacing: s.spacing ? `${s.spacing * z}px` : "",
      } satisfies Partial<CSSStyleDeclaration>);
    }
    spans.push(span);
  }
  // a last empty line is shown by a break after it
  if (l.text.endsWith("\n")) {
    const br = document.createElement("br");
    br.dataset.end = "1";
    spans.push(br);
  }
  root.replaceChildren(...spans);
}

/** Bold on a font's family: the next heavier face (towards bold), or back to the lighter one when it is bold already. */
function bolder(font: string, now: number): number | undefined {
  const weights = weightsOf(font);
  const lighter = weights.filter((w) => w < now);
  const heavier = weights.filter((w) => w > now);
  if (now >= 600 && lighter.length) return lighter.reduce((a, b) => (Math.abs(b - 400) < Math.abs(a - 400) ? b : a));
  if (heavier.length) return heavier.find((w) => w >= 700) ?? heavier.at(-1);
  return undefined;
}

/**
 * The words of a text layer typed in place, over the canvas (which leaves the layer out while they are). Each run is
 * shown in its own style; letters picked here are what the style panel styles, and what ⌘B, ⌘I, ⌘U and ⇧⌘X set bold,
 * slanted, underlined or struck through. Focus moving to the style panel keeps the typing on (the words so far are
 * saved); anywhere else ends it, as Escape does.
 */
export function TypedText({
  layer,
  scale,
  z,
  style,
  onSave,
  onDone,
  onSelect,
  ref,
}: {
  /** the layer as saved */
  layer: TextLayer;
  /** the size its letters are drawn at, of their own size (a text that shrinks to fit is drawn smaller) */
  scale: number;
  z: number;
  /** its place on the screen */
  style: CSSProperties;
  /** the words so far, while the typing goes on */
  onSave: (l: TextLayer) => void;
  /** the typing ended: the words as typed (their ends trimmed) */
  onDone: (l: TextLayer) => void;
  /** the letters picked, from and up to (none when only the caret is in them) */
  onSelect: (sel: { start: number; end: number } | null) => void;
  ref?: Ref<TypedHandle>;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** the words and runs as typed, ahead of the saved layer */
  const now = useRef({ text: layer.text, runs: layer.runs });
  const picked = useRef<{ start: number; end: number } | null>(null);
  const lastDown = useRef<EventTarget | null>(null);
  const ended = useRef(false);
  const latest = useRef({ layer, scale, z, onSave, onDone, onSelect });
  latest.current = { layer, scale, z, onSave, onDone, onSelect };

  const typed = (): TextLayer => {
    const { runs: _, ...rest } = latest.current.layer;
    return { ...rest, text: now.current.text, ...(now.current.runs ? { runs: now.current.runs } : {}) };
  };
  const selection = (): { start: number; end: number } | null => {
    const root = box.current;
    const s = window.getSelection();
    if (!root || !s?.rangeCount || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) return null;
    const a = offsetOf(root, s.anchorNode!, s.anchorOffset);
    const b = offsetOf(root, s.focusNode!, s.focusOffset);
    return { start: Math.min(a, b), end: Math.max(a, b) };
  };
  /** Painted again from the words as typed, the letters picked kept picked (and shown, when focus is elsewhere). */
  const repaint = (mark: boolean) => {
    const root = box.current;
    if (!root) return;
    const keep = document.activeElement === root ? selection() : null;
    const { scale, z } = latest.current;
    paint(root, typed(), scale, z, mark ? picked.current : null);
    if (keep) {
      const [an, ao] = placeOf(root, keep.start);
      const [fn, fo] = placeOf(root, keep.end);
      window.getSelection()?.setBaseAndExtent(an, ao, fn, fo);
    }
  };
  const finish = () => {
    if (ended.current) return;
    ended.current = true;
    const t = typed();
    latest.current.onDone(retext(t, t.text));
  };
  useImperativeHandle(ref, () => ({ end: () => (document.activeElement === box.current ? box.current?.blur() : finish()) }));

  // first shown: painted, every letter picked, and the keys its own without the canvas scrolling to it (a box partly
  // off the canvas would otherwise drag everything on it sideways)
  useEffect(() => {
    const root = box.current!;
    repaint(false);
    root.focus({ preventScroll: true });
    window.getSelection()?.selectAllChildren(root);
    const down = (e: PointerEvent) => void (lastDown.current = e.target);
    const moved = () => {
      const s = selection();
      if (!s) return;
      picked.current = s.end > s.start ? s : null;
      latest.current.onSelect(picked.current);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("selectionchange", moved);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("selectionchange", moved);
    };
    // painted once here; again below when the layer changes from outside
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the layer changed from outside (the style panel styled the picked letters, an undo): shown as it is now
  const runsKey = JSON.stringify(layer.runs ?? null);
  useEffect(() => {
    if (layer.text === now.current.text && runsKey === JSON.stringify(now.current.runs ?? null)) return;
    now.current = { text: layer.text, runs: layer.runs };
    repaint(document.activeElement !== box.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer.text, runsKey]);

  /** The picked letters with a switch turned (or a weight set): saved at once, one step to undo. */
  const toggle = (key: "weight" | "italic" | "underline" | "strike") => {
    const s = selection();
    if (!s || s.end <= s.start) return;
    const t = typed();
    const at = styleAt(t, s.start);
    let set: TextStyle;
    if (key === "weight") {
      const w = bolder(at.font, faceOf(at.font, at.weight, at.italic).weight);
      if (w === undefined) return;
      set = { weight: w };
    } else set = { [key]: !at[key] };
    const next = styleRange(t, s.start, s.end, set);
    now.current = { text: next.text, runs: next.runs };
    repaint(false);
    latest.current.onSave(next);
  };

  const how = caseOf(layer);
  const face = faceOf(layer.font, layer.weight, layer.italic);
  return (
    <div
      ref={box}
      role="textbox"
      aria-multiline
      aria-label="The words of this layer"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      spellCheck={false}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onInput={(e) => {
        if ((e.nativeEvent as InputEvent).isComposing) return;
        const root = e.currentTarget;
        const words = textIn(root);
        const s = selection();
        const d = diffText(now.current.text, words, s && s.start === s.end ? s.start : undefined);
        const next = editRuns(typed(), d.at, d.removed, d.inserted);
        now.current = { text: next.text, runs: next.runs };
        // the browser's own typing lands in the span it is in: painted again only when it made something else (a
        // line break of its own, a new element), so its own undo keeps working while words are only typed
        const tidy = [...root.childNodes].every((n) => n.nodeName === "SPAN" ? [...n.childNodes].every((c) => c.nodeType === Node.TEXT_NODE) : n.nodeName === "BR" && (n as HTMLElement).dataset.end);
        if (!tidy || words.endsWith("\n") !== !!root.querySelector("br[data-end]")) repaint(false);
      }}
      onCompositionEnd={(e) => e.currentTarget.dispatchEvent(new InputEvent("input", { bubbles: true }))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") return e.currentTarget.blur();
        const mod = e.metaKey || e.ctrlKey;
        const key = e.key.toLowerCase();
        const which = mod && !e.altKey ? (key === "b" && !e.shiftKey ? "weight" : key === "i" && !e.shiftKey ? "italic" : key === "u" && !e.shiftKey ? "underline" : key === "x" && e.shiftKey ? "strike" : null) : null;
        if (which) {
          e.preventDefault();
          toggle(which);
        }
      }}
      onFocus={() => (lastDown.current = null)}
      onBlur={(e) => {
        const to = e.relatedTarget ?? lastDown.current;
        if (to instanceof Element && to.closest(STYLE_PANEL)) {
          // to the style panel: the words so far saved, the picked letters shown picked while it styles them
          const t = typed();
          if (t.text.trim()) latest.current.onSave(t);
          return repaint(true);
        }
        finish();
      }}
      className="absolute overflow-hidden whitespace-pre-wrap break-words border-0 bg-transparent p-0 outline outline-1 outline-[#0d99ff] [&:not(:focus)_[data-sel]]:bg-[#0d99ff]/30"
      style={{
        ...style,
        font: pieceFont(face, layer.size * scale * z),
        fontStyle: face.slant ? "italic" : undefined,
        lineHeight: `${lineHeightOf({ ...layer, size: layer.size * scale }) * z}px`,
        letterSpacing: layer.spacing ? `${layer.spacing * z}px` : undefined,
        color: layer.color,
        textAlign: layer.align,
        textTransform: how === "upper" ? "uppercase" : how === "lower" ? "lowercase" : how === "title" ? "capitalize" : undefined,
        fontVariantCaps: how === "small" ? "small-caps" : undefined,
        textDecorationLine: [layer.underline && "underline", layer.strike && "line-through"].filter(Boolean).join(" ") || undefined,
      }}
    />
  );
}
