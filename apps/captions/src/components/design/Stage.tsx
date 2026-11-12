import { useEffect, useRef, useState } from "react";
import type { DesignPage, Layer, TextLayer } from "@contracts/design";
import { drawPage, fontOf, layerAt, lineHeightOf, type Loaded } from "@/lib/design/draw";

/**
 * The page as it will be saved, and the hands on it: click a layer to pick it, drag to move it (it catches on the
 * page's edges and middle; Shift keeps it on one axis), drag a corner or a side to resize it (Shift keeps its shape),
 * double-click words to type in place. A turned layer moves but has no resize handles: its size is typed in the panel.
 */

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type Handle = (typeof HANDLES)[number];
const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
/** How near (in screen pixels) an edge or the middle catches a moving layer. */
const SNAP = 6;
const MIN = 8;

export function Stage({
  page,
  width,
  height,
  scale,
  loaded,
  version,
  selected,
  onSelect,
  onLive,
  onCommit,
  editing,
  onEdit,
}: {
  page: DesignPage;
  width: number;
  height: number;
  /** screen pixels per design pixel */
  scale: number;
  loaded: Loaded;
  /** moves when a picture or a font finished loading, so the page is drawn again */
  version: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** the page while a drag is under way (not a step to undo) */
  onLive: (page: DesignPage | null) => void;
  /** the page once a drag or an edit ends (one step to undo) */
  onCommit: (page: DesignPage) => void;
  /** the text layer being typed in */
  editing: string | null;
  onEdit: (id: string | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const sel = page.layers.find((l) => l.id === selected) ?? null;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * scale * dpr);
    c.height = Math.round(height * scale * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    // the words being typed are in the box over the page: the layer itself is not drawn under them
    drawPage(ctx, editing ? { ...page, layers: page.layers.filter((l) => l.id !== editing) } : page, width, height, loaded);
  }, [page, width, height, scale, loaded, version, editing]);

  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const withLayer = (l: Layer): DesignPage => ({ ...page, layers: page.layers.map((x) => (x.id === l.id ? l : x)) });

  /** Follows the pointer until it lifts: `to` gives the layer for a pointer's page position. */
  const drag = (e: React.PointerEvent, to: (p: { x: number; y: number }, shift: boolean) => Layer) => {
    e.preventDefault();
    let last: DesignPage | null = null;
    const move = (ev: PointerEvent) => {
      last = withLayer(to(at(ev), ev.shiftKey));
      onLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGuides({});
      onLive(null);
      if (last) onCommit(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startMove = (e: React.PointerEvent, l: Layer) => {
    const from = at(e);
    drag(e, (p, shift) => {
      let dx = p.x - from.x;
      let dy = p.y - from.y;
      if (shift) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      let x = l.x + dx;
      let y = l.y + dy;
      const near = SNAP / scale;
      const g: { x?: number; y?: number } = {};
      // its left edge, middle and right edge against the page's; the same down the page
      for (const [mine, theirs] of [[x, 0], [x + l.w / 2, width / 2], [x + l.w, width]] as const) if (g.x === undefined && Math.abs(mine - theirs) < near) (x += theirs - mine), (g.x = theirs);
      for (const [mine, theirs] of [[y, 0], [y + l.h / 2, height / 2], [y + l.h, height]] as const) if (g.y === undefined && Math.abs(mine - theirs) < near) (y += theirs - mine), (g.y = theirs);
      setGuides(g);
      return { ...l, x: Math.round(x), y: Math.round(y) };
    });
  };

  const startResize = (e: React.PointerEvent, l: Layer, h: Handle) => {
    e.stopPropagation();
    const from = at(e);
    drag(e, (p, shift) => {
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      let { x, y, w, h: hh } = l;
      if (h.includes("e")) w = Math.max(MIN, l.w + dx);
      if (h.includes("s")) hh = Math.max(MIN, l.h + dy);
      if (h.includes("w")) (w = Math.max(MIN, l.w - dx)), (x = l.x + l.w - w);
      if (h.includes("n")) (hh = Math.max(MIN, l.h - dy)), (y = l.y + l.h - hh);
      if (shift && h.length === 2) {
        // a corner with Shift keeps the shape: the side that moved more leads
        const k = Math.max(w / l.w, hh / l.h);
        (w = l.w * k), (hh = l.h * k);
        if (h.includes("w")) x = l.x + l.w - w;
        if (h.includes("n")) y = l.y + l.h - hh;
      }
      return { ...l, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) };
    });
  };

  const box = (l: Layer): React.CSSProperties => ({ left: l.x * scale, top: l.y * scale, width: l.w * scale, height: l.h * scale, transform: l.rotate ? `rotate(${l.rotate}deg)` : undefined });
  const typed = page.layers.find((l): l is TextLayer => l.id === editing && l.type === "text");

  return (
    <div className="relative shrink-0 shadow-xl" style={{ width: width * scale, height: height * scale }}>
      <canvas ref={canvas} aria-label="The page" className="block h-full w-full" />
      <div
        role="application"
        aria-label="Layers on the page"
        className="absolute inset-0 touch-none select-none"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          // a press beside the words being typed ends the typing and keeps them (a drag keeps the focus where it is,
          // so the box is told to let go itself); it picks or moves nothing
          if (typing.current) return typing.current.blur();
          const p = at(e);
          const hit = layerAt(page, p.x, p.y);
          onSelect(hit?.id ?? null);
          if (hit) startMove(e, hit);
        }}
        onDoubleClick={(e) => {
          const p = at(e);
          const hit = layerAt(page, p.x, p.y);
          if (hit?.type === "text") onEdit(hit.id);
        }}
      >
        {guides.x !== undefined && <div className="pointer-events-none absolute inset-y-0 w-px bg-violet-500" style={{ left: guides.x * scale }} />}
        {guides.y !== undefined && <div className="pointer-events-none absolute inset-x-0 h-px bg-violet-500" style={{ top: guides.y * scale }} />}
        {sel && !typed && (
          <div className="pointer-events-none absolute outline outline-2 outline-violet-500" style={box(sel)}>
            {!sel.rotate &&
              HANDLES.map((h) => (
                <span
                  key={h}
                  data-handle={h}
                  onPointerDown={(e) => e.button === 0 && startResize(e, sel, h)}
                  className="pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-violet-500 bg-white"
                  style={{ left: h.includes("w") ? 0 : h.includes("e") ? "100%" : "50%", top: h.includes("n") ? 0 : h.includes("s") ? "100%" : "50%", cursor: CURSOR[h] }}
                />
              ))}
          </div>
        )}
      </div>
      {typed && (
        <textarea
          ref={typing}
          autoFocus
          aria-label="The words of this layer"
          defaultValue={typed.text}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
            e.stopPropagation();
          }}
          onBlur={(e) => {
            const text = e.currentTarget.value.replace(/\r\n/g, "\n").trim();
            onEdit(null);
            // words taken out whole: the layer goes with them
            if (text !== typed.text) onCommit(text ? withLayer({ ...typed, text }) : { ...page, layers: page.layers.filter((l) => l.id !== typed.id) });
          }}
          className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline outline-2 outline-violet-500"
          style={{ ...box(typed), font: fontOf(typed, scale), lineHeight: `${lineHeightOf(typed) * scale}px`, color: typed.color, textAlign: typed.align, textTransform: typed.upper ? "uppercase" : undefined }}
        />
      )}
    </div>
  );
}

/** A small picture of a page, for the list of pages. */
export function PageThumb({ page, width, height, loaded, version, size = 88 }: { page: DesignPage; width: number; height: number; loaded: Loaded; version: number; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const k = size / width;
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * k * dpr);
    c.height = Math.round(height * k * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    drawPage(ctx, page, width, height, loaded);
  }, [page, width, height, loaded, version, k]);
  return <canvas ref={canvas} aria-hidden className="block rounded-sm" style={{ width: size, height: height * k }} />;
}
