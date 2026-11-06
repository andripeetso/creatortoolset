/**
 * Client side of Clips (api/clips.ts, the /clips page). Recordings live
 * apart from caption projects: capture the screen, then the server
 * transcribes and titles the clip when cloud AI is unlocked.
 */

export interface ClipChapter {
  t: number;
  title: string;
}

export type ClipBlockKind =
  | "takeaways"
  | "actions"
  | "summary"
  | "chapters"
  | "quotes";

export interface ClipBlockItem {
  text: string;
  t?: number;
}

export interface ClipBlock {
  id: ClipBlockKind;
  kind: ClipBlockKind;
  text?: string;
  items?: ClipBlockItem[];
  chapters?: ClipChapter[];
}

export const CLIP_BLOCK_CATALOG: {
  kind: ClipBlockKind;
  label: string;
  hint: string;
}[] = [
  { kind: "takeaways", label: "Takeaways", hint: "What to remember" },
  { kind: "actions", label: "Action plan", hint: "What to do next" },
  { kind: "summary", label: "Summary", hint: "A short recap" },
  { kind: "chapters", label: "Chapters", hint: "Jump through the video" },
  { kind: "quotes", label: "Quotes", hint: "Lines worth keeping" },
];

export interface ClipSession {
  id: string;
  name: string;
  owner?: string;
  duration: number;
  bytes: number;
  mime: string;
  status: "processing" | "ready" | "error";
  progress: number;
  step?: "thumbnail" | "audio" | "transcribe" | "title";
  error?: string;
  summary?: string;
  chapters?: ClipChapter[];
  blocks?: ClipBlock[];
  createdAt: number;
  updatedAt: number;
  hasTranscript: boolean;
  hasThumb: boolean;
  generating?: ClipBlockKind[];
  blockErrors?: Partial<Record<ClipBlockKind, string>>;
}

export function clipChapters(s: ClipSession): ClipChapter[] {
  if (s.chapters?.length) return s.chapters;
  const nested = s.blocks?.find((b) => b.kind === "chapters")?.chapters;
  return nested?.length ? nested : [];
}

export function displayBlocks(s: ClipSession): ClipBlock[] {
  const raw = s.blocks
    ? s.blocks
    : s.summary
      ? [{ id: "summary" as const, kind: "summary" as const, text: s.summary }]
      : [];
  return raw.filter((b) => b.kind !== "chapters");
}

/** Labels for generated sections a viewer can open from a document embed. */
export function clipBlockLabels(s: ClipSession): string[] {
  const out: string[] = [];
  for (const b of displayBlocks(s)) {
    const c = CLIP_BLOCK_CATALOG.find((x) => x.kind === b.kind);
    if (c) out.push(c.label);
  }
  if (clipChapters(s).length) out.push("Chapters");
  return out;
}

export interface ClipWord {
  text: string;
  start: number;
  end: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

/** Split a timed word list into readable paragraphs. */
export function transcriptParagraphs(
  words: ClipWord[],
  chapters: ClipChapter[] = [],
): ClipWord[][] {
  if (!words.length) return [];
  const cuts = chapters.map((c) => c.t).filter((t) => t > 0.5);
  const paras: ClipWord[][] = [];
  let cur: ClipWord[] = [];
  let sentences = 0;
  let cutI = 0;

  const flush = () => {
    if (!cur.length) return;
    paras.push(cur);
    cur = [];
    sentences = 0;
  };

  for (const w of words) {
    while (cutI < cuts.length && w.start >= cuts[cutI]) {
      flush();
      cutI++;
    }
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end >= 1.4 && cur.length >= 6) flush();
    cur.push(w);
    if (SENTENCE_END.test(w.text)) {
      sentences++;
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0);
      if (sentences >= 3 || (sentences >= 2 && chars >= 180) || chars >= 420) {
        flush();
      }
    } else if (cur.length >= 72) {
      flush();
    }
  }
  flush();
  return paras;
}

export interface ClipCaptionCue {
  start: number;
  end: number;
  words: ClipWord[];
}

const CLAUSE_END = /[,;:—–-]["')\]]*$/;

/**
 * Pack timed words into on-screen caption cues: a phrase at a time,
 * breaking on punctuation, pauses, and a short-line budget.
 */
export function clipCaptionCues(words: ClipWord[]): ClipCaptionCue[] {
  if (!words.length) return [];
  const MAX_WORDS = 8;
  const MAX_CHARS = 42;
  const MAX_DUR = 4.2;
  const PAUSE = 0.7;
  const groups: ClipWord[][] = [];
  let current: ClipWord[] = [];
  const flush = () => {
    if (!current.length) return;
    groups.push(current);
    current = [];
  };
  for (const w of words) {
    const prev = current[current.length - 1];
    const dur = current.length ? w.end - current[0].start : 0;
    const chars = current.reduce((n, x) => n + x.text.length + 1, 0);
    if (
      current.length > 0 &&
      ((prev && w.start - prev.end >= PAUSE) ||
        current.length >= MAX_WORDS ||
        chars + w.text.length > MAX_CHARS ||
        dur > MAX_DUR)
    ) {
      flush();
    }
    current.push(w);
    if (SENTENCE_END.test(w.text)) flush();
    else if (CLAUSE_END.test(w.text) && current.length >= 3) flush();
  }
  flush();
  const cues = groups.map((g) => ({
    start: g[0].start,
    end: g[g.length - 1].end + 0.12,
    words: g,
  }));
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].end = Math.min(cues[i].end, cues[i + 1].start - 0.001);
  }
  return cues;
}

export function captionCueAt(
  cues: ClipCaptionCue[],
  t: number,
): ClipCaptionCue | null {
  for (const c of cues) {
    if (t >= c.start && t < c.end) return c;
  }
  return null;
}

export interface ClipsAvailability {
  cloud: boolean;
  ai: boolean;
}

export const isProcessing = (s: ClipSession | null | undefined) =>
  s?.status === "processing";

async function json<T>(res: Response): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

export const getClipsAvailability = () =>
  fetch("/api/clips/availability").then((r) => json<ClipsAvailability>(r));

export const listClips = () =>
  fetch("/api/clips").then((r) => json<ClipSession[]>(r));

export const getClip = (id: string) =>
  fetch(`/api/clips/${id}`).then((r) => json<ClipSession>(r));

export const retryClip = (id: string) =>
  fetch(`/api/clips/${id}/retry`, { method: "POST" }).then((r) =>
    json<ClipSession>(r),
  );

export const renameClip = (id: string, name: string) =>
  fetch(`/api/clips/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then((r) => json<ClipSession>(r));

export const deleteClip = (id: string) =>
  fetch(`/api/clips/${id}`, { method: "DELETE" }).then(() => undefined);

export const getClipTranscript = (id: string) =>
  fetch(`/api/clips/${id}/transcript`).then((r) =>
    json<{ words: ClipWord[]; cleaned?: boolean }>(r),
  );

export const cleanupClipTranscript = (id: string) =>
  fetch(`/api/clips/${id}/cleanup`, { method: "POST" }).then((r) =>
    json<{ words: ClipWord[]; cleaned?: boolean }>(r),
  );

export const restoreClipTranscript = (id: string) =>
  fetch(`/api/clips/${id}/transcript/restore`, { method: "POST" }).then((r) =>
    json<{ words: ClipWord[]; cleaned?: boolean }>(r),
  );

const BLOCK_WAIT_MS = 13 * 60 * 1000;
const BLOCK_POLL_MS = 800;

async function settleBlock(
  id: string,
  kind: ClipBlockKind,
): Promise<ClipSession> {
  const deadline = Date.now() + BLOCK_WAIT_MS;
  for (;;) {
    const s = await getClip(id);
    if (!s.generating?.includes(kind)) {
      const err = s.blockErrors?.[kind];
      if (err) throw new Error(err);
      return s;
    }
    if (Date.now() >= deadline) {
      throw new Error("The AI took too long to answer — try again");
    }
    await new Promise<void>((r) => window.setTimeout(r, BLOCK_POLL_MS));
  }
}

async function requestBlock(
  id: string,
  kind: ClipBlockKind,
  url: string,
  init?: RequestInit,
): Promise<ClipSession> {
  const res = await fetch(url, init);
  const j = (await res.json().catch(() => null)) as
    | (ClipSession & { error?: string })
    | null;
  if (res.status === 202 || (res.status === 409 && j?.error === "Already generating")) {
    return settleBlock(id, kind);
  }
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as ClipSession;
}

export const addClipBlock = (id: string, kind: ClipBlockKind) =>
  requestBlock(id, kind, `/api/clips/${id}/blocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind }),
  });

export const retryClipBlock = (id: string, kind: ClipBlockKind) =>
  requestBlock(id, kind, `/api/clips/${id}/blocks/${kind}/retry`, {
    method: "POST",
  });

export const deleteClipBlock = (id: string, kind: ClipBlockKind) =>
  fetch(`/api/clips/${id}/blocks/${kind}`, { method: "DELETE" }).then((r) =>
    json<ClipSession>(r),
  );

export const reorderClipBlocks = (id: string, order: ClipBlockKind[]) =>
  fetch(`/api/clips/${id}/blocks`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  }).then((r) => json<ClipSession>(r));

export const playClipUrl = (id: string) => `/api/clips/${id}/play`;
export const thumbClipUrl = (id: string) => `/api/clips/${id}/thumb`;

export function downloadClip(s: ClipSession): void {
  const a = document.createElement("a");
  a.href = `/api/clips/${s.id}/download`;
  a.download = "";
  a.click();
}

const PART_BYTES = 16 * 1024 * 1024;
const PARALLEL_WORKERS = 6;
const RETRIES = 10;

const pause = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** One upload request with progress (our parts, Review's pieces to the video store).
 *  Aborts after 45 s without progress; resolves with the finished request. */
export function xhrSend(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: Blob,
  onProgress: (loaded: number) => void,
): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = "json";
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    const STALL_MS = 45_000;
    let stallTimer = window.setTimeout(() => xhr.abort(), STALL_MS);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(() => xhr.abort(), STALL_MS);
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      window.clearTimeout(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr);
      else {
        const resp = xhr.response as { error?: string } | null;
        reject(new Error(resp?.error || `Part upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      window.clearTimeout(stallTimer);
      reject(new Error("Network error during part upload"));
    };
    xhr.onabort = () => {
      window.clearTimeout(stallTimer);
      reject(new Error("Part upload stalled — retrying"));
    };
    xhr.send(body);
  });
}

const postClipPart = (
  base: string,
  id: string,
  partNumber: number,
  chunk: Blob,
  partSize: number,
  total: number,
  onProgress: (loaded: number) => void,
) =>
  xhrSend(
    "POST",
    `${base}/${id}/parts/${partNumber}`,
    {
      "Upload-Part-Size": String(partSize),
      "Upload-Length": String(total),
      "Content-Type": "application/octet-stream",
    },
    chunk,
    onProgress,
  );

export const uploadClip = (
  file: Blob,
  name: string,
  mime: string,
  onProgress: (pct: number) => void,
) =>
  chunkedUpload<ClipSession>(
    "/api/clips",
    "/api/clips/init",
    file,
    { name, mime },
    onProgress,
  );

/** An earlier try at this exact upload the server still holds parts of
 *  (GET <base>/<id>/parts, where the route exists). */
async function resumable(base: string, key: string): Promise<{ id: string; partSize: number; parts: number[] } | null> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!id) return null;
  const res = await fetch(`${base}/${id}/parts`).catch(() => null);
  const j = res?.ok ? await res.json().catch(() => null) : null;
  if (!Array.isArray(j?.parts) || !j.partSize) return null;
  return { id, partSize: j.partSize as number, parts: j.parts as number[] };
}

const remember = (key: string, id: string | null) => {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    // private window: no resume, the upload still works
  }
};

/** Parallel, retried 16 MB parts: POST init, <base>/<id>/parts/<n>, <base>/<id>/complete.
 *  Uploading the same file again after a failure or a closed tab resumes it. */
export async function chunkedUpload<T>(
  base: string,
  initUrl: string,
  file: Blob,
  fields: Record<string, string>,
  onProgress: (pct: number) => void,
): Promise<T> {
  const key = `upload:${initUrl}:${file.size}:${file instanceof File ? file.lastModified : ""}:${JSON.stringify(fields)}`;
  const resumed = await resumable(base, key);
  const init: { id: string; partSize: number } =
    resumed ??
    (await fetch(initUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, size: file.size }),
    }).then((r) => json<{ id: string; partSize: number }>(r)));
  remember(key, init.id);
  const partSize = init.partSize || PART_BYTES;
  const totalParts = Math.ceil(file.size / partSize);
  const progress = new Map<number, number>();
  const updateProgress = () => {
    const bytes = [...progress.values()].reduce((sum, n) => sum + n, 0);
    onProgress(Math.min(99, Math.round((bytes / file.size) * 100)));
  };
  const have = new Set(resumed?.parts);
  for (const n of have) progress.set(n, Math.min(partSize, file.size - (n - 1) * partSize));
  updateProgress();
  const pending = Array.from({ length: totalParts }, (_, i) => i + 1).filter((n) => !have.has(n));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const partNumber = pending[cursor++];
      const start = (partNumber - 1) * partSize;
      const chunk = file.slice(start, Math.min(start + partSize, file.size));
      let lastError: unknown;
      // ~2.5 min of backoff: a Wi-Fi drop or a sleeping laptop shouldn't end the upload
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          await postClipPart(
            base,
            init.id,
            partNumber,
            chunk,
            partSize,
            file.size,
            (loaded) => {
              progress.set(partNumber, loaded);
              updateProgress();
            },
          );
          progress.set(partNumber, chunk.size);
          updateProgress();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          progress.delete(partNumber);
          updateProgress();
          if (attempt < RETRIES - 1) await pause(Math.min(1000 * 2 ** attempt, 30_000));
        }
      }
      if (lastError) throw lastError;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_WORKERS, pending.length) }, worker),
  );
  onProgress(99);
  const done = await fetch(`${base}/${init.id}/complete`, {
    method: "POST",
  }).then((r) => json<T>(r));
  remember(key, null);
  onProgress(100);
  return done;
}
