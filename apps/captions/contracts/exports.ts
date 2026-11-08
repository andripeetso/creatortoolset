/** Background export job states (api/exports.ts moves between them; the tray in src/lib/exports.ts shows them). */
export const EXPORT_STATUSES = ["queued", "running", "done", "error"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];
