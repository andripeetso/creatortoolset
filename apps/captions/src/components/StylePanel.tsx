import { useEffect, useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  SlidersHorizontal,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { useStudio } from "@/lib/store";
import { useMe } from "@/lib/auth";
import { PublishButton } from "@/components/community/PublishDialog";
import { posSegmentAt } from "@/lib/captions";
import {
  usePresets,
  type ServerPreset,
  type TextPresetPatch,
} from "@/lib/presets";
import {
  DEFAULT_STYLE,
  FONT_OPTIONS,
  STYLE_PRESETS,
  TEXT_PRESETS,
} from "@/lib/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Label + switch, the shape every on/off row in this panel uses. */
function ToggleRow({
  label,
  on,
  onChange,
  hint,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <span className="min-w-0 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
        {hint && (
          <span className="ml-1 normal-case tracking-normal text-zinc-600">{hint}</span>
        )}
      </span>
      <button
        onClick={() => onChange(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          on ? "bg-violet-600" : "bg-zinc-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
            on ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  disabled = false,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2 ${
        disabled ? "cursor-not-allowed opacity-40" : ""
      }`}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full min-w-0 flex-1 accent-violet-500 disabled:cursor-not-allowed"
      />
      <span className="w-9 shrink-0 text-right font-mono text-[11px] text-zinc-400">
        {format ? format(value) : value}
      </span>
    </div>
  );
}

function ColorInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      type="color"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 w-10 cursor-pointer rounded border border-zinc-700 bg-zinc-800 p-0.5"
    />
  );
}

const selectCls =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-violet-500";

/** Figma-style labeled number field — commits on Enter/blur. */
function NumField({
  label,
  value,
  onCommit,
  step = 1,
  precision = 0,
  suffix = "",
  disabled = false,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  precision?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (!Number.isNaN(v)) onCommit(v);
    setDraft(null);
  };
  // ↑/↓ steps the value live (Shift = ×10), like Figma
  const bump = (dir: 1 | -1, mult: number) => {
    const cur = draft !== null ? Number(draft) : value;
    onCommit((Number.isNaN(cur) ? value : cur) + dir * step * mult);
    setDraft(null);
  };
  // dragging the label scrubs the value (Shift = ×10)
  const scrub = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    const startX = e.clientX;
    const startV = value;
    const onMove = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : 1;
      onCommit(startV + Math.round((ev.clientX - startX) / 2) * step * mult);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  return (
    <label
      className={`flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 ${
        disabled ? "cursor-not-allowed opacity-40" : ""
      }`}
    >
      <span
        onPointerDown={scrub}
        title={disabled ? undefined : "Drag to change"}
        className={`shrink-0 select-none text-[10px] font-medium uppercase text-zinc-500 ${
          disabled ? "" : "cursor-ew-resize hover:text-zinc-300"
        }`}
      >
        {label}
      </span>
      <input
        type="number"
        step={step}
        value={draft ?? value.toFixed(precision)}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(null);
          if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(1, e.shiftKey ? 10 : 1);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(-1, e.shiftKey ? 10 : 1);
          }
        }}
        className="w-full min-w-0 bg-transparent text-xs text-zinc-200 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      {suffix && (
        <span className="shrink-0 text-[10px] text-zinc-500">{suffix}</span>
      )}
    </label>
  );
}

/** Small square icon button for the Position rows (Figma-style centering). */
function CenterBtn({
  axis,
  onClick,
}: {
  axis: "h" | "v";
  onClick: () => void;
}) {
  const Icon = axis === "h" ? AlignCenterHorizontal : AlignCenterVertical;
  return (
    <button
      onClick={onClick}
      title={axis === "h" ? "Center horizontally" : "Center vertically"}
      className="flex h-[26px] w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Preset chips: built-ins (shadowed by same-named global presets),
 * server presets (global + the account's own), a delete × where
 * allowed, and an inline save-current-style flow. Admin saves are
 * global for everyone; user saves stay on the account.
 */
function PresetRow({
  kind,
  builtins,
  active,
  applyServer,
  styleToSave,
}: {
  kind: "caption" | "text";
  builtins: { name: string; apply: () => void }[];
  active: string | null;
  applyServer: (p: ServerPreset) => void;
  styleToSave: () => Record<string, unknown>;
}) {
  const presets = usePresets((s) => s.presets);
  const loaded = usePresets((s) => s.loaded);
  const refresh = usePresets((s) => s.refresh);
  const save = usePresets((s) => s.save);
  const remove = usePresets((s) => s.remove);
  const me = useMe();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const server = presets.filter((p) => p.kind === kind);
  const shadowed = new Set(
    server
      .filter((p) => p.scope === "global")
      .map((p) => p.name.toLowerCase())
  );
  const shownBuiltins = builtins.filter(
    (b) => !shadowed.has(b.name.toLowerCase())
  );
  const canDelete = (p: ServerPreset) =>
    me?.role === "admin" || p.owner === me?.username;

  const activeCls =
    "border-violet-500 bg-violet-500/20 text-violet-200";
  const idleCls =
    "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200";

  const doSave = async () => {
    const n = name.trim();
    if (!n) return;
    await save(n, kind, styleToSave());
    setNaming(false);
    setName("");
  };

  return (
    <Row label="Presets">
      <div className="flex flex-wrap items-center gap-1.5">
        {shownBuiltins.map((b) => (
          <button
            key={b.name}
            onClick={b.apply}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              active === b.name ? activeCls : idleCls
            }`}
          >
            {b.name}
          </button>
        ))}
        {server.map((p) => (
          <span
            key={p.id}
            className={`flex items-center overflow-hidden rounded-full border text-[11px] transition-colors ${
              active === p.name ? activeCls : idleCls
            }`}
          >
            <button
              onClick={() => applyServer(p)}
              title={
                p.scope === "global"
                  ? `Global preset (everyone) · by ${p.owner}`
                  : "Your preset"
              }
              className="py-1 pl-2.5 pr-1"
            >
              {p.name}
            </button>
            {p.owner === me?.username && p.scope !== "global" && (
              <span className="py-1 pl-0.5 pr-0.5 text-zinc-500 hover:text-violet-300">
                <PublishButton item={{ kind: "captionStyle", id: p.id, defaultName: p.name }} compact className="flex items-center" />
              </span>
            )}
            {canDelete(p) ? (
              <button
                onClick={() => void remove(p.id)}
                title="Delete preset"
                className="py-1 pl-0.5 pr-1.5 text-zinc-500 hover:text-red-400"
              >
                <X className="h-3 w-3" />
              </button>
            ) : (
              <span className="pr-1.5" />
            )}
          </span>
        ))}
        {naming ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSave();
                if (e.key === "Escape") {
                  setNaming(false);
                  setName("");
                }
              }}
              placeholder="Preset name"
              className="w-24 rounded-full border border-zinc-600 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-200 outline-none"
            />
            <button
              onClick={() => void doSave()}
              className="rounded-full border border-zinc-600 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
            >
              Save
            </button>
          </span>
        ) : (
          <button
            onClick={() => setNaming(true)}
            title={
              me?.role === "admin"
                ? "Save the current style as a preset for everyone (same name overrides an existing one)"
                : "Save the current style as a preset on your account"
            }
            className="rounded-full border border-dashed border-zinc-600 px-2.5 py-1 text-[11px] text-zinc-500 hover:border-zinc-400 hover:text-zinc-300"
          >
            + Save
          </button>
        )}
      </div>
    </Row>
  );
}

/** Shown instead of the caption style while a text overlay is selected. */
function TextStylePanel() {
  const texts = useStudio((s) => s.texts);
  const selectedTextId = useStudio((s) => s.selectedTextId);
  const updateText = useStudio((s) => s.updateText);
  const deleteText = useStudio((s) => s.deleteText);
  const videoWidth = useStudio((s) => s.sourceWidth || s.videoWidth);
  const videoHeight = useStudio((s) => s.sourceHeight || s.videoHeight);
  const duration = useStudio((s) => s.duration);
  const t = texts.find((x) => x.id === selectedTextId);
  if (!t) return null;

  return (
    <div className="flex h-full w-64 flex-col border-l border-zinc-800 bg-zinc-925">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-violet-300">
        <Type className="h-3.5 w-3.5" /> Text style
      </div>
      <div className="flex-1 overflow-x-hidden overflow-y-scroll px-4 py-3">
        <PresetRow
          kind="text"
          active={null}
          builtins={TEXT_PRESETS.map((p) => ({
            name: p.name,
            apply: () => updateText(t.id, p.patch),
          }))}
          applyServer={(p) => updateText(t.id, p.style as TextPresetPatch)}
          styleToSave={() => ({
            fontFamily: t.fontFamily,
            color: t.color,
            outlineColor: t.outlineColor,
            outlineWidth: t.outlineWidth,
            shadowDepth: t.shadowDepth,
            boxEnabled: t.boxEnabled,
            boxColor: t.boxColor,
            sizePct: t.sizePct,
          })}
        />
        <Row label="Text">
          <textarea
            value={t.text}
            rows={3}
            spellCheck={false}
            // the whole typing session is one undo step
            onFocus={() => useStudio.getState().snapshotHistory()}
            onChange={(e) => updateText(t.id, { text: e.target.value })}
            className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-violet-500"
          />
        </Row>
        <Row label="Font">
          <select
            value={t.fontFamily}
            onChange={(e) => updateText(t.id, { fontFamily: e.target.value })}
            className={selectCls}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.label} value={f.family}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Size">
          <Slider
            value={t.sizePct}
            min={0.5}
            max={14}
            step={0.1}
            onChange={(v) => updateText(t.id, { sizePct: v })}
            format={(v) => `${Math.round((v / 100) * videoHeight)}px`}
          />
        </Row>
        <Row label="Position">
          <div className="flex gap-2">
            <NumField
              label="X"
              value={(t.x / 100) * videoWidth}
              onCommit={(v) =>
                updateText(t.id, {
                  x: Math.max(0, Math.min(100, (v / videoWidth) * 100)),
                })
              }
            />
            <NumField
              label="Y"
              value={(t.y / 100) * videoHeight}
              onCommit={(v) =>
                updateText(t.id, {
                  y: Math.max(0, Math.min(100, (v / videoHeight) * 100)),
                })
              }
            />
            <CenterBtn axis="h" onClick={() => updateText(t.id, { x: 50 })} />
            <CenterBtn axis="v" onClick={() => updateText(t.id, { y: 50 })} />
          </div>
        </Row>
        <Row label="Dimensions">
          <div className="flex gap-2">
            <NumField
              label="W"
              value={(t.w / 100) * videoWidth}
              onCommit={(v) =>
                updateText(t.id, {
                  w: Math.max(6, Math.min(100, (v / videoWidth) * 100)),
                })
              }
            />
            <NumField
              label="R"
              suffix="°"
              value={t.rotation}
              onCommit={(v) =>
                updateText(t.id, { rotation: ((v % 360) + 540) % 360 - 180 })
              }
            />
          </div>
        </Row>
        <Row label="Timing">
          <div className="flex gap-2">
            <NumField
              label="In"
              suffix="s"
              precision={2}
              step={0.1}
              value={t.start}
              onCommit={(v) => {
                const d = t.end - t.start;
                const ns = Math.max(0, Math.min(v, duration - 0.1));
                updateText(t.id, {
                  start: ns,
                  end: Math.min(duration, ns + d),
                });
              }}
            />
            <NumField
              label="Dur"
              suffix="s"
              precision={2}
              step={0.1}
              value={t.end - t.start}
              onCommit={(v) =>
                updateText(t.id, {
                  end: Math.min(duration, t.start + Math.max(0.1, v)),
                })
              }
            />
          </div>
        </Row>
        <Row label="Color">
          <ColorInput
            value={t.color}
            onChange={(v) => updateText(t.id, { color: v })}
          />
        </Row>
        {/* the pill replaces the outline while it's on — same as the render */}
        {!t.boxEnabled && (
          <>
            <ToggleRow
              label="Outline"
              on={t.outlineWidth > 0}
              onChange={(on) => updateText(t.id, { outlineWidth: on ? 4 : 0 })}
            />
            {t.outlineWidth > 0 && (
              <div className="grid grid-cols-2 gap-2">
                <Row label="Outline color">
                  <ColorInput
                    value={t.outlineColor}
                    onChange={(v) => updateText(t.id, { outlineColor: v })}
                  />
                </Row>
                <Row label="Outline width">
                  <Slider
                    value={t.outlineWidth}
                    min={0.5}
                    max={12}
                    step={0.5}
                    onChange={(v) => updateText(t.id, { outlineWidth: v })}
                  />
                </Row>
              </div>
            )}
            <Row label="Shadow">
              <Slider
                value={t.shadowDepth}
                min={0}
                max={6}
                step={0.5}
                onChange={(v) => updateText(t.id, { shadowDepth: v })}
              />
            </Row>
          </>
        )}
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Background box
          </span>
          <button
            onClick={() => updateText(t.id, { boxEnabled: !t.boxEnabled })}
            className={`h-5 w-9 rounded-full transition-colors ${
              t.boxEnabled ? "bg-violet-600" : "bg-zinc-700"
            } relative`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                t.boxEnabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        {t.boxEnabled && (
          <Row label="Box color">
            <ColorInput
              value={t.boxColor}
              onChange={(v) => updateText(t.id, { boxColor: v })}
            />
          </Row>
        )}
        <p className="mb-3 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 text-[11px] leading-4 text-zinc-500">
          Double-click the text on the video to type in place — Enter adds a
          line break. Drag it to move, pull the side handles to change the
          wrap width.
        </p>
        <button
          onClick={() => deleteText(t.id)}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete text
        </button>
      </div>
    </div>
  );
}

export function StylePanel() {
  const style = useStudio((s) => s.style);
  const setStyle = useStudio((s) => s.setStyle);
  const applyPreset = useStudio((s) => s.applyPreset);
  const activePreset = useStudio((s) => s.activePreset);
  const textSelected = useStudio((s) => s.selectedTextId !== null);
  // pixel fields speak in ORIGINAL clip pixels, not the preview proxy's
  const videoWidth = useStudio((s) => s.sourceWidth || s.videoWidth);
  const videoHeight = useStudio((s) => s.sourceHeight || s.videoHeight);
  // effective caption box at the playhead (section override or global)
  const effX = useStudio(
    (s) => posSegmentAt(s.posSegments, s.currentTime)?.x ?? s.style.boxX
  );
  const effY = useStudio(
    (s) => posSegmentAt(s.posSegments, s.currentTime)?.y ?? s.style.boxY
  );
  const inSection = useStudio((s) => {
    const seg = posSegmentAt(s.posSegments, s.currentTime);
    return !!seg && seg.x != null;
  });

  /** Write X/Y (video px) to the section under the playhead, else global. */
  const commitBoxPos = (px?: number, py?: number) => {
    const s = useStudio.getState();
    const sw = s.sourceWidth || s.videoWidth;
    const sh = s.sourceHeight || s.videoHeight;
    const seg = posSegmentAt(s.posSegments, s.currentTime);
    const cl = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));
    const x = cl(
      px !== undefined ? (px / sw) * 100 : (seg?.x ?? s.style.boxX),
      s.style.boxW / 2,
      100 - s.style.boxW / 2
    );
    const y = cl(
      py !== undefined ? (py / sh) * 100 : (seg?.y ?? s.style.boxY),
      s.style.boxH / 2,
      100 - s.style.boxH / 2
    );
    if (seg) s.setPosOverride(seg.id, x, y);
    else s.setStyle({ boxX: x, boxY: y });
  };

  if (textSelected) return <TextStylePanel />;

  return (
    <div className="flex h-full w-64 flex-col border-l border-zinc-800 bg-zinc-925">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-zinc-400">
        <SlidersHorizontal className="h-3.5 w-3.5" /> Caption style
      </div>
      <div className="flex-1 overflow-x-hidden overflow-y-scroll px-4 py-3">
        <PresetRow
          kind="caption"
          active={activePreset}
          builtins={STYLE_PRESETS.map((p) => ({
            name: p.name,
            apply: () => applyPreset(p.name, p.style),
          }))}
          applyServer={(p) =>
            applyPreset(p.name, { ...DEFAULT_STYLE, ...p.style })
          }
          styleToSave={() => ({ ...style })}
        />

        <Row label="Position">
          <div className="flex gap-2">
            <NumField
              label="X"
              value={(effX / 100) * videoWidth}
              onCommit={(v) => commitBoxPos(v, undefined)}
            />
            <NumField
              label="Y"
              value={(effY / 100) * videoHeight}
              onCommit={(v) => commitBoxPos(undefined, v)}
            />
            <CenterBtn
              axis="h"
              onClick={() => commitBoxPos(videoWidth / 2, undefined)}
            />
            <CenterBtn
              axis="v"
              onClick={() => commitBoxPos(undefined, videoHeight / 2)}
            />
          </div>
        </Row>
        <Row label="Dimensions">
          <div className="flex gap-2">
            <NumField
              label="W"
              value={(style.boxW / 100) * videoWidth}
              onCommit={(v) =>
                setStyle({
                  boxW: Math.max(15, Math.min(100, (v / videoWidth) * 100)),
                })
              }
            />
            <NumField
              label="H"
              value={(style.boxH / 100) * videoHeight}
              onCommit={(v) =>
                setStyle({
                  boxH: Math.max(4, Math.min(100, (v / videoHeight) * 100)),
                })
              }
            />
          </div>
        </Row>
        {inSection && (
          <p className="-mt-2 mb-3 text-[10px] text-zinc-500">
            position applies to the current caption section
          </p>
        )}

        <Row label="Animation">
          <select
            value={style.animation}
            onChange={(e) =>
              setStyle({ animation: e.target.value as typeof style.animation })
            }
            className={selectCls}
          >
            <option value="karaoke">Karaoke word highlight</option>
            <option value="pop">Pop in</option>
            <option value="fade">Fade</option>
            <option value="none">None</option>
          </select>
        </Row>

        <Row label="Font">
          <select
            value={style.fontFamily}
            onChange={(e) => setStyle({ fontFamily: e.target.value })}
            className={selectCls}
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.family + f.label} value={f.family}>
                {f.label}
              </option>
            ))}
          </select>
        </Row>

        <Row label="Size">
          <Slider
            value={style.fontSizePct}
            min={0.5}
            max={10}
            step={0.1}
            onChange={(v) => setStyle({ fontSizePct: v })}
            format={(v) => `${Math.round((v / 100) * videoHeight)}px`}
          />
        </Row>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <Row label="Text">
            <ColorInput
              value={style.textColor}
              onChange={(v) => setStyle({ textColor: v })}
            />
          </Row>
          <Row label="Highlight">
            <ColorInput
              value={style.highlightColor}
              onChange={(v) => setStyle({ highlightColor: v })}
            />
          </Row>
        </div>

        {/* a background box replaces the outline in both the preview and
            the render, so there's nothing to configure while it's on */}
        {!style.boxEnabled && (
          <>
            <ToggleRow
              label="Outline"
              on={style.outlineWidth > 0}
              onChange={(on) => setStyle({ outlineWidth: on ? 4 : 0 })}
            />
            {style.outlineWidth > 0 && (
              <div className="mb-3 grid grid-cols-2 gap-3">
                <Row label="Outline color">
                  <ColorInput
                    value={style.outlineColor}
                    onChange={(v) => setStyle({ outlineColor: v })}
                  />
                </Row>
                <Row label="Outline width">
                  <Slider
                    value={style.outlineWidth}
                    min={0.5}
                    max={12}
                    step={0.5}
                    onChange={(v) => setStyle({ outlineWidth: v })}
                  />
                </Row>
              </div>
            )}

            <Row label="Shadow">
              <Slider
                value={style.shadowDepth}
                min={0}
                max={8}
                step={0.5}
                onChange={(v) => setStyle({ shadowDepth: v })}
              />
            </Row>
          </>
        )}

        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Background box
          </span>
          <button
            onClick={() => setStyle({ boxEnabled: !style.boxEnabled })}
            className={`h-5 w-9 rounded-full transition-colors ${
              style.boxEnabled ? "bg-violet-600" : "bg-zinc-700"
            } relative`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                style.boxEnabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
        {style.boxEnabled && (
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Row label="Box color">
              <ColorInput
                value={style.boxColor}
                onChange={(v) => setStyle({ boxColor: v })}
              />
            </Row>
            <Row label="Box opacity">
              <Slider
                value={style.boxOpacity}
                min={0.1}
                max={1}
                step={0.05}
                onChange={(v) => setStyle({ boxOpacity: v })}
                format={(v) => `${Math.round(v * 100)}%`}
              />
            </Row>
          </div>
        )}

        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Uppercase
          </span>
          <button
            onClick={() => setStyle({ uppercase: !style.uppercase })}
            className={`h-5 w-9 rounded-full transition-colors ${
              style.uppercase ? "bg-violet-600" : "bg-zinc-700"
            } relative`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                style.uppercase ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>

        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Lowercase
          </span>
          <button
            onClick={() => setStyle({ lowercase: !style.lowercase })}
            className={`h-5 w-9 rounded-full transition-colors ${
              style.lowercase ? "bg-violet-600" : "bg-zinc-700"
            } relative`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                style.lowercase ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
