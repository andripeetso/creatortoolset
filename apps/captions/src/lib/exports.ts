import { create } from "zustand";
import type { CaptionRenderSpec } from "./types";
import type { ExportStatus } from "@contracts/exports";
import { onTopic } from "./sync";

/**
 * Client side of background exports. Jobs render on the server, so they
 * survive reloads and closed tabs; this store reads /api/exports again whenever the server says exports changed
 * (lib/sync.ts: a render's progress, its end) and drives the bottom-right tray. Finished files
 * auto-download once (when the completion happens live) and stay
 * re-downloadable until server retention removes them.
 */

export interface ExportJob {
  id: string;
  kind: "burn" | "overlay";
  engine?: "native" | "wysiwyg";
  format: string;
  ext: string;
  filename: string;
  status: ExportStatus;
  progress: number;
  note?: string;
  error?: string;
  bytes?: number;
  createdAt: number;
  finishedAt?: number;
}

/** Still changing on the server: rendering. */
const isActive = (j: ExportJob) => j.status === "queued" || j.status === "running";

export const FORMAT_LABELS: Record<string, string> = {
  h264: "MP4 · H.264",
  h265: "MP4 · H.265",
  mov: "MOV · ProRes 4444",
  webm: "WebM · VP9",
  png: "PNG sequence",
};

export function fmtBytes(n: number): string {
  return `${(n / 1e6).toFixed(n < 10e6 ? 1 : 0)} MB`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const DISMISSED_KEY = "cap-export-dismissed";

function loadDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface ExportsState {
  jobs: ExportJob[];
  dismissed: string[];
  loadedOnce: boolean;
}

export const useExports = create<ExportsState>(() => ({
  jobs: [],
  dismissed: loadDismissed(),
  loadedOnce: false,
}));

export function downloadExport(job: ExportJob): void {
  const a = document.createElement("a");
  a.href = `/api/exports/${job.id}/file`;
  a.download = job.filename;
  a.click();
}

/** Several finished exports as one ZIP download (one export: the file itself). */
export function downloadExportsZip(jobs: ExportJob[], name = "exports"): void {
  if (jobs.length === 1) return downloadExport(jobs[0]);
  const a = document.createElement("a");
  a.href = `/api/exports/zip?ids=${jobs.map((j) => j.id).join(",")}&name=${encodeURIComponent(name)}`;
  a.download = `${name}.zip`;
  a.click();
}

/**
 * Exports started together (a batch export) download once, as one ZIP, when the last of them is done
 *.
 */
const batches: { ids: string[]; name: string }[] = [];
export function batchExports(ids: string[], name: string): void {
  if (ids.length > 1) batches.push({ ids, name });
}

let refreshing = false;
let againAfter = false;

async function refresh(): Promise<void> {
  if (refreshing) {
    againAfter = true; // a notice during a read: read once more after it
    return;
  }
  refreshing = true;
  try {
    const res = await fetch("/api/exports");
    if (!res.ok) return;
    const next: ExportJob[] = await res.json();
    const prev = useExports.getState().jobs;

    // a job we watched go running → done finishes live: download it once
    for (const j of next) {
      const before = prev.find((p) => p.id === j.id);
      if (
        j.status === "done" &&
        before &&
        (before.status === "queued" || before.status === "running") &&
        !batches.some((b) => b.ids.includes(j.id))
      ) {
        downloadExport(j);
      }
    }
    for (const b of [...batches]) {
      const of = b.ids.map((id) => next.find((j) => j.id === id));
      if (of.some((j) => j && isActive(j))) continue;
      batches.splice(batches.indexOf(b), 1);
      const done = of.filter((j): j is ExportJob => j?.status === "done");
      if (done.length) downloadExportsZip(done, b.name);
    }

    // drop dismissed ids whose jobs no longer exist (retention cleaned up)
    const alive = new Set(next.map((j) => j.id));
    const dismissed = useExports.getState().dismissed.filter((id) => alive.has(id));
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));

    useExports.setState({ jobs: next, dismissed, loadedOnce: true });
  } catch {
    /* transient network error — the next change notice reads again */
  } finally {
    refreshing = false;
    if (againAfter) {
      againAfter = false;
      void refresh();
    }
  }
}

/** Fetch now and follow every change from then on (straight away, not when shown: a finished render downloads). */
let watching = false;
export function watchExports(): void {
  void refresh();
  if (watching) return;
  watching = true;
  onTopic("exports", () => void refresh());
}

/** Kick off a background export; resolves with the accepted job. */
export async function startExport(payload: {
  kind: "burn" | "overlay";
  /**
   * native: server renders the ASS document with libass (fast, no
   * browser needed). wysiwyg: headless Chromium captures the DOM
   * surface per frame (pixel-exact, slower). Server defaults to native.
   */
  engine?: "native" | "wysiwyg";
  /** ASS document for the native engine (built with buildAss). */
  ass?: string;
  format: string;
  name: string;
  duration: number;
  projectId?: string;
  clipId?: string;
  width?: number;
  height?: number;
  fps?: number;
  renderSpec?: CaptionRenderSpec;
  /** burn only: the server sends the render to the owner's Finals when it is done */
  finals?: boolean;
}): Promise<ExportJob> {
  const res = await fetch("/api/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error || `Export failed (${res.status})`);
  }
  const job: ExportJob = await res.json();
  useExports.setState((s) => ({ jobs: [job, ...s.jobs.filter((x) => x.id !== job.id)] }));
  watchExports();
  return job;
}

/** Hide a finished job from the tray; the file stays on the server. */
/** A finished export into the Media Library (the workspace's first library). Says what happened, or throws. */
export async function saveExportToLibrary(id: string): Promise<"saved" | "already"> {
  const res = await fetch(`/api/exports/${id}/library`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const data = (await res.json().catch(() => ({}))) as { error?: string; duplicateOf?: string };
  if (!res.ok) throw new Error(data.error || "Couldn't save it to the library");
  return data.duplicateOf ? "already" : "saved";
}

export function dismissExport(id: string): void {
  const dismissed = [...useExports.getState().dismissed, id];
  localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
  useExports.setState({ dismissed });
}

/** Cancel a render in progress (or delete a finished file). */
export async function cancelExport(id: string): Promise<void> {
  useExports.setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  await fetch(`/api/exports/${id}`, { method: "DELETE" }).catch(() => {});
}
