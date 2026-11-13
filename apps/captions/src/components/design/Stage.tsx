import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DESIGN_LIMITS, type DesignPage, type DesignShape, type ImageLayer, type Layer, type PathLayer, type TextLayer } from "@contracts/design";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { drawPage, fontOf, inLayer, keptOr, layerAt, lineHeightOf, measurer, setText, type Loaded } from "@/lib/design/draw";
import { boundsOf, boxPick, frameOf, freshIds, groupOf, pageName, regroup, withGroups, resizeAll, resizeBox, snapMove, snapSpacing, zoomAt, type Gap, type Handle, type Rect, type View } from "@/lib/design/hands";
import { dragHandle, fitPath, inPixels, pathHit, refit, svgPath, toBox, toFrame, toggleSmooth, type Anchor } from "@/lib/design/path";
import { framePlan, keptScale, useView, type KeptFrame, type ViewStore } from "@/lib/design/view";
import { cn } from "@/lib/utils";

/**
 * The canvas: every frame of the design where it lies, each drawn as it will be saved, and the hands on them.
 *   Frames      a frame is dragged by its name (it catches on the other frames' edges and middles), and resized by
 *               its handles once its name has picked it; the frame tool draws a new one. Its layers keep their
 *               place on the canvas while it is resized. An empty frame, and a frame that is picked, is also taken
 *               by its own area. Shift with a press on a name adds the frame to the picked ones or takes it out;
 *               several picked frames move as one, and a press on one of them without a drag picks that one alone.
 *   Groups      a layer of a group picks the whole group, and they move as one; ⌘ (or Ctrl) with the click, or a
 *               double click, picks the one layer inside it.
 *   Move tool   click picks a layer (Shift adds or takes one), a drag moves what is picked (it catches on its
 *               frame's and the other layers' edges and middles, and where its gaps to its neighbours come out
 *               even, which are then shown with their size; Shift keeps one axis, Alt drags a copy) and, let
 *               go over another frame, leaves it in that frame; a drag from empty canvas draws a box, and what it
 *               picks shows while it is drawn (hands.ts boxPick: a frame it covers whole, else the layers it
 *               touches; ⌘ always the layers; Shift adds to what was picked); a double click on words types in
 *               place.
 *   The pen     each press puts a point of a line down, a corner; dragged on from the press, the point gets two
 *               handles and the line curves through it. A press on the first point closes the line; Enter, Esc or a
 *               double click ends it open. A double click (or Enter) on a path shows its points: a point or a
 *               handle's end is dragged (Alt: that handle alone), a double click on a point makes it a corner or
 *               smooth, Delete takes the picked point out.
 *   A picture   a double click (or Enter) on a picture moves it inside its box: a drag slides it, the wheel or a
 *               pinch zooms it, and a press beside it (or Esc) is done with it. The box itself stays.
 *   Handles     a corner or a side resizes about the opposite one (Shift keeps the shape, Alt the middle), through
 *               the layer's rotation; just outside a corner turns it (Shift: steps of 15°). Several layers resize
 *               together.
 *   The view    the wheel scrolls, ⌘ or Ctrl with the wheel (or a pinch) zooms about the pointer, Space or the hand
 *               tool or the middle button drags the canvas.
 *   Drawing     while the view or a layer moves, every frame that did not change is put on the canvas as the picture
 *               kept of it (lib/design/view.ts framePlan), so a step of the wheel costs a few pictures copied, not
 *               every layer of every frame drawn again; a moment after the last move the frames are exact again.
 */

export type Tool = "move" | "hand" | "frame" | DesignShape | "text" | "pen";

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const CURSOR: Record<Handle, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
/** How near (in screen pixels) a line catches what is moving. */
const SNAP = 6;
/** No layer is resized smaller than this, in design pixels. */
const MIN = 8;
const BLUE = "#0d99ff";
/** The device pixels all the kept pictures of frames may have together (about 96 MB), and how long nothing has to move before the frames are made exact again, in ms. */
const KEPT_PIXELS = 24_000_000;
const SETTLE = 120;
type FramePicture = KeptFrame & { canvas: HTMLCanvasElement };
/** A number for an object, the same one every time: what a frame's picture was made of, told apart without comparing every layer. */
const numbered = new WeakMap<object, number>();
let numbers = 0;
const numberOf = (o: object) => numbered.get(o) ?? (numbered.set(o, ++numbers), numbers);
const TURN = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-width="5"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></g><g stroke="#000" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></g></svg>')}") 11 11, crosshair`;

type Point = { x: number; y: number };
/** On a Mac, Ctrl with a click is the right click: only ⌘ picks inside a group there. */
const ON_A_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
/** A line a moving thing caught on, in the canvas's own pixels, as long as `span`; and the gaps it sits evenly between. */
type Guides = { x?: number; y?: number; span: Rect; gaps?: Gap[] };

export function Stage({
  pages,
  at,
  width,
  height,
  room,
  view: held,
  loaded,
  version,
  selected,
  framed,
  framedIds,
  onPick,
  onLive,
  onCommit,
  tool,
  onMake,
  onMakeFrame,
  editing,
  onEdit,
  onMakePath,
  shaping,
  onShape,
  cropping,
  onCrop,
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
  /** where the canvas is scrolled to and how far it is zoomed: this one draws itself again when it moves, the page around it does not */
  view: ViewStore;
  loaded: Loaded;
  /** moves when a picture or a font finished loading, so the frames are drawn again */
  version: number;
  selected: string[];
  /** the frame itself is picked (by its name) */
  framed: boolean;
  /** every frame that is picked, by its id (frame `at` among them); none when layers or nothing are */
  framedIds: readonly string[];
  /** `frames`: every frame picked, by id, when more than the one at `at` */
  onPick: (at: number, ids: string[], framed?: boolean, frames?: string[]) => void;
  /** frames while a drag is under way (not a step to undo) */
  onLive: (pages: DesignPage[] | null) => void;
  /** frames once a drag or an edit ends (one step to undo, however many frames it changed; `merge`: joined to the step before it of the same name) */
  onCommit: (pages: DesignPage[], merge?: string) => void;
  tool: Tool;
  /** a box drawn with a making tool, in its frame's pixels; `dragged` false: a click, the box has no size */
  onMake: (at: number, box: Rect, dragged: boolean) => void;
  /** a box drawn with the frame tool, in the canvas's pixels; `dragged` false: a click */
  onMakeFrame: (box: Rect, dragged: boolean) => void;
  /** the text layer being typed in */
  editing: string | null;
  onEdit: (id: string | null) => void;
  /** a line drawn with the pen, in its frame's pixels: its box and its points in parts of that box */
  onMakePath: (at: number, path: { x: number; y: number; w: number; h: number; points: PathLayer["points"]; closed: boolean }) => void;
  /** the path layer whose points are shown, and the one of them that is picked */
  shaping: { id: string; anchor: number | null } | null;
  onShape: (s: { id: string; anchor: number | null } | null) => void;
  /** the picture layer being moved inside its box */
  cropping: string | null;
  onCrop: (id: string | null) => void;
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
  /** The line the pen is drawing: its frame, its points in that frame's pixels, and where the pointer is on the canvas. */
  const [pen, setPen] = useState<{ k: number; points: Anchor[] } | null>(null);
  const [penAt, setPenAt] = useState<Point | null>(null);
  const penNow = useRef(pen);
  useEffect(() => void (penNow.current = pen), [pen]);
  /** The pen's line is done: a layer of its frame, when it has two points that are not one. */
  const finishPen = (closed: boolean) => {
    const made = penNow.current;
    penNow.current = null;
    setPen(null);
    setPenAt(null);
    const points = (made?.points ?? []).filter((p, n, all) => !n || p.x !== all[n - 1]!.x || p.y !== all[n - 1]!.y);
    if (!made || points.length < 2) return;
    const { box, points: parts } = fitPath(points, closed && points.length > 2);
    onMakePath(made.k, { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h), points: parts, closed: closed && points.length > 2 });
  };
  // another tool taken up (Esc and Enter take the move tool) ends the line the pen was on, open
  const endPen = useRef(finishPen);
  useEffect(() => void (endPen.current = finishPen));
  useEffect(() => {
    if (tool !== "pen") endPen.current(false);
  }, [tool]);
  const view = useView(held);
  // The view as of the last event: two wheel ticks before the next drawing both count. What the wheel and a drag ask
  // of it is shown once for every picture of the screen, however many of them arrive in one; in a window that shows
  // no pictures (hidden), at once.
  const live = useRef(view);
  useEffect(() => held.subscribe(() => void (live.current = held.get())), [held]);
  const due = useRef(0);
  useEffect(() => () => cancelAnimationFrame(due.current), []);
  const setView = useCallback(
    (v: View) => {
      live.current = v;
      if (document.hidden) return held.set(v);
      due.current ||= requestAnimationFrame(() => {
        due.current = 0;
        held.set(live.current);
      });
    },
    [held],
  );

  /** Where each frame lies on the canvas. */
  const fr = pages.map((p, k) => frameOf(p, k, width, height));
  const page = pages[at];
  const here = fr[at];
  const picked = page ? page.layers.filter((l) => selected.includes(l.id)) : [];
  const typed = page?.layers.find((l): l is TextLayer => l.id === editing && l.type === "text");
  // the words being typed are set at the size they are drawn at (their own, or the one they shrank to)
  const typedAs = typed ? { ...typed, size: setText(typed, measurer(fontOf(typed))).size } : typed;
  const cropped = page?.layers.find((l): l is ImageLayer => l.id === cropping && l.type === "image");
  const shaped = page?.layers.find((l): l is PathLayer => l.id === shaping?.id && l.type === "path");
  // the wheel or a pinch over a picture that is being moved in its box zooms the picture, not the canvas
  const pictureZoom = useRef<{ now: number; set: (zoom: number) => void } | null>(null);
  useEffect(() => {
    pictureZoom.current =
      cropped && page
        ? {
            now: cropped.zoom ?? 1,
            set: (to) => {
              const zoom = Math.round(Math.min(8, Math.max(1, to)) * 100) / 100;
              if (zoom !== (cropped.zoom ?? 1)) onCommit([{ ...page, layers: page.layers.map((l) => (l.id === cropped.id ? { ...cropped, zoom: zoom > 1 ? zoom : undefined } : l)) }], `zoom ${cropped.id}`);
            },
          }
        : null;
  });

  // the words to type get the keys without the canvas scrolling to them: a box partly off the canvas would otherwise
  // drag everything on it sideways, and the pointer would then be off by that much (found in a real browser)
  const typedId = typed?.id;
  useEffect(() => {
    typing.current?.focus({ preventScroll: true });
    typing.current?.select();
  }, [typedId]);

  // The frames, drawn. A frame that fits a kept picture at this zoom is put on the canvas as that picture, made again
  // only when its content changed; the others are copied. `sharp` moves a moment after the last drawing that left a
  // stretched picture on the canvas (a zoom): then every frame is exact again.
  const kept = useRef(new Map<string, { key: string; size: number; made: FramePicture }>()).current;
  const [sharp, setSharp] = useState(0);
  const drawnAs = useRef<{ view: View | null; sharp: number; timer: number }>({ view: null, sharp: 0, timer: 0 });
  useEffect(() => {
    const was = drawnAs.current;
    return () => window.clearTimeout(was.timer);
  }, []);
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
    const was = drawnAs.current;
    const exact = sharp !== was.sharp;
    const viewMoved = !!was.view && (was.view.x !== view.x || was.view.y !== view.y || was.view.z !== view.z);
    was.sharp = sharp;
    was.view = view;
    const want = view.z * dpr;
    let rough = false;
    pages.forEach((p, k) => {
      const f = frameOf(p, k, width, height);
      const left = view.x + f.x * view.z;
      const top = view.y + f.y * view.z;
      if (left > room.w || left + f.w * view.z < 0 || top > room.h || top + f.h * view.z < 0) return;
      // the words being typed are in the box over the frame: the layer itself is not drawn under them
      const inWords = editing && k === at ? editing : "";
      const shown = inWords ? { ...p, layers: p.layers.filter((l) => l.id !== inWords) } : p;
      // on whole device pixels, so a kept picture copied there and the frame drawn there are the same picture
      const x = Math.round(left * dpr);
      const y = Math.round(top * dpr);
      const content = [numberOf(p.layers), p.background, p.gradient ? JSON.stringify(p.gradient) : "", f.w, f.h, numberOf(loaded), version, inWords].join("|");
      const plan = framePlan({ want, finest: keptScale(f.w, f.h), content, had: kept.get(p.id)?.made, viewMoved, exact });
      if (plan.how === "direct") {
        ctx.save();
        ctx.setTransform(want, 0, 0, want, x, y);
        ctx.beginPath();
        ctx.rect(0, 0, f.w, f.h);
        ctx.clip();
        drawPage(ctx, shown, f.w, f.h, loaded);
        ctx.restore();
        return;
      }
      const w = Math.ceil(f.w * plan.scale);
      const h = Math.ceil(f.h * plan.scale);
      const picture = keptOr(kept, p.id, `${content}@${plan.scale}`, w * h, KEPT_PIXELS, (old) => {
        const canvas = old?.canvas ?? document.createElement("canvas");
        // setting the size empties it
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext("2d")!;
        g.setTransform(plan.scale, 0, 0, plan.scale, 0, 0);
        drawPage(g, shown, f.w, f.h, loaded);
        return { canvas, content, scale: plan.scale };
      });
      if (plan.scale === want) return void ctx.drawImage(picture.canvas, x, y);
      rough = true;
      ctx.drawImage(picture.canvas, 0, 0, f.w * plan.scale, f.h * plan.scale, left * dpr, top * dpr, f.w * want, f.h * want);
    });
    window.clearTimeout(was.timer);
    if (rough) was.timer = window.setTimeout(() => setSharp((n) => n + 1), SETTLE);
  }, [pages, at, width, height, room, view, loaded, version, editing, sharp, kept]);

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
      const picture = pictureZoom.current;
      if (picture) return picture.set(picture.now * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01));
      const v = live.current;
      if (e.ctrlKey || e.metaKey) return setView(zoomAt(v, v.z * Math.exp(-Math.max(-50, Math.min(50, e.deltaY)) * 0.01), ...spot(e)));
      // a wheel that counts in lines or pages (some browsers, for a mouse's wheel) scrolls that many pixels
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1;
      // a wheel with Shift scrolls sideways
      const side = e.shiftKey && !e.deltaX;
      setView({ ...v, x: v.x - (side ? e.deltaY : e.deltaX) * unit, y: v.y - (side ? 0 : e.deltaY) * unit });
    };
    // Safari's pinch: its own events, with the scale since the pinch began
    let from = 1;
    const pinch = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale: number; clientX: number; clientY: number };
      const picture = pictureZoom.current;
      if (e.type === "gesturestart") from = picture ? picture.now : live.current.z;
      else if (picture) picture.set(from * g.scale);
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
  }, [setView]);

  // While the pen is on a line, Backspace, Delete and ⌘Z take its last point off and nothing else (not a layer, not a
  // frame, not the last saved change): heard before anything else hears the key.
  useEffect(() => {
    if (!pen) return;
    const key = (e: KeyboardEvent) => {
      const undo = (e.metaKey || e.ctrlKey) && e.code === "KeyZ";
      if (!undo && e.key !== "Backspace" && e.key !== "Delete") return;
      e.preventDefault();
      e.stopPropagation();
      const points = (penNow.current?.points ?? []).slice(0, -1);
      const next = penNow.current && points.length ? { k: penNow.current.k, points } : null;
      penNow.current = next;
      setPen(next);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [pen]);

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
  const hitAt = (k: number, p: Point) => (k >= 0 ? layerAt(pages[k]!, p.x - fr[k]!.x, p.y - fr[k]!.y, 6 / live.current.z) : null);

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

  const [panning, setPanning] = useState(false);
  const pan = (e: React.PointerEvent) => {
    const v0 = live.current;
    const x0 = e.clientX;
    const y0 = e.clientY;
    setPanning(true);
    drag(
      e,
      (ev) => setView({ ...v0, x: v0.x + ev.clientX - x0, y: v0.y + ev.clientY - y0 }),
      () => setPanning(false),
    );
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
        const near = SNAP / live.current.z;
        const at = { ...b0, x: b0.x + ox + m.dx, y: b0.y + oy + m.dy };
        const s = snapMove(at, targets, near);
        // an axis that caught on no edge or middle catches on even spacing with the layers beside it (not the frame)
        const others = targets.slice(1);
        const evenX = m.lockX || s.x !== undefined ? null : snapSpacing({ ...at, y: at.y + (m.lockY ? 0 : s.dy) }, others, near, "x");
        const evenY = m.lockY || s.y !== undefined ? null : snapSpacing({ ...at, x: at.x + (m.lockX ? 0 : s.dx) + (evenX?.d ?? 0) }, others, near, "y");
        // the axis Shift holds still catches on nothing
        const dx = Math.round(ox + m.dx + (m.lockX ? 0 : s.dx) + (evenX?.d ?? 0));
        const dy = Math.round(oy + m.dy + (m.lockY ? 0 : s.dy) + (evenY?.d ?? 0));
        const inCanvas = (gap: Gap): Gap => (gap.axis === "x" ? { ...gap, from: gap.from + g.x, to: gap.to + g.x, at: gap.at + g.y } : { ...gap, from: gap.from + g.y, to: gap.to + g.y, at: gap.at + g.x });
        setGuides({ ...(m.lockX || s.x === undefined ? {} : { x: g.x + s.x }), ...(m.lockY || s.y === undefined ? {} : { y: g.y + s.y }), span: g, gaps: [...(evenX?.gaps ?? []), ...(evenY?.gaps ?? [])].map(inCanvas) });
        // an id of its own in the frame it lands in
        const taken = new Set(host.layers.filter((l) => to !== k || copy || !ids.includes(l.id)).map((l) => l.id));
        const fresh = freshIds(host, moving.length);
        const placed = moving.map((l, n) => ({ ...l, x: l.x + dx, y: l.y + dy, id: taken.has(l.id) || (copy && to === k) ? fresh[n]! : l.id }));
        // copies, and layers landing in another frame, are a group among themselves, not part of one that is there
        const next = to !== k || copy ? regroup(placed, host.layers.filter((l) => to !== k || copy || !ids.includes(l.id))) : placed;
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
        } else if (!moved && ids.length > 1) {
          // a click on one of several picked: that one alone (with its group)
          const one = p.layers.find((l) => l.id === hit);
          onPick(k, one ? groupOf(p.layers, one) : [hit]);
        }
      },
    );
  };

  /** A box drawn from empty canvas: what it picks (hands.ts boxPick) is picked while it is drawn. Shift adds to what was picked before. */
  const marquee = (e: React.PointerEvent, k: number) => {
    const from = world(e);
    const home = k >= 0 ? k : at;
    const all = pages.map((p, n) => ({ rect: fr[n]!, layers: p.layers }));
    const add = e.shiftKey;
    let shown = "";
    const pickNow = (ev: PointerEvent, r: Rect) => {
      const got = boxPick(all, r, { home, deep: ev.metaKey || (ev.ctrlKey && !ON_A_MAC) });
      let to: [number, string[], boolean, string[]?] = add ? [at, [...selected], framed, [...framedIds]] : [home, [], false];
      if (got && "frames" in got) {
        const ids = [...new Set([...(add ? framedIds : []), ...got.frames.map((n) => pages[n]!.id)])];
        to = [pages.findIndex((p) => p.id === ids[0]), [], true, ids];
      } else if (got) {
        const ids = withGroups(pages[got.at]!.layers, got.layers);
        to = [got.at, add && got.at === at && !framed ? [...new Set([...selected, ...ids])] : ids, false];
      }
      // told only when it is something else than at the last move
      const key = JSON.stringify(to);
      if (key === shown) return;
      shown = key;
      onPick(...to);
    };
    drag(
      e,
      (ev) => {
        const to = world(ev);
        const r = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) };
        setBand(r);
        pickNow(ev, r);
      },
      (moved) => {
        setBand(null);
        // a press that drew no box: nothing is picked any more (with Shift, what was picked stays)
        if (!moved && !add) onPick(home, []);
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

  /**
   * A picture slid inside its box. The box cuts off what does not fit, and the focus says from which side: a drag
   * moves the picture by what was dragged, along the layer's own axes, as far as there is picture to show.
   */
  const slidePicture = (e: React.PointerEvent, l: ImageLayer) => {
    const pic = loaded.get(l.picture);
    if (!page || !pic?.width || !pic.height) return;
    const from = world(e);
    const k = (l.fit === "cover" ? Math.max(l.w / pic.width, l.h / pic.height) : Math.min(l.w / pic.width, l.h / pic.height)) * (l.zoom ?? 1);
    // the room the picture has to move in: below 0 where it is bigger than the box
    const room = { x: l.w - pic.width * k, y: l.h - pic.height * k };
    const was = { x: l.focus?.x ?? 0.5, y: l.focus?.y ?? 0.5 };
    const a = (-(l.rotate ?? 0) * Math.PI) / 180;
    const part = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const along = (dx * Math.cos(a) - dy * Math.sin(a)) * (l.flipX ? -1 : 1);
        const down = (dx * Math.sin(a) + dy * Math.cos(a)) * (l.flipY ? -1 : 1);
        last = withLayers(page, [{ ...l, focus: { x: Math.abs(room.x) > 0.5 ? part(was.x + along / room.x) : was.x, y: Math.abs(room.y) > 0.5 ? part(was.y + down / room.y) : was.y } }]);
        onLive([last]);
      },
      () => {
        onLive(null);
        if (last) onCommit([last]);
      },
    );
  };

  /** A press with the pen: a point of the line; on its first point, the line closed and done. Dragged on, the point's two handles. */
  const penDown = (e: React.PointerEvent, p: Point, under: number) => {
    const k = pen?.k ?? (under >= 0 ? under : at);
    const f = fr[k];
    // its frame is gone (taken out somewhere else): so is the line; and a line holds no more points than a path may
    if (!f) return void (setPen(null), setPenAt(null));
    if ((pen?.points.length ?? 0) >= DESIGN_LIMITS.points) return finishPen(false);
    const local = { x: Math.round(p.x - f.x), y: Math.round(p.y - f.y) };
    const first = pen?.points[0];
    if (pen && pen.points.length > 1 && first && Math.hypot(local.x - first.x, local.y - first.y) <= 8 / live.current.z) return finishPen(true);
    const points = [...(pen?.points ?? []), local];
    setPen({ k, points });
    drag(e, (ev) => {
      const to = world(ev);
      const out: [number, number] = [Math.round(to.x - f.x - local.x), Math.round(to.y - f.y - local.y)];
      setPen({ k, points: points.map((q, n) => (n === points.length - 1 ? { ...q, out, in: [-out[0], -out[1]] as [number, number] } : q)) });
    });
  };

  /** A point of a path, or the end of one of its handles, dragged: the line follows, and its box with it. */
  const shapeDrag = (e: React.PointerEvent, l: PathLayer, px: Anchor[], on: { anchor: number; handle?: "in" | "out" }) => {
    onShape({ id: l.id, anchor: on.anchor });
    if (!page || !here) return;
    const f = here;
    const a = px[on.anchor]!;
    let last: DesignPage | null = null;
    drag(
      e,
      (ev) => {
        const to = world(ev);
        // in the box as it was when the drag began: the layer is refit at every step, the drag is not
        const [bx, by] = toBox(l, to.x - f.x, to.y - f.y);
        const next = px.map((q, n) => (n !== on.anchor ? q : on.handle ? dragHandle(q, on.handle, [bx - a.x, by - a.y], ev.altKey) : { ...q, x: bx, y: by }));
        last = withLayers(page, [refit(l, next)]);
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
    const id = pages[k]!.id;
    // Shift: this frame joins the picked ones, or leaves them; nothing is dragged
    if (e.shiftKey && framedIds.length) {
      const next = framedIds.includes(id) ? framedIds.filter((x) => x !== id) : [...framedIds, id];
      const first = pages.findIndex((x) => x.id === next[0]);
      return first < 0 ? onPick(k, []) : onPick(first, [], true, next);
    }
    // one of several picked frames: they all move, and a press without a drag picks this one alone
    const many = framedIds.length > 1 && framedIds.includes(id);
    if (!many) onPick(k, [], true);
    const moving = pages.map((_, n) => n).filter((n) => (many ? framedIds.includes(pages[n]!.id) : n === k));
    const f = fr[k]!;
    const from = world(e);
    const others = fr.filter((_, n) => !moving.includes(n));
    let last: DesignPage[] | null = null;
    drag(
      e,
      (ev) => {
        // the frame under the pointer is the one that catches on the frames standing still; the others keep their place beside it
        const m = moveOf(ev, from);
        const s = snapMove({ ...f, x: f.x + m.dx, y: f.y + m.dy }, others, SNAP / live.current.z);
        const dx = Math.round(f.x + m.dx + (m.lockX ? 0 : s.dx)) - f.x;
        const dy = Math.round(f.y + m.dy + (m.lockY ? 0 : s.dy)) - f.y;
        setGuides({ ...(m.lockX || s.x === undefined ? {} : { x: s.x }), ...(m.lockY || s.y === undefined ? {} : { y: s.y }), span: boundsOf([...others, { ...f, x: f.x + dx, y: f.y + dy }]) });
        last = moving.map((n) => ({ ...pages[n]!, x: fr[n]!.x + dx, y: fr[n]!.y + dy }));
        onLive(last);
      },
      (moved) => {
        setGuides(null);
        onLive(null);
        if (last) onCommit(last);
        else if (!moved && many) onPick(k, [], true);
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
    // a picture being moved in its box: a press on it slides it, a press beside it is done with it
    if (cropped && here) {
      if (inLayer(cropped, p.x - here.x, p.y - here.y).inside) return slidePicture(e, cropped);
      onCrop(null);
    }
    // a path whose points are shown: a press on a point or a handle's end drags it, a press beside them is done with it
    if (shaped && here) {
      const [bx, by] = toBox(shaped, p.x - here.x, p.y - here.y);
      const px = inPixels(shaped);
      const on = pathHit(px, shaping?.anchor ?? null, bx, by, 7 / live.current.z);
      if (on) return shapeDrag(e, shaped, px, on);
      onShape(null);
    }
    if (tool === "frame") return make(e, -1);
    // a canvas with no frame yet: there is nothing to draw a layer on
    if (tool !== "move" && !fr.length) return;
    if (tool === "pen") return penDown(e, p, k);
    if (tool !== "move") return make(e, k >= 0 ? k : at);
    // an empty frame is taken by its own area, and so is a frame that is picked (its name always takes it)
    if (!hit && k >= 0 && (framedIds.includes(pages[k]!.id) || !pages[k]!.layers.some((l) => !l.hidden && !l.locked))) return moveFrame(e, k);
    if (!hit) return marquee(e, k);
    const mine = k === at ? selected : [];
    // a layer of a group picks the whole group; with ⌘ (or Ctrl) the one layer inside it
    const deep = e.metaKey || (e.ctrlKey && !ON_A_MAC);
    const whole = deep ? [hit.id] : groupOf(pages[k]!.layers, hit);
    if (e.shiftKey) return onPick(k, mine.includes(hit.id) ? mine.filter((id) => !whole.includes(id)) : [...new Set([...mine, ...whole])]);
    const ids = mine.includes(hit.id) && !deep ? mine : whole;
    if (ids !== mine) onPick(k, ids);
    move(e, k, ids, hit.id);
  };

  const over = (e: React.PointerEvent) => {
    const p = world(e);
    const k = frameUnder(p);
    if (pen) setPenAt(p);
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
          style={{ cursor: dropper ? "crosshair" : panning ? "grabbing" : space || tool === "hand" ? "grab" : tool === "move" ? "default" : "crosshair" }}
          onPointerDown={down}
          onPointerMove={over}
          onPointerLeave={() => setHover(null)}
          // the menu is for what is picked: a right press on something else picks that first. On the menu's own
          // event, since that is what opens it (a Ctrl-click on a Mac too)
          onContextMenu={(e) => {
            const p = world(e);
            const k = frameUnder(p);
            const hit = hitAt(k, p);
            if (hit && !(k === at && selected.includes(hit.id))) onPick(k, groupOf(pages[k]!.layers, hit));
          }}
          // nothing scrolls the canvas but its own view
          onScroll={(e) => e.currentTarget.scrollTo(0, 0)}
          onDoubleClick={(e) => {
            const p = world(e);
            const k = frameUnder(p);
            const hit = hitAt(k, p);
            if (tool === "pen") return finishPen(false);
            // on a point of the path being shaped: a corner made smooth, or smooth made a corner
            if (shaped && here && page) {
              const [bx, by] = toBox(shaped, p.x - here.x, p.y - here.y);
              const px = inPixels(shaped);
              const on = pathHit(px, null, bx, by, 7 / live.current.z);
              if (on) return onCommit([withLayers(page, [refit(shaped, toggleSmooth(px, on.anchor, !!shaped.closed))])]);
            }
            if (tool !== "move" || !hit) return;
            if (hit.type === "path") {
              onPick(k, [hit.id]);
              return onShape({ id: hit.id, anchor: null });
            }
            // a double click goes into a group: the one layer under it
            if (hit.type !== "text" && hit.type !== "image") return void (hit.group && onPick(k, [hit.id]));
            onPick(k, [hit.id]);
            if (hit.type === "text") onEdit(hit.id);
            else onCrop(hit.id);
          }}
        >
          <canvas ref={canvas} aria-label="The frames" className="pointer-events-none block h-full w-full" />
          {pages.map((p, k) => (
            <button
              key={p.id}
              type="button"
              data-page-name={k}
              onPointerDown={(e) => moveFrame(e, k)}
              className={cn("absolute -translate-y-full cursor-default truncate pb-1 text-left text-[11px] leading-4 outline-none focus-visible:underline", k === at || framedIds.includes(p.id) ? "text-[#0d99ff]" : "text-zinc-500 hover:text-[#0d99ff] dark:text-[#b3b3b3]")}
              style={{ left: view.x + fr[k]!.x * view.z, top: view.y + fr[k]!.y * view.z, maxWidth: Math.max(24, fr[k]!.w * view.z) }}
            >
              {pageName(p, k)}
            </button>
          ))}
          {framed && here && framedIds.length < 2 && (
            <div data-frame-selection className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={onScreen(here)}>
              {handles(true)}
            </div>
          )}
          {/* several frames picked: each is outlined, none has handles (they move, they are not resized together) */}
          {framedIds.length > 1 && pages.map((p, n) => framedIds.includes(p.id) && <div key={p.id} data-frame-selection className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={onScreen(fr[n]!)} />)}
          {outlined.map((l, n) => l && <div key={n} className="pointer-events-none absolute outline outline-2 outline-[#0d99ff]" style={place(n === 0 ? hover!.k : at, l)} />)}
          {guides?.x !== undefined && <div className="pointer-events-none absolute w-px bg-[#ff3b30]" style={{ left: view.x + guides.x * view.z, top: view.y + guides.span.y * view.z, height: guides.span.h * view.z }} />}
          {guides?.y !== undefined && <div className="pointer-events-none absolute h-px bg-[#ff3b30]" style={{ left: view.x + guides.span.x * view.z, top: view.y + guides.y * view.z, width: guides.span.w * view.z }} />}
          {guides?.gaps?.map((gap, n) => {
            // each even gap: a line across it, and how wide it is
            const a = gap.axis === "x" ? { left: view.x + gap.from * view.z, top: view.y + gap.at * view.z } : { left: view.x + gap.at * view.z, top: view.y + gap.from * view.z };
            const long = (gap.to - gap.from) * view.z;
            return (
              <div key={n} data-gap={gap.axis} className={cn("pointer-events-none absolute flex items-center justify-center bg-[#ff3b30]", gap.axis === "x" ? "h-px" : "w-px")} style={gap.axis === "x" ? { ...a, width: long } : { ...a, height: long }}>
                <span className="whitespace-nowrap rounded-sm bg-[#ff3b30] px-1 text-[10px] leading-[14px] text-white">{Math.round(gap.to - gap.from)}</span>
              </div>
            );
          })}
          {band && <div className="pointer-events-none absolute border border-[#0d99ff] bg-[#0d99ff]/10" style={onScreen(band)} />}
          {drawn && <div className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={onScreen(drawn)} />}
          {pen &&
            fr[pen.k] &&
            (() => {
              // the line so far, its points, and a thin line on to the pointer
              const f = fr[pen.k]!;
              const at = (x: number, y: number): [number, number] => [view.x + (f.x + x) * view.z, view.y + (f.y + y) * view.z];
              const last = pen.points.at(-1)!;
              const from = at(last.x, last.y);
              return (
                <svg data-pen className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                  <path d={svgPath(pen.points, false, at)} fill="none" stroke={BLUE} strokeWidth={1.5} />
                  {penAt && <line x1={from[0]} y1={from[1]} x2={view.x + penAt.x * view.z} y2={view.y + penAt.y * view.z} stroke={BLUE} strokeWidth={1} strokeDasharray="4 3" />}
                  {pen.points.map((q, n) => {
                    const [x, y] = at(q.x, q.y);
                    return <rect key={n} data-pen-point={n} x={x - 3.5} y={y - 3.5} width={7} height={7} fill="#ffffff" stroke={BLUE} strokeWidth={1} />;
                  })}
                </svg>
              );
            })()}
          {shaped &&
            here &&
            (() => {
              // the path's own line, its points, and the picked point's handles
              const px = inPixels(shaped);
              const at = (x: number, y: number): [number, number] => {
                const [fx, fy] = toFrame(shaped, x, y);
                return [view.x + (here.x + fx) * view.z, view.y + (here.y + fy) * view.z];
              };
              const picked = shaping?.anchor === null || shaping?.anchor === undefined ? null : px[shaping.anchor];
              return (
                <svg data-shaping className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
                  <path d={svgPath(px, !!shaped.closed, at)} fill="none" stroke={BLUE} strokeWidth={1} />
                  {picked &&
                    (["in", "out"] as const).map((which) => {
                      const h = picked[which];
                      if (!h) return null;
                      const [x1, y1] = at(picked.x, picked.y);
                      const [x2, y2] = at(picked.x + h[0], picked.y + h[1]);
                      return (
                        <g key={which}>
                          <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={BLUE} strokeWidth={1} />
                          <circle data-path-handle={which} cx={x2} cy={y2} r={3.5} fill="#ffffff" stroke={BLUE} strokeWidth={1} />
                        </g>
                      );
                    })}
                  {px.map((q, n) => {
                    const [x, y] = at(q.x, q.y);
                    return <rect key={n} data-path-point={n} x={x - 3.5} y={y - 3.5} width={7} height={7} fill={n === shaping?.anchor ? BLUE : "#ffffff"} stroke={BLUE} strokeWidth={1} />;
                  })}
                </svg>
              );
            })()}
          {!typed && picked.length > 1 && picked.map((l) => <div key={l.id} className="pointer-events-none absolute outline outline-1 outline-[#0d99ff]" style={place(at, l)} />)}
          {cropped && here && (
            <>
              <div data-cropping className="pointer-events-none absolute cursor-move outline-dashed outline-2 outline-[#0d99ff]" style={place(at, cropped)} />
              <div className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-sm px-1 text-[11px] leading-4 text-white" style={{ background: BLUE, left: view.x + (here.x + cropped.x + cropped.w / 2) * view.z, top: view.y + (here.y + boundsOf([cropped]).y + boundsOf([cropped]).h) * view.z + 6 }}>
                Drag to move the picture, scroll to zoom it
              </div>
            </>
          )}
          {!typed && !cropped && !shaped && around && here && (
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
          {framed && here && framedIds.length < 2 && (
            <div data-frame-size className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-sm px-1 text-[11px] leading-4 text-white" style={{ background: BLUE, left: view.x + (here.x + here.w / 2) * view.z, top: view.y + (here.y + here.h) * view.z + 6 }}>
              {here.w} × {here.h}
            </div>
          )}
          {typed && typedAs && page && (
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
              style={{ ...place(at, typed), font: fontOf(typedAs, view.z), lineHeight: `${lineHeightOf(typedAs) * view.z}px`, letterSpacing: typed.spacing ? `${typed.spacing * view.z}px` : undefined, color: typed.color, textAlign: typed.align, textTransform: typed.upper ? "uppercase" : undefined }}
            />
          )}
        </div>
      </ContextMenuTrigger>
      {menu}
    </ContextMenu>
  );
}
