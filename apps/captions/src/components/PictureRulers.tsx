import { useRef, useState } from "react";

/** A guide across the picture: `x` = a vertical line (from the left ruler), `y` = a horizontal one; `at` 0..1 of the picture. */
export type Guide = { axis: "x" | "y"; at: number };

/** Rulers and guides are the viewer's own: this browser keeps them. */
const KEY = "review.rulers";
function loadRulers(): { on: boolean; guides: Guide[] } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { on?: unknown; guides?: unknown };
    const guides = Array.isArray(v.guides)
      ? v.guides.filter((g): g is Guide => (g?.axis === "x" || g?.axis === "y") && Number.isFinite(g.at)).slice(0, 50)
      : [];
    return { on: v.on === true, guides };
  } catch {
    return { on: false, guides: [] };
  }
}
function saveRulers(v: { on: boolean; guides: Guide[] }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* private window: they last this visit */
  }
}

export const RULER = 20;
const nice = (s: number) => [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((k) => k * s >= 48) ?? 2000;

/**
 * Photoshop's rulers over Review's stage: pixels of the picture along the top and left, following the
 * viewer's zoom; drag out of a ruler for a guide, drag a guide to move it,
 * back onto its ruler to drop it.
 */
export function PictureRulers({ fit, pic, px, guides, setGuides }: {
  /** the picture's size and top-left in the stage, the stage's size */
  fit: { w: number; h: number; ox: number; oy: number; sw: number; sh: number };
  pic: { z: number; x: number; y: number };
  /** the picture in its own pixels */
  px: { w: number; h: number };
  guides: Guide[];
  setGuides: (f: (g: Guide[]) => Guide[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<number | null>(null);
  const [x0, y0] = [fit.ox + pic.x, fit.oy + pic.y]; // the picture's corner on the stage
  const [W, H] = [fit.w * pic.z, fit.h * pic.z]; // and its size there
  const spot = (e: React.PointerEvent) => {
    const r = root.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const place = (e: React.PointerEvent, axis: Guide["axis"]) => {
    const [x, y] = spot(e);
    return axis === "x" ? (x - x0) / W : (y - y0) / H;
  };
  const grab = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setHeld(i);
  };
  const follow = {
    onPointerMove: (e: React.PointerEvent) => {
      if (held === null) return;
      setGuides((l) => l.map((g, k) => (k === held ? { ...g, at: place(e, g.axis) } : g)));
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (held === null) return;
      const [x, y] = spot(e);
      // back on its ruler (or off the stage): gone
      setGuides((l) => l.filter((g, k) => k !== held || (g.axis === "x" ? x > RULER && x < fit.sw : y > RULER && y < fit.sh)));
      setHeld(null);
    },
  };
  const out = (axis: Guide["axis"]) => (e: React.PointerEvent) => {
    const at = place(e, axis);
    grab(guides.length)(e);
    setGuides((l) => [...l, { axis, at }]);
  };

  const ticks = (len: number, start: number, size: number, edge: number) => {
    const s = size / len; // stage px per picture px
    const step = nice(s);
    const minor = step >= 5 ? step / 5 : step;
    const from = Math.max(0, Math.ceil((RULER - start) / s / minor) * minor);
    const to = Math.min(len, (edge - start) / s);
    const out: { at: number; v: number; major: boolean }[] = [];
    for (let v = from; v <= to && out.length < 400; v += minor) out.push({ at: start + v * s, v, major: v % step === 0 });
    return out;
  };

  return (
    <div ref={root} className="pointer-events-none absolute inset-0 z-20 select-none text-[9px] text-zinc-400">
      {/* the guides, over the whole stage like Photoshop's */}
      {guides.map((g, i) => {
        const pos = g.axis === "x" ? x0 + g.at * W : y0 + g.at * H;
        const v = Math.round(g.at * (g.axis === "x" ? px.w : px.h));
        return (
          <div key={i} {...follow} onPointerDown={grab(i)}
            className={g.axis === "x"
              ? "pointer-events-auto absolute bottom-0 top-0 w-2 -translate-x-1/2 cursor-col-resize"
              : "pointer-events-auto absolute left-0 right-0 h-2 -translate-y-1/2 cursor-row-resize"}
            style={g.axis === "x" ? { left: pos } : { top: pos }}>
            <div className={g.axis === "x" ? "absolute bottom-0 left-1/2 top-0 w-px bg-cyan-400/90" : "absolute left-0 right-0 top-1/2 h-px bg-cyan-400/90"} />
            {held === i && (
              <span className="absolute rounded bg-cyan-500 px-1 font-mono text-[10px] text-black"
                style={g.axis === "x" ? { top: RULER + 4, left: 6 } : { left: RULER + 4, top: 6 }}>{v} px</span>
            )}
          </div>
        );
      })}
      {/* top ruler: drag down for a horizontal guide */}
      <div {...follow} onPointerDown={out("y")} title="Drag down for a guide"
        className="pointer-events-auto absolute left-0 right-0 top-0 cursor-s-resize border-b border-zinc-700 bg-zinc-900/95" style={{ height: RULER }}>
        <svg className="h-full w-full">
          <rect x={Math.max(RULER, x0)} width={Math.max(0, Math.min(fit.sw, x0 + W) - Math.max(RULER, x0))} height={RULER} className="fill-zinc-800" />
          {ticks(px.w, x0, W, fit.sw).map((t) => (
            <g key={t.v}>
              <line x1={t.at} x2={t.at} y1={t.major ? 6 : 14} y2={RULER} className="stroke-zinc-500" />
              {t.major && <text x={t.at + 2} y={9} className="fill-zinc-400">{t.v}</text>}
            </g>
          ))}
        </svg>
      </div>
      {/* left ruler: drag right for a vertical guide */}
      <div {...follow} onPointerDown={out("x")} title="Drag right for a guide"
        className="pointer-events-auto absolute bottom-0 left-0 top-0 cursor-e-resize border-r border-zinc-700 bg-zinc-900/95" style={{ width: RULER }}>
        <svg className="h-full w-full">
          <rect y={Math.max(RULER, y0)} height={Math.max(0, Math.min(fit.sh, y0 + H) - Math.max(RULER, y0))} width={RULER} className="fill-zinc-800" />
          {ticks(px.h, y0, H, fit.sh).map((t) => (
            <g key={t.v}>
              <line y1={t.at} y2={t.at} x1={t.major ? 6 : 14} x2={RULER} className="stroke-zinc-500" />
              {t.major && <text transform={`translate(9 ${t.at + 2}) rotate(90)`} className="fill-zinc-400">{t.v}</text>}
            </g>
          ))}
        </svg>
      </div>
      <div className="absolute left-0 top-0 border-b border-r border-zinc-700 bg-zinc-900" style={{ width: RULER, height: RULER }} />
    </div>
  );
}
PictureRulers.load = loadRulers;
PictureRulers.save = saveRulers;
