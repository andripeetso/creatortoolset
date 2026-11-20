import { useEffect, useRef, useState } from "react";
import { DESIGN_AIDS, DESIGN_SAFE, type DesignGuide, type DesignPage } from "@contracts/design";
import { gridOf, PIXEL_GRID_FROM, rulerTicks, safeOf, setAidPref, useAidPrefs } from "@/lib/design/aids";
import type { Rect, View } from "@/lib/design/hands";
import { cn } from "@/lib/utils";

/**
 * The designer's aids over the canvas (lib/design/aids.ts), never in a saved picture:
 *   Rulers      along the top and the left (⇧R), numbered from the picked frame's corner. A drag out of one, let go
 *               over a frame, puts a guide on that frame: from the top ruler a line across it, from the left one a
 *               line down it.
 *   Guides      a frame's, across it alone. A drag moves one (let go outside its frame or on a ruler: it is gone); a
 *               click picks it, and then Delete removes it, the arrows nudge it (Shift: by ten) and Esc lets it go.
 *   Grids       each frame's layout grids (⌃G on a Mac, Ctrl+Shift+4 elsewhere, shows or hides them all) and the
 *               parts a social app cuts or covers, as the frame's Inspector turned them on.
 *   Pixel grid  from 400 % every pixel of a frame is outlined (⇧' turns it off and on).
 */

const GUIDE = "#e0368a";
const BLUE = "#0d99ff";
const RULER = 20;
const ON_A_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || !!t.closest('[role="menu"],[role="dialog"]'));
const NUDGE: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

type Moving = { axis: DesignGuide["axis"]; at: number; frame?: string; n?: number };

export function Aids({ pages, frames, view, at, onCommit }: { pages: DesignPage[]; frames: Rect[]; view: View; at: number; onCommit: (pages: DesignPage[]) => void }) {
  const prefs = useAidPrefs();
  const root = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{ frame: string; n: number } | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  const now = useRef({ pages, frames, view, picked });
  now.current = { pages, frames, view, picked };

  const withGuides = (frame: string, guides: DesignGuide[]) => {
    const p = now.current.pages.find((x) => x.id === frame);
    if (p) onCommit([{ ...p, guides: guides.length ? guides : undefined }]);
  };
  const commit = useRef(withGuides);
  commit.current = withGuides;

  // the keys that show and hide the aids, and the picked guide's: heard before the page's own (Delete would delete layers)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const take = (fn: () => void) => (e.preventDefault(), e.stopPropagation(), fn());
      const mod = e.metaKey || e.ctrlKey;
      if (e.shiftKey && !mod && !e.altKey && e.code === "KeyR") return take(() => setAidPref("rulers"));
      if (e.shiftKey && !mod && !e.altKey && e.code === "Quote") return take(() => setAidPref("pixels"));
      if (ON_A_MAC ? e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyG" : e.ctrlKey && e.shiftKey && e.code === "Digit4") return take(() => setAidPref("grids"));
      const g = now.current.picked;
      const p = g && now.current.pages.find((x) => x.id === g.frame);
      const guide = p?.guides?.[g!.n];
      if (!g || !p || !guide || mod) return;
      if (e.key === "Escape") return take(() => setPicked(null));
      if (e.key === "Delete" || e.key === "Backspace") return take(() => (commit.current(p.id, p.guides!.filter((_, n) => n !== g.n)), setPicked(null)));
      const by = NUDGE[e.key];
      // only across the guide: an up-and-down line goes left and right
      if (by && (guide.axis === "x") === (e.key === "ArrowLeft" || e.key === "ArrowRight")) take(() => commit.current(p.id, p.guides!.map((x, n) => (n === g.n ? { ...x, at: Math.max(0, x.at + by * (e.shiftKey ? 10 : 1)) } : x))));
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);
  // a press anywhere but on a guide lets the picked one go
  useEffect(() => {
    if (!picked) return;
    const down = (e: PointerEvent) => !(e.target instanceof Element && e.target.closest("[data-guide]")) && setPicked(null);
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [picked]);

  /** A guide dragged: a new one out of a ruler (no frame yet), or frame `frame`'s guide `n`. */
  const dragGuide = (e: React.PointerEvent, axis: DesignGuide["axis"], from?: { frame: string; n: number }) => {
    e.preventDefault();
    e.stopPropagation();
    const box = root.current!.getBoundingClientRect();
    const rulers = prefs.rulers;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const canvasAt = (ev: { clientX: number; clientY: number }) => {
      const v = now.current.view;
      return { x: (ev.clientX - box.left - v.x) / v.z, y: (ev.clientY - box.top - v.y) / v.z, sx: ev.clientX - box.left, sy: ev.clientY - box.top };
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      moved = true;
      const c = canvasAt(ev);
      setMoving({ axis, at: Math.round(axis === "x" ? c.x : c.y), ...from });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setMoving(null);
      if (!moved) return void (from && setPicked(from));
      const { pages: ps, frames: fs } = now.current;
      const c = canvasAt(ev);
      // let go on a ruler (when they are shown): taken back, or a moved guide removed
      const onRuler = rulers && (c.sx < RULER || c.sy < RULER);
      if (from) {
        const k = ps.findIndex((p) => p.id === from.frame);
        const f = fs[k];
        const p = ps[k];
        if (!f || !p?.guides) return;
        const pos = Math.round(axis === "x" ? c.x - f.x : c.y - f.y);
        const gone = onRuler || pos < 0 || pos > (axis === "x" ? f.w : f.h);
        commit.current(p.id, gone ? p.guides.filter((_, n) => n !== from.n) : p.guides.map((g, n) => (n === from.n ? { ...g, at: pos } : g)));
        setPicked(gone ? null : from);
        return;
      }
      if (onRuler) return;
      // the frame let go over (the top one where frames overlap); loose pictures hold no guides
      const k = fs.map((_, n) => n).reverse().find((n) => !ps[n]!.loose && c.x >= fs[n]!.x && c.x <= fs[n]!.x + fs[n]!.w && c.y >= fs[n]!.y && c.y <= fs[n]!.y + fs[n]!.h);
      if (k === undefined) return;
      const p = ps[k]!;
      const f = fs[k]!;
      const guides = p.guides ?? [];
      if (guides.length >= DESIGN_AIDS.guides) return;
      commit.current(p.id, [...guides, { axis, at: Math.round(axis === "x" ? c.x - f.x : c.y - f.y) }]);
      setPicked({ frame: p.id, n: guides.length });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const z = view.z;
  const screen = (r: Rect): React.CSSProperties => ({ left: view.x + r.x * z, top: view.y + r.y * z, width: r.w * z, height: r.h * z });
  const origin = pages[at] && !pages[at]!.loose ? frames[at]! : { x: 0, y: 0, w: 0, h: 0 };

  return (
    <div ref={root} data-aids className="pointer-events-none absolute inset-0">
      {pages.map((p, k) => {
        if (p.loose) return null;
        const f = frames[k]!;
        const grids = prefs.grids ? (p.grids ?? []).filter((g) => !g.hidden) : [];
        const pixels = prefs.pixels && z >= PIXEL_GRID_FROM;
        if (!grids.length && !p.safe?.length && !p.guides?.length && !pixels) return null;
        return (
          <div key={p.id} data-frame-aids={p.id} className="absolute overflow-hidden" style={screen(f)}>
            {pixels && <div data-pixel-grid className="absolute inset-0" style={{ backgroundImage: "linear-gradient(to right, rgba(128,128,128,.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(128,128,128,.35) 1px, transparent 1px)", backgroundSize: `${z}px ${z}px` }} />}
            {(grids.length > 0 || !!p.safe?.length) && (
              <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${f.w} ${f.h}`} preserveAspectRatio="none">
                {grids.map((g, n) => {
                  const laid = gridOf(g, f.w, f.h);
                  // cells too small to see on screen are not drawn
                  if (g.kind === "grid" && (g.size ?? 10) * z < 4) return null;
                  return (
                    <g key={n} data-grid={g.kind}>
                      {laid.bands.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={g.color} fillOpacity={0.12} />)}
                      {g.kind === "grid" && laid.x.map((x, i) => <line key={`x${i}`} x1={x} x2={x} y1={0} y2={f.h} stroke={g.color} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" />)}
                      {g.kind === "grid" && laid.y.map((y, i) => <line key={`y${i}`} y1={y} y2={y} x1={0} x2={f.w} stroke={g.color} strokeOpacity={0.3} vectorEffect="non-scaling-stroke" />)}
                    </g>
                  );
                })}
                {p.safe?.map((id) => {
                  const s = safeOf(id, f.w, f.h);
                  return (
                    <g key={id} data-safe={id}>
                      {s.covered.map((c, i) => <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} fill="#ff3b30" fillOpacity={0.14} />)}
                      <rect x={s.safe.x} y={s.safe.y} width={s.safe.w} height={s.safe.h} fill="none" stroke="#ff3b30" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    </g>
                  );
                })}
              </svg>
            )}
            {p.safe?.map((id) => {
              const s = safeOf(id, f.w, f.h);
              return (
                <span key={id} className="absolute whitespace-nowrap px-1 text-[10px] leading-4 text-[#ff3b30]" style={{ left: s.safe.x * z, top: s.safe.y * z }}>
                  {DESIGN_SAFE.find((d) => d.id === id)!.name}
                </span>
              );
            })}
          </div>
        );
      })}

      {pages.map((p, k) =>
        p.loose
          ? null
          : (p.guides ?? []).map((g, n) => {
              const f = frames[k]!;
              const on = picked?.frame === p.id && picked.n === n;
              const dragged = moving?.frame === p.id && moving.n === n;
              const pos = dragged ? moving.at - (g.axis === "x" ? f.x : f.y) : g.at;
              const style: React.CSSProperties =
                g.axis === "x" ? { left: view.x + (f.x + pos) * z - 3, top: view.y + f.y * z, width: 7, height: f.h * z, cursor: "ew-resize" } : { left: view.x + f.x * z, top: view.y + (f.y + pos) * z - 3, width: f.w * z, height: 7, cursor: "ns-resize" };
              return (
                <div key={`${p.id}:${n}`} data-guide={`${p.id}:${n}`} aria-label={`Guide at ${pos}`} className="pointer-events-auto absolute" style={style} onPointerDown={(e) => e.button === 0 && dragGuide(e, g.axis, { frame: p.id, n })}>
                  <div className={cn("absolute", g.axis === "x" ? "inset-y-0 left-[3px] w-px" : "inset-x-0 top-[3px] h-px")} style={{ background: on || dragged ? BLUE : GUIDE }} />
                </div>
              );
            }),
      )}
      {/* a new guide on its way out of a ruler: across the whole canvas, its place shown */}
      {moving && moving.frame === undefined && <div className="absolute" style={moving.axis === "x" ? { left: view.x + moving.at * z, top: 0, bottom: 0, width: 1, background: GUIDE } : { top: view.y + moving.at * z, left: 0, right: 0, height: 1, background: GUIDE }} />}

      {prefs.rulers && (
        <>
          <Ruler axis="x" view={view} origin={origin.x} span={pages[at] && !pages[at]!.loose ? [origin.x, origin.x + origin.w] : null} onDown={(e) => e.button === 0 && dragGuide(e, "y")} />
          <Ruler axis="y" view={view} origin={origin.y} span={pages[at] && !pages[at]!.loose ? [origin.y, origin.y + origin.h] : null} onDown={(e) => e.button === 0 && dragGuide(e, "x")} />
          <div className="absolute left-0 top-0 z-10 border-b border-r border-[#e6e6e6] bg-white dark:border-[#444] dark:bg-[#2c2c2c]" style={{ width: RULER, height: RULER }} />
        </>
      )}
    </div>
  );
}

/** One ruler: along the top (`x`) or down the left (`y`), numbered in canvas pixels from `origin`, the picked frame's extent tinted. */
function Ruler({ axis, view, origin, span, onDown }: { axis: "x" | "y"; view: View; origin: number; span: [number, number] | null; onDown: (e: React.PointerEvent) => void }) {
  const [length, setLength] = useState(4000);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    const seen = new ResizeObserver(() => setLength(axis === "x" ? box.clientWidth : box.clientHeight));
    seen.observe(box);
    return () => seen.disconnect();
  }, [axis]);
  const shift = axis === "x" ? view.x : view.y;
  const toCanvas = (s: number) => (s - shift) / view.z;
  const { at } = rulerTicks(toCanvas(0) - origin, toCanvas(length) - origin, view.z);
  const s = (v: number) => shift + (v + origin) * view.z;
  return (
    <div
      ref={el}
      data-ruler={axis}
      aria-label={axis === "x" ? "Top ruler: drag down for a guide" : "Left ruler: drag right for a guide"}
      onPointerDown={onDown}
      className={cn("pointer-events-auto absolute z-10 overflow-hidden bg-white text-[9px] text-zinc-500 dark:bg-[#2c2c2c] dark:text-[#b3b3b3]", axis === "x" ? "left-0 right-0 top-0 cursor-ns-resize border-b border-[#e6e6e6] dark:border-[#444]" : "bottom-0 left-0 top-0 cursor-ew-resize border-r border-[#e6e6e6] dark:border-[#444]")}
      style={axis === "x" ? { height: RULER } : { width: RULER }}
    >
      {span && <div className="absolute bg-[#0d99ff]/15" style={axis === "x" ? { left: s(span[0] - origin), width: (span[1] - span[0]) * view.z, top: 0, bottom: 0 } : { top: s(span[0] - origin), height: (span[1] - span[0]) * view.z, left: 0, right: 0 }} />}
      {at.map((v) => (
        <div key={v} className="absolute" style={axis === "x" ? { left: s(v), bottom: 0, height: RULER } : { top: s(v), right: 0, width: RULER }}>
          <div className={cn("absolute bg-current opacity-60", axis === "x" ? "bottom-0 left-0 h-1.5 w-px" : "right-0 top-0 h-px w-1.5")} />
          <span className={cn("absolute whitespace-nowrap leading-none", axis === "x" ? "left-0.5 top-0.5" : "left-[3px] top-[3px] rotate-180 [writing-mode:vertical-rl]")}>{Math.round(v)}</span>
        </div>
      ))}
    </div>
  );
}
