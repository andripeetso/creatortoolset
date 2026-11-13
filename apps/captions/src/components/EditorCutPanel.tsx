import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Edit, ReviewPreview } from "@contracts/editor";
import { editedSpan, mergeEdit, playPlan, splitView, stackEdits, type ItemEdit, type TimelineItem, type TimelineView } from "@contracts/edit-timeline";
import { EditTimeline, OWN_CUT_RULES } from "@/components/EditTimeline";
import { Button } from "@/components/ui/button";
import { makeCut } from "@/lib/editor";
import { freshHist, histChange, histRedo, histUndo, type Hist } from "@/lib/edit-history";
import { peaks } from "@/lib/waveform";

/**
 * A version of an edit opened to cut by hand, on the edit's own page (pages/EditorEditPage.tsx): its video, its timeline
 * under it, and Make the next version. The same timeline, edits, rules and route as Review's panel on such a version
 * (components/ReviewEdits.tsx), so both make the same cut. Here the player shows the version as it was filed; Review is
 * where the edits play before they are made. So what nobody would see coming is said in words: a B-roll or sound clip that
 * sits wholly on frames taken out goes with them. Closing it loses nothing: the page keeps the edits for this version.
 */
export type CutEdits = Hist<ItemEdit[]>;

/** Whether [a, b) lies wholly inside the spans. */
const inside = (a: number, b: number, spans: [number, number][]) => {
  let at = a;
  for (const [from, to] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (from > at) break;
    at = Math.max(at, to);
  }
  return at >= b;
};

export function EditorCutPanel({ editId, name, title, at, working, kept, onKeep, onMade, onClose }: {
  editId: string;
  /** the version's name in the edit (v1, v2…) */
  name: string;
  title: string;
  /** what it was last filed as in Review: the only version of it that can be cut */
  at: ReviewPreview;
  /** a step of this version is queued or running: nothing is made from it meanwhile */
  working: boolean;
  /** the edits made on this version before the panel was last closed, and where each change of them is kept */
  kept?: CutEdits;
  onKeep?: (h: CutEdits) => void;
  onMade: (e: Edit) => void;
  onClose: () => void;
}) {
  const base = `/api/review/assets/${at.assetId}/v/${at.n}`;
  const video = useRef<HTMLVideoElement>(null);
  // undefined = being read; null = this version has none
  const [view, setView] = useState<TimelineView | null | undefined>(undefined);
  const [waves, setWaves] = useState<Record<string, Float32Array> | null>(null);
  const [hist, setHist] = useState<CutEdits>(() => kept ?? freshHist<ItemEdit[]>([]));
  const [picked, setPicked] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [making, setMaking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const edits = hist.now;
  const keep = useRef(onKeep);
  keep.current = onKeep;
  useEffect(() => {
    keep.current?.(hist); // whatever it returns is not this effect's clean-up
  }, [hist]);

  useEffect(() => {
    let gone = false;
    fetch(`${base}/timeline`)
      .then((r) => (r.ok ? (r.json() as Promise<TimelineView>) : null))
      .then((v) => !gone && setView(v), () => !gone && setView(null));
    // the cut's own sound under every audio lane
    peaks(`${base}/play`).then((mix) => !gone && setWaves({ "*": mix }), () => {});
    return () => {
      gone = true;
    };
  }, [base]);

  // the playhead, for the timeline's cursor
  useEffect(() => {
    const t = window.setInterval(() => setTime(video.current?.currentTime ?? 0), 200);
    return () => window.clearInterval(t);
  }, []);

  // ⌘Z and ⇧⌘Z are this panel's while it is open (the timeline has the buttons), and Space plays. A field keeps all its
  // keys; a button (a clip that was just clicked is one) and the video's own controls keep Space
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        setHist(e.shiftKey ? histRedo : histUndo);
      } else if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && video.current && !/^(BUTTON|VIDEO|A)$/.test(el?.tagName ?? "")) {
        e.preventDefault();
        if (video.current.paused) void video.current.play();
        else video.current.pause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const change = (changes: [TimelineItem, Partial<ItemEdit>][]) => {
    setRefused(null);
    setHist((h) => histChange(h, (list) => changes.reduce((acc, [item, patch]) => mergeEdit(acc, item.key, item.label, patch), list)));
  };
  const make = () => {
    setMaking(true);
    setRefused(null);
    makeCut(editId, name, { asset: at.assetId, n: at.n, edits: stackEdits([edits]) })
      .then((e) => {
        setHist(freshHist<ItemEdit[]>([]));
        onMade(e);
      }, (e: Error) => setRefused(e.message || "Couldn't make the next version"))
      .finally(() => setMaking(false));
  };

  // the layers' clips (not the speaker or the voice) that sit wholly on frames taken out: the maker drops them with those
  // frames (api/editor/edits.ts), and nothing on this page plays that
  const cut = view ? splitView(view, edits) : null;
  const skips = cut && edits.length ? playPlan(cut, edits).skips : [];
  const goes = cut && skips.length ? cut.tracks.flatMap((t) => t.items).filter((i) => {
    if (i.track === "V1" || i.track === "A1") return false;
    const e = edits.find((x) => x.key === i.key);
    if (e?.remove) return false;
    const now = editedSpan(i, e);
    return inside(now.rec, now.rec + now.len, skips);
  }).map((i) => i.label) : [];

  return (
    <section aria-label={`Edit ${title} by hand`} className="flex flex-col gap-2 rounded-xl border border-violet-500/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-medium">{title}: edit by hand</h3>
        <div className="flex shrink-0 items-center gap-1.5">
          {view && (
            <Button size="sm" disabled={!edits.length || making || working} onClick={make}
              title="Cut the next version from these timeline edits as you made them, with no AI">
              {making ? "Starting…" : "Make the next version"}
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <video ref={video} src={`${base}/play`} controls playsInline preload="metadata" className="mx-auto max-h-[50vh] max-w-full rounded-lg bg-black" />
      {view === null && <p className="text-xs text-zinc-500">This version was filed before its timeline could be edited: render its preview again.</p>}
      {cut && (
        <EditTimeline
          view={cut}
          time={time}
          onSeek={(t) => {
            if (video.current) video.current.currentTime = t;
            setTime(t);
          }}
          edits={edits}
          waves={waves}
          selected={picked}
          onSelect={(item) => setPicked(item?.key ?? null)}
          onEdit={change}
          rules={OWN_CUT_RULES}
          history={{ back: hist.past.length, ahead: hist.future.length, undo: () => setHist(histUndo), redo: () => setHist(histRedo) }}
        />
      )}
      {refused && <p role="alert" className="text-xs text-rose-500">{refused}</p>}
      {goes.length > 0 && (
        <p className="text-xs text-amber-600">On frames you took out, so {goes.length === 1 ? "it goes" : "they go"} too: {goes.join(", ")}.</p>
      )}
      {view && edits.length > 0 && !refused && (
        <p className="text-xs text-zinc-500">The player shows this version as it is. Your edits are in the next one.</p>
      )}
    </section>
  );
}
