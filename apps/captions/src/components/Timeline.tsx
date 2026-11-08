import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Layers,
  Loader2,
  Magnet,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Type,
  UnfoldHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { isEditorBusy, playerRef, useStudio } from "@/lib/store";
import { useShareTheme } from "@/components/ShareTheme";
import { fmtTimecode } from "@/lib/ass";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const RULER_H = 22;
const WAVE_H = 46;
const CUE_H = 30;
const POS_H = 24;
const PAD = 4;
const EDGE_GRAB_PX = 5;
const SNAP_PX = 6;
const MIN_TEXT_DUR = 0.2;
const MAX_ZOOM = 300;
/** Browsers cap canvas dimensions (~16384px) — wider canvases silently
 *  die and paint white, so the zoom must stop before width × dpr hits it. */
const MAX_CANVAS_PX = 15000;
/** Review's playback speeds. */
const SPEEDS = [0.5, 1, 1.5, 2];

type Drag =
  | { mode: "seek" }
  | { mode: "range"; anchor: number }
  | { mode: "rangeStart" | "rangeEnd" }
  | { mode: "edge"; id: number; side: "start" | "end" }
  | { mode: "posMove"; id: number; dt: number; dur: number }
  | { mode: "posTrim"; id: number; side: "start" | "end" }
  | { mode: "textMove"; id: number; dt: number; dur: number }
  | { mode: "textEdge"; id: number; side: "start" | "end" };

export function Timeline() {
  const duration = useStudio((s) => s.duration);
  const peaks = useStudio((s) => s.peaks);
  const cues = useStudio((s) => s.cues);
  const currentTime = useStudio((s) => s.currentTime);
  const playing = useStudio((s) => s.playing);
  const seek = useStudio((s) => s.seek);
  const updateCueTimes = useStudio((s) => s.updateCueTimes);
  const snapshotHistory = useStudio((s) => s.snapshotHistory);
  const fillGaps = useStudio((s) => s.fillGaps);
  const gapsFilled = useStudio((s) => !!s.style.fillGaps);
  const posSegments = useStudio((s) => s.posSegments);
  const splitPosAt = useStudio((s) => s.splitPosAt);
  const snapPosToCues = useStudio((s) => s.snapPosToCues);
  const movePosSegment = useStudio((s) => s.movePosSegment);
  const trimPosSegment = useStudio((s) => s.trimPosSegment);
  const deletePosSegment = useStudio((s) => s.deletePosSegment);
  const clearPosOverride = useStudio((s) => s.clearPosOverride);
  const texts = useStudio((s) => s.texts);
  const selectedTextId = useStudio((s) => s.selectedTextId);
  const setSelectedText = useStudio((s) => s.setSelectedText);
  const addTextAt = useStudio((s) => s.addTextAt);
  const updateText = useStudio((s) => s.updateText);
  const boxSelected = useStudio((s) => s.boxSelected);
  const fps = useStudio((s) => s.fps);
  // Every caption-processing phase owns the editor and locks this transport.
  const editorBusy = useStudio(isEditorBusy);
  const rangeSel = useStudio((s) => s.rangeSel);
  const setRangeSel = useStudio((s) => s.setRangeSel);
  const retranscribeRange = useStudio((s) => s.retranscribeRange);
  const transcribing = editorBusy;

  const [pxPerSec, setPxPerSec] = useState(60);
  const [viewportW, setViewportW] = useState(0);
  const [showLayers, setShowLayers] = useState(
    () => posSegments.length > 0 || texts.length > 0
  );
  const [selectedPosId, setSelectedPosId] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<Drag | null>(null);
  // undo snapshot is taken on the first real drag movement, not on
  // pointerdown — clicking a clip just to select it costs no undo step
  const snapPending = useRef(false);
  // where a click on a caption section takes the playhead, if it isn't dragged
  const clickSeek = useRef<number | null>(null);

  // stack overlapping texts into lanes (a clip goes to the first free lane)
  const textLanes = useMemo(() => {
    const sorted = [...texts].sort((a, b) => a.start - b.start || a.id - b.id);
    const laneEnds: number[] = [];
    const laneOf = new Map<number, number>();
    for (const t of sorted) {
      let lane = laneEnds.findIndex((e) => t.start >= e - 0.001);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = t.end;
      laneOf.set(t.id, lane);
    }
    return { laneOf, lanes: laneEnds.length };
  }, [texts]);

  const width = Math.max(1, Math.ceil(duration * pxPerSec));
  const lanesCount = showLayers ? textLanes.lanes : 0;
  /** Extra height of the layers block (position row + text lanes). */
  const layersExtra = showLayers
    ? POS_H + PAD + (lanesCount > 0 ? lanesCount * POS_H + PAD : 0)
    : 0;
  const canvasH = RULER_H + WAVE_H + CUE_H + PAD * 2 + layersExtra;
  const selectedSeg = posSegments.find((s) => s.id === selectedPosId) ?? null;
  const selectedText = texts.find((t) => t.id === selectedTextId) ?? null;

  // reveal the layers when clips appear from elsewhere (e.g. loading a project)
  const prevClipCount = useRef(posSegments.length + texts.length);
  useEffect(() => {
    const n = posSegments.length + texts.length;
    if (n > 0 && prevClipCount.current === 0) setShowLayers(true);
    prevClipCount.current = n;
  }, [posSegments.length, texts.length]);

  const posRowTop = RULER_H + PAD;
  const textTop = posRowTop + POS_H + PAD;

  const { dark } = useShareTheme();
  const draw = useCallback(() => {
    const k = (d: string, l: string) => (dark ? d : l); // the canvas colour for each theme
    const canvas = canvasRef.current;
    if (!canvas || duration <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = width;
    if (canvas.width !== W * dpr || canvas.height !== canvasH * dpr) {
      canvas.width = W * dpr;
      canvas.height = canvasH * dpr;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${canvasH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // the project colour (violet is a variable per tint), read for canvas fills
    const cs = getComputedStyle(canvas);
    const vc = (n: number) => `rgb(${cs.getPropertyValue(`--violet-${n}`).trim().split(/\s+/).join(", ")})`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, canvasH);

    // background
    ctx.fillStyle = k("#0d0d12", "#f7f7f8");
    ctx.fillRect(0, 0, W, canvasH);

    const t2x = (t: number) => t * pxPerSec;

    // ruler ticks
    const step = pxPerSec > 140 ? 1 : pxPerSec > 60 ? 2 : pxPerSec > 25 ? 5 : 10;
    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (let t = 0; t <= duration + 0.001; t += step) {
      const x = t2x(t);
      ctx.strokeStyle = k("#3f3f46", "#d4d4d8");
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 8);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillStyle = "#71717a";
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      ctx.fillText(`${m}:${String(s).padStart(2, "0")}`, x + 4, RULER_H / 2 - 1);
    }
    // frame ticks between seconds once zoomed in far enough (NLE-style)
    if (pxPerSec / fps >= 5) {
      ctx.strokeStyle = k("#2f2f37", "#e4e4e7");
      const frames = Math.floor(duration * fps);
      for (let fr = 1; fr <= frames; fr++) {
        if (fr % fps === 0) continue;
        const x = t2x(fr / fps);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, RULER_H - 4);
        ctx.lineTo(x + 0.5, RULER_H);
        ctx.stroke();
      }
    }

    // caption position layer (right under the ruler when open)
    if (showLayers) {
      ctx.font = "10px Inter, system-ui, sans-serif";
      if (posSegments.length === 0) {
        ctx.fillStyle = k("#1c1c22", "#f0f0f2");
        ctx.beginPath();
        ctx.roundRect(1, posRowTop, W - 2, POS_H - 4, 3);
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = k("#3f3f46", "#d4d4d8");
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#71717a";
        ctx.fillText(
          "captions — split to move them for a section",
          6,
          posRowTop + (POS_H - 4) / 2,
          W - 12
        );
      } else {
        for (const s of posSegments) {
          const x = t2x(s.start);
          const w = Math.max(2, t2x(s.end) - x);
          const custom = s.x != null;
          const active = currentTime >= s.start && currentTime < s.end;
          ctx.fillStyle = custom
            ? active
              ? vc(600)
              : vc(700)
            : active
              ? k("#4b4b55", "#c4c4cc")
              : k("#33333c", "#e4e4e7");
          ctx.beginPath();
          ctx.roundRect(x + 1, posRowTop, w - 2, POS_H - 4, 3);
          ctx.fill();
          if (s.id === selectedPosId) {
            ctx.strokeStyle = k("#f4f4f5", "#18181b");
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.roundRect(x + 1.5, posRowTop + 0.75, w - 3, POS_H - 5.5, 3);
            ctx.stroke();
            ctx.lineWidth = 1;
          }
          if (w > 44) {
            ctx.fillStyle = custom ? "#ffffff" : k("#a1a1aa", "#52525b");
            const label = custom ? "captions · moved" : "captions";
            ctx.fillText(label, x + 6, posRowTop + (POS_H - 4) / 2, w - 12);
          }
        }
      }

      // text overlay lanes
      for (const t of texts) {
        const lane = textLanes.laneOf.get(t.id) ?? 0;
        const ty = textTop + lane * POS_H;
        const x = t2x(t.start);
        const w = Math.max(2, t2x(t.end) - x);
        const active = currentTime >= t.start && currentTime < t.end;
        ctx.fillStyle = active ? "#0d9488" : k("#134e4a", "#99f6e4");
        ctx.beginPath();
        ctx.roundRect(x + 1, ty, w - 2, POS_H - 4, 3);
        ctx.fill();
        if (t.id === selectedTextId) {
          ctx.strokeStyle = k("#f4f4f5", "#18181b");
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(x + 1.5, ty + 0.75, w - 3, POS_H - 5.5, 3);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
        if (w > 30) {
          ctx.fillStyle = active ? "#ffffff" : k("#99f6e4", "#134e4a");
          ctx.fillText(`T ${t.text}`, x + 6, ty + (POS_H - 4) / 2, w - 12);
        }
      }
    }

    // waveform
    const waveTop = RULER_H + PAD + layersExtra;
    if (peaks && peaks.length > 0) {
      const mid = waveTop + WAVE_H / 2;
      ctx.fillStyle = k(vc(900), vc(300));
      const perPx = peaks.length / W;
      for (let x = 0; x < W; x++) {
        const i = Math.floor(x * perPx);
        const v = peaks[Math.min(peaks.length - 1, i)] || 0;
        const h = Math.max(1, v * WAVE_H * 0.92);
        ctx.fillRect(x, mid - h / 2, 1, h);
      }
    } else {
      ctx.fillStyle = k("#27272a", "#e4e4e7");
      ctx.fillRect(0, waveTop + WAVE_H / 2 - 1, W, 2);
    }

    // cue blocks (dimmed while locked by the cadence pass)
    const cueTop = waveTop + WAVE_H + PAD;
    ctx.font = "10px Inter, system-ui, sans-serif";
    if (editorBusy) ctx.globalAlpha = 0.4;
    for (const c of cues) {
      const x = t2x(c.start);
      const w = Math.max(2, t2x(c.end) - x);
      const active = currentTime >= c.start && currentTime < c.end;
      ctx.fillStyle = active ? vc(500) : k("#3b3b46", "#e4e4e7");
      ctx.beginPath();
      ctx.roundRect(x + 1, cueTop, w - 2, CUE_H - 4, 3);
      ctx.fill();
      if (w > 30) {
        ctx.fillStyle = active ? "#ffffff" : k("#a1a1aa", "#52525b");
        const text = c.words
          .map((ww) => ww.text)
          .join(" ")
          .slice(0, Math.floor(w / 6));
        ctx.fillText(text, x + 5, cueTop + CUE_H / 2 - 2, w - 10);
      }
    }
    ctx.globalAlpha = 1;

    // selected section (shift-drag) — the re-transcribe range
    if (rangeSel) {
      const x1 = t2x(rangeSel.start);
      const x2 = t2x(rangeSel.end);
      ctx.fillStyle = "rgba(245, 158, 11, 0.14)";
      ctx.fillRect(x1, 0, x2 - x1, canvasH);
      ctx.strokeStyle = "rgba(245, 158, 11, 0.7)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, canvasH - 1);
    }

    // playhead
    const px = t2x(currentTime);
    ctx.strokeStyle = k("#f4f4f5", "#18181b");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvasH);
    ctx.stroke();
    ctx.fillStyle = k("#f4f4f5", "#18181b");
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 8);
    ctx.closePath();
    ctx.fill();
  }, [duration, peaks, cues, currentTime, pxPerSec, width, canvasH, showLayers, layersExtra, posSegments, selectedPosId, texts, textLanes, selectedTextId, posRowTop, textTop, fps, editorBusy, rangeSel, dark]);

  useEffect(() => {
    draw();
  }, [draw]);

  // zooming out stops at fit-to-width: the tracks never get narrower than
  // the viewport
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const measure = () => setViewportW(sc.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);
  const minZoom =
    viewportW > 0 && duration > 0
      ? Math.min(MAX_ZOOM, viewportW / duration)
      : 10;
  // the canvas is duration × pxPerSec wide — cap zoom so it stays
  // allocatable (a 3min clip at 300px/s would need 54k px and break)
  const maxZoom =
    duration > 0
      ? Math.max(
          minZoom,
          Math.min(
            MAX_ZOOM,
            MAX_CANVAS_PX / duration / (window.devicePixelRatio || 1)
          )
        )
      : MAX_ZOOM;
  useEffect(() => {
    setPxPerSec((z) => Math.max(z, minZoom));
  }, [minZoom]);
  useEffect(() => {
    setPxPerSec((z) => Math.min(z, maxZoom));
  }, [maxZoom]);

  // zoom anchored to the playhead: keep it at the same viewport x while
  // zooming (or center it when it's off-screen)
  const zoomAnchor = useRef<number | null>(null);
  // several wheel events can land before a render: the latest zoom lives here
  const liveZoom = useRef(pxPerSec);
  const applyZoom = (nz: number) => {
    const z = Math.max(minZoom, Math.min(maxZoom, nz));
    if (z === liveZoom.current) return;
    const sc = scrollRef.current;
    if (sc && zoomAnchor.current === null) {
      const vx = currentTime * pxPerSec - sc.scrollLeft;
      zoomAnchor.current =
        vx >= 0 && vx <= sc.clientWidth ? vx : sc.clientWidth / 2;
    }
    liveZoom.current = z;
    setPxPerSec(z);
  };
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || zoomAnchor.current === null) return;
    sc.scrollLeft = currentTime * pxPerSec - zoomAnchor.current;
    zoomAnchor.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pxPerSec]);
  const zoomRef = useRef(applyZoom);
  useLayoutEffect(() => {
    liveZoom.current = pxPerSec;
    zoomRef.current = applyZoom;
  });
  // ⌥ + scroll or a pinch zooms about the playhead, ⌘ + scroll pans (Review)
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (e.altKey || (e.ctrlKey && !e.metaKey)) {
        e.preventDefault(); // a pinch arrives as Ctrl + wheel
        const f = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.006);
        zoomRef.current(liveZoom.current * f);
      } else if (e.metaKey) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, []);

  // playback speed and J / K / L shuttle, as in Review: L plays 2×, again
  // 4×, 8×; J the same backwards (the picture steps back: a video can't
  // play in reverse); K stops; 1 / 2 / 3 the same
  const [speed, setSpeed] = useState(1);
  const [shuttle, setShuttle] = useState(0);
  const shuttleRef = useRef(0);
  const speedRef = useRef(1);
  const changeSpeed = (s: number) => {
    speedRef.current = s;
    setSpeed(s);
    const v = playerRef.video;
    if (!v) return;
    v.defaultPlaybackRate = s; // survives the reload of a clip switch
    if (shuttleRef.current === 0) v.playbackRate = s;
  };
  const shuttleTo = (n: number) => {
    const v = playerRef.video;
    if (!v || isEditorBusy(useStudio.getState())) return;
    shuttleRef.current = n;
    setShuttle(n);
    if (n > 0) {
      v.playbackRate = n;
      void v.play();
    } else {
      v.pause();
      v.playbackRate = speedRef.current;
    }
  };
  // Space or the play button ends a shuttle: pausing a fast-forward,
  // playing out of a rewind (at the chosen speed)
  useEffect(() => {
    const sh = shuttleRef.current;
    if ((sh > 0 && !playing) || (sh < 0 && playing)) {
      shuttleRef.current = 0;
      setShuttle(0);
      if (playerRef.video) playerRef.video.playbackRate = speedRef.current;
    }
  }, [playing]);
  useEffect(() => {
    if (shuttle >= 0) return;
    const v = playerRef.video;
    if (!v) return;
    let last = performance.now();
    let at = v.currentTime;
    const id = window.setInterval(() => {
      const now = performance.now();
      at = Math.max(0, at + ((now - last) / 1000) * shuttle);
      last = now;
      const st = useStudio.getState();
      if (at <= 0 || isEditorBusy(st)) {
        shuttleRef.current = 0;
        setShuttle(0);
      }
      if (isEditorBusy(st)) return;
      if (!v.seeking) v.currentTime = at; // the decoder shows the frames it keeps up with
      st.setCurrentTime(at);
    }, 40);
    return () => clearInterval(id);
  }, [shuttle]);
  // J / K / L (1 / 2 / 3) shuttle; = / - zoom, \ fits the clip; Esc lets
  // go of the picked section and the range, as in Review
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const ae = e.target as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.tagName === "SELECT" ||
          ae.isContentEditable)
      )
        return;
      const k = e.key.toLowerCase();
      const sh = shuttleRef.current;
      if (k === "escape") {
        // the caption box and texts deselect in Player's own Esc handler
        setSelectedPosId(null);
        useStudio.getState().setRangeSel(null);
        return;
      }
      if (k === "k" || k === "2") shuttleTo(0);
      else if (k === "l" || k === "3") shuttleTo(sh > 0 ? Math.min(sh * 2, 8) : 2);
      else if (k === "j" || k === "1") shuttleTo(sh < 0 ? Math.max(sh * 2, -8) : -2);
      else if (k === "=" || k === "+") zoomRef.current(liveZoom.current * 1.4);
      else if (k === "-") zoomRef.current(liveZoom.current / 1.4);
      else if (k === "\\") zoomRef.current(0);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // follow playhead while playing
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || !playing) return;
    const x = currentTime * pxPerSec;
    if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth - 80) {
      sc.scrollLeft = x - sc.clientWidth * 0.3;
    }
  }, [currentTime, playing, pxPerSec]);

  // selecting a text elsewhere (e.g. clicking it on the video) drops the
  // section selection — only one clip is ever selected, so Delete is unambiguous
  useEffect(() => {
    if (selectedTextId != null) setSelectedPosId(null);
  }, [selectedTextId]);

  // Delete/Backspace removes the selected caption section (text overlays
  // are handled by the global shortcut in Home)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!selectedSeg || selectedText) return;
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          (ae as HTMLElement).isContentEditable)
      )
        return;
      e.preventDefault();
      deletePosSegment(selectedSeg.id);
      setSelectedPosId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedSeg, selectedText, deletePosSegment]);

  // Arrow up/down moves the selection between layers (captions row ↔ text
  // lanes); with nothing picked it jumps to the previous / next caption,
  // as Review's ↑ / ↓ jump between cuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      // the selected caption box owns the arrow keys (nudging)
      if (boxSelected) return;
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          (ae as HTMLElement).isContentEditable)
      )
        return;
      // layer 0 = captions position row, 1..N = text lanes
      const from = !showLayers
        ? null
        : selectedSeg
          ? 0
          : selectedText
            ? 1 + (textLanes.laneOf.get(selectedText.id) ?? 0)
            : null;
      if (from === null) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const now = useStudio.getState().currentTime;
        const to =
          e.key === "ArrowDown"
            ? cues.find((c) => c.start > now + 0.01)
            : [...cues].reverse().find((c) => c.start < now - 0.01);
        if (!to) return;
        e.preventDefault();
        seek(to.start);
        return;
      }
      e.preventDefault();
      const target = from + (e.key === "ArrowDown" ? 1 : -1);
      if (target < 0 || target > textLanes.lanes) return;
      const refT = selectedSeg
        ? (selectedSeg.start + selectedSeg.end) / 2
        : (selectedText!.start + selectedText!.end) / 2;
      const distTo = (a: number, b: number) =>
        refT >= a && refT < b ? 0 : Math.min(Math.abs(refT - a), Math.abs(refT - b));
      if (target === 0) {
        if (posSegments.length === 0) return;
        const s = posSegments.reduce((p, c) =>
          distTo(c.start, c.end) < distTo(p.start, p.end) ? c : p
        );
        setSelectedPosId(s.id);
        setSelectedText(null);
        seek((s.start + s.end) / 2);
      } else {
        const inLane = texts.filter(
          (t) => (textLanes.laneOf.get(t.id) ?? 0) === target - 1
        );
        if (inLane.length === 0) return;
        const t = inLane.reduce((p, c) =>
          distTo(c.start, c.end) < distTo(p.start, p.end) ? c : p
        );
        setSelectedText(t.id);
        setSelectedPosId(null);
        seek((t.start + t.end) / 2);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showLayers, boxSelected, selectedSeg, selectedText, posSegments, texts, textLanes, cues, seek, setSelectedText]);

  const pointerXY = (e: React.PointerEvent): { x: number; y: number } | null => {
    const sc = scrollRef.current;
    if (!sc) return null;
    const rect = sc.getBoundingClientRect();
    return {
      x: e.clientX - rect.left + sc.scrollLeft,
      y: e.clientY - rect.top,
    };
  };

  /**
   * Snap a time to nearby clip edges: cue in/out points, caption section
   * edges, other text clips, the playhead and the video ends. Edges snap
   * together but are never welded — clips stay independent.
   * Returns the snap delta, or null when nothing is in range.
   */
  const snapDelta = (
    t: number,
    opts: {
      excludeTextId?: number;
      excludePosId?: number;
      excludePlayhead?: boolean;
    } = {}
  ): number | null => {
    const thr = SNAP_PX / pxPerSec;
    const targets: number[] = [0, duration];
    if (!opts.excludePlayhead) targets.push(currentTime);
    for (const c of cues) targets.push(c.start, c.end);
    for (const s of posSegments)
      if (s.id !== opts.excludePosId) targets.push(s.start, s.end);
    for (const tx of texts)
      if (tx.id !== opts.excludeTextId) targets.push(tx.start, tx.end);
    let best: number | null = null;
    for (const g of targets) {
      const d = g - t;
      if (Math.abs(d) < (best === null ? thr : Math.abs(best))) best = d;
    }
    return best;
  };

  /** Selected-section edge under the pointer (adjust the range after selecting). */
  const rangeHandleAt = (x: number): "rangeStart" | "rangeEnd" | null => {
    if (!rangeSel) return null;
    if (Math.abs(x - rangeSel.start * pxPerSec) <= EDGE_GRAB_PX)
      return "rangeStart";
    if (Math.abs(x - rangeSel.end * pxPerSec) <= EDGE_GRAB_PX)
      return "rangeEnd";
    return null;
  };

  /** Cue edge under the pointer (for dragging caption in/out points). */
  const edgeAt = (x: number, y: number): { id: number; side: "start" | "end" } | null => {
    const cueTop = RULER_H + PAD + layersExtra + WAVE_H + PAD;
    if (y < cueTop || y > cueTop + CUE_H) return null;
    let best: { id: number; side: "start" | "end"; d: number } | null = null;
    for (const c of cues) {
      const edges = [
        { side: "start" as const, d: Math.abs(c.start * pxPerSec - x) },
        { side: "end" as const, d: Math.abs(c.end * pxPerSec - x) },
      ];
      for (const e of edges) {
        if (e.d <= EDGE_GRAB_PX && (!best || e.d < best.d)) {
          best = { id: c.id, side: e.side, d: e.d };
        }
      }
    }
    return best && { id: best.id, side: best.side };
  };

  /**
   * Caption section clip (or one of its edges) under the pointer —
   * NLE-style zones: near the left edge trims the in point, near the
   * right edge the out point, the middle moves the whole section.
   * Edge zones shrink on narrow clips so the middle third stays
   * grabbable; Shift (forceMove) turns the whole clip into a move handle.
   */
  const posClipAt = (
    x: number,
    y: number,
    forceMove = false
  ): { id: number; part: "move" | "start" | "end" } | null => {
    if (!showLayers || y < posRowTop || y > posRowTop + POS_H) return null;
    if (!forceMove) {
      // edges first; where two sections touch, the pointer side picks the clip
      let best: {
        id: number;
        part: "start" | "end";
        ex: number;
        d: number;
      } | null = null;
      for (const s of posSegments) {
        const grab = Math.min(EDGE_GRAB_PX, ((s.end - s.start) * pxPerSec) / 3);
        const edges = [
          { part: "start" as const, ex: s.start * pxPerSec },
          { part: "end" as const, ex: s.end * pxPerSec },
        ];
        for (const c of edges) {
          const d = Math.abs(x - c.ex);
          if (d > grab) continue;
          const sideWins =
            (c.part === "end" && x < c.ex) || (c.part === "start" && x >= c.ex);
          if (!best || d < best.d || (d === best.d && sideWins))
            best = { id: s.id, part: c.part, ex: c.ex, d };
        }
      }
      if (best) return { id: best.id, part: best.part };
    }
    for (const s of posSegments) {
      if (x > s.start * pxPerSec && x < s.end * pxPerSec)
        return { id: s.id, part: "move" };
    }
    return null;
  };

  /** Text clip (or its edge) under the pointer. Shift (forceMove) = whole clip moves. */
  const textClipAt = (
    x: number,
    y: number,
    forceMove = false
  ): { id: number; part: "move" | "start" | "end" } | null => {
    if (!showLayers || texts.length === 0) return null;
    for (const t of texts) {
      const lane = textLanes.laneOf.get(t.id) ?? 0;
      const ty = textTop + lane * POS_H;
      if (y < ty || y > ty + POS_H - 4) continue;
      const x1 = t.start * pxPerSec;
      const x2 = t.end * pxPerSec;
      const grab = forceMove ? 0 : Math.min(EDGE_GRAB_PX, (x2 - x1) / 3);
      if (!forceMove && Math.abs(x - x1) <= grab)
        return { id: t.id, part: "start" };
      if (!forceMove && Math.abs(x - x2) <= grab)
        return { id: t.id, part: "end" };
      if (x > x1 - grab && x < x2 + grab)
        return { id: t.id, part: "move" };
    }
    return null;
  };

  const dragEdge = (x: number) => {
    const drag = dragging.current;
    if (!drag || drag.mode !== "edge") return;
    const i = cues.findIndex((c) => c.id === drag.id);
    if (i < 0) return;
    const c = cues[i];
    const t = x / pxPerSec;
    if (drag.side === "end") {
      // linger as long as you like — but never overlap the next caption
      const min = c.start + 0.05;
      const max = i < cues.length - 1 ? cues[i + 1].start - 0.001 : duration || t;
      updateCueTimes(c.id, c.start, Math.max(min, Math.min(max, t)));
    } else {
      const min = i > 0 ? cues[i - 1].end + 0.001 : 0;
      const max = c.end - 0.05;
      updateCueTimes(c.id, Math.max(min, Math.min(max, t)), c.end);
    }
  };

  const seekFromEvent = (e: React.PointerEvent) => {
    const sc = scrollRef.current;
    if (!sc || duration <= 0) return;
    const rect = sc.getBoundingClientRect();
    const x = e.clientX - rect.left + sc.scrollLeft;
    let t = x / pxPerSec;
    // playhead snaps to caption starts/ends and clip edges so a split
    // lands exactly on a boundary — hold Shift to scrub freely
    if (!e.shiftKey) {
      const d = snapDelta(t, { excludePlayhead: true });
      if (d !== null) t += d;
    }
    seek(t);
  };

  const togglePlay = () => {
    if (editorBusy) return;
    const v = playerRef.video;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  return (
    <div
      className="flex flex-col border-t border-zinc-800 bg-zinc-925"
      // a clicked button or the zoom slider never keeps the keys, as in
      // Review: Space and the arrows stay the player's
      onPointerUp={() =>
        setTimeout(() => {
          const a = document.activeElement as HTMLElement | null;
          if (a?.matches("button:not([aria-haspopup]), input[type=range]")) a.blur();
        }, 0)
      }
    >
      {/* transport */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          onClick={() => seek(currentTime - 5)}
          disabled={editorBusy}
          title="Back 5 s"
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <SkipBack className="h-4 w-4" />
        </button>
        <button
          onClick={togglePlay}
          disabled={editorBusy}
          title={editorBusy ? "Playback is locked while captions are processing" : "Play / pause"}
          className="rounded-full bg-violet-600 p-2 text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 pl-0.5" />}
        </button>
        <button
          onClick={() => seek(currentTime + 5)}
          disabled={editorBusy}
          title="Forward 5 s"
          className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-30"
        >
          <SkipForward className="h-4 w-4" />
        </button>
        <span
          className="ml-2 font-mono text-xs text-zinc-400"
          title={`MM:SS:FF @ ${fps} fps`}
        >
          {fmtTimecode(currentTime, fps)}{" "}
          <span className="text-zinc-600">/ {fmtTimecode(duration, fps)}</span>
        </span>
        {shuttle !== 0 && (
          <span className="rounded bg-violet-600/30 px-1.5 font-mono text-[11px] tabular-nums text-violet-200">
            {shuttle < 0 ? "◀◀" : "▶▶"} {Math.abs(shuttle)}×
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              title="Playback speed · J / K / L shuttle"
              className="rounded px-1.5 py-1 font-mono text-[11px] tabular-nums text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
            >
              {speed}×
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {SPEEDS.map((s) => (
              <DropdownMenuItem key={s} onClick={() => changeSpeed(s)}>
                {s}×
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          onClick={fillGaps}
          disabled={cues.length === 0 || editorBusy}
          title={
            editorBusy
              ? "Locked while captions are processing"
              : gapsFilled
                ? "On: every caption stays up until the next one, whatever you change. Click to turn off"
                : "Keep every caption up until the next one starts, through every change (drag a caption's edge below to adjust one)"
          }
          aria-pressed={gapsFilled}
          className={`ml-3 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] disabled:opacity-40 ${
            gapsFilled
              ? "border-violet-500/60 bg-violet-600/20 text-violet-200"
              : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          <UnfoldHorizontal className="h-3.5 w-3.5" /> Fill gaps
        </button>
        <button
          onClick={() => setShowLayers((v) => !v)}
          title="Video layers — caption positioning per section + text on screen"
          className={`ml-1.5 flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
            showLayers
              ? "border-violet-500/60 bg-violet-600/20 text-violet-200"
              : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          <Layers className="h-3.5 w-3.5" /> Layers
        </button>
        <button
          onClick={() => {
            setShowLayers(true);
            addTextAt(currentTime);
          }}
          disabled={duration <= 0}
          title="Add text on screen at the playhead"
          className="ml-1.5 flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          <Type className="h-3.5 w-3.5" /> Text
        </button>
        {showLayers && (
          <button
            onClick={() => splitPosAt(currentTime)}
            disabled={duration <= 0}
            title="Split the caption layer at the playhead"
            className="ml-1.5 flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            <Scissors className="h-3.5 w-3.5" /> Split
          </button>
        )}
        {showLayers && posSegments.length > 0 && (
          <button
            onClick={snapPosToCues}
            disabled={cues.length === 0 || editorBusy}
            title="Snap the caption layer's edges to the nearest caption cut, so no caption appears or disappears halfway"
            className="ml-1.5 flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            <Magnet className="h-3.5 w-3.5" /> Snap to cuts
          </button>
        )}
        {showLayers && selectedSeg && selectedSeg.x != null && (
          <button
            onClick={() => clearPosOverride(selectedSeg.id)}
            title="Reset this section to the default caption position"
            className="ml-1.5 flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
        )}
        {showLayers && selectedSeg && (
          <button
            onClick={() => {
              deletePosSegment(selectedSeg.id);
              setSelectedPosId(null);
            }}
            title="Remove this section (captions use the default position here)"
            className="ml-1.5 flex items-center gap-1.5 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </button>
        )}
        {rangeSel ? (
          <span className="ml-1.5 flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 text-[11px] font-medium text-amber-300">
            <button
              onClick={() => void retranscribeRange()}
              disabled={transcribing}
              title="Re-run the transcription engine on just the selected section — fresh words are spliced in, the rest of the transcript stays"
              className="flex items-center gap-1.5 py-1 pl-2 hover:text-amber-200 disabled:opacity-40"
            >
              {transcribing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Re-transcribe {(rangeSel.end - rangeSel.start).toFixed(1)}s
            </button>
            <button
              onClick={() => setRangeSel(null)}
              title="Clear the section selection (or just click the tracks)"
              className="rounded-r-md px-1.5 py-1 text-amber-300/60 hover:bg-amber-500/20 hover:text-amber-200"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          cues.length > 0 && (
            <span className="ml-1.5 self-center text-[10px] text-zinc-600">
              ⇧drag on the tracks to select a section
            </span>
          )
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => applyZoom(pxPerSec / 1.4)}
            title="Zoom out (-) · ⌥ scroll or pinch zooms, \ fits"
            className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={minZoom}
            max={maxZoom}
            step="any"
            value={pxPerSec}
            onChange={(e) => applyZoom(Number(e.target.value))}
            className="h-1 w-24 accent-violet-500"
          />
          <button
            onClick={() => applyZoom(pxPerSec * 1.4)}
            title="Zoom in (=)"
            className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-50"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* tracks */}
      <div
        ref={scrollRef}
        tabIndex={0}
        className="overflow-x-auto overflow-y-hidden outline-none"
        onPointerDown={(e) => {
          if (editorBusy) return;
          e.currentTarget.focus();
          const p = pointerXY(e);
          if (!p) return;
          // cue edges are locked while the cadence pass runs (updateCueTimes
          // no-ops in the store) — near-edge clicks fall through to seeking
          const hit = editorBusy ? null : edgeAt(p.x, p.y);
          const tc = hit ? null : textClipAt(p.x, p.y, e.shiftKey);
          const pc = hit || tc ? null : posClipAt(p.x, p.y, e.shiftKey);
          snapPending.current = Boolean(hit || tc || pc);
          if (hit) {
            dragging.current = { mode: "edge", ...hit };
          } else if (tc) {
            const tx = texts.find((t) => t.id === tc.id)!;
            setSelectedText(tc.id);
            setSelectedPosId(null);
            // the playhead stays put: it's the frame
            // the text is being dragged to snap to
            dragging.current =
              tc.part === "move"
                ? {
                    mode: "textMove",
                    id: tc.id,
                    dt: p.x / pxPerSec - tx.start,
                    dur: tx.end - tx.start,
                  }
                : { mode: "textEdge", id: tc.id, side: tc.part };
          } else if (pc) {
            const s = posSegments.find((x) => x.id === pc.id)!;
            setSelectedPosId(pc.id);
            setSelectedText(null);
            // a plain click jumps into the section so the video preview (and
            // the caption box drag) targets it; a drag leaves the playhead
            // where it is, to snap to (onPointerUp)
            clickSeek.current =
              currentTime < s.start || currentTime >= s.end
                ? (s.start + s.end) / 2
                : null;
            dragging.current =
              pc.part === "move"
                ? {
                    mode: "posMove",
                    id: pc.id,
                    dt: p.x / pxPerSec - s.start,
                    dur: s.end - s.start,
                  }
                : { mode: "posTrim", id: pc.id, side: pc.part };
          } else {
            setSelectedPosId(null);
            setSelectedText(null);
            const rh = e.shiftKey ? null : rangeHandleAt(p.x);
            if (rh) {
              // grab a selection edge to fine-tune the range
              dragging.current = { mode: rh };
            } else if (e.shiftKey) {
              // shift-drag = select a section (for section re-transcribe);
              // a plain shift-click still seeks freely
              dragging.current = { mode: "range", anchor: p.x / pxPerSec };
              setRangeSel(null);
            } else {
              // clicking away without shift drops any section selection
              setRangeSel(null);
              dragging.current = { mode: "seek" };
            }
            if (dragging.current.mode === "seek" || dragging.current.mode === "range") {
              seekFromEvent(e);
            }
          }
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = pointerXY(e);
          if (!p) return;
          const drag = dragging.current;
          if (drag && drag.mode !== "seek" && snapPending.current) {
            snapPending.current = false;
            snapshotHistory();
          }
          if (drag?.mode === "edge") dragEdge(p.x);
          else if (drag?.mode === "posMove") {
            const opts = { excludePosId: drag.id };
            let ns = Math.max(
              0,
              Math.min(p.x / pxPerSec - drag.dt, duration - drag.dur)
            );
            const cands = [snapDelta(ns, opts), snapDelta(ns + drag.dur, opts)]
              .filter((d): d is number => d !== null);
            if (cands.length)
              ns += cands.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
            movePosSegment(drag.id, ns);
          } else if (drag?.mode === "posTrim") {
            let t = p.x / pxPerSec;
            const d = snapDelta(t, { excludePosId: drag.id });
            if (d !== null) t += d;
            trimPosSegment(drag.id, drag.side, t);
          } else if (drag?.mode === "textMove") {
            const opts = { excludeTextId: drag.id };
            let ns = Math.max(
              0,
              Math.min(p.x / pxPerSec - drag.dt, duration - drag.dur)
            );
            const cands = [snapDelta(ns, opts), snapDelta(ns + drag.dur, opts)]
              .filter((d): d is number => d !== null);
            if (cands.length)
              ns += cands.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
            ns = Math.max(0, Math.min(ns, duration - drag.dur));
            updateText(drag.id, { start: ns, end: ns + drag.dur });
          } else if (drag?.mode === "textEdge") {
            const tx = texts.find((t) => t.id === drag.id);
            if (!tx) return;
            let t = p.x / pxPerSec;
            const d = snapDelta(t, { excludeTextId: drag.id });
            if (d !== null) t += d;
            if (drag.side === "start")
              updateText(drag.id, {
                start: Math.max(0, Math.min(t, tx.end - MIN_TEXT_DUR)),
              });
            else
              updateText(drag.id, {
                end: Math.min(duration, Math.max(t, tx.start + MIN_TEXT_DUR)),
              });
          } else if (drag?.mode === "range") {
            const t = Math.max(0, Math.min(duration, p.x / pxPerSec));
            setRangeSel({
              start: Math.min(drag.anchor, t),
              end: Math.max(drag.anchor, t),
            });
          } else if (drag?.mode === "rangeStart" || drag?.mode === "rangeEnd") {
            const cur = useStudio.getState().rangeSel;
            if (cur) {
              let t = Math.max(0, Math.min(duration, p.x / pxPerSec));
              const d = snapDelta(t, { excludePlayhead: true });
              if (d !== null) t += d;
              setRangeSel(
                drag.mode === "rangeStart"
                  ? { start: Math.min(t, cur.end - 0.1), end: cur.end }
                  : { start: cur.start, end: Math.max(t, cur.start + 0.1) }
              );
            }
          } else if (drag?.mode === "seek") seekFromEvent(e);
          else if (canvasRef.current) {
            const tc = textClipAt(p.x, p.y, e.shiftKey);
            const pc = tc ? null : posClipAt(p.x, p.y, e.shiftKey);
            canvasRef.current.style.cursor =
              (!editorBusy && edgeAt(p.x, p.y)) ||
              rangeHandleAt(p.x) ||
              (tc && tc.part !== "move") ||
              (pc && pc.part !== "move")
                ? "col-resize"
                : tc || pc
                  ? "grab"
                  : "text";
          }
        }}
        onPointerUp={() => {
          const mode = dragging.current?.mode;
          if (
            (mode === "posMove" || mode === "posTrim") &&
            snapPending.current &&
            clickSeek.current !== null
          ) {
            seek(clickSeek.current); // never moved: a click
          }
          clickSeek.current = null;
          // a shift-click that never grew into a range was just a seek
          if (
            dragging.current?.mode === "range" &&
            rangeSel &&
            rangeSel.end - rangeSel.start < 0.1
          ) {
            setRangeSel(null);
          }
          dragging.current = null;
          snapPending.current = false;
        }}
      >
        <canvas
          ref={canvasRef}
          className={`block ${editorBusy ? "cursor-wait" : "cursor-text"}`}
        />
      </div>
    </div>
  );
}
