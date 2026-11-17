import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FlipHorizontal2, FlipVertical2, RotateCcw } from "lucide-react";
import { find, isVideo, lengthOf, move, rateOf, setItems, setSpeed, slip, trim, type Flip, type NleItem, type NleTimeline } from "@/lib/nle/model";
import { cn } from "@/lib/utils";

// The selected clip's settings, in folding sections: Transform, Crop, Composite, Speed, Audio, Clip. A value changes the
// player at once while it is dragged or typed (`onLive`), and is one step of undo when let go or entered (`onCommit`).
// Every row fits the panel's width: the panel only ever scrolls down.

const open = new Set(["Transform", "Crop", "Composite", "Speed", "Audio", "Clip"]);

export function NleInspector({ tl, keys, nameOf, onLive, onCommit }: {
  /** the timeline as committed (what a change is made from) */
  tl: NleTimeline;
  keys: string[];
  nameOf: (it: NleItem) => string;
  onLive: (tl: NleTimeline | null) => void;
  onCommit: (tl: NleTimeline) => void;
}) {
  const fps = tl.timeline.fps;
  const hits = keys.map((k) => find(tl, k)).filter((h): h is NonNullable<typeof h> => !!h);
  if (!hits.length) {
    const n = Object.values(tl.tracks).reduce((a, t) => a + t.items.length, 0);
    return (
      <div className="grid gap-1 text-xs text-zinc-400">
        <div className="truncate text-sm font-medium text-zinc-200">{tl.timeline.name || "Timeline"}</div>
        <div className="tabular-nums">{(lengthOf(tl) / fps).toFixed(2)} s · {tl.timeline.width}×{tl.timeline.height} · {fps} fps</div>
        <div>{n} clip{n === 1 ? "" : "s"} on {Object.keys(tl.tracks).length} tracks</div>
      </div>
    );
  }
  const { track, item } = hits[0];
  const video = isVideo(track);
  // the change goes to every selected clip of the same kind
  const same = hits.filter((h) => isVideo(h.track) === video).map((h) => h.item._k!);
  const set = (patch: Partial<NleItem>) => setItems(tl, same, patch);
  const num = (label: string, value: number, def: number, make: (v: number) => NleTimeline, o: { step: number; min?: number; max?: number; unit?: string; digits?: number } = { step: 1 }) => (
    <NumberRow key={label} label={label} value={value} def={def} {...o}
      onLive={(v) => onLive(v === null ? null : make(v))} onCommit={(v) => { onLive(null); onCommit(make(v)); }} />
  );
  const crop = item.crop ?? [0, 0, 0, 0];
  const cropAt = (i: number) => (v: number) => {
    const c = [...crop] as [number, number, number, number];
    c[i] = Math.min(0.95, Math.max(0, v / 100));
    return set({ crop: c.some((x) => x > 0) ? c : undefined });
  };
  const flip = (axis: "h" | "v") => {
    const h = item.flip === "h" || item.flip === "hv";
    const v = item.flip === "v" || item.flip === "hv";
    const [nh, nv] = axis === "h" ? [!h, v] : [h, !v];
    const f: Flip | undefined = nh && nv ? "hv" : nh ? "h" : nv ? "v" : undefined;
    onCommit(set({ flip: f }));
  };
  const src = tl.sources[item.src] ?? {};
  const sfps = src.fps || fps;
  const sec = (f: number) => Math.round((f / fps) * 1000) / 1000;

  return (
    <div className="grid min-w-0 gap-2 text-xs">
      <div className="min-w-0">
        <div className="font-mono text-zinc-500">{track}{same.length > 1 ? ` · ${same.length} clips` : ""}</div>
        <div className="truncate text-sm font-medium text-zinc-200" title={nameOf(item)}>{nameOf(item)}</div>
      </div>
      {video && (
        <Section title="Transform">
          {num("Zoom", item.zoom ?? 1, 1, (v) => set({ zoom: v === 1 ? undefined : v }), { step: 0.01, min: 0.05, max: 10, digits: 3 })}
          {num("Position X", item.pan ?? 0, 0, (v) => set({ pan: v || undefined }), { step: 1, digits: 1 })}
          {num("Position Y", item.tilt ?? 0, 0, (v) => set({ tilt: v || undefined }), { step: 1, digits: 1 })}
          {num("Rotation", item.rot ?? 0, 0, (v) => set({ rot: v || undefined }), { step: 0.5, min: -360, max: 360, unit: "°", digits: 1 })}
          <Row label="Flip" reset={item.flip ? () => onCommit(set({ flip: undefined })) : undefined}>
            <div className="flex gap-1">
              {(["h", "v"] as const).map((a) => {
                const on = item.flip === a || item.flip === "hv";
                return (
                  <button key={a} type="button" aria-pressed={on} aria-label={a === "h" ? "Flip horizontally" : "Flip vertically"} onClick={() => flip(a)}
                    className={cn("rounded border px-1.5 py-0.5", on ? "border-violet-500 bg-violet-500/20 text-violet-100" : "border-zinc-800 text-zinc-400 hover:bg-zinc-800")}>
                    {a === "h" ? <FlipHorizontal2 className="size-3.5" /> : <FlipVertical2 className="size-3.5" />}
                  </button>
                );
              })}
            </div>
          </Row>
        </Section>
      )}
      {video && (
        <Section title="Crop">
          {(["Left", "Top", "Right", "Bottom"] as const).map((l, i) => num(l, Math.round(crop[i] * 1000) / 10, 0, cropAt(i), { step: 0.5, min: 0, max: 95, unit: "%", digits: 1 }))}
        </Section>
      )}
      {video && (
        <Section title="Composite">
          {num("Opacity", Math.round((item.opacity ?? 1) * 1000) / 10, 100, (v) => set({ opacity: v >= 100 ? undefined : Math.max(0, v) / 100 }), { step: 1, min: 0, max: 100, unit: "%", digits: 1 })}
        </Section>
      )}
      <Section title="Speed">
        {num("Speed", item.speed ?? 1, 1, (v) => setSpeed(tl, same, v), { step: 0.05, min: 0.1, max: 16, unit: "×", digits: 2 })}
      </Section>
      {!video && (
        <Section title="Audio">
          {num("Volume", item.gain_db ?? 0, 0, (v) => set({ gain_db: v ? Math.round(v * 10) / 10 : undefined }), { step: 0.5, min: -60, max: 24, unit: "dB", digits: 1 })}
        </Section>
      )}
      <Section title="Clip">
        <Row label="On">
          <input type="checkbox" checked={item.enabled !== false} aria-label="Clip on"
            onChange={(e) => onCommit(set({ enabled: e.target.checked ? undefined : false }))} className="accent-violet-500" />
        </Row>
        {num("Start", sec(item.rec), sec(item.rec), (v) => move(tl, [item._k!], Math.round(v * fps) - item.rec), { step: 1 / fps, min: 0, unit: "s", digits: 2 })}
        {num("Length", sec(item.len), sec(item.len), (v) => trim(tl, item._k!, "tail", Math.round(v * fps) - item.len), { step: 1 / fps, min: 1 / fps, unit: "s", digits: 2 })}
        {num("Source in", Math.round((item.in / sfps) * 1000) / 1000, Math.round((item.in / sfps) * 1000) / 1000,
          (v) => slip(tl, item._k!, Math.round((v * sfps - item.in) / rateOf(tl, item))), { step: 1 / sfps, min: 0, unit: "s", digits: 2 })}
        <Row label="File">
          <span className="block truncate text-zinc-400" title={String(src.path ?? item.src)}>{String(src.path ?? item.src).split("/").pop()}</span>
        </Row>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [on, setOn] = useState(open.has(title));
  return (
    <section className="min-w-0 border-t border-zinc-800/80 pt-1.5">
      <button type="button" aria-expanded={on} onClick={() => {
        setOn(!on);
        if (on) open.delete(title); else open.add(title);
      }} className="flex w-full items-center gap-1 py-0.5 text-[11px] font-semibold tracking-wide text-zinc-300 uppercase">
        {on ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} {title}
      </button>
      {on && <div className="grid min-w-0 gap-1 pt-1">{children}</div>}
    </section>
  );
}

function Row({ label, children, reset, onScrub }: { label: string; children: ReactNode; reset?: () => void; onScrub?: (e: ReactPointerEvent) => void }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,5rem)_minmax(0,1fr)_1.25rem] items-center gap-1.5">
      <span onPointerDown={onScrub} className={cn("truncate text-zinc-500", onScrub && "cursor-ew-resize select-none")} title={onScrub ? `${label}: drag to change` : label}>{label}</span>
      <div className="min-w-0">{children}</div>
      {reset ? (
        <button type="button" aria-label={`Reset ${label}`} title="Reset" onClick={reset} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <RotateCcw className="size-3" />
        </button>
      ) : <span />}
    </div>
  );
}

/** A number: typed (live while typing, made on Enter or leaving the field) or dragged on its label. */
function NumberRow({ label, value, def, step, min = -Infinity, max = Infinity, unit, digits = 2, onLive, onCommit }: {
  label: string; value: number; def: number; step: number; min?: number; max?: number; unit?: string; digits?: number;
  onLive: (v: number | null) => void; onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = Number(value.toFixed(digits));
  const scrub = useRef<{ x: number; v: number; last: number } | null>(null);
  const escaped = useRef(false);
  const read = (s: string) => {
    const v = Number(s.replace(",", "."));
    return Number.isFinite(v) && s.trim() !== "" ? clamp(v) : null;
  };
  return (
    <Row label={label} reset={shown !== Number(def.toFixed(digits)) ? () => onCommit(def) : undefined}
      onScrub={(e) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        scrub.current = { x: e.clientX, v: value, last: value };
        const el = e.currentTarget as HTMLElement;
        const moveIt = (ev: PointerEvent) => {
          const s = scrub.current!;
          s.last = clamp(Number((s.v + Math.round((ev.clientX - s.x) / 2) * step * (ev.shiftKey ? 10 : 1)).toFixed(digits)));
          onLive(s.last);
        };
        const upIt = () => {
          el.removeEventListener("pointermove", moveIt);
          el.removeEventListener("pointerup", upIt);
          const s = scrub.current!;
          scrub.current = null;
          if (s.last !== s.v) onCommit(s.last);
          else onLive(null);
        };
        el.addEventListener("pointermove", moveIt);
        el.addEventListener("pointerup", upIt);
      }}>
      <label className="flex h-6 min-w-0 items-center rounded border border-zinc-800 bg-zinc-950 px-1.5 focus-within:border-violet-500">
        <input inputMode="decimal" aria-label={label} value={text ?? String(shown)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setText(e.target.value);
            const v = read(e.target.value);
            if (v !== null) onLive(v);
          }}
          onBlur={() => {
            const v = text === null || escaped.current ? null : read(text);
            escaped.current = false;
            setText(null);
            if (v !== null && v !== value) onCommit(v);
            else onLive(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              escaped.current = true;
              onLive(null);
              e.currentTarget.blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const v = clamp(Number((value + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1)).toFixed(digits)));
              setText(null);
              onCommit(v);
            }
          }}
          className="w-full min-w-0 bg-transparent font-mono tabular-nums text-zinc-100 outline-none" />
        {unit && <span className="shrink-0 pl-1 text-zinc-500">{unit}</span>}
      </label>
    </Row>
  );
}
