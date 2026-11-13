import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import type { TimelineItem } from "@contracts/edit-timeline";
import type { ReviewEditRef, ReviewTimelineSlot } from "@/lib/plugin";

type FaceSlot = NonNullable<ReviewTimelineSlot["face"]>;

/**
 * Face, from the timeline (a talent shot's Face): how strong the face refinement is, picked on a frame. The plug-in
 * renders the paused frame once, as filmed and retouched at `slot.max` x the edit's look; over the video the page fades
 * one into the other, so the slider moves the picture live. "Use" keeps the strength for the whole edit (the plug-in
 * makes the next version with it). Pausing on another frame of the shot renders that one.
 */
export function FacePanel({ slot, edit, item, fps, video, onClose }: {
  slot: FaceSlot;
  edit: ReviewEditRef;
  item: TimelineItem;
  fps: number;
  /** the player's video, read on each use (a remounted element is the one it covers) */
  video: { readonly current: HTMLVideoElement | null };
  onClose: () => void;
}) {
  // where the player is: the frame shows only while paused on this shot
  const [pos, setPos] = useState({ paused: true, frame: 0 });
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const on = () => setPos({ paused: el.paused, frame: Math.floor(el.currentTime * fps + 0.01) });
    on();
    const evs = ["pause", "play", "seeked", "playing"] as const;
    evs.forEach((e) => el.addEventListener(e, on));
    return () => evs.forEach((e) => el.removeEventListener(e, on));
  }, [video, fps]);
  const inShot = pos.frame >= item.rec && pos.frame < item.rec + item.len;
  const want = pos.paused && inShot ? pos.frame : null;

  // the frame from the plug-in: as filmed | at full strength, one image (by value: the page hands a new `edit` each refresh)
  const [shown, setShown] = useState<{ at: number; url?: string; error?: string } | null>(null);
  const [proj, draft] = [edit.project, edit.draft];
  useEffect(() => {
    if (want === null) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      setShown((s) => (s?.at === want && !s.error ? s : { at: want }));
      slot.still({ project: proj, draft }, item.key, want, ctl.signal).then(
        (url) => setShown((s) => (s?.at === want ? { at: want, url } : (URL.revokeObjectURL(url), s))),
        (e: Error) => e.name !== "AbortError" && setShown((s) => (s?.at === want ? { at: want, error: e.message } : s)),
      );
    }, 350);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [want, item.key, proj, draft, slot]);
  useEffect(() => () => { if (shown?.url) URL.revokeObjectURL(shown.url); }, [shown?.url]);

  // the strength, in % of the edit's look (100 = as it is made today)
  const max = Math.round(slot.max * 100);
  const [kept, setKept] = useState<number | null>(null);
  const [pct, setPct] = useState(100);
  const [saving, setSaving] = useState<"" | "busy" | "done" | { error: string }>("");
  useEffect(() => {
    slot.strength({ project: proj, draft }).then((s) => {
      const v = Math.round(s * 100);
      setKept(v);
      setPct(v);
    }, () => setKept(100));
  }, [proj, draft, slot]);
  const use = () => {
    setSaving("busy");
    slot.save({ project: proj, draft }, pct / 100).then(
      () => (setKept(pct), setSaving("done")),
      (e: Error) => setSaving({ error: e.message }),
    );
  };

  const here = want !== null && shown?.at === want ? shown : null;
  const stage = video.current?.parentElement ?? null;
  const half = (url: string, right: boolean) => ({ backgroundImage: `url(${url})`, backgroundSize: "200% 100%", backgroundPosition: right ? "100% 0" : "0 0" });
  const chip = "pointer-events-none absolute bottom-2 left-2 select-none rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white";
  const where = !inShot ? "move the playhead onto this shot" : !pos.paused ? "pause to see it" : here?.error ? "" : "on this frame";
  const note = typeof saving === "object" ? saving.error
    : saving === "done" ? "A new version with this strength is on its way"
      : pct === 0 ? "Off: no face refinement" : "100% = the standard look";

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-400">
      <span className="font-semibold text-zinc-200">Face refinement</span>
      {where && <span>{where}</span>}
      <label className="flex items-center gap-2">
        Strength
        <input type="range" min={0} max={max} step={5} value={pct} list="face-strength-marks" disabled={kept === null}
          onChange={(e) => (setPct(Number(e.target.value)), setSaving(""))} className="w-56 accent-violet-500" />
        <datalist id="face-strength-marks"><option value={100} /></datalist>
        <span className="w-10 tabular-nums text-zinc-100">{pct}%</span>
      </label>
      <button type="button" onClick={use} disabled={kept === null || pct === kept || saving === "busy"}
        className="rounded bg-violet-600 px-2 py-0.5 font-semibold text-white disabled:opacity-40">
        Use {pct}% for this edit
      </button>
      <span className={typeof saving === "object" ? "text-rose-400" : ""}>{note}</span>
      <button type="button" aria-label="Close Face" onClick={onClose} className="ml-auto rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-100">
        <X className="h-3.5 w-3.5" />
      </button>
      {stage && here && createPortal(
        here.url ? (
          <>
            <div className="pointer-events-none absolute inset-0 z-20" style={half(here.url, false)} />
            <div className="pointer-events-none absolute inset-0 z-20" style={{ ...half(here.url, true), opacity: pct / max }} />
            <span className={`${chip} z-20`}>Face refinement {pct}%</span>
          </>
        ) : here.error ? (
          <span className={`${chip} z-20 max-w-[90%] bg-amber-500/90 text-black`}>Face: {here.error}</span>
        ) : (
          <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/60 text-center text-white backdrop-blur-sm">
            <Loader2 className="h-10 w-10 animate-spin text-violet-300" />
            <p className="text-sm font-semibold">Retouching this frame</p>
          </div>
        ),
        stage,
      )}
    </div>
  );
}
