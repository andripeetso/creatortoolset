import { useState, type ReactNode } from "react";
import { RotateCcw, Save, Trash2 } from "lucide-react";
import {
  applyCleanPreset,
  CLEAN_PRESETS,
  DEFAULT_ADJUSTMENTS,
  LOOK_PRESETS,
  editOptionsSchema,
  type EditOptions,
  type VideoAdjustments,
} from "@contracts/clean-edit";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CleanCleanupControls } from "./CleanCleanupControls";
import { FULL_CLEANUP } from "@contracts/clean-inspection";

const presetKey = "clean-editor-presets-v1";
interface Preset {
  name: string;
  options: EditOptions;
}
function readPresets(): Preset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(presetKey) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 20).flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const p = item as Preset;
      const parsed = editOptionsSchema.safeParse(p.options);
      return typeof p.name === "string" && parsed.success
        ? [{ name: p.name.slice(0, 40), options: parsed.data }]
        : [];
    });
  } catch {
    return [];
  }
}
export function CleanEditorControls({
  options,
  duration,
  onChange,
}: {
  options: EditOptions;
  duration: number;
  onChange: (value: EditOptions) => void;
}) {
  const a = options.adjustments;
  const update = (value: Partial<VideoAdjustments>) =>
    onChange({ ...options, adjustments: { ...a, ...value } });
  const [presets, setPresets] = useState(readPresets);
  const [name, setName] = useState("");
  const [presetError, setPresetError] = useState("");
  function store(next: Preset[]) {
    try {
      localStorage.setItem(presetKey, JSON.stringify(next));
      setPresets(next);
      setPresetError("");
    } catch {
      setPresetError("This browser could not save the preset.");
    }
  }
  return (
    <aside className="space-y-4">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
        <h2 className="mb-3 text-sm font-semibold">Presets</h2>
        <div className="flex flex-wrap gap-2">
          {CLEAN_PRESETS.map((p) => {
            const active = samePicture(applyCleanPreset(a, p), a);
            return (
              <Tooltip key={p.name} delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onChange({
                        ...options,
                        adjustments: applyCleanPreset(a, p),
                      })
                    }
                    className={`rounded-full border px-3 py-1 text-xs ${active ? "border-violet-500 bg-violet-500/20 text-white" : "border-zinc-700 text-zinc-300 hover:border-violet-500 hover:text-white"}`}
                  >
                    {p.name}
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  sideOffset={6}
                  className="max-w-64 leading-relaxed"
                >
                  {p.note}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <details className="mt-4 text-xs text-zinc-400">
          <summary className="cursor-pointer">
            Your presets · settings only
          </summary>
          <div className="mt-3 flex gap-1">
            <input
              aria-label="Preset name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name this preset"
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 p-2"
            />
            <button
              type="button"
              aria-label="Save preset"
              disabled={!name.trim() || presets.length >= 20}
              onClick={() => {
                store([
                  ...presets.filter((p) => p.name !== name.trim()),
                  {
                    name: name.trim(),
                    options: {
                      ...options,
                      adjustments: { ...a, start: 0, end: null, cuts: [] },
                    },
                  },
                ]);
                setName("");
              }}
              className="rounded border border-zinc-700 px-2 disabled:opacity-40"
            >
              <Save className="h-4 w-4" />
            </button>
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Saved in this browser. Trim points, scenes and videos are not stored
            in presets.
          </p>
          {presetError && (
            <p role="alert" className="mt-2 text-amber-300">
              {presetError}
            </p>
          )}
          {presets.map((p) => (
            <div className="mt-2 flex items-center gap-2" key={p.name}>
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded bg-zinc-800 p-2 text-left"
                onClick={() =>
                  onChange({
                    ...p.options,
                    adjustments: {
                      ...p.options.adjustments,
                      start: a.start,
                      end: a.end,
                      cuts: a.cuts,
                    },
                  })
                }
              >
                {p.name}
              </button>
              <button
                type="button"
                aria-label={`Delete preset ${p.name}`}
                onClick={() =>
                  store(presets.filter((item) => item.name !== p.name))
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </details>
      </section>
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 pt-4">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Adjust your own</h2>
          <button
            type="button"
            onClick={() =>
              onChange({ ...options, adjustments: { ...DEFAULT_ADJUSTMENTS } })
            }
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        </div>
        <Group title="Color" open>
          <p className="mb-2 text-xs text-zinc-500">Look</p>
          <div className="mb-4 flex flex-wrap gap-2">
            {LOOK_PRESETS.map((p) => (
              <button
                type="button"
                key={p.name}
                onClick={() =>
                  update({
                    brightness: p.brightness,
                    contrast: p.contrast,
                    saturation: p.saturation,
                  })
                }
                className="rounded-lg border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-violet-500 hover:text-white"
              >
                {p.name}
              </button>
            ))}
          </div>
          <Slider
            label="Brightness"
            value={a.brightness}
            min={0.5}
            max={1.5}
            step={0.01}
            display={Math.round(a.brightness * 100) + "%"}
            onChange={(brightness) => update({ brightness })}
          />
          <Slider
            label="Contrast"
            value={a.contrast}
            min={0.5}
            max={1.5}
            step={0.01}
            display={Math.round(a.contrast * 100) + "%"}
            onChange={(contrast) => update({ contrast })}
          />
          <Slider
            label="Saturation"
            value={a.saturation}
            min={0}
            max={2}
            step={0.01}
            display={Math.round(a.saturation * 100) + "%"}
            onChange={(saturation) => update({ saturation })}
          />
        </Group>
        <Group title="Crop & orientation" open>
          <label className="mb-4 flex items-center justify-between text-xs text-zinc-400">
            Aspect ratio
            <select
              aria-label="Aspect ratio"
              value={a.crop}
              onChange={(e) =>
                update({ crop: e.target.value as VideoAdjustments["crop"] })
              }
              className="rounded border border-zinc-700 bg-zinc-950 p-1.5"
            >
              {["original", "9:16", "1:1", "4:5", "16:9"].map((ratio) => (
                <option key={ratio} value={ratio}>
                  {ratio === "original" ? "Original" : ratio}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Zoom"
            value={a.zoom}
            min={1}
            max={2}
            step={0.01}
            display={a.zoom.toFixed(2) + "×"}
            onChange={(zoom) => update({ zoom })}
          />
          <Slider
            label="Horizontal position"
            value={a.panX}
            min={-1}
            max={1}
            step={0.01}
            display={Math.round(a.panX * 100) + "%"}
            onChange={(panX) => update({ panX })}
          />
          <Slider
            label="Vertical position"
            value={a.panY}
            min={-1}
            max={1}
            step={0.01}
            display={Math.round(a.panY * 100) + "%"}
            onChange={(panY) => update({ panY })}
          />
          <label className="mb-4 flex items-center justify-between text-xs text-zinc-400">
            Rotation
            <select
              aria-label="Rotation"
              value={a.rotate}
              onChange={(e) =>
                update({
                  rotate: Number(e.target.value) as VideoAdjustments["rotate"],
                })
              }
              className="rounded border border-zinc-700 bg-zinc-950 p-1.5"
            >
              {[0, 90, 180, 270].map((angle) => (
                <option key={angle} value={angle}>
                  {angle}°
                </option>
              ))}
            </select>
          </label>
          <Toggle
            label="Flip horizontally"
            checked={a.flipH}
            onChange={(flipH) => update({ flipH })}
          />
          <Toggle
            label="Flip vertically"
            checked={a.flipV}
            onChange={(flipV) => update({ flipV })}
          />
        </Group>
        <Group title="Trim & speed">
          {!!a.cuts.length && (
            <p className="mb-3 text-xs text-violet-300">
              Use Cuts & scene order to adjust the active scene timeline.
            </p>
          )}
          <div className="mb-4 grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-400">
              Start (s)
              <input
                aria-label="Trim start"
                type="number"
                min={0}
                max={Math.max(0, (a.end ?? duration) - 0.1)}
                step={0.1}
                value={a.start}
                onChange={(e) =>
                  update({
                    start: Math.max(
                      0,
                      Math.min(
                        Number(e.target.value),
                        (a.end ?? duration) - 0.1,
                      ),
                    ),
                  })
                }
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 p-2"
                disabled={!duration || !!a.cuts.length}
              />
            </label>
            <label className="text-xs text-zinc-400">
              End (s)
              <input
                aria-label="Trim end"
                type="number"
                min={a.start + 0.1}
                max={duration}
                step={0.1}
                value={a.end ?? (duration ? Number(duration.toFixed(2)) : "")}
                onChange={(e) =>
                  update({
                    end: e.target.value
                      ? Math.max(
                          a.start + 0.1,
                          Math.min(Number(e.target.value), duration),
                        )
                      : null,
                  })
                }
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-950 p-2"
                disabled={!duration || !!a.cuts.length}
              />
            </label>
          </div>
          <Slider
            label="Playback speed"
            value={Math.round(a.speed * 100)}
            min={90}
            max={110}
            step={1}
            display={Math.round(a.speed * 100) + "%"}
            onChange={(percent) => update({ speed: percent / 100 })}
          />
          <p className="-mt-2 mb-4 text-[11px] text-zinc-500">
            90–110% · 100% is the original speed
          </p>
          {(a.speed < 0.9 || a.speed > 1.1) && (
            <p className="mb-3 text-xs text-amber-300">
              This saved speed is outside the slider’s range. Move the slider to
              choose 90–110%.
            </p>
          )}
          <button
            type="button"
            className="text-xs text-violet-300"
            onClick={() => update({ start: 0, end: null, cuts: [] })}
          >
            Use full video
          </button>
        </Group>
        <Group title="Audio">
          <Toggle
            label="Mute audio"
            checked={a.mute}
            onChange={(mute) => update({ mute })}
          />
          <Slider
            label="Volume"
            value={a.volume}
            min={0}
            max={1}
            step={0.01}
            display={Math.round(a.volume * 100) + "%"}
            onChange={(volume) => update({ volume })}
          />
        </Group>
        <Group title="Metadata & file hash" open>
          <div className="mb-4">
            <CleanCleanupControls
              policy={options.cleanup ?? FULL_CLEANUP}
              onChange={(cleanup) => onChange({ ...options, cleanup })}
            />
          </div>
          <Toggle
            label="Unique file hash"
            checked={options.unique}
            onChange={(unique) => onChange({ ...options, unique })}
          />
          <p className="text-[11px] leading-relaxed text-zinc-500">
            Unique hash adds session-specific file padding. It does not alter
            the picture. Visual edits export as MP4.
          </p>
        </Group>
      </section>
    </aside>
  );
}
/** Same look and framing: whether a preset is the current edit. */
function samePicture(a: VideoAdjustments, b: VideoAdjustments) {
  return Object.keys(DEFAULT_ADJUSTMENTS).every(
    (k) =>
      JSON.stringify(a[k as keyof VideoAdjustments]) ===
      JSON.stringify(b[k as keyof VideoAdjustments]),
  );
}
function Group({
  title,
  open,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={open} className="border-t border-zinc-800 py-4">
      <summary className="cursor-pointer text-xs font-semibold text-zinc-300">
        {title}
      </summary>
      <div className="pt-4">{children}</div>
    </details>
  );
}
function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mb-4 block text-xs text-zinc-400">
      <span className="mb-2 flex justify-between gap-2">
        <span>{label}</span>
        <span className="tabular-nums text-zinc-200">{display}</span>
      </span>
      <input
        aria-label={label}
        aria-valuetext={display}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-500"
      />
    </label>
  );
}
export function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-violet-500"
      />
      {label}
    </label>
  );
}
