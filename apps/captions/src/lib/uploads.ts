/**
 * Resumable uploads from the browser (the client half of api/lib/uploads.ts):
 * 16 MB parts sent in parallel with retries, and a remembered upload id so
 * the same file picks up where it stopped. Used by Clips, Review and the
 * assistant's file drop. `putDirect` sends a bucket library's parts straight
 * to the bucket instead (presigned URLs from the server).
 */

export async function json<T>(res: Response): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
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

/**
 * Sends a file to the bucket in parts, each PUT to its presigned URL (part n is urls[n - 1]), in parallel with retries.
 * Resolves with the part numbers and ETags the bucket returned, which the server needs to finish the upload. The
 * bucket must allow PUT from this origin and expose the ETag header (its CORS setting).
 */
export async function putDirect(
  file: Blob,
  direct: { partSize: number; urls: string[] },
  onProgress: (sent: number) => void,
): Promise<{ number: number; etag: string }[]> {
  const sent = new Map<number, number>();
  const etags: { number: number; etag: string }[] = [];
  const report = () => onProgress([...sent.values()].reduce((sum, n) => sum + n, 0));
  let cursor = 0;
  const worker = async () => {
    while (cursor < direct.urls.length) {
      const n = ++cursor; // part numbers start at 1
      const start = (n - 1) * direct.partSize;
      const chunk = file.slice(start, Math.min(start + direct.partSize, file.size));
      let lastError: unknown;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          const xhr = await xhrSend("PUT", direct.urls[n - 1]!, {}, chunk, (loaded) => {
            sent.set(n, loaded);
            report();
          });
          const etag = xhr.getResponseHeader("ETag");
          if (!etag) throw new Error("The bucket did not return an ETag: its CORS setting must expose ETag");
          etags.push({ number: n, etag });
          sent.set(n, chunk.size);
          report();
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          sent.delete(n);
          report();
          if (attempt < RETRIES - 1) await pause(Math.min(1000 * 2 ** attempt, 30_000));
        }
      }
      if (lastError) throw lastError;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_WORKERS, direct.urls.length) }, worker));
  return etags.sort((a, b) => a.number - b.number);
}

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
  /** The upload's id, as soon as the server has made it (before any part): a message can name the file then. */
  onStart?: (id: string) => void,
  /** Abort: no further part is sent (one already on its way finishes); the upload rejects. */
  signal?: AbortSignal,
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
  onStart?.(init.id);
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
      signal?.throwIfAborted();
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
