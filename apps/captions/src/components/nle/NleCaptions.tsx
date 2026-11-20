import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { EdjCaptions } from "@contracts/editor";
import { CaptionRenderSurface } from "@/components/CaptionRenderSurface";
import { buildSrt } from "@/lib/ass";
import { downloadText } from "@/lib/download";
import { renderSpecOf, storedRenderData, storedStyle, type StoredClip } from "@/lib/export-request";
import type { NleClock } from "@/lib/nle/audio";
import { onTopic } from "@/lib/sync";
import { cn } from "@/lib/utils";

// The Captions lane and the viewer's captions (PRD F13): the timeline's captions are a Caption Studio clip (EDJ
// `captions`, lib/nle/captions.ts), read from Caption Studio and drawn by its own renderer, never a copy of its own.

export type CaptionClip = StoredClip & { id: string; name?: string };

/** Where Caption Studio opens on the clip. */
export const captionsHref = (link: EdjCaptions) => `/captions?project=${encodeURIComponent(link.project)}&clip=${encodeURIComponent(link.clip)}`;

/** The Caption Studio clip the captions are, read again when its projects change; `captioning` while it is transcribed. */
export function useCaptionClip(link: EdjCaptions | undefined) {
  const key = link ? `${link.project}/${link.clip}` : "";
  const [got, setGot] = useState<{ key: string; clip: CaptionClip | null; captioning: boolean } | null>(null);
  useEffect(() => {
    if (!link) return;
    let on = true;
    const read = () =>
      void fetch(`/api/projects/${encodeURIComponent(link.project)}`)
        .then((r) => (r.ok ? (r.json() as Promise<{ clips?: CaptionClip[]; captioning?: string }>) : null))
        .then((p) => on && setGot({ key, clip: p?.clips?.find((c) => c.id === link.clip) ?? null, captioning: !!p?.captioning }), () => {});
    read();
    const off = onTopic("projects", read);
    return () => {
      on = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again for another clip only
  }, [key]);
  return got?.key === key ? got : null;
}

/** The clip's captions as Resolve imports them (File → Import → Subtitle): Caption Studio's own SRT. */
export const downloadSrt = (name: string, clip: CaptionClip) =>
  downloadText(`${name || "Timeline"} Subtitles.srt`, buildSrt(clip.cues ?? [], storedStyle(clip.style)), "application/x-subrip;charset=utf-8");

const pill = "pointer-events-auto inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px]";

/** The lane's head: its name, Make Captions or the burn-in switch. */
export function CaptionsHead({ link, busy, readOnly, onMake, onBurn, onMenu }: {
  link?: EdjCaptions;
  busy: boolean;
  readOnly?: boolean;
  onMake: () => void;
  onBurn: () => void;
  onMenu: (at: { x: number; y: number }) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1" onContextMenu={(e) => (e.preventDefault(), onMenu({ x: e.clientX, y: e.clientY }))}>
      <span className="shrink-0 rounded-[3px] border border-[#8a6d2c] bg-[#5c4818] px-1 font-mono text-[10px] leading-[14px] font-semibold text-white">CC</span>
      <span className="min-w-0 flex-1 truncate text-zinc-300">Captions</span>
      {!link ? (
        <button type="button" disabled={busy || readOnly} onClick={onMake} title="Make Captions: this saved cut's render to Caption Studio, which transcribes it"
          className={cn(pill, "bg-zinc-700/70 text-zinc-100 hover:bg-zinc-600 disabled:opacity-40")}>
          {busy && <Loader2 className="size-3 animate-spin" />}Make Captions
        </button>
      ) : (
        <button type="button" aria-pressed={link.burn} disabled={readOnly} onClick={onBurn}
          title={link.burn ? "Burned in: the render and the export show the captions" : "Not burned in: the render and the export are without captions"}
          className={cn(pill, link.burn ? "bg-amber-500/25 text-amber-200" : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100")}>Burn In</button>
      )}
    </div>
  );
}

/** What is on the lane: the cues where they play, or why there are none yet; from an older cut, its badge and Update Captions. */
export function CaptionsBody({ pps, link, clip, captioning, stale, busy, readOnly, onUpdate, onOpen }: {
  pps: number;
  link?: EdjCaptions;
  clip: CaptionClip | null | undefined;
  captioning: boolean;
  stale: boolean;
  busy: boolean;
  readOnly?: boolean;
  onUpdate: () => void;
  onOpen: () => void;
}) {
  const note = !link ? null : clip === undefined ? null : clip === null ? "Not in Caption Studio" : captioning ? "Transcribing in Caption Studio" : !clip.cues?.length ? "No words heard" : null;
  return (
    <>
      {link && clip?.cues?.map((c) => (
        <div key={c.id} data-cue={c.id} title={`${c.words.map((w) => w.text).join(" ")} (double-click: Caption Studio)`} onDoubleClick={onOpen}
          className={cn("absolute inset-y-1 cursor-default truncate rounded-[3px] border px-1 text-[10px] leading-[18px]",
            stale ? "border-zinc-600/60 bg-zinc-700/40 text-zinc-400" : "border-[#b8913a]/70 bg-[#6b5520] text-amber-50")}
          style={{ left: c.start * pps, width: Math.max(2, (c.end - c.start) * pps) }}>
          {c.words.map((w) => w.text).join(" ")}
        </div>
      ))}
      {/* at the lane's visible start, over its cues */}
      {(note || stale || busy) && (
        <div className="pointer-events-none sticky left-[152px] z-10 flex h-full w-max items-center gap-1 pl-1.5">
          {busy && <span className={cn(pill, "bg-zinc-800 text-zinc-300")}><Loader2 className="size-3 animate-spin" />Sending to Caption Studio</span>}
          {note && !busy && <span className={cn(pill, "bg-zinc-800 text-zinc-400")}>{captioning && <Loader2 className="size-3 animate-spin" />}{note}</span>}
          {stale && !busy && (
            <>
              <span className={cn(pill, "bg-[#3b3014] text-amber-200")}>From an older cut</span>
              <button type="button" disabled={readOnly} onClick={onUpdate} title="Update Captions: the captions moved through the edit, only new material transcribed (save the cut first)"
                className={cn(pill, "bg-zinc-700 text-zinc-100 hover:bg-zinc-600 disabled:opacity-40")}>Update Captions</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Over the viewer's frame: the captions as Caption Studio draws them (its render surface), at the playhead's frame. */
export function CaptionsOver({ clip, clock, fps }: { clip: CaptionClip; clock: NleClock; fps: number }) {
  const spec = useMemo(() => renderSpecOf(storedRenderData(clip)), [clip]);
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // a frame's time, so it draws again once a frame (and not at all while it stays on one)
  const frame = (t: number) => Math.floor(t * fps + 1e-6) / fps;
  const [t, setT] = useState(() => frame(clock.now()));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one listener per clock
  useEffect(() => clock.subscribe((x) => setT(frame(x))), [clock, fps]);
  return (
    <div ref={box} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {spec.width > 0 && (
        <div style={{ transform: `scale(${w / spec.width})`, transformOrigin: "0 0" }}>
          <CaptionRenderSurface spec={spec} currentTime={t} />
        </div>
      )}
    </div>
  );
}
