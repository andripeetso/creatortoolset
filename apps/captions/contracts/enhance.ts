/** Audio Enhancer session states: api/enhance.ts moves between them, the /enhance page shows them. */
export const ENHANCE_STATUSES = ["ready", "queued", "running", "done", "error"] as const;
export type EnhanceStatus = (typeof ENHANCE_STATUSES)[number];
