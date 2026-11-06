import { z } from "zod";
import { editOptionsSchema, type EditOptions } from "./clean-edit";
import type { CleanupAudit } from "./clean-inspection";
export const batchRequestSchema = z
  .object({
    items: z
      .array(
        z
          .object({ sourceId: z.string().uuid(), options: editOptionsSchema })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.sourceId)).size === v.items.length,
    "Select each video once.",
  );
export interface BatchResult {
  sourceId: string;
  filename: string;
  bytes: number;
  md5: string;
  options: EditOptions;
  audit: CleanupAudit;
}
export interface CleanBatch {
  id: string;
  state: "processing" | "packing" | "ready" | "failed" | "cancelled";
  completed: number;
  total: number;
  currentName?: string;
  error?: string;
  bytes?: number;
  results: BatchResult[];
  expiresAt: number;
}
