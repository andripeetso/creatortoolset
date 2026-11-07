/**
 * Client side of the standalone Audio Enhancer (api/enhance.ts, the
 * /enhance page). Sessions live entirely apart from caption projects:
 * upload any audio/video file — it's enhanced immediately with the picked
 * engine — then A/B the result and download.
 */

/** The engines (api/enhance.ts ENGINES), every result at the same loudness. */
export const ENGINES = [
  { key: "nvidia", label: "NVIDIA", name: "NVIDIA Studio Voice", hint: "Rebuilds a full, studio-quality voice" },

  { key: "elevenlabs", label: "ElevenLabs", name: "ElevenLabs Voice Isolator", hint: "Strips noise and music, keeps the voice as it is" },
] as const;
export type Engine = (typeof ENGINES)[number]["key"];
export const engineLabel = (e?: string) => ENGINES.find((x) => x.key === e)?.label ?? e ?? "";
/** "ElevenLabs → NVIDIA" for a session run in two passes. */
export const chainLabel = (s: Pick<EnhanceSession, "engine" | "chain">) =>
  (s.chain?.length ? s.chain : s.engine ? [s.engine] : []).map(engineLabel).join(" → ");

export interface EnhanceSession {
  id: string;
  name: string;
  owner?: string;
  hasVideo: boolean;
  duration: number;
  bytes: number;
  status: "ready" | "queued" | "running" | "done" | "error";
  engine?: string;

  /** the passes in order (admins: a second one); step = the one running */
  chain?: Engine[];
  step?: number;
  /** the strength picked: the result's share against the original, 0..1 */
  mix?: number;
  progress: number; // 0..1
  error?: string;
  videoOutExt?: "mp4" | "mkv";
  createdAt: number;
  updatedAt: number;
  hasEnhanced: boolean;
}

export interface EnhanceAvailability {
  /** A key serves this account for the engine (their own from Settings → My API keys, or the server's)? */
  nvidia: boolean;
  elevenlabs: boolean;
  /** Why not, per engine: the key to add */
  why?: Partial<Record<Engine, string>>;

  default: Engine;
  /** may add a second pass */
  admin: boolean;
  /** guest mode's limits, null for accounts */
  guest: { maxSeconds: number; maxBytes: number; keepMinutes: number } | null;
}

export const isEnhancing = (s: EnhanceSession | null | undefined) =>
  s?.status === "queued" || s?.status === "running";

async function json<T>(res: Response): Promise<T> {
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

export const getAvailability = () =>
  fetch("/api/enhance/availability").then((r) => json<EnhanceAvailability>(r));

export const listEnhance = () =>
  fetch("/api/enhance").then((r) => json<EnhanceSession[]>(r));

export const getEnhance = (id: string) =>
  fetch(`/api/enhance/${id}`).then((r) => json<EnhanceSession>(r));

/** ?engine= and, for admins, ?then= (a second pass). */
const passes = (engine: Engine, then?: Engine | null) =>
  `engine=${engine}${then && then !== engine ? `&then=${then}` : ""}`;

export const runEnhance = (id: string, engine: Engine, then?: Engine | null) =>
  fetch(`/api/enhance/${id}/run?${passes(engine, then)}`, {
    method: "POST",
  }).then((r) => json<EnhanceSession>(r));

export const cancelEnhance = (id: string) =>
  fetch(`/api/enhance/${id}/cancel`, { method: "POST" }).then((r) =>
    json<EnhanceSession>(r),
  );

export const deleteEnhance = (id: string) =>
  fetch(`/api/enhance/${id}`, { method: "DELETE" }).then(() => undefined);

export const playUrl = (id: string, which: "original" | "enhanced") =>
  `/api/enhance/${id}/play?which=${which}`;

export const setEnhanceMix = (id: string, mix: number) =>
  fetch(`/api/enhance/${id}/mix`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mix }),
  }).then((r) => json<EnhanceSession>(r));

/** The result at the strength picked (under 100 %: blended with the original on the server). */
export function downloadEnhanced(
  s: EnhanceSession,
  kind: "audio" | "video",
  mix = 1,
): void {
  const a = document.createElement("a");
  a.href = `/api/enhance/${s.id}/download?mix=${mix}${kind === "video" ? "&kind=video" : ""}`;
  a.download = "";
  a.click();
}

/**
 * Upload with progress (fetch can't report it). The server extracts a
 * playable copy of the audio before responding, so the promise resolves
 * a moment after the last byte.
 */
export function uploadEnhance(
  file: File,
  engine: Engine,
  then: Engine | null,
  onProgress: (pct: number) => void,
): Promise<EnhanceSession> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/enhance?name=${encodeURIComponent(file.name)}&${passes(engine, then)}`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const resp = xhr.response as EnhanceSession | { error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && resp && "id" in resp) {
        resolve(resp);
      } else {
        reject(
          new Error(
            (resp as { error?: string })?.error ||
              `Upload failed (${xhr.status})`,
          ),
        );
      }
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.send(file);
  });
}
