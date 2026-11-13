import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  alphaFileName,
  cameraCut,
  cameraPlace,
  defaultCamera,
  defaultLook,
  faceFollower,
  normalizeLook,
  opaqueLook,
  outputSize,
  pointerAt,
  pointerPath,
  trimOf,
  zoomFloor,
  type CursorImages,
  type FaceTrack,
  type FrameShape,
  type ScreenEvents,
  type ScreenLook,
} from "@/lib/screen-recording";
import { clock } from "@/lib/screen-timeline";
import { renderScreenVideo } from "@/lib/screen-export";
import { canSaveTransparent, transparentVideoMade } from "@/lib/mac-record";
import type { ScreenSource } from "@/lib/screen-source";
import { Inspector, type InspectorTab } from "@/components/screen-editor/Inspector";
import { Timeline } from "@/components/screen-editor/Timeline";
import { Segmented } from "@/components/screen-editor/controls";
import { useMacRecorderState } from "@/components/settings/ThisMacSection";
import { usePlayer } from "@/components/screen-editor/usePlayer";

/** A way out for the finished video. `run` gets it (`name` has no extension) and reports its own steps. */
export type EditorAction = {
  label: string;
  title?: string;
  primary?: boolean;
  run: (out: { blob: Blob; name: string }, progress: (step: string, pct: number) => void) => Promise<void>;
};

const SIZE_KEY = "screen-editor-size";

const SHAPES: { id: FrameShape; label: string; title: string }[] = [
  { id: "source", label: "Auto", title: "The shape of what you recorded" },
  { id: "16:9", label: "16:9", title: "Wide" },
  { id: "9:16", label: "9:16", title: "Tall, for phones" },
  { id: "1:1", label: "1:1", title: "Square" },
  { id: "4:5", label: "4:5", title: "Portrait" },
];
const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/**
 * The editor of a screen recording: the picture with its look, playing as it opens; under it the recording and its
 * zooms on a timeline; beside it the look (background, pointer, zooms, camera). Export makes the video on this
 * computer; the caller says where it goes (`actions`): Review adds it as the next version, the Screen Recorder saves
 * it or uploads it. `extra` goes before Export. `embedded` fills its parent (a page) instead of covering the window;
 * such a page hands over a place in its own top bar (`barSlot`) and Export goes there, so the screen has one bar.
 * `download` saves a file the way the page's downloads go. With it, in a Mac app that turns the editor's packed file
 * into a see-through video (lib/mac-record.ts canSaveTransparent), the background can be None: Export then has one
 * way out, that video. Anywhere else None is not offered and a look that says it is shown with the first gradient.
 */
export function ScreenRecordingEditor({
  source,
  meta,
  actions,
  download,
  onClose,
  extra,
  embedded = false,
  barSlot,
}: {
  source: ScreenSource;
  meta: { name: string; duration: number; width: number; height: number };
  actions: EditorAction[];
  download?: (blob: Blob, fileName: string) => void;
  onClose?: () => void;
  extra?: ReactNode;
  embedded?: boolean;
  barSlot?: HTMLElement | null;
}) {
  const [events, setEvents] = useState<ScreenEvents | null>(null);
  const [saved, setLook] = useState<ScreenLook | null>(null);
  const canClear = !!download && canSaveTransparent();
  // what is shown and made; changes go to the saved one, which keeps its "none" for where it can be made
  const look = useMemo(() => (saved && !canClear ? opaqueLook(saved) : saved), [saved, canClear]);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<number | null>(null);
  const [tab, setTab] = useState<InspectorTab>("background");
  const [uhd, setUhd] = useState(() => {
    try {
      return localStorage.getItem(SIZE_KEY) === "4k";
    } catch {
      return false;
    }
  });
  const [exporting, setExporting] = useState(false);
  const [making, setMaking] = useState<{ step: string; pct: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  // the source is read through a ref: its identity can change on every page render, its url cannot
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const { width, height } = meta;
  const base = meta.name.replace(/\.(mp4|mov|m4v|webm)$/i, "");

  const path = useMemo(() => (events ? pointerPath(events) : []), [events]);
  // Follow my face: where the face is in the camera (found before, or found now by the Mac app), and the cut that follows it
  const [faceTrack, setFaceTrack] = useState<FaceTrack | null | undefined>(undefined);
  const [finding, setFinding] = useState<number | null>(null);
  useEffect(() => {
    void sourceRef.current.faces?.().then(setFaceTrack, () => setFaceTrack(null));
  }, [source.url]);
  const follower = useMemo(() => faceFollower(faceTrack), [faceTrack]);
  // the pointer as it really looked: the cursors the recording saved (an I-beam over text, a hand over a link)
  const [cursorImages, setCursorImages] = useState<CursorImages | undefined>(undefined);
  useEffect(() => {
    const shapes = events?.cursors ?? [];
    const at = sourceRef.current.cursor;
    if (!shapes.length || !at) return;
    let gone = false;
    void Promise.all(
      shapes.map((_, i) =>
        fetch(at(i))
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
          .then((b) => createImageBitmap(b))
          .catch(() => null),
      ),
    ).then((images) => !gone && setCursorImages(images));
    return () => {
      gone = true;
    };
  }, [events]);
  const mac = useMacRecorderState();
  const canFind = !!source.findFaces && !!mac && !!mac.faces;
  const findFaces = async () => {
    if (finding !== null) return;
    setFinding(0);
    try {
      setFaceTrack(await sourceRef.current.findFaces!((p) => setFinding(Math.round(p * 100))));
    } catch (e) {
      setFaceTrack(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFinding(null);
    }
  };
  const player = usePlayer({ url: source.url, cameraUrl: source.cameraUrl, look, events, path, duration: meta.duration, width, height, faces: follower, cursors: cursorImages });
  // a recording filed without its length (one that stopped early) takes it from the file
  const duration = meta.duration > 0 ? meta.duration : player.mediaDuration;
  const loaded = useRef<{ events: ScreenEvents; look: ScreenLook | null } | null>(null);

  useEffect(() => {
    sourceRef.current
      .load()
      .then(({ events, look }) => {
        if (!events) throw new Error("This recording has no pointer log");
        loaded.current = { events, look };
        setEvents(events);
      })
      .catch((e: Error) => setError(e.message));
    // the url names the recording; a new source for the same one must not reload and lose edits
  }, [source.url]);

  // the look needs the length: read it once both are known
  const lookRef = useRef<ScreenLook | null>(null);
  useEffect(() => {
    if (lookRef.current || !loaded.current || !(duration > 0)) return;
    const { events, look } = loaded.current;
    lookRef.current = normalizeLook(look, events, duration);
    setLook(lookRef.current);
  }, [events, duration]);

  // every change is kept (the page can close any time), and can be undone
  const history = useRef({ past: [] as ScreenLook[], future: [] as ScreenLook[], at: 0 });
  const [, setSteps] = useState(0);
  const unsaved = useRef<ScreenLook | null>(null);
  const saver = useRef(0);
  const keep = useCallback((next: ScreenLook) => {
    lookRef.current = next;
    setLook(next);
    unsaved.current = next;
    window.clearTimeout(saver.current);
    saver.current = window.setTimeout(() => {
      unsaved.current = null;
      sourceRef.current.saveLook(next);
    }, 700);
  }, []);
  // closing within the wait still saves the last change
  useEffect(
    () => () => {
      window.clearTimeout(saver.current);
      if (unsaved.current) sourceRef.current.saveLook(unsaved.current);
    },
    [],
  );
  const change = useCallback(
    (patch: Partial<ScreenLook>) => {
      const now = lookRef.current;
      if (!now) return;
      const h = history.current;
      const at = performance.now();
      // one drag is one step back: changes less than 0.6 s apart count as the same one
      if (at - h.at > 600) {
        h.past.push(now);
        if (h.past.length > 200) h.past.shift();
        setSteps((n) => n + 1);
      }
      h.at = at;
      h.future = [];
      keep({ ...now, ...patch });
    },
    [keep],
  );
  const step = useCallback(
    (back: boolean) => {
      const h = history.current;
      const now = lookRef.current;
      const to = (back ? h.past : h.future).pop();
      if (!now || !to) return;
      (back ? h.future : h.past).push(now);
      h.at = 0;
      setSteps((n) => n + 1);
      keep(to);
    },
    [keep],
  );

  // where a zoom at t should look: the pointer there, or the nearest edge when it was outside the picture
  const aim = useCallback(
    (t: number) => {
      const p = pointerAt(path, t) ?? { x: 0.5, y: 0.5 };
      const inside = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
      return { x: inside(p.x), y: inside(p.y) };
    },
    [path],
  );
  const zoom = look && picked !== null ? look.zooms[picked] : undefined;

  /** Picks a zoom: its settings open, and the picture goes to where it is zoomed in, so a change is seen at once. */
  const pick = useCallback(
    (index: number | null) => {
      setPicked(index);
      const z = index !== null ? lookRef.current?.zooms[index] : undefined;
      if (!z) return;
      setTab("zoom");
      player.pause();
      const t = player.time();
      if (t < z.start + 0.7 || t > z.end - 0.7) player.seek((z.start + z.end) / 2);
    },
    [player],
  );

  useEffect(() => () => abort.current?.abort(), []);

  // The camera in the picture: drag it to move what it shows, scroll over it to go closer (the Camera tab's Framing).
  // A press that moves is no play/pause click.
  const dragged = useRef(false);
  const camAt = (e: { clientX: number; clientY: number }) => {
    const c = player.canvas.current;
    const now = lookRef.current;
    const size = player.cameraSize();
    if (!c || !now || !size || !sourceRef.current.cameraUrl) return null;
    const cam = now.camera ?? defaultCamera();
    const place = cameraPlace(now, cam, c.width, c.height, (width && height ? width / height : player.ratio()) || 16 / 9);
    const b = c.getBoundingClientRect();
    const k = c.width / b.width;
    const x = (e.clientX - b.left) * k;
    const y = (e.clientY - b.top) * k;
    if (!place || x < place.r.x || x > place.r.x + place.r.w || y < place.r.y || y > place.r.y + place.r.h) return null;
    return { cam, r: place.r, size, k };
  };
  const grabCamera = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    dragged.current = false;
    const hit = e.button === 0 ? camAt(e) : null;
    if (!hit) return;
    const { cam, r, size, k } = hit;
    if (cam.follow && follower) return; // the face decides where it looks; a scroll still goes closer
    const cut = cameraCut(size.width, size.height, r, cam, cam.mirror);
    const fw = cut.sw / size.width;
    const fh = cut.sh / size.height;
    const inside = (v: number, f: number) => (f >= 1 ? 0.5 : Math.min(1 - f / 2, Math.max(f / 2, v)));
    const from = { x: inside(cam.x ?? 0.5, fw), y: inside(cam.y ?? 0.5, fh), cx: e.clientX, cy: e.clientY };
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = "grabbing";
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - from.cx;
      const dy = ev.clientY - from.cy;
      if (!dragged.current && Math.hypot(dx, dy) < 3) return;
      dragged.current = true;
      const round = (v: number) => Math.round(v * 1000) / 1000;
      change({
        camera: { ...cam, x: round(inside(from.x - ((dx * k) / r.w) * fw, fw)), y: round(inside(from.y - ((dy * k) / r.h) * fh, fh)) },
      });
    };
    const up = () => {
      el.style.cursor = "";
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const camAtRef = useRef(camAt);
  camAtRef.current = camAt;
  useEffect(() => {
    const c = player.canvas.current;
    if (!c) return;
    const wheel = (e: WheelEvent) => {
      const hit = camAtRef.current(e);
      if (!hit) return;
      e.preventDefault();
      const zoom = Math.round(Math.min(3, Math.max(1, (hit.cam.zoom ?? 1) * Math.exp(-e.deltaY * 0.002))) * 100) / 100;
      change({ camera: { ...hit.cam, zoom } });
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, [player.canvas, change]);

  // Space plays, the arrows step, Delete removes the picked zoom, ⌘Z and ⇧⌘Z undo and redo. Taken before anything
  // else gets the key (capture), and kept from going further: a button pressed a moment ago still has the focus and
  // would take the Space, and a page under this editor (Review) has keys of its own.
  useEffect(() => {
    const elsewhere = (e: KeyboardEvent) =>
      typing(e) || !!(e.target as Partial<HTMLElement> | null)?.closest?.('[data-slot="popover-content"], [role="menu"]');
    const onKey = (e: KeyboardEvent) => {
      const look = lookRef.current;
      if (!look || elsewhere(e)) return;
      const on = (e.target as Partial<HTMLElement> | null)?.closest?.("[role=slider], [role=radiogroup], [role=tablist]");
      if (e.key === " ") player.toggle();
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !on && !e.metaKey && !e.altKey) {
        player.seek(player.time() + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 1));
      } else if ((e.key === "Backspace" || e.key === "Delete") && picked !== null && look.zooms[picked]) {
        change({ zooms: look.zooms.filter((_, i) => i !== picked) });
        setPicked(null);
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z") step(!e.shiftKey);
      else if (e.key === "Escape" && picked !== null) setPicked(null);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // the Space that played must not also press the focused button when it comes up
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !lookRef.current || elsewhere(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [player, picked, change, step]);

  /** Makes the video and hands it to `a`; null: the see-through video (1080p), handed to the app as a download, which writes it. */
  const run = async (a: EditorAction | null) => {
    if (!look || !events) return;
    setExporting(false);
    player.pause();
    const ctl = new AbortController();
    abort.current = ctl;
    const out = outputSize(look.shape, width, height, uhd && !!a);
    const kept = trimOf(look, duration);
    try {
      setError("");
      setMaking({ step: "Making", pct: 0 });
      const blob = await renderScreenVideo({
        url: sourceRef.current.url,
        cameraUrl: sourceRef.current.cameraUrl ?? undefined,
        file: sourceRef.current.file,
        cameraFile: sourceRef.current.cameraFile,
        events,
        look,
        faces: follower,
        cursors: cursorImages,
        ...out,
        trim: look.trim ? kept : undefined,
        alpha: !a,
        signal: ctl.signal,
        onProgress: (p) => setMaking({ step: "Making", pct: Math.round(p * 100) }),
      });
      if (ctl.signal.aborted) return;
      if (!a) {
        // the app asks where the video goes and writes it; the button counts along until it is there (Stop ends it)
        const made = transparentVideoMade((part) => setMaking({ step: "Writing", pct: Math.round(part * 100) }), ctl.signal);
        setMaking({ step: "Writing", pct: 0 });
        download?.(blob, alphaFileName(`${base} (transparent)`, out.width, out.height));
        return await made;
      }
      await a.run({ blob, name: `${base} (zoomed)` }, (step, pct) => {
        if (!ctl.signal.aborted) setMaking({ step, pct: Math.round(pct) });
      });
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMaking(null);
    }
  };

  const sizes = look ? { hd: outputSize(look.shape, width, height, false), uhd: outputSize(look.shape, width, height, true) } : null;
  // no background (only where the see-through video can be made): one way out, at 1080p
  const clear = look?.background === "none";
  const size = sizes && (uhd && !clear ? sizes.uhd : sizes.hd);
  const kept = look ? trimOf(look, duration) : null;
  // where zooms fill the whole frame, none is shallower than what covers it: the panel and the timeline say that depth
  const shape = (width && height ? width / height : player.ratio()) || 16 / 9;
  const floor = look ? Math.ceil(zoomFloor(look, shape, source.cameraUrl ? (look.camera ?? defaultCamera()) : null) * 10 - 1e-6) / 10 : 1;
  const initial = useMemo(() => (events ? defaultLook(events, duration) : null), [events, duration]);
  const h = history.current;

  const buttons = (
    <>
      {error && look && (
        <span className="max-w-md truncate text-xs text-red-400" title={error}>
          {error}
        </span>
      )}
      {extra}
      {making ? (
        <Button size="sm" variant="outline" onClick={() => abort.current?.abort()}>
          <Loader2 className="animate-spin" /> {making.step} {making.pct}% · Stop
        </Button>
      ) : (
        <Popover open={exporting} onOpenChange={setExporting}>
          <PopoverTrigger asChild>
            <Button size="sm" disabled={!look} className="bg-violet-600 text-white hover:bg-violet-500">
              <Upload /> Export
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3 border-zinc-800 bg-zinc-950 p-3 text-zinc-100">
            {size && kept && (
              <>
                {!clear && (
                  <Segmented
                    label="Video size"
                    value={uhd ? "4k" : "hd"}
                    options={[
                      { id: "hd", label: "1080p" },
                      { id: "4k", label: "4K" },
                    ]}
                    onChange={(v) => {
                      setUhd(v === "4k");
                      try {
                        localStorage.setItem(SIZE_KEY, v);
                      } catch {
                        // kept for this visit only
                      }
                    }}
                  />
                )}
                <p className="text-center text-[11px] tabular-nums text-zinc-400">
                  {size.width} × {size.height} pixels · {clock(kept.end - kept.start, true)}
                </p>
              </>
            )}
            <div className="space-y-1.5">
              {clear && (
                <Button
                  size="sm"
                  title="Makes a .mov with a transparent background (ProRes 4444) where you choose, to lay over other video"
                  onClick={() => void run(null)}
                  className="w-full bg-violet-600 text-white hover:bg-violet-500"
                >
                  Save transparent video…
                </Button>
              )}
              {(clear ? [] : actions).map((a) => (
                <Button
                  key={a.label}
                  size="sm"
                  title={a.title}
                  variant={a.primary ? "default" : "outline"}
                  onClick={() => void run(a)}
                  className={cn("w-full", a.primary && "bg-violet-600 text-white hover:bg-violet-500")}
                >
                  {a.label}
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  );

  return (
    <div
      className={cn("flex flex-col bg-zinc-950 text-zinc-100", embedded ? "min-h-0 flex-1" : "fixed inset-0 z-50")}
      role={embedded ? undefined : "dialog"}
      aria-label="Zoom and pointer"
    >
      {embedded ? (
        barSlot ? (
          createPortal(buttons, barSlot)
        ) : (
          <div className="flex min-h-12 items-center justify-end gap-2 border-b border-zinc-800 px-4">{buttons}</div>
        )
      ) : (
        <div className="flex min-h-14 items-center gap-3 px-4" data-titlebar>
          <span className="text-sm font-semibold">Zoom & pointer</span>
          <span className="truncate text-xs text-zinc-400">{meta.name}</span>
          <div className="ml-auto flex items-center gap-2">
            {buttons}
            {onClose && (
              <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close">
                <X />
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* the frame's shape, over the picture it changes, whichever tab is open */}
          {look && (
            <div className="flex justify-center pt-3">
              <div className="w-80">
                {/* a split shares a frame of its own shape: no Auto */}
                <Segmented
                  label="Frame shape"
                  value={look.shape}
                  options={source.cameraUrl && look.camera?.layout === "split" ? SHAPES.filter((s) => s.id !== "source") : SHAPES}
                  onChange={(shape) => change({ shape })}
                />
              </div>
            </div>
          )}
          {/* the picture: fitted into this box by the player, a press plays and pauses */}
          <div className="relative min-h-0 flex-1 p-6">
            <div ref={player.stage} className="flex h-full w-full items-center justify-center">
              <canvas
                ref={player.canvas}
                onClick={() => (dragged.current ? (dragged.current = false) : player.toggle())}
                onPointerDown={grabCamera}
                onPointerMove={(e) => {
                  if (e.buttons === 0) e.currentTarget.style.cursor = camAt(e) ? "grab" : "";
                }}
                className={cn("cursor-pointer rounded-md shadow-2xl transition-opacity", player.ready && look ? "opacity-100" : "opacity-0")}
              />
            </div>
            {(!player.ready || !look) && (
              <div className="absolute inset-0 flex items-center justify-center">
                {error || player.failed ? (
                  <p className="text-sm text-red-400">{error || "This recording can't be played here"}</p>
                ) : (
                  <Loader2 className="h-6 w-6 animate-spin text-zinc-600" />
                )}
              </div>
            )}
            {/* the videos themselves: the player makes them here, out of sight */}
            <div ref={player.holder} />
          </div>

          {look && events && (
            <Timeline
              player={player}
              duration={duration}
              look={look}
              clicks={events.clicks}
              picked={zoom ? picked : null}
              onPick={pick}
              change={change}
              aim={aim}
              depth={look.zooms.at(-1)?.scale ?? 2}
              floor={floor}
              undo={h.past.length ? () => step(true) : null}
              redo={h.future.length ? () => step(false) : null}
            />
          )}
        </div>

        {look && events && initial && (
          <Inspector
            tab={tab}
            onTab={(t) => {
              setTab(t);
              if (t !== "zoom") setPicked(null);
            }}
            look={look}
            initial={initial}
            change={change}
            events={events}
            duration={duration}
            picked={zoom ? picked : null}
            onPick={pick}
            player={player}
            aim={aim}
            hasCamera={!!source.cameraUrl}
            faces={{ found: follower !== null, tried: faceTrack != null, can: canFind, finding, find: () => void findFaces() }}
            canClear={canClear}
            floor={floor}
          />
        )}
      </div>
    </div>
  );
}
