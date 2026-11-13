import { useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  Lock,
  Play,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react";
import {
  activeCadenceOutcome,
  isCadenceBusy,
  isEditorBusy,
  narrowerThanMatched,
  playerRef,
  useStudio,
} from "@/lib/store";
import { posSegmentAt } from "@/lib/captions";
import { aiStatus, estimateCadenceDuration, type AiStatus } from "@/lib/refine";
import {
  CLOUD_MODEL_ID,
  MODELS,
  cloudStatus,
  onComputers,
  storedEngine,
} from "@/lib/transcribe";
import { canUseCloud, useMe } from "@/lib/auth";
import { EnginePicker } from "./EnginePicker";
import type { TextOverlay } from "@/lib/types";
import { textOverlayFrameStyle } from "@/lib/caption-css";
import { CaptionVisual, TextOverlayVisual } from "./CaptionRenderSurface";

/** Nearest standard frame rate within 2%, else the raw estimate rounded. */
const STD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120];
function snapFps(raw: number): number {
  let best = STD_FPS[0];
  for (const s of STD_FPS) {
    if (Math.abs(raw - s) < Math.abs(raw - best)) best = s;
  }
  return Math.abs(raw - best) / best < 0.02
    ? best
    : Math.round(raw * 100) / 100;
}

function CaptionOverlay({ rect }: { rect: { w: number; h: number } }) {
  const cues = useStudio((s) => s.cues);
  const style = useStudio((s) => s.style);
  const posSegments = useStudio((s) => s.posSegments);
  const currentTime = useStudio((s) => s.currentTime);
  // wrap against the dimensions the EXPORT uses (the original clip), not
  // the proxy being played — the proxy is rounded to even pixels, so its
  // aspect differs just enough to break a line in a different place than
  // the render would
  const videoWidth = useStudio((s) => s.sourceWidth || s.videoWidth);
  const videoHeight = useStudio((s) => s.sourceHeight || s.videoHeight);
  return (
    <CaptionVisual
      rect={rect}
      layoutWidth={videoWidth}
      layoutHeight={videoHeight}
      cues={cues}
      style={style}
      posSegments={posSegments}
      currentTime={currentTime}
    />
  );
}

/** Draggable + resizable caption bounding box on the video. */
function CaptionBox({
  rect,
  selected,
  onSelect,
}: {
  rect: { w: number; h: number };
  selected: boolean;
  onSelect: () => void;
}) {
  const style = useStudio((s) => s.style);
  const setStyle = useStudio((s) => s.setStyle);
  const posSegments = useStudio((s) => s.posSegments);
  const currentTime = useStudio((s) => s.currentTime);
  const setPosOverride = useStudio((s) => s.setPosOverride);
  const hasCues = useStudio((s) => s.cues.length > 0);
  const srcW = useStudio((s) => s.sourceWidth || s.videoWidth);
  const srcH = useStudio((s) => s.sourceHeight || s.videoHeight);
  const refining = useStudio((s) => s.refining);
  const fitSplits = useStudio((s) => s.fitSplits);
  const fittingSplits = useStudio((s) => s.fittingSplits);
  // the box got narrower than the match planned for: some lines had to
  // break where the match marked none — offer to plan them for this size
  const needsRematch = useStudio(narrowerThanMatched);
  const [ai, setAi] = useState<AiStatus | null>(null);
  useEffect(() => {
    void aiStatus().then(setAi);
  }, []);
  const [guides, setGuides] = useState({ v: false, h: false });
  const [dragInfo, setDragInfo] = useState<string | null>(null);

  // when the position track is split, drags write to the segment under the
  // playhead instead of the global style
  const seg = posSegmentAt(posSegments, currentTime);
  const effX = seg?.x ?? style.boxX;
  const effY = seg?.y ?? style.boxY;

  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));

  const startDrag = (e: React.PointerEvent, kind: string) => {
    e.preventDefault();
    e.stopPropagation();
    // resizing re-lays out the matched thoughts live, so a running
    // cadence pass doesn't block it (it lands on the new box)
    const busy = useStudio.getState();
    if (isEditorBusy(busy) && !isCadenceBusy(busy)) return;
    const dragSeg = seg;
    const start = {
      x: e.clientX,
      y: e.clientY,
      bx: effX,
      by: effY,
      bw: style.boxW,
      bh: style.boxH,
    };
    const minW = 15;
    const minH = Math.max(4, style.fontSizePct * 1.4);
    // section overrides live in the undo history (global box position is
    // style, which isn't) — snapshot on first movement, not on click
    let snapped = false;
    const onMove = (ev: PointerEvent) => {
      if (!snapped && dragSeg) {
        snapped = true;
        useStudio.getState().snapshotHistory();
      }
      const dx = ((ev.clientX - start.x) / rect.w) * 100;
      const dy = ((ev.clientY - start.y) / rect.h) * 100;
      if (kind === "move") {
        // Shift constrains to the dominant axis (live, like design tools)
        let mdx = dx;
        let mdy = dy;
        if (ev.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) mdy = 0;
          else mdx = 0;
        }
        // snap the box center to the video's center guides (~8px range)
        const snapX = (8 / rect.w) * 100;
        const snapY = (8 / rect.h) * 100;
        let nx = clamp(start.bx + mdx, start.bw / 2, 100 - start.bw / 2);
        let ny = clamp(start.by + mdy, start.bh / 2, 100 - start.bh / 2);
        const v = Math.abs(nx - 50) < snapX;
        const h = Math.abs(ny - 50) < snapY;
        if (v) nx = 50;
        if (h) ny = 50;
        setGuides({ v, h });
        setDragInfo(
          `x ${Math.round((nx / 100) * srcW)} · y ${Math.round((ny / 100) * srcH)}`,
        );
        if (dragSeg) setPosOverride(dragSeg.id, nx, ny);
        else setStyle({ boxX: nx, boxY: ny });
        return;
      }
      const left = start.bx - start.bw / 2;
      const right = start.bx + start.bw / 2;
      const top = start.by - start.bh / 2;
      const bottom = start.by + start.bh / 2;
      let nl = left;
      let nr = right;
      let nt = top;
      let nb = bottom;
      if (kind.includes("e")) nr = clamp(right + dx, left + minW, 100);
      if (kind.includes("w")) nl = clamp(left + dx, 0, right - minW);
      if (kind.includes("s")) nb = clamp(bottom + dy, top + minH, 100);
      if (kind.includes("n")) nt = clamp(top + dy, 0, bottom - minH);
      setDragInfo(
        `${Math.round(((nr - nl) / 100) * srcW)} × ${Math.round(((nb - nt) / 100) * srcH)}`,
      );
      // size is always global (it drives text wrapping); the new center
      // goes to the active segment when the track is split
      if (dragSeg) {
        setPosOverride(dragSeg.id, (nl + nr) / 2, (nt + nb) / 2);
        setStyle({ boxW: nr - nl, boxH: nb - nt });
      } else {
        setStyle({
          boxX: (nl + nr) / 2,
          boxY: (nt + nb) / 2,
          boxW: nr - nl,
          boxH: nb - nt,
        });
      }
    };
    const onUp = () => {
      setGuides({ v: false, h: false });
      setDragInfo(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!style.fitBox || !hasCues || rect.w === 0) return null;

  const boxPos: React.CSSProperties = {
    left: `${effX - style.boxW / 2}%`,
    top: `${effY - style.boxH / 2}%`,
    width: `${style.boxW}%`,
    height: `${style.boxH}%`,
  };

  if (!selected) {
    // invisible hit area: click to select, drag to select + move in one gesture
    return (
      <div
        data-caption-box
        onPointerDown={(e) => {
          onSelect();
          startDrag(e, "move");
        }}
        className="pointer-events-auto absolute cursor-move rounded-md border border-dashed border-transparent transition-colors hover:border-violet-400/40"
        style={boxPos}
      />
    );
  }

  const handles: { kind: string; cls: string }[] = [
    {
      kind: "nw",
      cls: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize",
    },
    {
      kind: "ne",
      cls: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize",
    },
    {
      kind: "sw",
      cls: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize",
    },
    {
      kind: "se",
      cls: "right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize",
    },
  ];
  const strips: { kind: string; cls: string }[] = [
    { kind: "n", cls: "inset-x-0 top-0 h-2 -translate-y-1/2 cursor-ns-resize" },
    {
      kind: "s",
      cls: "inset-x-0 bottom-0 h-2 translate-y-1/2 cursor-ns-resize",
    },
    {
      kind: "w",
      cls: "inset-y-0 left-0 w-2 -translate-x-1/2 cursor-ew-resize",
    },
    {
      kind: "e",
      cls: "inset-y-0 right-0 w-2 translate-x-1/2 cursor-ew-resize",
    },
  ];

  return (
    <>
      {guides.v && (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-violet-400" />
      )}
      {guides.h && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-violet-400" />
      )}
      <div
        data-caption-box
        className="pointer-events-none absolute rounded-md border border-dashed border-violet-400"
        style={boxPos}
      >
        {dragInfo && (
          <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900/90 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">
            {dragInfo}
          </div>
        )}
        {(needsRematch || fittingSplits) && !refining && !dragInfo && ai?.available && ai.allowed && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              void fitSplits();
            }}
            disabled={fittingSplits}
            title="Some lines no longer fit where the cadence match planned its breaks — plan the breaks for this box width (the thoughts stay)"
            className="pointer-events-auto absolute -top-8 left-1/2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md bg-violet-600 px-2 py-1 text-[10px] font-medium text-white shadow-lg transition-colors hover:bg-violet-500"
          >
            {fittingSplits ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : (
              <Sparkles className="h-2.5 w-2.5" />
            )}
            {fittingSplits ? "Fitting lines…" : "Re-match for this size"}
          </button>
        )}
        <div
          onPointerDown={(e) => startDrag(e, "move")}
          className="pointer-events-auto absolute inset-0 cursor-move"
        />
        {strips.map((s) => (
          <div
            key={s.kind}
            onPointerDown={(e) => startDrag(e, s.kind)}
            className={`pointer-events-auto absolute ${s.cls}`}
          />
        ))}
        {handles.map((h) => (
          <div
            key={h.kind}
            data-box-handle={h.kind}
            onPointerDown={(e) => startDrag(e, h.kind)}
            className={`pointer-events-auto absolute h-2.5 w-2.5 rounded-sm border border-violet-300 bg-violet-600 ${h.cls}`}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Manual text-on-screen overlays. Click selects (and drags), the side
 * handles resize the wrap box, double-click edits the text in place
 * (Enter = line break).
 */
function TextOverlays({ rect }: { rect: { w: number; h: number } }) {
  const texts = useStudio((s) => s.texts);
  const currentTime = useStudio((s) => s.currentTime);
  const selectedTextId = useStudio((s) => s.selectedTextId);
  const setSelectedText = useStudio((s) => s.setSelectedText);
  const editingTextId = useStudio((s) => s.editingTextId);
  const setEditingText = useStudio((s) => s.setEditingText);
  const updateText = useStudio((s) => s.updateText);
  const srcW = useStudio((s) => s.sourceWidth || s.videoWidth);
  const srcH = useStudio((s) => s.sourceHeight || s.videoHeight);
  const [guides, setGuides] = useState({ v: false, h: false });
  const [dragInfo, setDragInfo] = useState<{
    id: number;
    label: string;
  } | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // keep the inline editor sized to its content
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  });

  if (rect.w === 0) return null;
  const visible = texts.filter(
    (t) => currentTime >= t.start && currentTime < t.end,
  );
  if (visible.length === 0) return null;

  const startMove = (e: React.PointerEvent, t: TextOverlay) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedText(t.id);
    const start = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
    let snapped = false;
    const onMove = (ev: PointerEvent) => {
      // snapshot on first movement so a click-to-select costs no undo step
      if (!snapped) {
        snapped = true;
        useStudio.getState().snapshotHistory();
      }
      let dx = ((ev.clientX - start.x) / rect.w) * 100;
      let dy = ((ev.clientY - start.y) / rect.h) * 100;
      // Shift constrains to the dominant axis (live, like design tools)
      if (ev.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let nx = Math.max(0, Math.min(100, start.tx + dx));
      let ny = Math.max(0, Math.min(100, start.ty + dy));
      const snapX = (8 / rect.w) * 100;
      const snapY = (8 / rect.h) * 100;
      const v = Math.abs(nx - 50) < snapX;
      const h = Math.abs(ny - 50) < snapY;
      if (v) nx = 50;
      if (h) ny = 50;
      setGuides({ v, h });
      setDragInfo({
        id: t.id,
        label: `x ${Math.round((nx / 100) * srcW)} · y ${Math.round((ny / 100) * srcH)}`,
      });
      updateText(t.id, { x: nx, y: ny });
    };
    const onUp = () => {
      setGuides({ v: false, h: false });
      setDragInfo(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const startResize = (
    e: React.PointerEvent,
    t: TextOverlay,
    side: "e" | "w",
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, tx: t.x, tw: t.w };
    let snapped = false;
    const onMove = (ev: PointerEvent) => {
      if (!snapped) {
        snapped = true;
        useStudio.getState().snapshotHistory();
      }
      const dx = ((ev.clientX - start.x) / rect.w) * 100;
      // the grabbed edge follows the pointer; the other edge stays put
      const d = side === "e" ? dx : -dx;
      const nw = Math.max(6, Math.min(100, start.tw + d));
      const applied = nw - start.tw;
      const nx = start.tx + (side === "e" ? applied / 2 : -applied / 2);
      setDragInfo({
        id: t.id,
        label: `w ${Math.round((nw / 100) * srcW)}px`,
      });
      updateText(t.id, { w: nw, x: Math.max(0, Math.min(100, nx)) });
    };
    const onUp = () => {
      setDragInfo(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <>
      {guides.v && (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-teal-400" />
      )}
      {guides.h && (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-teal-400" />
      )}
      {visible.map((t) => {
        const selected = t.id === selectedTextId;
        const editing = t.id === editingTextId;
        const fontPx = (t.sizePct / 100) * rect.h;
        return (
          <div
            key={t.id}
            data-text-overlay
            onPointerDown={(e) => {
              if (!editing) startMove(e, t);
              else e.stopPropagation();
            }}
            onDoubleClick={() => setEditingText(t.id)}
            className={`pointer-events-auto absolute rounded-sm text-center ${
              editing ? "cursor-text" : "cursor-move"
            } ${selected ? "outline-dashed outline-1 outline-teal-300" : ""}`}
            style={{
              ...textOverlayFrameStyle(t, rect.h),
            }}
          >
            {dragInfo?.id === t.id && (
              <div className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-900/90 px-1.5 py-0.5 font-mono text-[10px] text-teal-200">
                {dragInfo.label}
              </div>
            )}
            {editing ? (
              <textarea
                ref={taRef}
                autoFocus
                value={t.text}
                onChange={(e) => updateText(t.id, { text: e.target.value })}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setEditingText(null);
                  }
                }}
                spellCheck={false}
                className="block w-full resize-none overflow-hidden text-center caret-teal-300 outline-none"
                style={{
                  color: t.color,
                  lineHeight: 1.18,
                  background: t.boxEnabled ? t.boxColor : "transparent",
                  borderRadius: t.boxEnabled ? fontPx * 0.18 : 0,
                }}
              />
            ) : (
              <TextOverlayVisual
                overlay={t}
                frameWidth={srcW}
                frameHeight={srcH}
                displayHeight={rect.h}
              />
            )}
            {selected && !editing && (
              <>
                <div
                  onPointerDown={(e) => startResize(e, t, "w")}
                  className="absolute -left-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-ew-resize rounded-sm border border-teal-200 bg-teal-500"
                />
                <div
                  onPointerDown={(e) => startResize(e, t, "e")}
                  className="absolute -right-1.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 cursor-ew-resize rounded-sm border border-teal-200 bg-teal-500"
                />
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

export function Player() {
  const me = useMe();
  const allowedByView = canUseCloud(me);
  const videoUrl = useStudio((s) => s.videoUrl);
  const videoWidth = useStudio((s) => s.videoWidth);
  const videoHeight = useStudio((s) => s.videoHeight);
  const duration = useStudio((s) => s.duration);
  const status = useStudio((s) => s.status);
  const words = useStudio((s) => s.words);
  const model = useStudio((s) => s.model);
  const setModel = useStudio((s) => s.setModel);
  const runTranscription = useStudio((s) => s.runTranscription);
  const serverCaptioning = useStudio((s) => s.serverCaptioning);
  const setVideoMeta = useStudio((s) => s.setVideoMeta);
  const setCurrentTime = useStudio((s) => s.setCurrentTime);
  const setPlaying = useStudio((s) => s.setPlaying);
  const setSelectedText = useStudio((s) => s.setSelectedText);
  const boxSelected = useStudio((s) => s.boxSelected);
  const setBoxSelected = useStudio((s) => s.setBoxSelected);
  const playing = useStudio((s) => s.playing);
  const editingTextId = useStudio((s) => s.editingTextId);
  const refining = useStudio((s) => s.refining);
  const cadenceBusy = useStudio(isCadenceBusy);
  const editorBusy = useStudio(isEditorBusy);
  const cadenceRunOutcome = useStudio(activeCadenceOutcome);
  const refineError = useStudio((s) => s.refineError);
  // another engine wrote the transcript (the person's computers were off): said quietly, for a few seconds
  const transcribeNote = useStudio((s) => s.transcribeNote);
  const [noteRead, setNoteRead] = useState<{ text: string } | null>(null);
  const note = transcribeNote !== noteRead ? transcribeNote?.text : undefined;
  useEffect(() => {
    if (!transcribeNote) return;
    const t = window.setTimeout(() => setNoteRead(transcribeNote), 8000);
    return () => window.clearTimeout(t);
  }, [transcribeNote]);
  const [cadenceComplete, setCadenceComplete] = useState(false);
  // a note while it transcribes: the server could not, and the browser's model runs instead (store.ts fromServer)
  const serverRun = model === CLOUD_MODEL_ID && !transcribeNote;
  const cloudTranscribing = status.phase === "transcribing" && serverRun;
  const [transcriptionComplete, setTranscriptionComplete] = useState(false);
  const wasCloudTranscribing = useRef(cloudTranscribing);

  const wrapRef = useRef<HTMLDivElement>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const [rect, setRect] = useState({ w: 0, h: 0 });
  // any pointer held down on the preview (dragging the caption box, text
  // overlays, resize handles…) hides the paused badge until release
  const [interacting, setInteracting] = useState(false);

  // Let an estimated bar visibly reach a truthful 100% before the status
  // card disappears and the editor unlocks.
  useEffect(() => {
    if (cadenceBusy || cadenceRunOutcome !== "completed") {
      const clear = window.setTimeout(() => setCadenceComplete(false), 0);
      return () => window.clearTimeout(clear);
    }
    const show = window.setTimeout(() => setCadenceComplete(true), 0);
    const hide = window.setTimeout(() => setCadenceComplete(false), 900);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [cadenceBusy, cadenceRunOutcome]);

  // When automatic cadence is off, let cloud transcription visibly reach
  // 100% before its card disappears. With auto-cadence on, the matching card
  // takes over immediately instead.
  useEffect(() => {
    const wasTranscribing = wasCloudTranscribing.current;
    wasCloudTranscribing.current = cloudTranscribing;
    if (cloudTranscribing || status.phase !== "done") {
      const clear = window.setTimeout(() => setTranscriptionComplete(false), 0);
      return () => window.clearTimeout(clear);
    }
    if (!wasTranscribing) return;
    const show = window.setTimeout(() => setTranscriptionComplete(true), 0);
    const hide = window.setTimeout(() => setTranscriptionComplete(false), 900);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [cloudTranscribing, status.phase]);

  // default to the cloud engine when the server has a key and this
  // account may use it — locked accounts see it greyed out instead.
  // Only when the user never picked an engine themselves: an explicit
  // choice is persisted and must not be overridden here.
  useEffect(() => {
    cloudStatus().then((s) => {
      if (
        s.available &&
        s.allowed &&
        allowedByView &&
        storedEngine() === null &&
        useStudio.getState().model === MODELS[0].id
      ) {
        setModel(CLOUD_MODEL_ID);
      }
    });
  }, [allowedByView, setModel]);

  // Escape deselects the caption box / text overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setBoxSelected(false);
      setSelectedText(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSelectedText, setBoxSelected]);

  // arrow keys nudge the selected caption box (Shift = bigger steps)
  useEffect(() => {
    if (!boxSelected) return;
    const onKey = (e: KeyboardEvent) => {
      const dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      const dy = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      if (!dx && !dy) return;
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          (ae as HTMLElement).isContentEditable)
      )
        return;
      e.preventDefault();
      const step = e.shiftKey ? 2 : 0.5;
      const s = useStudio.getState();
      if (isEditorBusy(s)) return;
      const clamp = (v: number, lo: number, hi: number) =>
        Math.max(lo, Math.min(hi, v));
      // same target as dragging: the section under the playhead, else global
      const seg = posSegmentAt(s.posSegments, s.currentTime);
      // one undo step per key press — auto-repeat while held is one nudge
      if (seg && !e.repeat) s.snapshotHistory();
      const nx = clamp(
        (seg?.x ?? s.style.boxX) + dx * step,
        s.style.boxW / 2,
        100 - s.style.boxW / 2,
      );
      const ny = clamp(
        (seg?.y ?? s.style.boxY) + dy * step,
        s.style.boxH / 2,
        100 - s.style.boxH / 2,
      );
      if (seg) s.setPosOverride(seg.id, nx, ny);
      else s.setStyle({ boxX: nx, boxY: ny });
    };
    // capture phase so this outranks the global arrow-seek shortcut
    // (which skips events already claimed via preventDefault)
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [boxSelected]);

  useEffect(() => {
    playerRef.video = videoEl.current;
    return () => {
      playerRef.video = null;
    };
  }, [videoUrl]);

  // Processing always owns the editor. If a run starts during playback (for
  // example from a keyboard action), stop immediately and keep the store and
  // media element in agreement.
  useEffect(() => {
    if (!editorBusy) return;
    videoEl.current?.pause();
    setPlaying(false);
  }, [editorBusy, setPlaying]);

  // Frame clock. requestVideoFrameCallback ticks once per frame actually
  // composited, carrying that frame's exact media timestamp — captions stay
  // glued to the picture. Driving them from video.currentTime (rAF fallback)
  // makes them lead the display: currentTime tracks the playback clock,
  // which runs a frame or two ahead of what's on screen.
  useEffect(() => {
    const v = videoEl.current;
    if (!v) return;
    if (typeof v.requestVideoFrameCallback === "function") {
      let handle = 0;
      // frame-rate estimate for clips the server has not probed yet
      // (before the upload lands): median frame duration over ~24 frames
      let prev: VideoFrameCallbackMetadata | null = null;
      const deltas: number[] = [];
      const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
        setCurrentTime(meta.mediaTime);
        if (
          useStudio.getState().srcFps === null &&
          !v.paused &&
          v.playbackRate === 1
        ) {
          if (prev && meta.presentedFrames > prev.presentedFrames) {
            // dropped frames advance mediaTime by whole multiples — divide
            // them back out; seeks land outside the sane-duration window
            const d =
              (meta.mediaTime - prev.mediaTime) /
              (meta.presentedFrames - prev.presentedFrames);
            if (d > 1 / 240 && d < 0.1) deltas.push(d);
            if (deltas.length >= 24) {
              const sorted = [...deltas].sort((a, b) => a - b);
              useStudio
                .getState()
                .setSrcFps(snapFps(1 / sorted[sorted.length >> 1]), "estimate");
            }
          }
          prev = meta;
        }
        handle = v.requestVideoFrameCallback(tick);
      };
      handle = v.requestVideoFrameCallback(tick);
      return () => v.cancelVideoFrameCallback(handle);
    }
    let raf = 0;
    const tick = () => {
      setCurrentTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentTime, videoUrl]);

  // measure letterboxed video rect
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (!videoWidth || !videoHeight) return;
      // mid-layout the wrapper can measure a few px tall; a subpixel rect
      // would stick until the next real resize and leave the video black
      if (cw < 40 || ch < 40) return;
      const scale = Math.min(cw / videoWidth, ch / videoHeight);
      setRect({ w: videoWidth * scale, h: videoHeight * scale });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [videoWidth, videoHeight]);

  const processing = editorBusy;
  const showStatusCard =
    processing ||
    cadenceComplete ||
    transcriptionComplete ||
    !!refineError ||
    !!note ||
    (words.length === 0 &&
      (status.phase === "idle" || status.phase === "error"));

  return (
    <div
      ref={wrapRef}
      className="relative flex h-full items-center justify-center overflow-hidden bg-zinc-900 dark:bg-black"
      onPointerDownCapture={() => {
        // capture phase: overlay drag handlers stopPropagation, and drags
        // finish on window listeners, so release is tracked there too
        setInteracting(true);
        const done = () => {
          setInteracting(false);
          window.removeEventListener("pointerup", done);
          window.removeEventListener("pointercancel", done);
        };
        window.addEventListener("pointerup", done);
        window.addEventListener("pointercancel", done);
      }}
      onPointerDown={(e) => {
        const el = e.target as HTMLElement;
        if (!el.closest("[data-caption-box]")) setBoxSelected(false);
        if (!el.closest("[data-text-overlay]") && !el.closest("[data-text-ui]"))
          setSelectedText(null);
      }}
    >
      {videoUrl && (
        <video
          ref={videoEl}
          src={videoUrl}
          className={`max-h-full max-w-full ${editorBusy ? "cursor-wait" : ""}`}
          style={{ width: rect.w || undefined, height: rect.h || undefined }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setVideoMeta(v.videoWidth, v.videoHeight, v.duration);
          }}
          onPlay={(e) => {
            if (editorBusy) {
              e.currentTarget.pause();
              setPlaying(false);
              return;
            }
            setPlaying(true);
            // playing hands the keys back from a text box: J / K / L, Space and the arrows work at once
            const a = document.activeElement as HTMLElement | null;
            if (a?.matches("input, textarea, select, [contenteditable=true]")) a.blur();
          }}
          onPause={() => setPlaying(false)}
          onClick={(e) => {
            if (editorBusy) return;
            const v = e.currentTarget;
            if (v.paused) v.play();
            else v.pause();
          }}
        />
      )}

      {/* caption preview layer aligned to the video rect */}
      <div
        className="pointer-events-none absolute"
        style={{ width: rect.w, height: rect.h }}
      >
        <CaptionOverlay rect={rect} />
        <CaptionBox
          rect={rect}
          selected={boxSelected}
          onSelect={() => setBoxSelected(true)}
        />
        <TextOverlays rect={rect} />
      </div>

      {/* paused badge — fades out while playing, dragging, or editing text;
          pointer-events-none so the click still lands on the video to play */}
      {videoUrl && (
        <div
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity duration-200 ${
            !playing && !interacting && !editingTextId && !editorBusy
              ? "opacity-100"
              : "opacity-0"
          }`}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 shadow-lg backdrop-blur-sm">
            <Play className="ml-1 h-6 w-6 text-white" fill="currentColor" />
          </div>
        </div>
      )}

      {/* One consistent place for actions and any state that locks editing. */}
      {showStatusCard && (
        <div className="absolute inset-x-0 bottom-4 z-50 flex justify-center px-4">
          <div
            role={
              processing || cadenceComplete || transcriptionComplete || serverCaptioning
                ? "status"
                : undefined
            }
            aria-live={
              processing || cadenceComplete || transcriptionComplete || serverCaptioning
                ? "polite"
                : undefined
            }
            className="flex max-w-full items-center gap-3 rounded-xl border border-zinc-700/80 bg-zinc-900/95 px-4 py-3 shadow-xl"
          >
            {/* the server is making them (a video sent from the assistant's chat): they come in by themselves */}
            {words.length === 0 && status.phase === "idle" && serverCaptioning && (
              <span className="flex items-center gap-2 text-sm text-zinc-200">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet-400" />
                Making the captions
              </span>
            )}
            {words.length === 0 && status.phase === "idle" && !serverCaptioning && (
              <>
                <EnginePicker className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none" />
                <button
                  onClick={runTranscription}
                  className="flex items-center gap-2 rounded-md bg-violet-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
                >
                  <Sparkles className="h-4 w-4" /> Transcribe
                </button>
              </>
            )}
            {status.phase === "extracting" && !refining && (
              <ExtractionProcessingStatus
                duration={duration}
                progress={status.progress}
                detail={status.detail}
              />
            )}
            {status.phase === "loading" && !refining && (
              <ModelLoadingStatus progress={status.progress} />
            )}
            {status.phase === "transcribing" &&
              !refining &&
              (serverRun ? (
                <CloudTranscriptionStatus
                  duration={duration}
                  complete={false}
                />
              ) : (
                <OnDeviceTranscriptionStatus duration={duration} />
              ))}
            {transcriptionComplete && (
              <CloudTranscriptionStatus duration={duration} complete />
            )}
            {note && <span className="text-xs text-zinc-400">{note}</span>}
            {status.phase === "checking" && <ScriptCheckProcessingStatus />}
            {(cadenceBusy || cadenceComplete) && (
              <CadenceProcessingStatus complete={cadenceComplete} />
            )}
            {refineError && !processing && (
              <span className="flex max-w-[60vw] items-start gap-2 text-sm leading-5 text-red-300">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{refineError}</span>
              </span>
            )}
            {words.length === 0 && status.phase === "error" && (
              <div className="flex max-w-[60vw] flex-col gap-2">
                <span className="flex items-center gap-2 text-sm text-red-400">
                  <TriangleAlert className="h-4 w-4 shrink-0" />
                  <span className="truncate">{status.message}</span>
                </span>
                <span className="flex items-center gap-2">
                  <EnginePicker className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-200 outline-none" />
                  <button
                    onClick={runTranscription}
                    className="rounded-md bg-zinc-700 px-3 py-1.5 text-xs text-zinc-50 hover:bg-zinc-600"
                  >
                    Retry
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CadenceProcessingStatus({ complete }: { complete: boolean }) {
  const wordCount = useStudio((s) => s.words.length);
  const cancelCadence = useStudio((s) => s.cancelCadence);
  const estimate = estimateCadenceDuration(wordCount);

  return (
    <EstimatedProcessingStatus
      operationKey="cadence"
      complete={complete}
      title="Matching cadence…"
      completeTitle="Cadence matched"
      completeDetail="Captions are fitted to the speech rhythm and your layout."
      expectedSeconds={estimate.expectedSeconds}
      lowSeconds={estimate.lowSeconds}
      highSeconds={estimate.highSeconds}
      progressLabel="Estimated cadence matching progress"
      workingMessage={`Still working — estimate based on ${wordCount.toLocaleString()} words${
        estimate.learnedFromRuns
          ? ` and ${estimate.learnedFromRuns} recent run${estimate.learnedFromRuns === 1 ? "" : "s"}`
          : ""
      }.`}
      completeMessage="Done — playback and editing are unlocked."
      lockMessage="Playback and editing are locked."
      onStop={cancelCadence}
    />
  );
}

export function ScriptCheckProcessingStatus() {
  const wordCount = useStudio((s) => s.words.length);
  const cancelScriptCheck = useStudio((s) => s.cancelScriptCheck);
  // one model call per ~400 words, run in parallel; the answer is short
  const expectedSeconds = Math.round(Math.min(60, 12 + wordCount / 40));

  return (
    <EstimatedProcessingStatus
      operationKey="script-check"
      complete={false}
      title="Checking against your script…"
      completeTitle="Script checked"
      completeDetail="Mis-heard words are fixed from your script."
      expectedSeconds={expectedSeconds}
      lowSeconds={Math.max(5, Math.round(expectedSeconds * 0.5))}
      highSeconds={expectedSeconds * 3}
      progressLabel="Estimated script check progress"
      workingMessage={`Still working — reading ${wordCount.toLocaleString()} words against your script.`}
      completeMessage="Done."
      lockMessage="Playback and editing are locked."
      onStop={cancelScriptCheck}
    />
  );
}

export function ExtractionProcessingStatus({
  duration,
  progress,
  detail,
}: {
  duration: number;
  progress?: number;
  detail?: string;
}) {
  const expectedSeconds = Math.max(
    5,
    Math.min(90, Math.round(Math.max(0, duration) * 0.12)),
  );

  const onDevice = useStudio((s) => s.model !== CLOUD_MODEL_ID);

  return (
    <EstimatedProcessingStatus
      plain={onDevice}
      operationKey="extracting"
      complete={false}
      title={
        detail?.startsWith("Uploading")
          ? "Uploading source…"
          : "Preparing audio…"
      }
      completeTitle="Audio ready"
      completeDetail="The audio is ready for transcription."
      expectedSeconds={expectedSeconds}
      lowSeconds={Math.max(2, Math.round(expectedSeconds * 0.4))}
      highSeconds={Math.max(15, expectedSeconds * 3)}
      progressLabel="Estimated audio preparation progress"
      workingMessage={
        detail?.startsWith("Uploading")
          ? "The upload is resumable; your project is already saved."
          : "Preparing the clip’s audio without blocking the editor."
      }
      completeMessage="Audio is ready."
      lockMessage="Playback and editing are locked."
      progressOverride={progress}
      progressDetail={detail}
    />
  );
}

export function ModelLoadingStatus({ progress }: { progress: number }) {
  // the server's engine loads no model here: when it falls back to the browser's, that is the first one
  const model = useStudio((s) => (s.model === CLOUD_MODEL_ID ? MODELS[0].id : s.model));
  const mb = MODELS.find((m) => m.id === model)?.mb;
  // already in this browser's model cache: nothing downloads, so the size is not said again
  const [kept, setKept] = useState(false);
  useEffect(() => {
    void globalThis.caches
      ?.open("transformers-cache")
      .then((c) => c.keys())
      .then((keys) => setKept(keys.some((k) => k.url.includes(`/${model}/`) && k.url.endsWith(".onnx"))))
      .catch(() => {});
  }, [model]);
  return (
    <EstimatedProcessingStatus
      plain
      operationKey="model-loading"
      complete={false}
      title={`Getting the speech model ready${mb && !kept ? ` (${mb} MB, only the first time)` : ""}`}
      completeTitle="Model ready"
      completeDetail="The transcription model is ready."
      expectedSeconds={30}
      lowSeconds={5}
      highSeconds={180}
      progressLabel="Speech model progress"
      workingMessage=""
      completeMessage=""
      lockMessage=""
      progressOverride={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
    />
  );
}

export function OnDeviceTranscriptionStatus({
  duration,
  complete = false,
}: {
  duration: number;
  complete?: boolean;
}) {
  const expectedSeconds = Math.max(
    30,
    Math.min(600, Math.round(Math.max(0, duration) * 0.6)),
  );

  return (
    <EstimatedProcessingStatus
      plain={!complete}
      operationKey="on-device-transcription"
      complete={complete}
      title="Listening to your video"
      completeTitle="Transcription complete"
      completeDetail="Your captions are ready to review and edit."
      expectedSeconds={expectedSeconds}
      lowSeconds={Math.max(15, Math.round(expectedSeconds * 0.5))}
      highSeconds={Math.max(90, expectedSeconds * 4)}
      progressLabel="Estimated on-device transcription progress"
      workingMessage="Still working — turning the audio into editable captions on this device."
      completeMessage="Done — captions are ready to edit."
      lockMessage="Playback and editing are locked."
    />
  );
}

export function CloudTranscriptionStatus({
  duration,
  complete,
}: {
  duration: number;
  complete: boolean;
}) {
  // Deepgram windows run in parallel. Production measurements on the 1:24
  // and 2:48 benchmark clips both completed in roughly three seconds, while
  // the wider ceiling covers network and service variance.
  const expectedSeconds = Math.max(
    6,
    Math.min(30, 5 + Math.ceil(Math.max(0, duration) / 180)),
  );
  const lowSeconds = Math.max(3, Math.round(expectedSeconds * 0.5));
  const highSeconds = Math.max(15, expectedSeconds * 3);
  const durationLabel =
    duration > 0 ? formatElapsed(Math.round(duration)) : null;

  return (
    <EstimatedProcessingStatus
      operationKey="cloud-transcription"
      complete={complete}
      title={onComputers() ? "Transcribing on your computers…" : "Transcribing in the cloud…"}
      completeTitle="Transcription complete"
      completeDetail="Your captions are ready to review and edit."
      expectedSeconds={expectedSeconds}
      lowSeconds={lowSeconds}
      highSeconds={highSeconds}
      progressLabel="Estimated cloud transcription progress"
      workingMessage={
        durationLabel
          ? `Still working — transcribing ${durationLabel} of audio ${onComputers() ? "on your computers" : "in the cloud"}.`
          : "Still working — turning the audio into editable captions."
      }
      completeMessage="Done — captions are ready to edit."
      lockMessage="Editing controls are locked until captions are ready."
    />
  );
}

function EstimatedProcessingStatus({
  operationKey,
  complete,
  title,
  completeTitle,
  completeDetail,
  expectedSeconds,
  lowSeconds,
  highSeconds,
  progressLabel,
  workingMessage,
  completeMessage,
  lockMessage,
  onStop,
  progressOverride,
  progressDetail,
  plain,
}: {
  operationKey: string;
  complete: boolean;
  title: string;
  completeTitle: string;
  completeDetail: string;
  expectedSeconds: number;
  lowSeconds: number;
  highSeconds: number;
  progressLabel: string;
  workingMessage: string;
  completeMessage: string;
  lockMessage: string;
  onStop?: () => void;
  progressOverride?: number;
  progressDetail?: string;
  /** One line and its bar: no estimate, no second line (the on-device steps of a first job). */
  plain?: boolean;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (complete) return;
    const startedAt = Date.now();
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [complete, operationKey]);

  let progress: number;
  if (complete) {
    progress = 100;
  } else if (progressOverride !== undefined) {
    progress = progressOverride;
  } else if (elapsed <= expectedSeconds) {
    progress = 5 + (elapsed / expectedSeconds) * 85;
  } else if (elapsed <= highSeconds) {
    const span = Math.max(1, highSeconds - expectedSeconds);
    progress = 90 + ((elapsed - expectedSeconds) / span) * 7;
  } else {
    progress = 97 + 2 * (1 - Math.exp(-(elapsed - highSeconds) / 60));
  }
  const shownProgress = Math.min(complete ? 100 : 99, Math.round(progress));
  const estimated = progressOverride === undefined;
  const overdue = !complete && estimated && elapsed >= highSeconds;
  const estimateLabel = `${formatElapsed(lowSeconds)}–${formatElapsed(highSeconds)}`;

  return (
    <span
      className={`flex min-w-0 flex-col gap-2.5 text-zinc-300 ${
        plain ? "w-[min(34rem,calc(100vw-3rem))]" : "w-[min(28rem,calc(100vw-3rem))]"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        {complete ? (
          <Check className="h-5 w-5 shrink-0 text-emerald-400" />
        ) : (
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-violet-400" />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium text-zinc-100">
              {complete ? completeTitle : title}
            </span>
            {!(plain && estimated) && (
              <span
                aria-hidden="true"
                className="shrink-0 font-mono text-[11px] tabular-nums text-zinc-400"
              >
                {shownProgress}%{complete || !estimated ? "" : " estimated"}
              </span>
            )}
          </span>
          {!plain && (
            <span className="text-[11px] text-zinc-400">
              {complete
                ? completeDetail
                : progressDetail
                  ? `${progressDetail} · ${formatElapsed(elapsed)} elapsed`
                  : `Estimated ${estimateLabel} · ${formatElapsed(elapsed)} elapsed`}
            </span>
          )}
        </span>
      </span>

      <span
        role="progressbar"
        aria-label={progressLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shownProgress}
        aria-valuetext={
          complete
            ? "Complete"
            : `${shownProgress}%${estimated ? " estimated" : ""}`
        }
        aria-live="off"
        className="relative h-1 overflow-hidden rounded-full bg-zinc-700/80"
      >
        <span
          className={`absolute inset-y-0 left-0 overflow-hidden rounded-full transition-[width] duration-1000 ease-linear ${
            complete ? "bg-emerald-400" : "bg-violet-500"
          }`}
          style={{ width: `${shownProgress}%` }}
        >
          {!complete && (
            <span className="processing-progress-shimmer absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent" />
          )}
        </span>
      </span>

      {!plain && (
      <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-zinc-400">
        <span className="flex items-center gap-2">
          {!complete && (
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-400" />
            </span>
          )}
          {complete
            ? completeMessage
            : overdue
              ? "Sorry — this is taking longer than estimated. It’s still working."
              : workingMessage}
        </span>
        {!complete && (
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-zinc-500">
              <Lock className="h-3 w-3 shrink-0" /> {lockMessage}
            </span>
            {onStop && (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 rounded-md border border-zinc-600 px-2 py-1 font-medium text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800"
              >
                <Square className="h-2.5 w-2.5" fill="currentColor" /> Stop
              </button>
            )}
          </span>
        )}
      </span>
      )}
    </span>
  );
}
