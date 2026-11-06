import { z } from "zod";
import {
  cleanupSchema,
  FULL_CLEANUP,
  type CleanupAudit,
} from "./clean-inspection";
import type { FingerprintReport } from "./clean-fingerprints";
import type { MetadataItem } from "./clean-workspace";

export const adjustmentsSchema = z
  .object({
    brightness: z.number().min(0.5).max(1.5).default(1),
    contrast: z.number().min(0.5).max(1.5).default(1),
    saturation: z.number().min(0).max(2).default(1),
    crop: z
      .enum(["original", "9:16", "1:1", "4:5", "16:9"])
      .default("original"),
    zoom: z.number().min(1).max(2).default(1),
    panX: z.number().min(-1).max(1).default(0),
    panY: z.number().min(-1).max(1).default(0),
    rotate: z
      .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
      .default(0),
    flipH: z.boolean().default(false),
    flipV: z.boolean().default(false),
    start: z.number().min(0).max(86400).default(0),
    end: z.number().positive().max(86400).nullable().default(null),
    cuts: z
      .array(
        z
          .object({
            start: z.number().min(0).max(86400),
            end: z.number().positive().max(86400),
          })
          .strict()
          .refine(
            (c) => c.end - c.start >= 0.099999,
            "A scene must be at least 0.1 seconds long.",
          ),
      )
      .max(64)
      .default([]),
    speed: z.number().min(0.5).max(2).default(1),
    volume: z.number().min(0).max(1).default(1),
    mute: z.boolean().default(false),
  })
  .strict();
export const editOptionsSchema = z
  .object({
    stripMetadata: z.boolean().default(true),
    unique: z.boolean().default(true),
    cleanup: cleanupSchema.default(FULL_CLEANUP),
    adjustments: adjustmentsSchema,
  })
  .strict();
export type VideoAdjustments = z.infer<typeof adjustmentsSchema>;
export type EditOptions = z.infer<typeof editOptionsSchema>;
export const DEFAULT_ADJUSTMENTS: VideoAdjustments = adjustmentsSchema.parse(
  {},
);
export const DEFAULT_EDIT: EditOptions = {
  stripMetadata: true,
  unique: true,
  cleanup: FULL_CLEANUP,
  adjustments: DEFAULT_ADJUSTMENTS,
};
/** Old presets migrate to full privacy; explicit category choices apply to every export route. */
export function cleanExportOptions(options: EditOptions): EditOptions {
  return editOptionsSchema.parse({ ...options, stripMetadata: true });
}
export const LOOK_PRESETS = [
  { name: "Natural", brightness: 1, contrast: 1, saturation: 1 },
  { name: "Bright", brightness: 1.12, contrast: 1.02, saturation: 1.05 },
  { name: "Vivid", brightness: 1.02, contrast: 1.12, saturation: 1.25 },
  { name: "Soft", brightness: 1.06, contrast: 0.88, saturation: 0.85 },
  { name: "Monochrome", brightness: 1, contrast: 1.12, saturation: 0 },
];
/**
 * Cleaner presets: a look plus the smallest reframe that measured outside the
 * reference ranges on the lab's 8 test videos (docs/VIDEO-CLEANER.md
 * "Presets"). Applying one keeps trim, scenes and audio. The iPhone app reads
 * this list from GET /api/clean/presets.
 */
export const CLEAN_PRESETS: {
  name: string;
  note: string;
  adjustments: Partial<VideoAdjustments>;
}[] = [
  {
    name: "Just clean",
    note: "No picture changes: hidden details removed, file made unique. Every visual check still matches.",
    adjustments: {},
  },
  {
    name: "Light",
    note: "5% zoom kept to the bottom, brighter look. Clears the frame checks (PDQ, vPDQ); the whole-video TMK still matches.",
    adjustments: {
      zoom: 1.05,
      panY: 1,
      brightness: 1.12,
      contrast: 1.02,
      saturation: 1.05,
    },
  },
  {
    name: "Reframe",
    note: "12% zoom kept to the bottom-right corner. Clears PDQ, TMK and vPDQ on vertical videos, nothing mirrored. Landscape clips: crop to 9:16 or use Mirror.",
    adjustments: { zoom: 1.12, panX: 1, panY: 1 },
  },
  {
    name: "Mirror",
    note: "Flipped, 5% zoom kept to the bottom. Clears all three on every video, PDQ even when un-mirrored. Mirrors any text or captions.",
    adjustments: { flipH: true, zoom: 1.05, panY: 1 },
  },
  {
    name: "Strong",
    note: "Flipped, 10% corner zoom, vivid look, 5% faster. The widest margin on every video. Mirrors any text or captions.",
    adjustments: {
      flipH: true,
      zoom: 1.1,
      panX: 1,
      panY: 1,
      speed: 1.05,
      brightness: 1.02,
      contrast: 1.12,
      saturation: 1.25,
    },
  },
];
/** A preset over the current edit: its look and framing, the same trim, scenes and sound. */
export function applyCleanPreset(
  a: VideoAdjustments,
  preset: (typeof CLEAN_PRESETS)[number],
): VideoAdjustments {
  const { start, end, cuts, volume, mute } = a;
  return { ...DEFAULT_ADJUSTMENTS, start, end, cuts, volume, mute, ...preset.adjustments };
}
export interface EditAudit {
  options: EditOptions;
  audit: CleanupAudit;
}
export interface EditMeasurement extends EditAudit {
  options: EditOptions;
  measuredAt: number;
  bytes: number;
  md5: string;
  metadata: MetadataItem[];
  width: number;
  height: number;
  duration: number;
  fingerprints: FingerprintReport;
}
export function cropGeometry(
  width: number,
  height: number,
  a: VideoAdjustments,
) {
  const ratio =
    a.crop === "original"
      ? width / height
      : Number(a.crop.split(":")[0]) / Number(a.crop.split(":")[1]);
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const w = even(Math.min(width, height * ratio) / a.zoom);
  const h = even(Math.min(height, width / ratio) / a.zoom);
  const x = Math.max(0, Math.floor(((width - w) * (a.panX + 1)) / 4) * 2);
  const y = Math.max(0, Math.floor(((height - h) * (a.panY + 1)) / 4) * 2);
  return {
    x,
    y,
    width: w,
    height: h,
    outputWidth: a.rotate % 180 ? h : w,
    outputHeight: a.rotate % 180 ? w : h,
  };
}
export function sameEdit(a: EditOptions, b: EditOptions) {
  return (
    JSON.stringify(editOptionsSchema.parse(a)) ===
    JSON.stringify(editOptionsSchema.parse(b))
  );
}
export function hasAdjustments(a: VideoAdjustments) {
  return Object.entries(DEFAULT_ADJUSTMENTS).some(([key, value]) =>
    key === "cuts"
      ? a.cuts.length > 0
      : a[key as keyof VideoAdjustments] !== value,
  );
}
