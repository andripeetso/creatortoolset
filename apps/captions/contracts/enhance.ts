/** Audio Enhancer session states: api/enhance.ts moves between them, the /enhance page shows them. needs_key = waiting for the engine's key (Settings → API keys). */
export const ENHANCE_STATUSES = ["ready", "queued", "running", "done", "error", "needs_key"] as const;
export type EnhanceStatus = (typeof ENHANCE_STATUSES)[number];
