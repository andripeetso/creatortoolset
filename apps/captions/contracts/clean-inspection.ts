import { z } from "zod";

export const cleanupSchema = z
  .object({
    location: z.boolean().default(true),
    device: z.boolean().default(true),
    dates: z.boolean().default(true),
    credits: z.boolean().default(true),
    description: z.boolean().default(true),
    other: z.boolean().default(true),
  })
  .strict();
export type CleanupPolicy = z.infer<typeof cleanupSchema>;
export type MetadataCategory = keyof CleanupPolicy;
export const FULL_CLEANUP: CleanupPolicy = cleanupSchema.parse({});
export const CLEANUP_LABELS: Record<MetadataCategory, string> = {
  location: "Location & GPS",
  device: "Camera, device & software",
  dates: "Dates & timestamps",
  credits: "Author & copyright",
  description: "Titles, descriptions & comments",
  other: "Other native tags",
};
export const CLEANUP_PRESETS = [
  { id: "privacy", name: "Full privacy", policy: FULL_CLEANUP },
  {
    id: "credits",
    name: "Keep credits",
    policy: { ...FULL_CLEANUP, credits: false },
  },
  {
    id: "descriptive",
    name: "Keep credits & descriptions",
    policy: { ...FULL_CLEANUP, credits: false, description: false },
  },
];
export function cleanupPreset(policy: CleanupPolicy) {
  return (
    CLEANUP_PRESETS.find((p) =>
      Object.keys(FULL_CLEANUP).every(
        (k) =>
          p.policy[k as MetadataCategory] === policy[k as MetadataCategory],
      ),
    )?.id ?? "custom"
  );
}
export interface DeepInspection {
  status: "checked" | "partial" | "unsupported";
  findings: {
    kind: "xmp" | "c2pa" | "unknown";
    where: string;
    bytes: number;
  }[];
  warnings: string[];
}
/** Keys and locations only: an exported audit must never reintroduce stripped private values. */
export interface MetadataInspection {
  native: {
    category: MetadataCategory | "extra";
    where: string;
    key: string;
  }[];
  embedded: DeepInspection;
}
export interface CleanupAudit {
  before: MetadataInspection;
  after: MetadataInspection;
  checkedAt: number;
  rows: {
    category: MetadataCategory | "extra" | "xmp" | "c2pa" | "unknown";
    label: string;
    before: number | null;
    after: number | null;
    remove: boolean;
    status:
      | "removed"
      | "remaining"
      | "kept"
      | "not-retained"
      | "not-found"
      | "unchecked";
  }[];
}
