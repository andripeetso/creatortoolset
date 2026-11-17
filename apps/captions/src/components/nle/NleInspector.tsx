import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FlipHorizontal2, FlipVertical2, RotateCcw } from "lucide-react";
import { find, isVideo, lengthOf, move, rateOf, setItems, setSpeed, slip, trim, withLinked, type Flip, type NleItem, type NleTimeline } from "@/lib/nle/model";
import { cn } from "@/lib/utils";
import { Panel } from "./NleLayout";

// The Inspector panel: the selected clips' settings in tabs (Video: Transform, Crop, Composite; Audio: Volume; Clip:
// on, start, length, source in, speed, file) and the timeline's own (name, size, rate, length) in Timeline, the tab
// shown when nothing is selected. Sections fold. Every row is a label column and a value column of the panel's width,
// so the panel only ever scrolls down. A number is typed or dragged (on the field or its label): it changes the player
// at once while it is dragged or typed (`onLive`) and is one step of undo when let go or entered (`onCommit`).

type Tab = "video" | "audio" | "clip" | "timeline";
const TABS: [Tab, string][] = [["video", "Video"], ["audio", "Audio"], ["clip", "Clip"], ["timeline", "Timeline"]];
const folded = new Set<string>();
let lastTab: Tab = "video";

export function NleInspector({ tl, keys, nameOf, onLive, onCommit, notes }: {
  /** the timeline as committed (what a change is made from) */
  tl: NleTimeline;
  keys: string[];
  nameOf: (it: NleItem) => string;
  onLive: (tl: NleTimeline | null) => void;
  onCommit: (tl: NleTimeline) => void;
  /** what else the Timeline tab says (the page's own notes on this timeline) */
  notes?: ReactNode;
}) {
  const [pref, setPref] = useState<Tab>(lastTab);
  const fps = tl.timeline.fps;
  const hits = keys.map((k) => find(tl, k)).filter((h): h is NonNullable<typeof h> => !!h);
  const videos = hits.filter((h) => isVideo(h.track)).map((h) => h.item._k!);
  // the sound of the selection: its sound clips and the ones linked to its pictures
  const sounds = withLinked(tl, hits.map((h) => h.item._k!)).filter((k) => !isVideo(find(tl, k)!.track));
  const can: Record<Tab, boolean> = { video: videos.length > 0, audio: sounds.length > 0, clip: hits.length > 0, timeline: true };
  const tab: Tab = !hits.length ? "timeline" : can[pref] ? pref : (["video", "audio", "clip"] as const).find((t) => can[t])!;
  const pick = (t: Tab) => {
    lastTab = t;
    setPref(t);
  };
  const first = hits[0];

  return (
    <Panel title="Inspector" className="flex-1" bar={first ? (
      <span className="min-w-0 truncate text-zinc-300" title={nameOf(first.item)}>
        <span className="font-mono text-zinc-500">{first.track}</span> {nameOf(first.item)}{hits.length > 1 ? <span className="text-zinc-500"> · {hits.length} clips</span> : null}
      </span>
    ) : null}>
      <div role="tablist" aria-label="Inspector" className="grid shrink-0 grid-cols-4 border-b border-black/60 bg-[#1f1f23] text-[11px]">
        {TABS.map(([t, l]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} disabled={!can[t]} onClick={() => pick(t)}
            className={cn("relative h-8 font-medium", tab === t ? "text-zinc-50" : "text-zinc-400 hover:text-zinc-100", "disabled:text-zinc-700 disabled:hover:text-zinc-700")}>
            {l}
            {tab === t && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded bg-violet-500" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll pb-4 text-xs" role="tabpanel">
        {tab === "timeline" ? <TimelineTab tl={tl} onCommit={onCommit} notes={notes} />
          : tab === "video" ? <VideoTab tl={tl} keys={videos} onLive={onLive} onCommit={onCommit} />
          : tab === "audio" ? <AudioTab tl={tl} keys={sounds} onLive={onLive} onCommit={onCommit} />
          : <ClipTab tl={tl} item={first!.item} keys={hits.map((h) => h.item._k!)} fps={fps} onLive={onLive} onCommit={onCommit} />}
      </div>
    </Panel>
  );
}

type Edit = { tl: NleTimeline; onLive: (tl: NleTimeline | null) => void; onCommit: (tl: NleTimeline) => void };
type NumOpts = { step: number; min?: number; max?: number; unit?: string; digits?: number };

/** A number row whose change is `make(value)`. */
const numRow = ({ onLive, onCommit }: Edit, label: string, value: number, def: number, make: (v: number) => NleTimeline, o: NumOpts) => (
  <NumberRow key={label} label={label} value={value} def={def} {...o}
    onLive={(v) => onLive(v === null ? null : make(v))} onCommit={(v) => { onLive(null); onCommit(make(v)); }} />
);

function VideoTab({ keys, ...e }: Edit & { keys: string[] }) {
  const { tl, onCommit } = e;
  const item = find(tl, keys[0])!.item;
  const set = (patch: Partial<NleItem>) => setItems(tl, keys, patch);
  const crop = item.crop ?? [0, 0, 0, 0];
  const cropAt = (i: number) => (v: number) => {
    const c = [...crop] as [number, number, number, number];
    c[i] = Math.min(0.95, Math.max(0, v / 100));
    return set({ crop: c.some((x) => x > 0) ? c : undefined });
  };
  const hv = { h: item.flip === "h" || item.flip === "hv", v: item.flip === "v" || item.flip === "hv" };
  const flip = (axis: "h" | "v") => {
    const n = { ...hv, [axis]: !hv[axis] };
    const f: Flip | undefined = n.h && n.v ? "hv" : n.h ? "h" : n.v ? "v" : undefined;
    onCommit(set({ flip: f }));
  };
  const pan = item.pan ?? 0;
  const tilt = item.tilt ?? 0;
  return (
    <>
      <Section title="Transform">
        {numRow(e, "Zoom", item.zoom ?? 1, 1, (v) => set({ zoom: v === 1 ? undefined : v }), { step: 0.01, min: 0.05, max: 10, digits: 3 })}
        <PairRow label="Position" a={{ tag: "X", value: pan }} b={{ tag: "Y", value: tilt }} step={1} digits={1}
          reset={pan || tilt ? () => onCommit(set({ pan: undefined, tilt: undefined })) : undefined}
          onLive={(x, y) => e.onLive(x === null ? null : set({ pan: x || undefined, tilt: y || undefined }))}
          onCommit={(x, y) => { e.onLive(null); onCommit(set({ pan: x || undefined, tilt: y || undefined })); }} />
        {numRow(e, "Rotation", item.rot ?? 0, 0, (v) => set({ rot: v || undefined }), { step: 0.5, min: -360, max: 360, unit: "°", digits: 1 })}
        <Row label="Flip" reset={item.flip ? () => onCommit(set({ flip: undefined })) : undefined}>
          <div className="flex gap-1">
            {(["h", "v"] as const).map((a) => (
              <button key={a} type="button" aria-pressed={hv[a]} aria-label={a === "h" ? "Flip horizontally" : "Flip vertically"} title={a === "h" ? "Flip horizontally" : "Flip vertically"} onClick={() => flip(a)}
                className={cn("inline-flex h-6 w-8 items-center justify-center rounded border", hv[a] ? "border-violet-500 bg-violet-500/20 text-violet-100" : "border-zinc-700/80 text-zinc-400 hover:bg-zinc-800")}>
                {a === "h" ? <FlipHorizontal2 className="size-3.5" /> : <FlipVertical2 className="size-3.5" />}
              </button>
            ))}
          </div>
        </Row>
      </Section>
      <Section title="Crop">
        {(["Left", "Top", "Right", "Bottom"] as const).map((l, i) => numRow(e, l, Math.round(crop[i] * 1000) / 10, 0, cropAt(i), { step: 0.5, min: 0, max: 95, unit: "%", digits: 1 }))}
      </Section>
      <Section title="Composite">
        {numRow(e, "Opacity", Math.round((item.opacity ?? 1) * 1000) / 10, 100, (v) => set({ opacity: v >= 100 ? undefined : Math.max(0, v) / 100 }), { step: 1, min: 0, max: 100, unit: "%", digits: 1 })}
      </Section>
    </>
  );
}

function AudioTab({ keys, ...e }: Edit & { keys: string[] }) {
  const item = find(e.tl, keys[0])!.item;
  return (
    <Section title="Volume">
      {numRow(e, "Volume", item.gain_db ?? 0, 0, (v) => setItems(e.tl, keys, { gain_db: v ? Math.round(v * 10) / 10 : undefined }), { step: 0.5, min: -60, max: 24, unit: "dB", digits: 1 })}
    </Section>
  );
}

function ClipTab({ item, keys, fps, ...e }: Edit & { item: NleItem; keys: string[]; fps: number }) {
  const { tl, onCommit } = e;
  const src = tl.sources[item.src] ?? {};
  const sfps = src.fps || fps;
  const sec = (f: number) => Math.round((f / fps) * 1000) / 1000;
  const inS = Math.round((item.in / sfps) * 1000) / 1000;
  const path = String(src.path ?? item.src);
  return (
    <>
      <Section title="Timing">
        <Row label="On">
          <input type="checkbox" checked={item.enabled !== false} aria-label="Clip on"
            onChange={(ev) => onCommit(setItems(tl, keys, { enabled: ev.target.checked ? undefined : false }))} className="size-3.5 accent-violet-500" />
        </Row>
        {numRow(e, "Start", sec(item.rec), sec(item.rec), (v) => move(tl, [item._k!], Math.round(v * fps) - item.rec), { step: 1 / fps, min: 0, unit: "s", digits: 2 })}
        {numRow(e, "Length", sec(item.len), sec(item.len), (v) => trim(tl, item._k!, "tail", Math.round(v * fps) - item.len), { step: 1 / fps, min: 1 / fps, unit: "s", digits: 2 })}
        {numRow(e, "Source in", inS, inS, (v) => slip(tl, item._k!, Math.round((v * sfps - item.in) / rateOf(tl, item))), { step: 1 / sfps, min: 0, unit: "s", digits: 2 })}
        {numRow(e, "Speed", item.speed ?? 1, 1, (v) => setSpeed(tl, keys, v), { step: 0.05, min: 0.1, max: 16, unit: "×", digits: 2 })}
      </Section>
      <Section title="File">
        <Row label="Name"><span className="block truncate text-zinc-300" title={path}>{path.split("/").pop()}</span></Row>
        <Row label="Folder"><span className="block truncate text-zinc-500" title={path}>{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}</span></Row>
        {src.w && src.h ? <Row label="Size"><span className="font-mono tabular-nums text-zinc-400">{src.w}×{src.h}{src.fps ? ` · ${src.fps} fps` : ""}</span></Row> : null}
      </Section>
    </>
  );
}

function TimelineTab({ tl, onCommit, notes }: { tl: NleTimeline; onCommit: (tl: NleTimeline) => void; notes?: ReactNode }) {
  const t = tl.timeline;
  const fps = t.fps;
  const n = Object.values(tl.tracks).reduce((a, x) => a + x.items.length, 0);
  const setT = (patch: Partial<NleTimeline["timeline"]>) => onCommit({ ...tl, timeline: { ...t, ...patch } });
  const len = lengthOf(tl);
  return (
    <>
      <Section title="Timeline">
        <Row label="Name">
          <TextField value={t.name ?? ""} label="Timeline name" onCommit={(v) => setT({ name: v || undefined })} />
        </Row>
        <PairRow label="Size" a={{ tag: "W", value: t.width ?? 1080 }} b={{ tag: "H", value: t.height ?? 1920 }} step={2} digits={0} min={16} max={8192}
          onLive={() => {}} onCommit={(w, h) => setT({ width: Math.round(w), height: Math.round(h) })} />
        <Row label="Frame rate"><span className="font-mono tabular-nums text-zinc-300">{fps} fps</span></Row>
        <Row label="Length"><span className="font-mono tabular-nums text-zinc-300">{(len / fps).toFixed(2)} s · {len} f</span></Row>
        <Row label="Clips"><span className="tabular-nums text-zinc-400">{n} on {Object.keys(tl.tracks).length} tracks</span></Row>
      </Section>
      {notes && <div className="px-3 pt-2 text-zinc-500">{notes}</div>}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [on, setOn] = useState(!folded.has(title));
  return (
    <section className="min-w-0 border-b border-black/50">
      <button type="button" aria-expanded={on} onClick={() => {
        setOn(!on);
        if (on) folded.add(title); else folded.delete(title);
      }} className="flex h-8 w-full items-center gap-1.5 px-2 text-[12px] font-medium text-zinc-200 hover:bg-white/[0.03]">
        {on ? <ChevronDown className="size-3.5 text-zinc-500" /> : <ChevronRight className="size-3.5 text-zinc-500" />} {title}
      </button>
      {on && <div className="grid min-w-0 gap-1.5 px-3 pb-3">{children}</div>}
    </section>
  );
}

/** Label column, value column, reset: the same columns on every row. */
function Row({ label, children, reset, onScrub }: { label: string; children: ReactNode; reset?: () => void; onScrub?: (e: ReactPointerEvent) => void }) {
  return (
    <div className="grid min-h-6 min-w-0 grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_1.25rem] items-center gap-2">
      <span onPointerDown={onScrub} className={cn("truncate text-right text-zinc-400", onScrub && "cursor-ew-resize select-none")} title={label}>{label}</span>
      <div className="min-w-0">{children}</div>
      {reset ? (
        <button type="button" aria-label={`Reset ${label}`} title="Reset" onClick={reset} className="inline-flex size-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
          <RotateCcw className="size-3" />
        </button>
      ) : <span />}
    </div>
  );
}

/** A drag that changes a number: 2 px a step, ⇧ ten steps. `start` is the value it starts from. */
function scrubber(start: number, step: number, digits: number, clamp: (v: number) => number, onLive: (v: number) => void, onEnd: (v: number | null) => void) {
  return (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const x0 = e.clientX;
    let last = start;
    let moved = false;
    const moveIt = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      last = clamp(Number((start + Math.round((ev.clientX - x0) / 2) * step * (ev.shiftKey ? 10 : 1)).toFixed(digits)));
      onLive(last);
    };
    const upIt = () => {
      el.removeEventListener("pointermove", moveIt);
      el.removeEventListener("pointerup", upIt);
      el.removeEventListener("pointercancel", upIt);
      onEnd(moved ? last : null);
    };
    el.addEventListener("pointermove", moveIt);
    el.addEventListener("pointerup", upIt);
    el.addEventListener("pointercancel", upIt);
  };
}

/** One number field: dragged sideways to change it, clicked to type in it. */
function NumField({ label, tag, value, step, min = -Infinity, max = Infinity, unit, digits = 2, onLive, onCommit }: {
  label: string; tag?: string; value: number; step: number; min?: number; max?: number; unit?: string; digits?: number;
  onLive: (v: number | null) => void; onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const escaped = useRef(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = Number(value.toFixed(digits));
  const read = (s: string) => {
    const v = Number(s.replace(",", "."));
    return Number.isFinite(v) && s.trim() !== "" ? clamp(v) : null;
  };
  const typing = text !== null;
  return (
    <div
      onPointerDown={(e) => {
        if (typing || e.button !== 0) return;
        e.preventDefault();
        scrubber(value, step, digits, clamp, onLive, (v) => {
          if (v === null) {
            onLive(null);
            input.current?.focus();
          } else if (v !== value) onCommit(v);
          else onLive(null);
        })(e);
      }}
      className={cn("flex h-6 min-w-0 flex-1 items-center gap-1 rounded border border-zinc-700/70 bg-[#121214] px-1.5 focus-within:border-violet-500",
        !typing && "cursor-ew-resize hover:border-zinc-500")}>
      {tag && <span className="shrink-0 text-[10px] font-medium text-zinc-500">{tag}</span>}
      <input ref={input} inputMode="decimal" aria-label={tag ? `${label} ${tag}` : label} value={text ?? String(shown)}
        onFocus={(e) => {
          setText(String(shown));
          e.currentTarget.select();
        }}
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
            setText(String(v));
            onCommit(v);
          }
        }}
        className={cn("w-full min-w-0 bg-transparent text-right font-mono tabular-nums text-zinc-100 outline-none", !typing && "pointer-events-none")} />
      {unit && <span className="shrink-0 text-zinc-500">{unit}</span>}
    </div>
  );
}

function NumberRow({ label, value, def, onLive, onCommit, ...o }: NumOpts & {
  label: string; value: number; def: number; onLive: (v: number | null) => void; onCommit: (v: number) => void;
}) {
  const digits = o.digits ?? 2;
  const clamp = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  return (
    <Row label={label} reset={Number(value.toFixed(digits)) !== Number(def.toFixed(digits)) ? () => onCommit(def) : undefined}
      onScrub={scrubber(value, o.step, digits, clamp, onLive, (v) => (v === null || v === value ? onLive(null) : onCommit(v)))}>
      <NumField label={label} value={value} {...o} onLive={onLive} onCommit={onCommit} />
    </Row>
  );
}

/** Two numbers on one row (X and Y, width and height). */
function PairRow({ label, a, b, step, digits = 1, min, max, reset, onLive, onCommit }: {
  label: string; a: { tag: string; value: number }; b: { tag: string; value: number }; step: number; digits?: number; min?: number; max?: number;
  reset?: () => void; onLive: (x: number | null, y: number) => void; onCommit: (x: number, y: number) => void;
}) {
  return (
    <Row label={label} reset={reset}>
      <div className="flex min-w-0 gap-1">
        <NumField label={label} tag={a.tag} value={a.value} step={step} digits={digits} min={min} max={max}
          onLive={(v) => onLive(v, b.value)} onCommit={(v) => onCommit(v, b.value)} />
        <NumField label={label} tag={b.tag} value={b.value} step={step} digits={digits} min={min} max={max}
          onLive={(v) => onLive(v === null ? null : a.value, v ?? b.value)} onCommit={(v) => onCommit(a.value, v)} />
      </div>
    </Row>
  );
}

function TextField({ value, label, onCommit }: { value: string; label: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const escaped = useRef(false);
  return (
    <input aria-label={label} value={text ?? value} onFocus={() => setText(value)} onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = escaped.current ? undefined : text?.trim();
        escaped.current = false;
        setText(null);
        if (v !== undefined && v !== value) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") escaped.current = true;
        if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
      }}
      className="h-6 w-full min-w-0 rounded border border-zinc-700/70 bg-[#121214] px-1.5 text-zinc-100 outline-none focus:border-violet-500" />
  );
}
