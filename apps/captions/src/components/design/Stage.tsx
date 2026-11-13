import { useEffect, useRef, useState, type ReactNode } from "react";
import { DESIGN_LIMITS, type DesignPage, type Layer, type TextLayer } from "@contracts/design";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { drawPage, fontOf, layerAt, lineHeightOf, type Loaded } from "@/lib/design/draw";
import { boundsOf, frameOf, freshIds, intersects, pageName, resizeAll, resizeBox, snapMove, zoomAt, type Handle, type Rect, type View } from "@/lib/design/hands";
import { cn } from "@/lib/utils";

/**
 * The canvas: every frame of the design where it lies, each drawn as it will be saved, and the hands on them.
 *   Frames      a frame is dragged by its name (it catches on the other frames' edges and middles), and resized by
 *               its handles once its name has picked it; the frame tool draws a new one. Its layers keep their
 *               place on the canvas while it is resized.
 *   Move tool   click picks a layer (Shift adds or takes one), a drag moves what is picked (it catches on its
 *               frame's and the other layers' edges and middles; Shift keeps one axis, Alt drags a copy) and, let
 *               go over another frame, leaves it in that frame; a drag from empty canvas draws a box round the
 *               layers to pick; a double click on words types in place.
 *   Handles     a corner or a side resizes about the opposite one (Shift keeps the shape, Alt the middle), through
 *               the layer's rotation; just outside a corner turns it (Shift: steps of 15°). Several layers resize
 *               together.
 *   The view    the wheel scrolls, ⌘ or Ctrl with the wheel (or a pinch) zooms about the pointer, Space or the hand
 *               tool or the middle button drags the canvas.
 */

export type Tool = "move" | "hand" | "frame" | "rect" | "ellipse" | "text";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
/** How near (in screen pixels) a line catches what is moving. */
const SNAP = 6;
/** No layer is resized smaller than this, in design pixels. */
const MIN = 8;
const BLUE = "#0d99ff";
const TURN = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="5"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></g><g stroke="#000" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></g></svg>')}") 11 11, crosshair`;

type Point = { x: number; y: number };
/** A line a moving thing caught on, in the canvas's own pixels, as long as `span`. */
type Guides = { x?: number; y?: number; span: Rect };

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
  onMakeFrame,
  editing,
  onEdit,
  pointed,
  dropper,
  menu,
}: {
  /** the frames as shown: one being dragged is its live self */
  pages: DesignPage[];
  /** the frame the picked layers are on */
  at: number;
  /** the size a frame has when it gives none (a design from before frames had their own) */
  width: number;
  height: number;
  /** the canvas's size on the screen */
  room: { w: number; h: number };
  view: View;
  onView: (v: View) => void;
  loaded: Loaded;
  /** moves when a picture or a font finished loading, so the frames are drawn again */
  version: number;
  selected: string[];
  /** the frame itself is picked (by its name) */
  framed: boolean;
  onPick: (at: number, ids: string[], framed?: boolean) => void;
  /** frames while a drag is under way (not a step to undo) */
  onLive: (pages: DesignPage[] | null) => void;
  /** frames once a drag or an edit ends (one step to undo, however many frames it changed) */
  onCommit: (pages: DesignPage[]) => void;
  tool: Tool;
  /** a box drawn with a making tool, in its frame's pixels; `dragged` false: a click, the box has no size */
  onMake: (at: number, box: Rect, dragged: boolean) => void;
  /** a box drawn with the frame tool, in the canvas's pixels; `dragged` false: a click */
  onMakeFrame: (box: Rect, dragged: boolean) => void;
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
  const [guides, setGuides] = useState<Guides | null>(null);
  const [band, setBand] = useState<Rect | null>(null);
  /** the box a making tool is drawing, in the canvas's pixels */
  const [drawn, setDrawn] = useState<Rect | null>(null);
  const [hover, setHover] = useState<{ k: number; id: string } | null>(null);
  const [space, setSpace] = useState(false);
  // the view as of the last event: two wheel ticks before the next drawing both count
  const live = useRef(view);
  useEffect(() => void (live.current = view), [view]);
  const show = useRef(onView);
  useEffect(() => void (show.current = onView), [onView]);
  const setView = (v: View) => ((live.current = v), show.current(v));

  /** Where each frame lies on the canvas. */
  const fr = pages.map((p, k) => frameOf(p, k, width, height));
  const page = pages[at];
  const here = fr[at];
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
      const f = frameOf(p, k, width, height);
      const left = view.x + f.x * view.z;
      const top = view.y + f.y * view.z;
      if (left > room.w || left + f.w * view.z < 0 || top > room.h || top + f.h * view.z < 0) return;
      ctx.save();
      ctx.setTransform(view.z * dpr, 0, 0, view.z * dpr, left * dpr, top * dpr);
      ctx.beginPath();
      ctx.rect(0, 0, f.w, f.h);
      ctx.clip();
      // the words being typed are in the box over the frame: the layer itself is not drawn under them
      drawPage(ctx, editing && k === at ? { ...p, layers: p.layers.filter((l) => l.id !== editing) } : p, f.w, f.h, loaded);
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

  /** The pointer's place on the canvas, in design pixels. */
  const world = (e: { clientX: number; clientY: number }): Point => {
    const r = box.current!.getBoundingClientRect();
    const v = live.current;
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z };
  };
  /** The frame under a point of the canvas: where two lie over each other, the later one. */
  const frameUnder = (p: Point): number => {
    for (let k = fr.length - 1; k >= 0; k--) if (p.x >= fr[k]!.x && p.x <= fr[k]!.x + fr[k]!.w && p.y >= fr[k]!.y && p.y <= fr[k]!.y + fr[k]!.h) return k;
    return -1;
  };
  const hitAt = (k: number, p: Point) => (k >= 0 ? layerAt(pages[k]!, p.x - fr[k]!.x, p.y - fr[k]!.y) : null);

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
  /** The pointer's move since `from`; Shift keeps the longer of its two directions. */
  const moveOf = (ev: PointerEvent, from: Point) => {
    const to = world(ev);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const flat = Math.abs(dx) > Math.abs(dy);
    return { dx: ev.shiftKey && !flat ? 0 : dx, dy: ev.shiftKey && flat ? 0 : dy, lockX: ev.shiftKey && !flat, lockY: ev.shiftKey && flat };
  };

  const pan = (e: React.PointerEvent) => {
    const v0 = live.current;
    const x0 = e.clientX;
    const y0 = e.clientY;
    drag(e, (ev) => setView({ ...v0, x: v0.x + ev.clientX - x0, y: v0.y + ev.clientY - y0 }));
  };

  /**
   * The picked layers follow the pointer. Over another frame they are that frame's (shown there while still held, and
   * left there when let go): which frame is under the middle of what is moving decides.
   */
  const move = (e: React.PointerEvent, k: number, ids: string[], hit: string) => {
    const p = pages[k]!;
    const f = fr[k]!;
    const from = world(e);
    // a layer locked while it was picked stays where it is
    const moving = p.layers.filter((l) => ids.includes(l.id) && !l.locked);
    if (!moving.length) return;
    // Alt drags a copy and leaves the layer where it was
    const copy = e.altKey;
    const b0 = boundsOf(moving);
    let last: { pages: DesignPage[]; to: number; ids: string[] } | null = null;
    drag(
      e,
      (ev) => {
        const m = moveOf(ev, from);
        const mid = { x: f.x + b0.x + m.dx + b0.w / 2, y: f.y + b0.y + m.dy + b0.h / 2 };
        const over = frameUnder(mid);
        // another frame takes them only when it has room for them; a copy stays in a frame that has room too
        const fits = (n: number) => pages[n]!.layers.length + moving.length <= DESIGN_LIMITS.layers;
        const to = over >= 0 && over !== k && fits(over) ? over : k;
        if (to === k && copy && !fits(k)) return;
        const host = pages[to]!;
        const g = fr[to]!;
        // in the host frame's own pixels
        const ox = f.x - g.x;
        const oy = f.y - g.y;
        const targets: Rect[] = [{ x: 0, y: 0, w: g.w, h: g.h }, ...host.layers.filter((l) => !l.hidden && (to !== k || copy || !ids.includes(l.id))).map((l) => boundsOf([l]))];
        const s = snapMove({ ...b0, x: b0.x + ox + m.dx, y: b0.y + oy + m.dy }, targets, SNAP / live.current.z);
        // the axis Shift holds still catches on nothing
        const dx = Math.round(ox + m.dx + (m.lockX ? 0 : s.dx));
        const dy = Math.round(oy + m.dy + (m.lockY ? 0 : s.dy));
        setGuides({ ...(m.lockX || s.x === undefined ? {} : { x: g.x + s.x }), ...(m.lockY || s.y === undefined ? {} : { y: g.y + s.y }), span: g });
        // an id of its own in the frame it lands in
        const taken = new Set(host.layers.filter((l) => to !== k || copy || !ids.includes(l.id)).map((l) => l.id));
        const fresh = freshIds(host, moving.length);
        const next = moving.map((l, n) => ({ ...l, x: l.x + dx, y: l.y + dy, id: taken.has(l.id) || (copy && to === k) ? fresh[n]! : l.id }));
        const home = copy ? p : { ...p, layers: p.layers.filter((l) => !moving.includes(l)) };
        last = to === k ? { pages: [copy ? { ...p, layers: [...p.layers, ...next] } : withLayers(p, next)], to, ids: next.map((l) => l.id) } : { pages: [home, { ...host, layers: [...host.layers, ...next] }], to, ids: next.map((l) => l.id) };
        onLive(last.pages);
      },
      (moved) => {
        setGuides(null);
        onLive(null);
        if (last) {
          onCommit(last.pages);
          if (last.to !== k || copy) onPick(last.to, last.ids);
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
        // the frame the box began on first, then the others: the first with a layer in the box
        for (const m of r ? [home, ...pages.map((_, n) => n).filter((n) => n !== home)] : []) {
          const inFrame = { ...r!, x: r!.x - fr[m]!.x, y: r!.y - fr[m]!.y };
          const ids = pages[m]!.layers.filter((l) => !l.hidden && !l.locked && intersects(boundsOf([l]), inFrame)).map((l) => l.id);
          if (ids.length) return onPick(m, ids);
        }
        onPick(home, []);
      },
    );
  };

  /** A making tool's box: a layer's in frame `k`, or (k < 0) a new frame's on the canvas. */
  const make = (e: React.PointerEvent, k: number) => {
    const from = world(e);
    const ox = k >= 0 ? fr[k]!.x : 0;
    const oy = k >= 0 ? fr[k]!.y : 0;
    let r: Rect | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        let w = Math.abs(to.x - from.x);
        let h = Math.abs(to.y - from.y);
        if (ev.shiftKey) w = h = Math.max(w, h);
        r = { x: to.x < from.x ? from.x - w : from.x, y: to.y < from.y ? from.y - h : from.y, w, h };
        setDrawn(r);
      },
      () => {
        setDrawn(null);
        const made = r ?? { x: from.x, y: from.y, w: 0, h: 0 };
        if (k < 0) onMakeFrame(made, !!r);
        else onMake(k, { ...made, x: made.x - ox, y: made.y - oy }, !!r);
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
        onLive([last]);
      },
      () => {
        onLive(null);
        if (last) onCommit([last]);
      },
    );
  };

  const turn = (e: React.PointerEvent, l: Layer) => {
    e.stopPropagation();
    if (e.button !== 0 || !page || !here) return;
    const mid = { x: here.x + l.x + l.w / 2, y: here.y + l.y + l.h / 2 };
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
        onLive([last]);
      },
      () => {
        onLive(null);
        if (last) onCommit([last]);
      },
    );
  };

  /** A frame dragged by its name: it catches on the other frames' edges and middles. A press without a drag only picks it. */
  const moveFrame = (e: React.PointerEvent, k: number) => {
    // the hand, the dropper, a making tool and the other buttons are the canvas's own press
    if (e.button !== 0 || space || tool !== "move" || dropper) return;
    e.stopPropagation();
    if (typing.current) return typing.current.blur();
    box.current?.focus({ preventScroll: true });
    onPick(k, [], true);
    const p = pages[k]!;
    const f = fr[k]!;
    const from = world(e);
    const others = fr.filter((_, n) => n !== k);
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        const m = moveOf(ev, from);
        const s = snapMove({ ...f, x: f.x + m.dx, y: f.y + m.dy }, others, SNAP / live.current.z);
        const x = Math.round(f.x + m.dx + (m.lockX ? 0 : s.dx));
        const y = Math.round(f.y + m.dy + (m.lockY ? 0 : s.dy));
        setGuides({ ...(m.lockX || s.x === undefined ? {} : { x: s.x }), ...(m.lockY || s.y === undefined ? {} : { y: s.y }), span: boundsOf([...others, { ...f, x, y }]) });
        last = { ...p, x, y };
        onLive([last]);
      },
      () => {
        setGuides(null);
        onLive(null);
        if (last) onCommit([last]);
      },
    );
  };

  /** The picked frame resized by a handle. Its layers stay where they are on the canvas: pulled from its left or top, its corner moves under them. */
  const resizeFrame = (e: React.PointerEvent, h: Handle) => {
    e.stopPropagation();
    if (e.button !== 0 || !page || !here) return;
    const from = world(e);
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        const f = resizeBox(here, h, to.x - from.x, to.y - from.y, { keep: ev.shiftKey, center: ev.altKey, min: DESIGN_LIMITS.frameMin });
        if (f.w > DESIGN_LIMITS.frameMax || f.h > DESIGN_LIMITS.frameMax) return;
        last = { ...page, x: f.x, y: f.y, w: f.w, h: f.h, layers: page.layers.map((l) => ({ ...l, x: l.x - (f.x - here.x), y: l.y - (f.y - here.y) })) };
        onLive([last]);
      },
      () => {
        onLive(null);
        if (last) onCommit([last]);
      },
    );
  };

  const down = (e: React.PointerEvent) => {
    // a press beside the words being typed ends the typing and keeps them; it picks or moves nothing
    if (typing.current) return typing.current.blur();
    box.current?.focus({ preventScroll: true });
    if (dropper) {
      // the colour as it is drawn, read off the canvas itself (a browser's own dropper is not in every browser); a
      // press beside every frame gives nothing and the dropper stays out
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
    const k = frameUnder(p);
    const hit = hitAt(k, p);
    if (e.button !== 0) return;
    if (tool === "frame") return make(e, -1);
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
    const k = frameUnder(p);
    const hit = !e.buttons && tool === "move" && !space ? hitAt(k, p) : null;
    if ((hit?.id ?? null) !== (hover?.id ?? null) || (hit && k !== hover?.k)) setHover(hit ? { k, id: hit.id } : null);
  };

  /** A box of the canvas on the screen. */
  const onScreen = (r: Rect): React.CSSProperties => ({ left: view.x + r.x * view.z, top: view.y + r.y * view.z, width: r.w * view.z, height: r.h * view.z });
  /** A box of frame `k` on the screen. */
  const place = (k: number, r: Rect & { rotate?: number }): React.CSSProperties => ({ ...onScreen({ ...r, x: (fr[k]?.x ?? 0) + r.x, y: (fr[k]?.y ?? 0) + r.y }), transform: r.rotate ? `rotate(${r.rotate}deg)` : undefined });
  const one = picked.length === 1 ? picked[0]! : null;
  const around = picked.length ? boundsOf(picked) : null;
  const outlined = [hover && !(hover.k === at && selected.includes(hover.id)) ? pages[hover.k]?.layers.find((l) => l.id === hover.id) : null, pointed && !selected.includes(pointed) ? page?.layers.find((l) => l.id === pointed) : null];
  /** The eight handles of a box: four corner knobs, and its sides (a side has no knob: the whole side is the handle). */
  const handles = (ofFrame: boolean) => {
    const mark = ofFrame ? "data-frame-handle" : "data-handle";
    const grab = (e: React.PointerEvent, h: Handle) => (ofFrame ? resizeFrame(e, h) : resize(e, h));
    return HANDLES.map((h) =>
      h.length === 2 ? (
        <span key={h} {...{ [mark]: h }} onPointerDown={(e) => grab(e, h)} className="pointer-events-auto absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 border bg-white" style={{ left: h.includes("w") ? 0 : "100%", top: h.includes("n") ? 0 : "100%", cursor: CURSOR[h], borderColor: BLUE }} />
      ) : (
        <span
          key={h}
          {...{ [mark]: h }}
          onPointerDown={(e) => grab(e, h)}
          className="pointer-events-auto absolute"
          style={h === "n" || h === "s" ? { left: 6, right: 6, height: 8, top: h === "n" ? -4 : undefined, bottom: h === "s" ? -4 : undefined, cursor: CURSOR[h] } : { top: 6, bottom: 6, width: 8, left: h === "w" ? -4 : undefined, right: h === "e" ? -4 : undefined, cursor: CURSOR[h] }}
        />
      ),
    );
  };

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
            const k = frameUnder(p);
            const hit = hitAt(k, p);
            if (hit && !(k === at && selected.includes(hit.id))) onPick(k, [hit.id]);
          }}
          // nothing scrolls the canvas but its own view
          onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
          onDoubleClick={(e) => {
            const p = world(e);
            const k = frameUnder(p);
            const hit = hitAt(k, p);
            if (hit?.type !== "text" || tool !== "move") return;
            onPick(k, [hit.id]);
            onEdit(hit.id);
          }}
        >
          <canvas ref={canvas} aria-label="The frames" className="pointer-events-none block h-full w-full" />
          {pages.map((p, k) => (
            <button
              key={p.id}
              type="button"
              data-page-name={k}
              onPointerDown={(e) => moveFrame(e, k)}
              className={cn("absolute -translate-y-full cursor-default truncate pb-1 text-left text-[11px] leading-4 outline-none focus-visible:underline", k === at ? "text-[#0d99ff]" : "text-zinc-500 hover:text-[#0d99ff] dark:text-[#b3b3b3]")}
              style={{ left: view.x + fr[k]!.x * view.z, top: view.y + fr[k]!.y * view.z, maxWidth: Math.max(24, fr[k]!.w * view.z) }}
            >
              {pageName(p, k)}
            </button>
          ))}
          {framed && here && (
            <div data-frame-selection className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={onScreen(here)}>
              {handles(true)}
            </div>
          )}
          {outlined.map((l, n) => l && <div key={n} className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={place(n === 0 ? hover!.k : at, l)} />)}
          {guides?.x !== undefined && <div className="pointer-events-none absolute w-px bg-[#ff3b30]" style={{ left: view.x + guides.x * view.z, top: view.y + guides.span.y * view.z, height: guides.span.h * view.z }} />}
          {guides?.y !== undefined && <div className="pointer-events-none absolute h-px bg-[#ff3b30]" style={{ left: view.x + guides.span.x * view.z, top: view.y + guides.y * view.z, width: guides.span.w * view.z }} />}
          {band && <div className="pointer-events-none absolute border border-[#0d99ff] bg-[#0d99ff]/10" style={onScreen(band)} />}
          {drawn && <div className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={onScreen(drawn)} />}
          {!typed && picked.length > 1 && picked.map((l) => <div key={l.id} className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={place(at, l)} />)}
          {!typed && around && here && (
            <>
              <div data-selection className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={place(at, one ?? around)}>
                {/* just outside each corner: turning (one layer only) */}
                {one &&
                  (["nw", "ne", "se", "sw"] as const).map((h) => (
                    <span key={h} data-turn={h} onPointerDown={(e) => turn(e, one)} className="pointer-events-auto absolute h-5 w-5" style={{ left: h.includes("w") ? -20 : "100%", top: h.includes("n") ? -20 : "100%", cursor: TURN }} />
                  ))}
                {handles(false)}
              </div>
              <div data-selection-size className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-sm px-1 text-[11px] leading-4 text-white" style={{ background: BLUE, left: view.x + (here.x + around.x + around.w / 2) * view.z, top: view.y + (here.y + around.y + around.h) * view.z + 6 }}>
                {Math.round((one ?? around).w)} × {Math.round((one ?? around).h)}
              </div>
            </>
          )}
          {framed && here && (
            <div data-frame-size className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-sm px-1 text-[11px] leading-4 text-white" style={{ background: BLUE, left: view.x + (here.x + here.w / 2) * view.z, top: view.y + (here.y + here.h) * view.z + 6 }}>
              {here.w} × {here.h}
            </div>
          )}
          {typed && page && (
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
                if (text !== typed.text) onCommit([text ? withLayers(page, [{ ...typed, text }]) : { ...page, layers: page.layers.filter((l) => l.id !== typed.id) }]);
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
