import { useContext, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  ChevronDown, ChevronLeft, ChevronRight, Diamond, FileText, Film, FlipHorizontal2, FlipVertical2, History, Link2, MessageCircle, Music, Palette,
  RotateCcw, Rows3, type LucideIcon,
} from "lucide-react";
import type { EdjCamera, EdjTrans, KeyEase, KeyProp } from "@contracts/editor";
import { PROFILES, type CameraLut, type Profile } from "@contracts/camera";
import type { TimelineItem, TimelineView } from "@contracts/edit-timeline";
import type { Grade } from "@contracts/grade";
import {
  find, handlesAt, isPlain, isVideo, lengthOf, maxLen, move, NO_MARKS, partsOf, putParts, rateOf, resetFields, setFades, setItems, setSpeed, slip,
  timecode, trim, withLinked, type Flip, type NleItem, type NleTimeline,
} from "@/lib/nle/model";
import { runAll, type NleRun } from "@/lib/nle/commands";
import { onKey, soundsAtCut } from "@/lib/nle/inspector-commands";
import { keysIn, valueOn } from "@/lib/nle/keyframes";
import type { Hist } from "@/lib/edit-history";
import type { Autosave } from "@/lib/nle/autosave";
import { fmtAgo } from "@/components/settings/helpers";
import { addLut, listLuts } from "@/lib/editor";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { GradePanel } from "@/components/GradePanel";
import { NleGate, Panel } from "./NleLayout";

// The Inspector panel, laid out like Resolve's: tabs with icons (Video: Transform, Cropping, Composite with the fades,
// Speed Change; Audio: Volume with the fades; File: on, start, length, source in, speed, the file) and the timeline's
// own (name, size, rate, length) in Timeline, the tab shown when nothing is selected. A section's header has its on/off
// switch, its reset and its fold. The model has no "off" flag, so turning a section off sets its values back to doing
// nothing and keeps them here (for this selection) to put back when it is turned on again. A number is dragged sideways
// (on the field or its label) or typed (click, Enter, Esc cancels): it changes the player at once while it is dragged
// or typed (`onLive`) and is one step of undo when let go or entered (`onCommit`). Double-click a label to reset it.
// Nothing here eases or animates: every change shows at once. A keyed row (◆) shows its value at the playhead and a
// change there keys it; keys, a picked transition and the camera run through the command registry (inspector-commands.ts).
// A picked transition takes the Video tab (Resolve's place for it).

type Tab = "video" | "audio" | "color" | "file" | "timeline" | "history";
const TABS: [Tab, string, LucideIcon][] = [
  ["video", "Video", Film], ["audio", "Audio", Music], ["color", "Color", Palette], ["file", "File", FileText], ["timeline", "Timeline", Rows3], ["history", "History", History],
];
/** a history step that came from the chat: its label starts with this (NleEditor names them) */
export const CHAT_STEP = "chat: ";
const RED = "#e5483b";
const folded = new Set<string>();
/** a section turned off: what its clips had (`null`: nothing to put back) by section and selection */
const parked = new Map<string, Record<string, Partial<NleItem>> | null>();
let lastTab: Tab = "video";

export function NleInspector({ tl, keys, nameOf, onLive, onCommit, notes, playhead = 0, transKey = null, onRun, hist, onHistory, autosaves = [], onAutosave, text }: {
  /** the timeline as committed (what a change is made from) */
  tl: NleTimeline;
  keys: string[];
  nameOf: (it: NleItem) => string;
  onLive: (tl: NleTimeline | null) => void;
  onCommit: (tl: NleTimeline, label?: string) => void;
  /** what else the Timeline tab says (the page's own notes on this timeline) */
  notes?: ReactNode;
  /** in timeline frames, as of the last pause or seek */
  playhead?: number;
  /** the picked transition: the handle of the clip after its cut */
  transKey?: string | null;
  /** registry commands run on clips `on` (the page's picks when left out) as one undo step */
  onRun?: (list: NleRun[], on?: string[]) => void;
  hist?: Hist<NleTimeline>;
  /** back or on to place `i` of the history */
  onHistory?: (i: number) => void;
  /** this timeline's autosaves, oldest first, listed under the steps; a click restores one as a step */
  autosaves?: Autosave[];
  onAutosave?: (a: Autosave) => void;
  /** at the top of the Video tab: a text clip's words and their style (NleText) */
  text?: ReactNode;
}) {
  const [pref, setPref] = useState<Tab>(lastTab);
  const fps = tl.timeline.fps;
  const hits = keys.map((k) => find(tl, k)).filter((h): h is NonNullable<typeof h> => !!h);
  const videos = hits.filter((h) => isVideo(h.track)).map((h) => h.item._k!);
  // the sound of the selection: its sound clips and the ones linked to its pictures
  const sounds = withLinked(tl, hits.map((h) => h.item._k!)).filter((k) => !isVideo(find(tl, k)!.track));
  const trans = transKey && find(tl, transKey)?.item.trans ? transKey : null;
  const can: Record<Tab, boolean> = {
    video: videos.length > 0 || !!trans, audio: sounds.length > 0, color: videos.length > 0, file: hits.length > 0, timeline: true, history: !!hist,
  };
  const tab: Tab = can[pref] ? pref : !hits.length && !trans ? "timeline" : (["video", "audio", "file"] as const).find((t) => can[t])!;
  const e: Edit = { tl, onLive, onCommit, playhead, onRun: onRun ?? (() => {}) };
  const pick = (t: Tab) => {
    lastTab = t;
    setPref(t);
  };
  const first = hits[0];

  return (
    <Panel title="Inspector" className="flex-1" bar={first ? (
      <span className="min-w-0 truncate text-zinc-200" title={nameOf(first.item)}>
        {nameOf(first.item)}{hits.length > 1 ? <span className="text-zinc-500"> · {hits.length} clips</span> : null}
      </span>
    ) : null}>
      <div role="tablist" aria-label="Inspector" className="grid shrink-0 grid-cols-6 border-b border-black/70 bg-[#1c1c1f]">
        {TABS.map(([t, l, Icon]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} disabled={!can[t]} onClick={() => pick(t)}
            className={cn("relative flex h-11 flex-col items-center justify-center gap-0.5 text-[10.5px]",
              tab === t ? "text-zinc-50" : "text-zinc-400 hover:text-zinc-100", "disabled:text-zinc-700 disabled:hover:text-zinc-700")}>
            <Icon className="size-4" strokeWidth={1.6} />
            <span className="max-w-full truncate px-0.5">{l}</span>
            {tab === t && <span className="absolute inset-x-2 bottom-0 h-0.5" style={{ background: RED }} />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-scroll bg-[#19191c] pb-4 text-[11.5px]" role="tabpanel">
        {tab === "timeline" ? <TimelineTab tl={tl} onCommit={onCommit} notes={notes} onRun={e.onRun} />
          : tab === "history" ? <HistoryTab hist={hist!} onHistory={onHistory ?? (() => {})} autosaves={autosaves} onAutosave={onAutosave ?? (() => {})} />
          : tab === "video" ? (trans ? <TransitionTab {...e} k={trans} /> : <>{text}<VideoTab {...e} keys={videos} /></>)
          : tab === "audio" ? <AudioTab {...e} keys={sounds} />
          : tab === "color" ? <ColorTab {...e} keys={videos} nameOf={nameOf} onClose={() => pick("video")} />
          : <FileTab {...e} item={first!.item} keys={hits.map((h) => h.item._k!)} fps={fps} />}
      </div>
    </Panel>
  );
}

/** Controls of clip field `field` on clips `keys`, greyed with why where the server's renders don't draw it (NleGate);
 *  `line`: the why written under them too. */
function Gated({ e, keys, field, line, children }: { e: Edit; keys: string[]; field: string; line?: boolean; children: ReactNode }) {
  const off = useContext(NleGate).field([...new Set(keys.flatMap((k) => find(e.tl, k)?.track ?? []))], field);
  if (!off) return <>{children}</>;
  return (
    <fieldset disabled title={off} className="min-w-0 opacity-40">
      {children}
      {line && <p className="px-2 pb-1 text-[11px] text-zinc-300">{off}</p>}
    </fieldset>
  );
}

type Edit = {
  tl: NleTimeline; onLive: (tl: NleTimeline | null) => void; onCommit: (tl: NleTimeline, label?: string) => void;
  playhead: number; onRun: (list: NleRun[], on?: string[]) => void;
};

/** A row's ◆: its props keyed on clips `keys` at the playhead. */
type KeyCtl = { on: boolean; ease?: KeyEase; toggle: () => void; setEase: (how: KeyEase) => void; del: () => void; prev: (() => void) | null; next: (() => void) | null };
function keyCtl(e: Edit, keys: string[], props: KeyProp[]): KeyCtl {
  const s = { tl: e.tl, sel: keys, playhead: e.playhead };
  const on = onKey(s, props[0]);
  const frames = keys.flatMap((k) => keysIn(e.tl, k, props[0]).map((x) => Math.round(x.f)));
  const all = (id: string, more: Record<string, string> = {}) => e.onRun(props.map((prop) => ({ id, params: { prop, ...more } })), keys);
  return {
    on: on.length > 0,
    ease: on.length ? keysIn(e.tl, on[0], props[0]).find((x) => Math.abs(x.f - e.playhead) < 1e-2)?.key[2] : undefined,
    toggle: () => all(on.length ? "deleteKey" : "key"),
    setEase: (ease) => all("key", { ease }),
    del: () => all("deleteKey"),
    prev: frames.some((f) => f < e.playhead) ? () => e.onRun([{ id: "prevKey", params: { prop: props[0] } }], keys) : null,
    next: frames.some((f) => f > e.playhead) ? () => e.onRun([{ id: "nextKey", params: { prop: props[0] } }], keys) : null,
  };
}
/** Whether clips `keys` key any of `props`. */
const keyed = (tl: NleTimeline, keys: string[], props: KeyProp[]) => keys.some((k) => props.some((p) => find(tl, k)?.item.keys?.[p]?.length));
/** The timeline with the props keyed at the playhead to `values` (registry "key"), each as the command's units. */
const keyAt = (e: Edit, keys: string[], values: Partial<Record<KeyProp, number>>) =>
  runAll({ tl: e.tl, sel: keys, playhead: e.playhead, marks: NO_MARKS }, Object.entries(values).map(([prop, value]) => ({ id: "key", params: { prop, value } }))).tl;
type NumOpts = { step: number; min?: number; max?: number; unit?: string; digits?: number };

/** A section's switch and reset over clip `fields` (see the top of the file). `bump` redraws when nothing was committed. */
function part(e: Edit, keys: string[], id: string, fields: string[], bump: () => void): { sw: Sw; reset: (() => void) | null } {
  const pk = `${id}|${keys.join(",")}`;
  const plain = isPlain(e.tl, keys, fields);
  const on = !(plain && parked.has(pk));
  return {
    reset: plain ? null : () => {
      parked.delete(pk);
      e.onCommit(resetFields(e.tl, keys, fields));
    },
    sw: {
      on,
      toggle: () => {
        if (!on) {
          const p = parked.get(pk);
          parked.delete(pk);
          if (p) e.onCommit(putParts(e.tl, p));
          else bump();
        } else if (plain) {
          parked.set(pk, null);
          bump();
        } else {
          parked.set(pk, partsOf(e.tl, keys, fields));
          e.onCommit(resetFields(e.tl, keys, fields));
        }
      },
    },
  };
}

/** Fade in / Fade out rows, in seconds, of clips whose first is `item`. */
const fadeRows = (e: Edit, keys: string[], item: NleItem) => {
  const fps = e.tl.timeline.fps;
  return (["in", "out"] as const).map((edge) => (
    <NumberRow key={edge} edit={e} label={edge === "in" ? "Fade in" : "Fade out"} value={((edge === "in" ? item.fade_in : item.fade_out) ?? 0) / fps}
      def={0} step={1 / fps} min={0} max={item.len / fps} unit="s" digits={2} make={(v) => setFades(e.tl, keys, edge, v * fps)} />
  ));
};

function VideoTab({ keys, ...e }: Edit & { keys: string[] }) {
  const { tl, onCommit } = e;
  const [, bump] = useReducer((n: number) => n + 1, 0);
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
  const at = (p: KeyProp) => valueOn(tl, keys[0], p, e.playhead);
  const has = (...p: KeyProp[]) => keyed(tl, keys, p);
  const pos = (v: [number, number]) => (has("pan", "tilt") ? keyAt(e, keys, { pan: v[0], tilt: v[1] }) : set({ pan: v[0] || undefined, tilt: v[1] || undefined }));
  return (
    <>
      <Section title="Transform" {...part(e, keys, "transform", ["zoom", "pan", "tilt", "rot", "flip"], bump)}>
        <NumberRow edit={e} label="Zoom" tags={["X", "Y"]} value={at("zoom")} def={1} step={0.01} min={0.05} max={10} digits={3}
          make={(v) => (has("zoom") ? keyAt(e, keys, { zoom: v }) : set({ zoom: v === 1 ? undefined : v }))} k={keyCtl(e, keys, ["zoom"])} />
        {/* shortcut: Position greys with pan, though its Y (tilt) may render; split the row if that matters */}
        <Gated e={e} keys={keys} field="pan">
          <PairRow label="Position" tags={["X", "Y"]} value={[at("pan"), at("tilt")]} def={[0, 0]} step={1} digits={3}
            onLive={(v) => e.onLive(v && pos(v))} onCommit={(v) => onCommit(pos(v), "Position")} k={keyCtl(e, keys, ["pan", "tilt"])} />
        </Gated>
        <Gated e={e} keys={keys} field="rot">
          <NumberRow edit={e} label="Rotation Angle" slider value={at("rot")} def={0} step={0.1} min={-360} max={360} digits={3}
            make={(v) => (has("rot") ? keyAt(e, keys, { rot: v }) : set({ rot: v || undefined }))} k={keyCtl(e, keys, ["rot"])} />
        </Gated>
        <Gated e={e} keys={keys} field="flip">
        <Row label="Flip" reset={item.flip ? () => onCommit(set({ flip: undefined })) : null}>
          <div className="flex gap-1.5">
            {(["h", "v"] as const).map((a) => (
              <button key={a} type="button" aria-pressed={hv[a]} aria-label={a === "h" ? "Flip horizontally" : "Flip vertically"} title={a === "h" ? "Flip horizontally" : "Flip vertically"} onClick={() => flip(a)}
                className={cn("inline-flex size-[22px] items-center justify-center rounded-sm border", hv[a] ? "border-zinc-300 bg-zinc-600 text-white" : "border-zinc-600 text-zinc-300 hover:border-zinc-400")}>
                {a === "h" ? <FlipHorizontal2 className="size-3.5" /> : <FlipVertical2 className="size-3.5" />}
              </button>
            ))}
          </div>
        </Row>
        </Gated>
      </Section>
      <Section title="Cropping" {...part(e, keys, "crop", ["crop"], bump)}>
        <Gated e={e} keys={keys} field="crop" line>
          {([["Crop Left", 0], ["Crop Right", 2], ["Crop Top", 1], ["Crop Bottom", 3]] as const).map(([l, i]) => (
            <NumberRow key={l} edit={e} label={l} slider value={Math.round(crop[i] * 10000) / 100} def={0} step={0.5} min={0} max={95} unit="%" digits={2} make={cropAt(i)} />
          ))}
        </Gated>
      </Section>
      <Section title="Composite" {...part(e, keys, "composite", ["opacity", "fade_in", "fade_out"], bump)}>
        <Gated e={e} keys={keys} field="opacity">
          <NumberRow edit={e} label="Opacity" slider value={Math.round(at("opacity") * 10000) / 100} def={100} step={1} min={0} max={100} digits={2}
            make={(v) => (has("opacity") ? keyAt(e, keys, { opacity: Math.max(0, v) / 100 }) : set({ opacity: v >= 100 ? undefined : Math.max(0, v) / 100 }))}
            k={keyCtl(e, keys, ["opacity"])} />
        </Gated>
        <Gated e={e} keys={keys} field="fade_in">{fadeRows(e, keys, item)}</Gated>
      </Section>
      <Section title="Speed Change" {...part(e, keys, "speed", ["speed"], bump)}>
        <Gated e={e} keys={keys} field="speed" line>
          <NumberRow edit={e} label="Speed" value={(item.speed ?? 1) * 100} def={100} step={1} min={10} max={1600} unit="%" digits={2}
            make={(v) => setSpeed(tl, keys, v / 100)} />
        </Gated>
      </Section>
      <CameraSection {...e} keys={keys} />
    </>
  );
}

function AudioTab({ keys, ...e }: Edit & { keys: string[] }) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const item = find(e.tl, keys[0])!.item;
  return (
    <Section title="Volume" {...part(e, keys, "volume", ["gain_db", "fade_in", "fade_out"], bump)}>
      <Gated e={e} keys={keys} field="gain_db">
        <NumberRow edit={e} label="Volume" slider value={valueOn(e.tl, keys[0], "gain_db", e.playhead)} def={0} step={0.1} min={-60} max={24} unit="dB" digits={2}
          make={(v) => (keyed(e.tl, keys, ["gain_db"]) ? keyAt(e, keys, { gain_db: Math.round(v * 100) / 100 })
            : setItems(e.tl, keys, { gain_db: v ? Math.round(v * 100) / 100 : undefined }))} k={keyCtl(e, keys, ["gain_db"])} />
      </Gated>
      <Gated e={e} keys={keys} field="fade_in">{fadeRows(e, keys, item)}</Gated>
    </Section>
  );
}

function FileTab({ item, keys, fps, ...e }: Edit & { item: NleItem; keys: string[]; fps: number }) {
  const { tl, onCommit } = e;
  const src = tl.sources[item.src] ?? {};
  const sfps = src.fps || fps;
  const sec = (f: number) => Math.round((f / fps) * 1000) / 1000;
  const path = String(src.path ?? item.src);
  return (
    <>
      <Section title="Timing">
        <Gated e={e} keys={keys} field="enabled">
          <Row label="On">
            <input type="checkbox" checked={item.enabled !== false} aria-label="Clip on"
              onChange={(ev) => onCommit(setItems(tl, keys, { enabled: ev.target.checked ? undefined : false }))} className="size-3.5 accent-zinc-300" />
          </Row>
        </Gated>
        <NumberRow edit={e} label="Start" value={sec(item.rec)} step={1 / fps} min={0} unit="s" digits={2} make={(v) => move(tl, [item._k!], Math.round(v * fps) - item.rec)} />
        <NumberRow edit={e} label="Length" value={sec(item.len)} step={1 / fps} min={1 / fps} unit="s" digits={2} make={(v) => trim(tl, item._k!, "tail", Math.round(v * fps) - item.len)} />
        <NumberRow edit={e} label="Source in" value={Math.round((item.in / sfps) * 1000) / 1000} step={1 / sfps} min={0} unit="s" digits={2}
          make={(v) => slip(tl, item._k!, Math.round((v * sfps - item.in) / rateOf(tl, item)))} />
        <Gated e={e} keys={keys} field="speed">
          <NumberRow edit={e} label="Speed" value={item.speed ?? 1} def={1} step={0.05} min={0.1} max={16} unit="×" digits={2} make={(v) => setSpeed(tl, keys, v)} />
        </Gated>
      </Section>
      <Section title="File">
        <Row label="Name"><span className="block truncate text-zinc-200" title={path}>{path.split("/").pop()}</span></Row>
        <Row label="Folder"><span className="block truncate text-zinc-500" title={path}>{path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""}</span></Row>
        {src.w && src.h ? <Row label="Size"><span className="font-mono tabular-nums text-zinc-400">{src.w}×{src.h}{src.fps ? ` · ${src.fps} fps` : ""}</span></Row> : null}
      </Section>
    </>
  );
}

function TimelineTab({ tl, onCommit, notes, onRun }: { tl: NleTimeline; onCommit: (tl: NleTimeline) => void; notes?: ReactNode; onRun: Edit["onRun"] }) {
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
        <PairRow label="Size" tags={["W", "H"]} value={[t.width ?? 1080, t.height ?? 1920]} step={2} digits={0} min={16} max={8192}
          onLive={() => {}} onCommit={([w, h]) => setT({ width: Math.round(w), height: Math.round(h) })} />
        <Row label="Frame rate"><span className="font-mono tabular-nums text-zinc-300">{fps} fps</span></Row>
        <Row label="Length"><span className="font-mono tabular-nums text-zinc-300">{(len / fps).toFixed(2)} s · {len} f</span></Row>
        <Row label="Clips"><span className="tabular-nums text-zinc-400">{n} on {Object.keys(tl.tracks).length} tracks</span></Row>
      </Section>
      <Section title="Markers">
        {tl.markers?.length ? [...tl.markers].sort((a, b) => a.frame - b.frame).map((m, i) => (
          <button key={i} type="button" title={typeof m.note === "string" && m.note ? m.note : undefined}
            onClick={() => onRun([{ id: "seek", params: { seconds: m.frame / fps } }])}
            className="grid h-6 min-w-0 grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-2 text-left hover:bg-white/5">
            <span className="size-2.5 rounded-sm" style={{ background: markerColor(m.color) }} />
            <span className="truncate text-zinc-200">{typeof m.name === "string" && m.name ? m.name : "Marker"}</span>
            <span className="font-mono tabular-nums text-zinc-400">{timecode(m.frame, fps)}</span>
          </button>
        )) : <p className="px-2 text-zinc-500">No markers</p>}
      </Section>
      {notes && <div className="px-3 pt-2 text-zinc-500">{notes}</div>}
    </>
  );
}

type Sw = { on: boolean; toggle: () => void };

/** A section: its switch (Resolve's red dot), its name (folds it), its reset and its fold chevron. */
function Section({ title, sw, reset, children }: { title: string; sw?: Sw; reset?: (() => void) | null; children: ReactNode }) {
  const [open, setOpen] = useState(!folded.has(title));
  const fold = () => {
    setOpen(!open);
    if (open) folded.add(title); else folded.delete(title);
  };
  return (
    <section className="min-w-0 border-b border-black/70">
      <div className="flex h-8 items-center gap-2 pl-2.5 pr-1">
        {sw && (
          <button type="button" role="switch" aria-checked={sw.on} aria-label={title} title={sw.on ? "Turn off" : "Turn on"} onClick={sw.toggle}
            className="flex h-3.5 w-6 shrink-0 items-center rounded-full bg-black/70 px-[3px]">
            <span className={cn("size-2 rounded-full", sw.on ? "ml-auto" : "bg-zinc-500")} style={sw.on ? { background: RED } : undefined} />
          </button>
        )}
        <button type="button" onClick={fold} className={cn("min-w-0 flex-1 truncate text-left text-[12px]", sw && !sw.on ? "text-zinc-500" : "text-zinc-100")}>{title}</button>
        {reset !== undefined && <ResetButton label={title} reset={reset} />}
        <button type="button" aria-expanded={open} aria-label={open ? `Fold ${title}` : `Open ${title}`} onClick={fold}
          className="inline-flex size-5 items-center justify-center rounded-sm text-zinc-500 hover:text-zinc-200">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      </div>
      {open && <div className={cn("grid min-w-0 gap-1 pb-2.5 pl-2 pr-1", sw && !sw.on && "opacity-50")}>{children}</div>}
    </section>
  );
}

/** `reset` null: at its default (shown dimmed). */
function ResetButton({ label, reset }: { label: string; reset: (() => void) | null }) {
  return (
    <button type="button" aria-label={`Reset ${label}`} title="Reset" disabled={!reset} onClick={reset ?? undefined}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-zinc-400 hover:text-zinc-100 disabled:text-zinc-700 disabled:hover:text-zinc-700">
      <RotateCcw className="size-3" />
    </button>
  );
}

/** Label column, value column, reset: the same columns on every row. `reset` omitted: no reset; null: at its default. */
function Row({ label, children, reset, onScrub }: { label: string; children: ReactNode; reset?: (() => void) | null; onScrub?: (e: ReactPointerEvent) => void }) {
  return (
    <div className="grid min-h-[26px] min-w-0 grid-cols-[minmax(0,6.25rem)_minmax(0,1fr)_1.25rem] items-center gap-2">
      <span onPointerDown={onScrub} onDoubleClick={reset ?? undefined} className={cn("truncate text-right text-zinc-400", onScrub && "cursor-ew-resize select-none")} title={label}>{label}</span>
      <div className="min-w-0">{children}</div>
      {reset !== undefined ? <ResetButton label={label} reset={reset} /> : <span />}
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

/** One number field (and its X / Y tag before it): dragged sideways to change it, clicked to type in it. */
function NumField({ label, tag, value, step, min = -Infinity, max = Infinity, unit, digits = 2, narrow, onLive, onCommit }: NumOpts & {
  label: string; tag?: string; value: number; narrow?: boolean; onLive: (v: number | null) => void; onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const escaped = useRef(false);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const shown = value.toFixed(digits);
  const read = (s: string) => {
    const v = Number(s.replace(",", "."));
    return Number.isFinite(v) && s.trim() !== "" ? clamp(v) : null;
  };
  const typing = text !== null;
  return (
    <>
      {tag && <span className="shrink-0 text-zinc-400">{tag}</span>}
      <div
        onPointerDown={(e) => {
          if (typing || e.button !== 0) return;
          e.preventDefault();
          scrubber(value, step, digits, clamp, onLive, (v) => {
            if (v === null) {
              onLive(null);
              input.current?.focus();
            } else onCommit(v);
          })(e);
        }}
        className={cn("flex h-[22px] min-w-0 items-center gap-1 rounded-sm border border-black bg-[#0f0f11] px-1.5 focus-within:border-zinc-400",
          narrow ? "w-[4.75rem] shrink-0" : "flex-1", !typing && "cursor-ew-resize hover:border-zinc-600")}>
        <input ref={input} inputMode="decimal" aria-label={tag ? `${label} ${tag}` : label} value={text ?? shown}
          onFocus={(e) => {
            setText(shown);
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
            if (v !== null) onCommit(v);
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
              setText(v.toFixed(digits));
              onCommit(v);
            }
          }}
          className={cn("w-full min-w-0 bg-transparent text-right font-mono text-[11px] tabular-nums text-zinc-100 outline-none", !typing && "pointer-events-none")} />
        {unit && <span className="shrink-0 text-zinc-500">{unit}</span>}
      </div>
    </>
  );
}

/** Resolve's slider before a number: moves the value while dragged, one commit when let go. */
function Slider({ label, value, min, max, step, onLive, onCommit }: {
  label: string; value: number; min: number; max: number; step: number; onLive: (v: number | null) => void; onCommit: (v: number) => void;
}) {
  const moved = useRef<number | null>(null);
  const end = () => {
    const v = moved.current;
    moved.current = null;
    if (v !== null) onCommit(v);
  };
  return (
    <input type="range" aria-label={`${label} slider`} min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))}
      onChange={(e) => {
        moved.current = Number(e.target.value);
        onLive(moved.current);
      }}
      // the slider's own keys move it, not the playhead
      onKeyDown={(e) => /^(Arrow|Home|End|Page)/.test(e.key) && e.stopPropagation()}
      onPointerUp={end} onKeyUp={end} onBlur={end}
      className="h-1 min-w-0 flex-1 cursor-pointer accent-zinc-400" />
  );
}

/**
 * A number row whose change is `make(value)`: the label and field scrub it, a `slider` sits before the field, `tags`
 * show it twice (Zoom X and Y: the model keeps one zoom, so the two stay linked). `def` omitted: no reset.
 */
function NumberRow({ edit, make, label, value, def, slider, tags, k, ...o }: NumOpts & {
  edit: Edit; make: (v: number) => NleTimeline; label: string; value: number; def?: number; slider?: boolean; tags?: [string, string]; k?: KeyCtl;
}) {
  // the value while it is dragged or typed: the row shows it, the timeline it is made from is still the committed one
  const [live, setLive] = useState<number | null>(null);
  const digits = o.digits ?? 2;
  const same = (a: number, b: number) => Number(a.toFixed(digits)) === Number(b.toFixed(digits));
  const clamp = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const onLive = (v: number | null) => {
    setLive(v);
    edit.onLive(v === null ? null : make(v));
  };
  const onCommit = (v: number) => {
    setLive(null);
    edit.onLive(null);
    if (!same(v, value)) edit.onCommit(make(v), label);
  };
  const shown = live ?? value;
  const field = (tag?: string) => <NumField label={label} tag={tag} value={shown} narrow={slider} {...o} onLive={onLive} onCommit={onCommit} />;
  return (
    <Row label={label} reset={def === undefined ? undefined : same(value, def) ? null : () => onCommit(def)}
      onScrub={scrubber(value, o.step, digits, clamp, onLive, (v) => (v === null ? onLive(null) : onCommit(v)))}>
      <div className="flex min-w-0 items-center gap-1.5">
        {slider && <Slider label={label} value={shown} min={o.min ?? 0} max={o.max ?? 100} step={o.step} onLive={onLive} onCommit={onCommit} />}
        {tags ? (
          <>
            {field(tags[0])}
            <span title="X and Y stay equal" className="shrink-0 text-zinc-300"><Link2 className="size-3.5" aria-label="X and Y linked" /></span>
            {field(tags[1])}
          </>
        ) : field()}
        {k && <KeyButtons label={label} k={k} />}
      </div>
    </Row>
  );
}

/** Two numbers on one row (Position X and Y, width and height). `def` omitted: no reset. */
function PairRow({ label, tags, value, def, step, digits = 1, min, max, onLive, onCommit, k }: {
  label: string; tags: [string, string]; value: [number, number]; def?: [number, number]; step: number; digits?: number; min?: number; max?: number;
  onLive: (v: [number, number] | null) => void; onCommit: (v: [number, number]) => void; k?: KeyCtl;
}) {
  const [live, setLive] = useState<[number, number] | null>(null);
  const shown = live ?? value;
  const go = (v: [number, number] | null) => {
    setLive(v);
    onLive(v);
  };
  const done = (v: [number, number]) => {
    go(null);
    if (v[0] !== value[0] || v[1] !== value[1]) onCommit(v);
  };
  const at = (i: number, v: number): [number, number] => (i ? [shown[0], v] : [v, shown[1]]);
  return (
    <Row label={label} reset={def ? (value[0] === def[0] && value[1] === def[1] ? null : () => done(def)) : undefined}>
      <div className="flex min-w-0 items-center gap-1.5">
        {[0, 1].map((i) => (
          <NumField key={i} label={label} tag={tags[i]} value={shown[i]} step={step} digits={digits} min={min} max={max}
            onLive={(v) => go(v === null ? null : at(i, v))} onCommit={(v) => done(at(i, v))} />
        ))}
        {k && <KeyButtons label={label} k={k} />}
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
      className="h-[22px] w-full min-w-0 rounded-sm border border-black bg-[#0f0f11] px-1.5 text-zinc-100 outline-none focus:border-zinc-400" />
  );
}

const EASES: [KeyEase, string][] = [["linear", "Linear"], ["ease", "Ease"], ["hold", "Hold"]];

/** ◀ ◆ ▶ at the right of a keyed row: ◆ adds a key at the playhead or (filled: one is there) deletes it; right-click it for its ease. */
function KeyButtons({ label, k }: { label: string; k: KeyCtl }) {
  const gate = useContext(NleGate);
  const arrow = "inline-flex h-4 w-3 items-center justify-center rounded-sm text-zinc-500 hover:text-zinc-100 disabled:text-zinc-800 disabled:hover:text-zinc-800";
  return (
    <span className="-ml-0.5 flex shrink-0 items-center">
      <button type="button" aria-label={`${label}: previous keyframe`} title="Previous keyframe" disabled={!k.prev} onClick={k.prev ?? undefined} className={arrow}>
        <ChevronLeft className="size-3" />
      </button>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!k.on}>
          <button type="button" aria-label={`${label} keyframe`} aria-pressed={k.on} disabled={!!gate.v2} title={gate.v2 ?? (k.on ? "Delete keyframe (right-click: Linear, Ease, Hold)" : "Add keyframe")}
            onClick={k.toggle} className="inline-flex size-4 items-center justify-center rounded-sm text-zinc-400 hover:text-zinc-100 disabled:text-zinc-700 disabled:hover:text-zinc-700">
            <Diamond className="size-3" fill={k.on ? RED : "none"} stroke={k.on ? RED : "currentColor"} />
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-32">
          <ContextMenuRadioGroup value={k.ease} onValueChange={(v) => k.setEase(v as KeyEase)}>
            {EASES.map(([v, l]) => <ContextMenuRadioItem key={v} value={v}>{l}</ContextMenuRadioItem>)}
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={k.del}>Delete</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <button type="button" aria-label={`${label}: next keyframe`} title="Next keyframe" disabled={!k.next} onClick={k.next ?? undefined} className={arrow}>
        <ChevronRight className="size-3" />
      </button>
    </span>
  );
}

/** Pick one: a radio list, a row each. */
function Radios({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <RadioGroup aria-label={label} value={value} onValueChange={onPick} className="gap-0.5 py-0.5">
      {options.map(([v, l]) => (
        <label key={v} className="flex min-h-[22px] min-w-0 cursor-pointer items-center gap-2 text-zinc-200">
          <RadioGroupItem value={v} aria-label={l} className="size-3.5 border-zinc-500" />
          <span className="truncate" title={l}>{l}</span>
        </label>
      ))}
    </RadioGroup>
  );
}

const TRANS_NAMES: Record<EdjTrans["type"], string> = { dissolve: "Cross Dissolve", dip_black: "Dip to Black", dip_white: "Dip to White", crossfade: "Cross Fade" };
const ALIGN: [EdjTrans["at"], string][] = [["center", "Center"], ["start", "Start on Cut"], ["end", "End on Cut"]];

/** A picked transition: its type, length (as long as the clips' handles allow) and alignment, and its linked sound. */
function TransitionTab({ k, ...e }: Edit & { k: string }) {
  const hit = find(e.tl, k)!;
  const t = hit.item.trans!;
  const fps = e.tl.timeline.fps;
  const video = isVideo(hit.track);
  const s = { tl: e.tl, sel: [k], trans: k, playhead: e.playhead, marks: NO_MARKS };
  const run = (params: Record<string, string | number>) => e.onRun([{ id: "transition", params }], [k]);
  const h = handlesAt(e.tl, k);
  const sounds = soundsAtCut(e.tl, k);
  return (
    <Section title="Transition">
      <Row label="Type">
        <Radios label="Transition type" value={t.type} onPick={(type) => run({ type })}
          options={(video ? (["dissolve", "dip_black", "dip_white"] as const) : (["crossfade"] as const)).map((x) => [x, TRANS_NAMES[x]])} />
      </Row>
      <NumberRow edit={e} label="Duration" value={t.len / fps} step={1 / fps} min={1 / fps} max={h ? maxLen(h, t.at) / fps : t.len / fps} unit="s" digits={2}
        make={(v) => runAll(s, [{ id: "transition", params: { frames: v * fps } }]).tl} />
      <Row label="Alignment">
        <Radios label="Alignment" value={t.at} options={ALIGN} onPick={(at) => run({ at })} />
      </Row>
      {video && (
        <Row label="Cross-fade sound">
          <input type="checkbox" role="switch" aria-label="Cross-fade sound" disabled={!sounds.length} checked={sounds.some((x) => find(e.tl, x)!.item.trans)}
            onChange={(ev) => run({ sound: ev.target.checked ? 1 : 0 })} className="size-3.5 accent-zinc-300" />
        </Row>
      )}
    </Section>
  );
}

/** The picked clips' file's camera conversion (per file: every clip of it gets it): None, what the file says, a curve, an added LUT. */
function CameraSection({ keys, ...e }: Edit & { keys: string[] }) {
  const gate = useContext(NleGate);
  const [luts, setLuts] = useState<CameraLut[]>([]);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    listLuts().then(setLuts, (x: Error) => setError(x.message));
  }, []);
  const src = e.tl.sources[find(e.tl, keys[0])?.item.src ?? ""];
  if (!src || src.kind === "design") return null;
  const cam = src.camera as EdjCamera | undefined;
  const value = !cam?.on ? "none" : cam.lut ?? (cam.from === "file" ? "file" : cam.curve ?? "none");
  const name = (c: string) => PROFILES[c as Profile]?.label ?? c;
  const options: [string, string][] = [
    ["none", "None"],
    ...(cam?.from === "file" && cam.curve ? [["file", `${name(cam.curve)} (from the file)`] as [string, string]] : []),
    ...Object.entries(PROFILES).map(([id, p]): [string, string] => [id, p.label]),
    ...luts.map((l): [string, string] => [l.id, l.name]),
    ...(cam?.lut && !luts.some((l) => l.id === cam.lut) ? [[cam.lut, cam.lut] as [string, string]] : []),
  ];
  const add = (f: File | undefined) => {
    if (!f) return;
    setError(null);
    addLut(f).then(setLuts, (x: Error) => setError(x.message));
  };
  return (
    <Section title="Camera">
      <fieldset disabled={!!gate.v2} title={gate.v2 ?? undefined} className="grid min-w-0 gap-1 px-2 disabled:opacity-40">
        {gate.v2 && <p className="text-[11px] text-zinc-400">{gate.v2}</p>}
        <Radios label="Camera" value={value} options={options} onPick={(pick) => e.onRun([{ id: "camera", params: { pick } }], keys)} />
        <button type="button" onClick={() => file.current?.click()} className="w-fit rounded-sm px-1 text-left text-zinc-300 hover:bg-white/5 hover:text-zinc-100">Add LUT…</button>
        <input ref={file} type="file" accept=".cube" hidden aria-label="LUT file" onChange={(ev) => {
          add(ev.target.files?.[0]);
          ev.target.value = "";
        }} />
        {error && <p role="alert" className="text-[11px] text-red-400">{error}</p>}
      </fieldset>
    </Section>
  );
}

/** The Review Color panel on the first picked clip's grade (by hand only); "Copy to take" goes to V1's clips of the same file. */
function ColorTab({ keys, nameOf, onClose, ...e }: Edit & { keys: string[]; nameOf: (it: NleItem) => string; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const tl = e.tl;
  const hit = find(tl, keys[0])!;
  const asItem = (it: NleItem, track: string): TimelineItem => ({ key: it._k!, track, rec: it.rec, len: it.len, label: nameOf(it), src: it.src, grade: it.grade as Grade | undefined });
  const item = asItem(hit.item, hit.track);
  const view: TimelineView = {
    name: String(tl.timeline.name ?? ""), fps: tl.timeline.fps, duration: lengthOf(tl) / tl.timeline.fps, width: tl.timeline.width ?? 0, height: tl.timeline.height ?? 0,
    tracks: [{ id: "V1", name: "V1", items: (tl.tracks.V1?.items ?? []).map((it) => asItem(it, "V1")) }], markers: [], words: [], flags: [],
  };
  return (
    <GradePanel view={view} item={item} pending={item.grade} video={video} hint="The grade is kept with the timeline's next Save"
      onLive={(g) => e.onLive(g && setItems(tl, [item.key], { grade: g }))}
      // no grade in a change: the same as the clip has now
      onApply={(changes) => e.onCommit(changes.reduce((t, [it, c]) => (c.grade ? setItems(t, [it.key], { grade: c.grade }) : t), tl), "Grade")}
      onClose={onClose} />
  );
}

const MARKER_CSS: Record<string, string> = {
  red: "#e5483b", yellow: "#e6c229", green: "#3fb950", cyan: "#22c3d6", blue: "#3b82f6", purple: "#a855f7", pink: "#ec4899", lavender: "#b4a7f5", magenta: "#b4a7f5",
};
const markerColor = (c: unknown) => MARKER_CSS[String(c).toLowerCase()] ?? "#3b82f6";

/** The undo steps, oldest first: a click goes back (or on) to that one; the ones after it stay grey until a new edit.
 *  Under them the autosaves, newest first: a click restores one as a new step. */
function HistoryTab({ hist, onHistory, autosaves, onAutosave }: {
  hist: Hist<NleTimeline>; onHistory: (i: number) => void; autosaves: Autosave[]; onAutosave: (a: Autosave) => void;
}) {
  const here = hist.past.length;
  const rows = hist.past.length + 1 + hist.future.length;
  return (
    <>
    <ol aria-label="History" className="py-1">
      {Array.from({ length: rows }, (_, i) => {
        const l = hist.labels?.[i];
        const chat = !!l?.startsWith(CHAT_STEP);
        const name = (chat ? l!.slice(CHAT_STEP.length) : l) || (i === 0 ? "Opened" : "Edit");
        return (
          <li key={i}>
            <button type="button" aria-current={i === here ? "step" : undefined} onClick={() => onHistory(i)}
              className={cn("flex h-6 w-full min-w-0 items-center gap-2 px-3 text-left hover:bg-white/5", i > here ? "text-zinc-600" : "text-zinc-200", i === here && "bg-white/10")}>
              <span className="w-6 shrink-0 text-right tabular-nums text-zinc-500">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {chat && <MessageCircle aria-label="From the chat" className="size-3 shrink-0 text-zinc-400" />}
            </button>
          </li>
        );
      })}
    </ol>
    {autosaves.length > 0 && (
      <section className="border-t border-white/10 py-1">
        <h3 className="px-3 py-1 text-[11px] text-zinc-500">Autosaves</h3>
        <ol aria-label="Autosaves">
          {[...autosaves].reverse().map((a, i) => (
            <li key={`${a.at}:${i}`}>
              <button type="button" onClick={() => onAutosave(a)} className="flex h-6 w-full min-w-0 items-center gap-2 px-3 text-left text-zinc-200 hover:bg-white/5">
                <span className="w-20 shrink-0 tabular-nums text-zinc-500">{fmtAgo(a.at)}</span>
                <span className="min-w-0 flex-1 truncate">{a.label?.startsWith(CHAT_STEP) ? a.label.slice(CHAT_STEP.length) : a.label || "Edit"}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
    )}
    </>
  );
}
