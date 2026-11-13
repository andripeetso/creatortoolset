import { useEffect, useRef, useState, type ReactNode } from "react";
import { DESIGN_LIMITS, type DesignPage, type Layer, type TextLayer } from "@contracts/design";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { drawPage, fontOf, layerAt, lineHeightOf, type Loaded } from "@/lib/design/draw";
import { boundsOf, freshIds, intersects, pageLeft, pageName, resizeAll, resizeBox, snapMove, zoomAt, type Handle, type Rect, type View } from "@/lib/design/hands";
import { cn } from "@/lib/utils";

/**
 * The canvas: every page of the design in a row, each drawn as it will be saved, and the hands on them.
 *   Move tool   click picks a layer (Shift adds or takes one), a drag moves what is picked (it catches on the page's
 *               and the other layers' edges and middles; Shift keeps one axis, Alt drags a copy), a drag from empty
 *               canvas draws a box round the layers to pick, a double click on words types in place, a page's name
 *               picks the page.
 *   Handles     a corner or a side resizes about the opposite one (Shift keeps the shape, Alt the middle), through the
 *               layer's rotation; just outside a corner turns it (Shift: steps of 15°). Several layers resize together.
 *   The view    the wheel scrolls, ⌘ or Ctrl with the wheel (or a pinch) zooms about the pointer, Space or the hand
 *               tool or the middle button drags the canvas.
 */

export type Tool = "move" | "hand" | "rect" | "ellipse" | "text";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
/** How near (in screen pixels) a line catches a moving layer. */
const SNAP = 6;
/** No layer is resized smaller than this, in design pixels. */
const MIN = 8;
const BLUE = "#0d99ff";
const TURN = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="5"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></g><g stroke="#000" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></g></svg>')}") 11 11, crosshair`;

type Point = { x: number; y: number };

export function Stage({
  pages,
  at,
  width,
  height,
  room,
  view,
  onView,
  loaded,
  version,
  selected,
  framed,
  onPick,
  onLive,
  onCommit,
  tool,
  onMake,
  editing,
  onEdit,
  pointed,
  dropper,
  menu,
}: {
  /** the pages as shown: the one being dragged is its live self */
  pages: DesignPage[];
  /** the page the picked layers are on */
  at: number;
  width: number;
  height: number;
  /** the canvas's size on the screen */
  room: { w: number; h: number };
  view: View;
  onView: (v: View) => void;
  loaded: Loaded;
  /** moves when a picture or a font finished loading, so the pages are drawn again */
  version: number;
  selected: string[];
  /** the page itself is picked (by its name) */
  framed: boolean;
  onPick: (at: number, ids: string[], framed?: boolean) => void;
  /** a page while a drag is under way (not a step to undo) */
  onLive: (page: DesignPage | null) => void;
  /** a page once a drag or an edit ends (one step to undo) */
  onCommit: (page: DesignPage) => void;
  tool: Tool;
  /** a box drawn with a making tool, in its page's pixels; `dragged` false: a click, the box has no size */
  onMake: (at: number, box: Rect, dragged: boolean) => void;
  /** the text layer being typed in */
  editing: string | null;
  onEdit: (id: string | null) => void;
  /** a layer pointed at in the layers list */
  pointed: string | null;
  /** the dropper is out: a press on the canvas gives it the colour under the pointer, and picks nothing */
  dropper: ((hex: string) => void) | null;
  /** the right-click menu's content */
  menu: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const [guides, setGuides] = useState<{ k: number; x?: number; y?: number } | null>(null);
  const [band, setBand] = useState<Rect | null>(null);
  const [drawn, setDrawn] = useState<(Rect & { k: number }) | null>(null);
  const [hover, setHover] = useState<{ k: number; id: string } | null>(null);
  const [space, setSpace] = useState(false);
  // the view as of the last event: two wheel ticks before the next drawing both count
  const live = useRef(view);
  useEffect(() => void (live.current = view), [view]);
  const show = useRef(onView);
  useEffect(() => void (show.current = onView), [onView]);
  const setView = (v: View) => ((live.current = v), show.current(v));

  const page = pages[at];
  const picked = page ? page.layers.filter((l) => selected.includes(l.id)) : [];
  const typed = page?.layers.find((l): l is TextLayer => l.id === editing && l.type === "text");

  // the words to type get the keys without the canvas scrolling to them: a box partly off the canvas would otherwise
  // drag everything on it sideways, and the pointer would then be off by that much (found in a real browser)
  const typedId = typed?.id;
  useEffect(() => {
    typing.current?.focus({ preventScroll: true });
    typing.current?.select();
  }, [typedId]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(room.w * dpr);
    const ch = Math.round(room.h * dpr);
    if (c.width !== cw) c.width = cw;
    if (c.height !== ch) c.height = ch;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    pages.forEach((p, k) => {
      const left = view.x + pageLeft(k, width) * view.z;
      if (left > room.w || left + width * view.z < 0 || view.y > room.h || view.y + height * view.z < 0) return;
      ctx.save();
      ctx.setTransform(view.z * dpr, 0, 0, view.z * dpr, left * dpr, view.y * dpr);
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.clip();
      // the words being typed are in the box over the page: the layer itself is not drawn under them
      drawPage(ctx, editing && k === at ? { ...p, layers: p.layers.filter((l) => l.id !== editing) } : p, width, height, loaded);
      ctx.restore();
    });
  }, [pages, at, width, height, room, view, loaded, version, editing]);

  // the wheel and the pinch are the canvas's own: a plain listener, since React's cannot stop the browser's zoom
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const spot = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = live.current;
      if (e.ctrlKey || e.metaKey) return setView(zoomAt(v, v.z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01), ...spot(e)));
      // a wheel with Shift scrolls sideways
      const side = e.shiftKey && !e.deltaX;
      setView({ ...v, x: v.x - (side ? e.deltaY : e.deltaX), y: v.y - (side ? 0 : e.deltaY) });
    };
    // Safari's pinch: its own events, with the scale since the pinch began
    let from = 1;
    const pinch = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      if (e.type === "gesturestart") from = live.current.z;
      else setView(zoomAt(live.current, from * g.scale, ...spot(g)));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("gesturestart", pinch);
    el.addEventListener("gesturechange", pinch);
    return () => {
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("gesturestart", pinch);
      el.removeEventListener("gesturechange", pinch);
    };
    // setView reads the newest onView itself
  }, []);

  // Space held: the pointer drags the canvas. Only while nothing else has the keys (a field, a button)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.type === "keyup") return setSpace(false);
      const a = document.activeElement;
      if (a && a !== document.body && a !== box.current) return;
      e.preventDefault();
      setSpace(true);
    };
    const off = () => setSpace(false);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", off);
    };
  }, []);

  /** The pointer's place on the canvas, in design pixels from the first page's corner. */
  const world = (e: { clientX: number; clientY: number }): Point => {
    const r = box.current!.getBoundingClientRect();
    const v = live.current;
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  };
  const pageUnder = (p: Point) => pages.findIndex((_, k) => p.x >= pageLeft(k, width) && p.x <= pageLeft(k, width) + width && p.y >= 0 && p.y <= height);
  const hitAt = (k: number, p: Point) => (k >= 0 ? layerAt(pages[k]!, p.x - pageLeft(k, width), p.y) : null);

  // a drag under way when the canvas goes away ends there, with its listeners
  const dragging = useRef<(() => void) | null>(null);
  useEffect(() => () => dragging.current?.(), []);

  /** Follows the pointer until it lifts. Nothing moves before the pointer has: a click is not a drag. */
  const drag = (e: React.PointerEvent, move: (ev: PointerEvent) => void, up: (moved: boolean) => void = () => {}) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      moved = true;
      move(ev);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      dragging.current = null;
      up(moved);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // the pointer taken away (a system gesture, the window losing it) ends the drag where it was
    window.addEventListener("pointercancel", onUp);
    dragging.current = onUp;
  };
  const withLayers = (p: DesignPage, next: readonly Layer[]): DesignPage => ({ ...p, layers: p.layers.map((l) => next.find((n) => n.id === l.id) ?? l) });

  const pan = (e: React.PointerEvent) => {
    const v0 = live.current;
    const x0 = e.clientX;
    const y0 = e.clientY;
    drag(e, (ev) => setView({ ...v0, x: v0.x + ev.clientX - x0, y: v0.y + ev.clientY - y0 }));
  };

  const move = (e: React.PointerEvent, k: number, ids: string[], hit: string) => {
    const p = pages[k]!;
    const from = world(e);
    // a layer locked while it was picked stays where it is
    const moving = p.layers.filter((l) => ids.includes(l.id) && !l.locked);
    if (!moving.length) return;
    // Alt drags a copy and leaves the layer where it was (not past what a page can hold)
    const copies = e.altKey && p.layers.length + moving.length <= DESIGN_LIMITS.layers ? freshIds(p, moving.length) : null;
    const b0 = boundsOf(moving);
    const targets: Rect[] = [{ x: 0, y: 0, w: width, h: height }, ...p.layers.filter((l) => !l.hidden && !ids.includes(l.id)).map((l) => boundsOf([l]))];
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        let dx = to.x - from.x;
        let dy = to.y - from.y;
        const flat = ev.shiftKey && Math.abs(dx) > Math.abs(dy);
        if (ev.shiftKey && flat) dy = 0;
        else if (ev.shiftKey) dx = 0;
        const s = snapMove({ ...b0, x: b0.x + dx, y: b0.y + dy }, targets, SNAP / live.current.z);
        // the axis Shift holds still catches on nothing
        const sx = ev.shiftKey && !flat ? undefined : s.x;
        const sy = ev.shiftKey && flat ? undefined : s.y;
        dx = Math.round(dx + (sx === undefined ? 0 : s.dx));
        dy = Math.round(dy + (sy === undefined ? 0 : s.dy));
        setGuides({ k, x: sx, y: sy });
        const next = moving.map((l, n) => ({ ...l, x: l.x + dx, y: l.y + dy, ...(copies ? { id: copies[n]! } : {}) }));
        last = copies ? { ...p, layers: [...p.layers, ...next] } : withLayers(p, next);
        onLive(last);
      },
      (moved) => {
        setGuides(null);
        onLive(null);
        if (last) {
          onCommit(last);
          if (copies) onPick(k, copies);
        } else if (!moved && ids.length > 1) onPick(k, [hit]); // a click on one of several picked: that one alone
      },
    );
  };

  const marquee = (e: React.PointerEvent, k: number) => {
    const from = world(e);
    let r: Rect | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        r = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
        setBand(r);
      },
      () => {
        setBand(null);
        const home = k >= 0 ? k : at;
        // the page the box began on first, then the others: the first with a layer in the box
        for (const m of r ? [home, ...pages.map((_, n) => n).filter((n) => n !== home)] : []) {
          const inPage = { ...r!, x: r!.x - pageLeft(m, width) };
          const ids = pages[m]!.layers.filter((l) => !l.hidden && !l.locked && intersects(boundsOf([l]), inPage)).map((l) => l.id);
          if (ids.length) return onPick(m, ids);
        }
        onPick(home, []);
      },
    );
  };

  const make = (e: React.PointerEvent, k: number) => {
    const from = world(e);
    const left = pageLeft(k, width);
    let r: Rect | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        let w = Math.abs(to.x - from.x);
        let h = Math.abs(to.y - from.y);
        if (ev.shiftKey) w = h = Math.max(w, h);
        r = { x: (to.x < from.x ? from.x - w : from.x) - left, y: to.y < from.y ? from.y - h : from.y, w, h };
        setDrawn({ k, ...r });
      },
      () => {
        setDrawn(null);
        onMake(k, r ?? { x: from.x - left, y: from.y, w: 0, h: 0 }, !!r);
      },
    );
  };

  const resize = (e: React.PointerEvent, h: Handle) => {
    e.stopPropagation();
    if (e.button !== 0 || !page) return;
    const from = world(e);
    const one = picked.length === 1 ? picked[0]! : null;
    const b0 = boundsOf(picked);
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        const o = { keep: ev.shiftKey, center: ev.altKey, min: MIN };
        last = withLayers(page, one ? [resizeBox(one, h, to.x - from.x, to.y - from.y, o)] : resizeAll(picked, b0, resizeBox(b0, h, to.x - from.x, to.y - from.y, o)));
        onLive(last);
      },
      () => {
        onLive(null);
        if (last) onCommit(last);
      },
    );
  };

  const turn = (e: React.PointerEvent, l: Layer) => {
    e.stopPropagation();
    if (e.button !== 0 || !page) return;
    const mid = { x: pageLeft(at, width) + l.x + l.w / 2, y: l.y + l.h / 2 };
    const angle = (p: Point) => (Math.atan2(p.y - mid.y, p.x - mid.x) * 180) / Math.PI;
    const a0 = angle(world(e));
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        let r = (l.rotate ?? 0) + angle(world(ev)) - a0;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        r = Math.round((((r % 360) + 540) % 360) - 180);
        last = withLayers(page, [{ ...l, rotate: r || undefined }]);
        onLive(last);
      },
      () => {
        onLive(null);
        if (last) onCommit(last);
      },
    );
  };

  const down = (e: React.PointerEvent) => {
    // a press beside the words being typed ends the typing and keeps them; it picks or moves nothing
    if (typing.current) return typing.current.blur();
    box.current?.focus({ preventScroll: true });
    if (dropper) {
      // the colour as it is drawn, read off the canvas itself (a browser's own dropper is not in every browser); a
      // press beside every page gives nothing and the dropper stays out
      const c = canvas.current;
      if (e.button !== 0 || !c) return;
      const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      const [red, green, blue, alpha] = c.getContext("2d")!.getImageData(Math.round((e.clientX - r.left) * k), Math.round((e.clientY - r.top) * k), 1, 1).data;
      if (alpha) dropper(`#${[red!, green!, blue!].map((n) => n.toString(16).padStart(2, "0")).join("")}`);
      return;
    }
    if (e.button === 1 || (e.button === 0 && (space || tool === "hand"))) return pan(e);
    const p = world(e);
    const k = pageUnder(p);
    const hit = hitAt(k, p);
    if (e.button !== 0) return;
    if (tool !== "move") return make(e, k >= 0 ? k : at);
    if (!hit) return marquee(e, k);
    const mine = k === at ? selected : [];
    if (e.shiftKey) return onPick(k, mine.includes(hit.id) ? mine.filter((id) => id !== hit.id) : [...mine, hit.id]);
    const ids = mine.includes(hit.id) ? mine : [hit.id];
    if (ids !== mine) onPick(k, ids);
    move(e, k, ids, hit.id);
  };

  const over = (e: React.PointerEvent) => {
    const p = world(e);
    const k = pageUnder(p);
    const hit = !e.buttons && tool === "move" && !space ? hitAt(k, p) : null;
    if ((hit?.id ?? null) !== (hover?.id ?? null) || (hit && k !== hover?.k)) setHover(hit ? { k, id: hit.id } : null);
  };

  /** A box of page `k` on the screen. */
  const place = (k: number, r: Rect & { rotate?: number }): React.CSSProperties => ({
    left: view.x + (pageLeft(k, width) + r.x) * view.z,
    top: view.y + r.y * view.z,
    width: r.w * view.z,
    height: r.h * view.z,
    transform: r.rotate ? `rotate(${r.rotate}deg)` : undefined,
  });
  const one = picked.length === 1 ? picked[0]! : null;
  const around = picked.length ? boundsOf(picked) : null;
  const outlined = [hover && !(hover.k === at && selected.includes(hover.id)) ? pages[hover.k]?.layers.find((l) => l.id === hover.id) : null, pointed && !selected.includes(pointed) ? page?.layers.find((l) => l.id === pointed) : null];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={box}
          tabIndex={0}
          role="application"
          aria-label="Canvas"
          className="absolute inset-0 touch-none select-none overflow-hidden outline-none"
          style={{ cursor: dropper ? "crosshair" : space || tool === "hand" ? "grab" : tool === "move" ? "default" : "crosshair" }}
          onPointerDown={down}
          onPointerMove={over}
          onPointerLeave={() => setHover(null)}
          // the menu is for what is picked: a right press on something else picks that first. On the menu's own
          // event, since that is what opens it (a Ctrl-click on a Mac too)
          onContextMenu={(e) => {
            const p = world(e);
            const k = pageUnder(p);
            const hit = hitAt(k, p);
            if (hit && !(k === at && selected.includes(hit.id))) onPick(k, [hit.id]);
          }}
          // nothing scrolls the canvas but its own view
          onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
          onDoubleClick={(e) => {
            const p = world(e);
            const k = pageUnder(p);
            const hit = hitAt(k, p);
            if (hit?.type !== "text" || tool !== "move") return;
            onPick(k, [hit.id]);
            onEdit(hit.id);
          }}
        >
          <canvas ref={canvas} aria-label="The pages" className="pointer-events-none block h-full w-full" />
          {pages.map((p, k) => (
            <button
              key={p.id}
              type="button"
              data-page-name={k}
              onPointerDown={(e) => (e.stopPropagation(), e.button === 0 && onPick(k, [], true))}
              className={cn("absolute -translate-y-full truncate pb-1 text-left text-[11px] leading-4 outline-none focus-visible:underline", k === at ? "text-[#0d99ff]" : "text-zinc-500 hover:text-[#0d99ff] dark:text-[#b3b3b3]")}
              style={{ left: view.x + pageLeft(k, width) * view.z, top: view.y, maxWidth: Math.max(24, width * view.z) }}
            >
              {pageName(p, k)}
            </button>
          ))}
          {framed && <div className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={place(at, { x: 0, y: 0, w: width, h: height })} />}
          {outlined.map((l, n) => l && <div key={n} className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={place(n === 0 ? hover!.k : at, l)} />)}
          {guides?.x !== undefined && <div className="pointer-events-none absolute w-px bg-[#ff3b30]" style={{ left: view.x + (pageLeft(guides.k, width) + guides.x) * view.z, top: view.y, height: height * view.z }} />}
          {guides?.y !== undefined && <div className="pointer-events-none absolute h-px bg-[#ff3b30]" style={{ left: view.x + pageLeft(guides.k, width) * view.z, top: view.y + guides.y * view.z, width: width * view.z }} />}
          {band && <div className="pointer-events-none absolute border border-[#0d99ff] bg-[#0d99ff]/10" style={{ left: view.x + band.x * view.z, top: view.y + band.y * view.z, width: band.w * view.z, height: band.h * view.z }} />}
          {drawn && <div className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={place(drawn.k, drawn)} />}
          {!typed && picked.length > 1 && picked.map((l) => <div key={l.id} className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={place(at, l)} />)}
          {!typed && around && (
            <>
              <div data-selection className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={place(at, one ?? around)}>
                {/* just outside each corner: turning (one layer only) */}
                {one &&
                  (["nw", "ne", "se", "sw"] as const).map((h) => (
                    <span key={h} data-turn={h} onPointerDown={(e) => turn(e, one)} className="pointer-events-auto absolute h-5 w-5" style={{ left: h.includes("w") ? -20 : "100%", top: h.includes("n") ? -20 : "100%", cursor: TURN }} />
                  ))}
                {HANDLES.map((h) =>
                  h.length === 2 ? (
                    <span
                      key={h}
                      data-handle={h}
                      onPointerDown={(e) => resize(e, h)}
                      className="pointer-events-auto absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 border bg-white"
                      style={{ left: h.includes("w") ? 0 : "100%", top: h.includes("n") ? 0 : "100%", cursor: CURSOR[h], borderColor: BLUE }}
                    />
                  ) : (
                    // a side has no knob: the whole side is the handle
                    <span
                      key={h}
                      data-handle={h}
                      onPointerDown={(e) => resize(e, h)}
                      className="pointer-events-auto absolute"
                      style={h === "n" || h === "s" ? { left: 6, right: 6, height: 8, top: h === "n" ? -4 : undefined, bottom: h === "s" ? -4 : undefined, cursor: CURSOR[h] } : { top: 6, bottom: 6, width: 8, left: h === "w" ? -4 : undefined, right: h === "e" ? -4 : undefined, cursor: CURSOR[h] }}
                    />
                  ),
                )}
              </div>
              <div data-selection-size className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-sm px-1 text-[11px] leading-4 text-white" style={{ background: BLUE, left: view.x + (pageLeft(at, width) + around.x + around.w / 2) * view.z, top: view.y + (around.y + around.h) * view.z + 6 }}>
                {Math.round((one ?? around).w)} × {Math.round((one ?? around).h)}
              </div>
            </>
          )}
          {typed && (
            <textarea
              ref={typing}
              aria-label="The words of this layer"
              defaultValue={typed.text}
              maxLength={DESIGN_LIMITS.text}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") e.currentTarget.blur();
                e.stopPropagation();
              }}
              onBlur={(e) => {
                const text = e.currentTarget.value.replace(/\r\n/g, "\n").trim();
                onEdit(null);
                // words taken out whole: the layer goes with them
                if (text !== typed.text && page) onCommit(text ? withLayers(page, [{ ...typed, text }]) : { ...page, layers: page.layers.filter((l) => l.id !== typed.id) });
              }}
              className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 outline outline-1 outline-[#0d99ff]"
              style={{ ...place(at, typed), font: fontOf(typed, view.z), lineHeight: `${lineHeightOf(typed) * view.z}px`, color: typed.color, textAlign: typed.align, textTransform: typed.upper ? "uppercase" : undefined }}
            />
          )}
        </div>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}
