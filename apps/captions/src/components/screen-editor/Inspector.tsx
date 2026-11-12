import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { Crosshair, Image as ImageIcon, MousePointer2, Plus, Sparkles, Trash2, Video, X, ZoomIn } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BACKGROUNDS,
  autoZooms,
  backgroundStops,
  defaultCamera,
  outputSize,
  shadowOf,
  zoomView,
  type CameraLook,
  type FrameShape,
  type ScreenEvents,
  type ScreenLook,
  type Zoom,
} from "@/lib/screen-recording";
import { clock, zoomSlot } from "@/lib/screen-timeline";
import { ColorField, Group, PanelButton, Segmented, SliderRow, SwitchRow, Swatches } from "./controls";
import type { Player } from "./usePlayer";

export type InspectorTab = "background" | "pointer" | "zoom" | "camera";

const SHAPES: { id: FrameShape; label: string; title: string }[] = [
  { id: "source", label: "Auto", title: "The shape of what you recorded" },
  { id: "16:9", label: "16:9", title: "Wide" },
  { id: "9:16", label: "9:16", title: "Tall, for phones" },
  { id: "1:1", label: "1:1", title: "Square" },
  { id: "4:5", label: "4:5", title: "Portrait" },
];

const COLORS = ["#000000", "#18181b", "#3f3f46", "#f4f4f5", "#ffffff", "#1e1b4b"];

const pct = (v: number) => `${Math.round(v * 100)}`;

/**
 * The side panel: one tab at a time. Background (the frame's shape, what is behind the picture, space, corners,
 * shadow), Pointer, Zoom (the picked zoom, or adding them) and Camera when the recording has one.
 */
export function Inspector({
  tab,
  onTab,
  look,
  initial,
  change,
  events,
  duration,
  picked,
  onPick,
  player,
  aim,
  hasCamera,
  canClear,
  floor,
}: {
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  look: ScreenLook;
  /** What Reset goes back to. */
  initial: ScreenLook;
  change: (patch: Partial<ScreenLook>) => void;
  events: ScreenEvents;
  duration: number;
  picked: number | null;
  onPick: (index: number | null) => void;
  player: Player;
  aim: (t: number) => { x: number; y: number };
  hasCamera: boolean;
  /** A see-through video can be made here: the background can be None. */
  canClear: boolean;
  /** The least depth a zoom is seen at (lib/screen-recording.ts zoomFloor, in tenths): above 1 where zooms fill the whole frame. */
  floor: number;
}) {
  const tabs: { id: InspectorTab; label: string; icon: typeof ImageIcon }[] = [
    { id: "background", label: "Background", icon: ImageIcon },
    { id: "pointer", label: "Pointer", icon: MousePointer2 },
    { id: "zoom", label: "Zoom", icon: ZoomIn },
    ...(hasCamera ? [{ id: "camera" as const, label: "Camera", icon: Video }] : []),
  ];
  const shown = tabs.some((t) => t.id === tab) ? tab : "background";

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800">
      <div role="tablist" aria-label="What to change" className="flex gap-1 border-b border-zinc-800 p-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={shown === t.id}
            onClick={() => onTab(t.id)}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] transition-colors",
              shown === t.id ? "bg-zinc-800 font-medium text-zinc-50" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
            )}
          >
            <t.icon className="h-4 w-4" />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 space-y-6 overflow-y-scroll p-4 bars:pr-2">
        {shown === "background" && <BackgroundTab look={look} initial={initial} change={change} canClear={canClear} />}
        {shown === "pointer" && <PointerTab look={look} initial={initial} change={change} />}
        {shown === "zoom" && (
          <ZoomTab look={look} change={change} events={events} duration={duration} picked={picked} onPick={onPick} player={player} aim={aim} floor={floor} />
        )}
        {shown === "camera" && <CameraTab look={look} change={change} />}
      </div>
    </aside>
  );
}

type TabProps = { look: ScreenLook; initial: ScreenLook; change: (patch: Partial<ScreenLook>) => void };

function BackgroundTab({ look, initial, change, canClear }: TabProps & { canClear: boolean }) {
  const [from, to] = backgroundStops(look);
  const kind = look.background === "none" ? "none" : look.background === "color" ? "color" : "gradient";
  return (
    <>
      <Group title="Frame">
        <Segmented label="Frame shape" value={look.shape} options={SHAPES} onChange={(shape) => change({ shape })} />
        {look.shape !== "source" && (
          <SwitchRow label="Fill the frame and follow the pointer" checked={look.fill} onChange={(fill) => change({ fill })} />
        )}
      </Group>

      <Group title="Background">
        <Segmented
          label="Background kind"
          value={kind}
          options={[
            { id: "gradient", label: "Gradient" },
            { id: "color", label: "Color" },
            ...(canClear ? [{ id: "none" as const, label: "None", title: "Nothing behind the window: Export makes a video with a transparent background" }] : []),
          ]}
          onChange={(k) =>
            change(k === "none" ? { background: "none" } : k === "color" ? { background: "color", color: look.color ?? from } : { background: BACKGROUNDS[0].id })
          }
        />
        {kind === "none" ? null : kind === "gradient" ? (
          <>
            <Swatches
              label="Gradient"
              value={look.background === "custom" ? null : look.background}
              options={BACKGROUNDS.map((b) => ({ id: b.id, label: b.label, fill: `linear-gradient(135deg, ${b.stops[0]}, ${b.stops[1]})` }))}
              onChange={(background) => change({ background })}
            />
            <div className="flex gap-2">
              <ColorField label="Gradient, first color" value={from} onChange={(c) => change({ background: "custom", stops: [c, to] })} />
              <ColorField label="Gradient, second color" value={to} onChange={(c) => change({ background: "custom", stops: [from, c] })} />
            </div>
          </>
        ) : (
          <>
            <Swatches
              label="Color"
              value={COLORS.includes(from.toLowerCase()) ? from.toLowerCase() : null}
              options={COLORS.map((c) => ({ id: c, label: c, fill: c }))}
              onChange={(color) => change({ background: "color", color })}
            />
            <div className="flex">
              <ColorField label="Background color" value={from} onChange={(color) => change({ background: "color", color })} />
            </div>
          </>
        )}
      </Group>

      <Group>
        <SliderRow label="Padding" value={look.padding} min={0} max={0.15} step={0.005} format={pct} initial={initial.padding} onChange={(padding) => change({ padding })} />
        <SliderRow label="Rounded corners" value={look.radius} min={0} max={0.06} step={0.002} format={(v) => `${Math.round(v * 1000)}`} initial={initial.radius} onChange={(radius) => change({ radius })} />
        {/* the shadow falls on the padding: with none, there is nothing to see */}
        {look.padding > 0 && (
          <SliderRow
            label="Shadow"
            value={shadowOf(look)}
            min={0}
            max={1}
            step={0.05}
            format={pct}
            initial={shadowOf(initial)}
            onChange={(v) => change({ shadow: v > 0, shadowAmount: v })}
          />
        )}
      </Group>
    </>
  );
}

function PointerTab({ look, initial, change }: TabProps) {
  return (
    <Group>
      <SwitchRow label="Show the pointer" checked={!look.pointerHidden} onChange={(on) => change({ pointerHidden: !on })} />
      {!look.pointerHidden && (
        <>
          <SliderRow label="Size" value={look.pointer} min={0.8} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} initial={initial.pointer} onChange={(pointer) => change({ pointer })} />
          <SliderRow label="Smooth movement" value={look.smooth} min={0} max={0.8} step={0.01} format={pct} initial={initial.smooth} onChange={(smooth) => change({ smooth })} />
          <SwitchRow label="Hide when it stays still" checked={look.hideIdle} onChange={(hideIdle) => change({ hideIdle })} />
        </>
      )}
      <SwitchRow label="Ring on clicks" checked={look.clickRings} onChange={(clickRings) => change({ clickRings })} />
    </Group>
  );
}

function ZoomTab({
  look,
  change,
  events,
  duration,
  picked,
  onPick,
  player,
  aim,
  floor,
}: {
  look: ScreenLook;
  change: (patch: Partial<ScreenLook>) => void;
  events: ScreenEvents;
  duration: number;
  picked: number | null;
  onPick: (index: number | null) => void;
  player: Player;
  aim: (t: number) => { x: number; y: number };
  floor: number;
}) {
  const zoom = picked !== null ? look.zooms[picked] : undefined;
  // where zooms fill the whole frame none is shallower than what covers it: the slider starts there, and the
  // depths shown are the ones seen
  const least = Math.max(1.2, floor);
  const depth = (z: Zoom) => Math.max(z.scale, least);
  const setZoom = (patch: Partial<Zoom>) => change({ zooms: look.zooms.map((z, i) => (i === picked ? { ...z, ...patch } : z)) });
  // where the clicks were or, with none, where the pointer was at work (lib/screen-recording.ts autoZooms)
  const laidOut = autoZooms(events, duration, zoom?.scale ?? look.zooms[0]?.scale);
  const add = () => {
    const slot = zoomSlot(look.zooms, player.time(), duration, "start");
    if (!slot) return;
    const at = aim((slot.start + slot.end) / 2);
    const z: Zoom = { ...slot, x: at.x, y: at.y, scale: look.zooms.at(-1)?.scale ?? 2 };
    const zooms = [...look.zooms, z].sort((a, b) => a.start - b.start);
    change({ zooms });
    onPick(zooms.indexOf(z));
  };

  if (zoom && picked !== null) {
    return (
      <>
        <Group>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium tabular-nums text-zinc-200">
              Zoom {clock(zoom.start, true)} – {clock(zoom.end, true)}
            </h3>
            <button type="button" onClick={() => onPick(null)} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Back to all zooms" title="Back to all zooms">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {least < 4 && (
            <SliderRow label="Depth" value={depth(zoom)} min={least} max={4} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(scale) => setZoom({ scale })} />
          )}
          <AimPad look={look} zoom={zoom} player={player} onAim={(x, y) => setZoom({ x, y })} />
          <PanelButton
            onClick={() => {
              const at = aim(player.time());
              setZoom({ x: at.x, y: at.y });
            }}
            title="Look where the pointer is at the playhead"
          >
            <Crosshair /> Aim at the pointer
          </PanelButton>
        </Group>
        <EveryZoom look={look} change={change} />
        <Group>
          {look.zooms.length > 1 && (
            <PanelButton onClick={() => change({ zooms: look.zooms.map((z) => ({ ...z, scale: zoom.scale })) })}>
              Use {depth(zoom).toFixed(1)}× for every zoom
            </PanelButton>
          )}
          <PanelButton
            tone="danger"
            onClick={() => {
              change({ zooms: look.zooms.filter((_, i) => i !== picked) });
              onPick(null);
            }}
          >
            <Trash2 /> Remove this zoom
          </PanelButton>
        </Group>
      </>
    );
  }

  return (
    <>
      <Group>
        <PanelButton tone="accent" onClick={add}>
          <Plus /> Add a zoom at the playhead
        </PanelButton>
        {laidOut.length > 0 && (
          <PanelButton
            onClick={() => {
              change({ zooms: laidOut });
              onPick(null);
            }}
            title="One zoom around each run of clicks (with no clicks, where the pointer was at work); replaces the zooms there are"
          >
            <Sparkles /> {look.zooms.length ? "Lay them out again" : "Lay out zooms"}
          </PanelButton>
        )}
      </Group>
      {look.zooms.length > 0 && (
        <>
          <EveryZoom look={look} change={change} />
          <Group title="Zooms">
            <div className="space-y-1">
              {look.zooms.map((z, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onPick(i)}
                  className="flex w-full items-center justify-between rounded-lg bg-zinc-900 px-2.5 py-2 text-xs tabular-nums text-zinc-300 hover:bg-zinc-800"
                >
                  <span>
                    {clock(z.start, true)} – {clock(z.end, true)}
                  </span>
                  <span className="text-zinc-400">{depth(z).toFixed(1)}×</span>
                </button>
              ))}
            </div>
          </Group>
        </>
      )}
    </>
  );
}

/**
 * What holds for every zoom: whether the view moves on to a click it would not show, and what a zoom does to the window the recording
 * sits in. The window can only grow where the whole recording is shown; up to the padding only where the frame has
 * space beside the window (another shape than the recording's).
 */
function EveryZoom({ look, change }: { look: ScreenLook; change: (patch: Partial<ScreenLook>) => void }) {
  const filled = look.fill && look.shape !== "source";
  const room = look.shape !== "source";
  const fit = look.zoomFit === "frame" ? "frame" : look.zoomFit === "space" && room ? "space" : "inside";
  return (
    <Group title="Every zoom">
      <SwitchRow label="Move to clicks outside the view" checked={look.follow} onChange={(follow) => change({ follow })} />
      {!filled && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">While zoomed, the window</p>
          <Segmented
            stacked
            label="While zoomed, the window"
            value={fit}
            options={[
              { id: "inside", label: "Keeps its size", title: "The window stays as it is; the picture is zoomed inside it" },
              ...(room ? [{ id: "space" as const, label: "Grows up to the padding", title: "The window grows into the empty space beside it, as far as the padding" }] : []),
              { id: "frame", label: "Fills the whole frame", title: "The window grows past the padding until the picture fills the frame" },
            ]}
            onChange={(zoomFit) => change({ zoomFit })}
          />
        </div>
      )}
    </Group>
  );
}

/**
 * Where a zoom looks: the recording's frame, small, with a box around the part the zoom shows. Drag the box, or
 * press anywhere, to aim it.
 */
function AimPad({ look, zoom, player, onAim }: { look: ScreenLook; zoom: Zoom; player: Player; onAim: (x: number, y: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ratio = player.ratio() || 16 / 9;

  useEffect(() => {
    let last = 0;
    const draw = () => {
      const now = performance.now();
      if (now - last < 200) return; // a playing recording redraws the pad five times a second at most
      const c = canvas.current;
      const ctx = c?.getContext("2d", { alpha: false });
      if (c && ctx && player.drawSource(ctx)) last = now;
    };
    draw();
    return player.onFrame(draw);
  }, [player]);

  // the box is the part of the recording the zoom shows, worked out the way the picture itself is laid out (a
  // window that grows with the zoom shows more than 1/depth of each side)
  const out = outputSize(look.shape, ratio * 1000, 1000, false);
  const view = zoomView(look, zoom, ratio * 1000, 1000, out.width, out.height);

  const aimAt = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    onAim(
      Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000) / 1000,
      Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 1000) / 1000,
    );
  };
  const press = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    aimAt(e, el);
    const move = (ev: PointerEvent) => aimAt(ev, el);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div className="space-y-2">
      <div className="text-xs text-zinc-400">Where it looks</div>
      <div
        onPointerDown={press}
        className="relative cursor-crosshair touch-none overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
        style={{ aspectRatio: `${ratio}`, maxHeight: 220 }}
      >
        <canvas ref={canvas} width={560} height={Math.round(560 / ratio)} className="h-full w-full opacity-70" />
        <div
          className="pointer-events-none absolute rounded-sm border-2 border-violet-400 bg-violet-400/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
          style={{ left: `${view.x * 100}%`, top: `${view.y * 100}%`, width: `${view.w * 100}%`, height: `${view.h * 100}%` }}
        />
      </div>
    </div>
  );
}

const LAYOUTS: { id: CameraLook["layout"]; label: string }[] = [
  { id: "bubble", label: "Bubble" },
  { id: "side", label: "Beside" },
  { id: "only", label: "Alone" },
  { id: "hidden", label: "Hidden" },
];

const CORNERS: { id: CameraLook["corner"]; label: string }[] = [
  { id: "tl", label: "Top left" },
  { id: "tr", label: "Top right" },
  { id: "bl", label: "Bottom left" },
  { id: "br", label: "Bottom right" },
];

function CameraTab({ look, change }: { look: ScreenLook; change: (patch: Partial<ScreenLook>) => void }) {
  const cam = look.camera ?? defaultCamera();
  const set = (patch: Partial<CameraLook>) => change({ camera: { ...cam, ...patch } });
  return (
    <Group>
      <Segmented label="Where the camera is" value={cam.layout} options={LAYOUTS} onChange={(layout) => set({ layout })} />
      {cam.layout === "bubble" && (
        <>
          <SliderRow label="Size" value={cam.size} min={0.12} max={0.4} step={0.01} format={pct} initial={defaultCamera().size} onChange={(size) => set({ size })} />
          <div className="flex items-center justify-between text-xs text-zinc-400">
            Corner
            <div role="radiogroup" aria-label="The bubble's corner" className="grid grid-cols-2 gap-1">
              {CORNERS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={cam.corner === c.id}
                  aria-label={c.label}
                  title={c.label}
                  onClick={() => set({ corner: c.id })}
                  className={cn("h-5 w-8 rounded", cam.corner === c.id ? "bg-violet-500" : "bg-zinc-800 hover:bg-zinc-700")}
                />
              ))}
            </div>
          </div>
          <Segmented
            label="The bubble's shape"
            value={cam.shape}
            options={[
              { id: "circle", label: "Circle" },
              { id: "rounded", label: "Rounded" },
            ]}
            onChange={(shape) => set({ shape })}
          />
        </>
      )}
      {cam.layout !== "hidden" && <SwitchRow label="Mirror" checked={cam.mirror} onChange={(mirror) => set({ mirror })} />}
    </Group>
  );
}
