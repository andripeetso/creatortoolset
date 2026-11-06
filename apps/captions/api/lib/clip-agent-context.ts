/**
 * Agent-readable clip payloads. Shape follows BuilderIO Clips so a pasted
 * /clips/<id> link can be inspected without a browser: context JSON, a
 * timestamped transcript, and JPEG frames at atMs.
 */

export const CLIP_AGENT_CONTEXT_VERSION = 2;
export const AGENT_CONTEXT_ENDPOINT = "/api/agent-context.json";
export const AGENT_TRANSCRIPT_ENDPOINT = "/api/agent-transcript.json";
export const AGENT_FRAME_ENDPOINT = "/api/agent-frame.jpg";
export const CLIPS_WEBMCP_MAX_TRANSCRIPT_SEGMENTS = 50;

const PUBLIC_UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLIP_PAGE = new RegExp(`^/clips/(${PUBLIC_UUID})/?$`, "i");

export type AgentClipReadiness = {
  state: "preparing" | "ready" | "failed";
  retryAfterSeconds: number | null;
  instruction: string | null;
};

export interface AgentTranscriptSegment {
  startMs: number;
  endMs: number;
  timestamp: string;
  range: string;
  text: string;
}

export interface AgentFrameSuggestion {
  atMs: number;
  timestamp: string;
  reason: string;
  url?: string;
}

export interface ClipAgentSource {
  id: string;
  name: string;
  duration: number;
  status: string;
  summary?: string;
  chapters?: { t: number; title: string }[];
  createdAt: number;
  updatedAt: number;
  hasThumb: boolean;
}

export function safeMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function parseTimestampMs(rawAtMs?: string, rawSeconds?: string): number {
  if (rawAtMs) {
    const atMs = Number(rawAtMs);
    return Number.isFinite(atMs) ? safeMs(atMs) : 0;
  }
  if (!rawSeconds) return 0;
  const seconds = Number(rawSeconds);
  return Number.isFinite(seconds) ? safeMs(seconds * 1000) : 0;
}

export function clipIdFromPath(path: string): string | null {
  const pathname = path.split("?")[0] ?? "";
  return CLIP_PAGE.exec(pathname)?.[1] ?? null;
}

export function wantsAgentJson(accept: string | undefined): boolean {
  const types = (accept ?? "")
    .split(",")
    .map((part) => part.split(";")[0]?.trim().toLowerCase() ?? "")
    .filter(Boolean);
  const jsonI = types.findIndex(
    (t) => t === "application/json" || t === "application/agent-native+json",
  );
  if (jsonI < 0) return false;
  const htmlI = types.findIndex((t) => t === "text/html");
  return htmlI < 0 || jsonI < htmlI;
}

export function requestOrigin(
  url: string,
  headers: { get: (name: string) => string | undefined },
): string {
  const host = headers.get("x-forwarded-host") || headers.get("host");
  if (host) {
    const proto =
      headers.get("x-forwarded-proto") ||
      (url.startsWith("https:") ? "https" : "http");
    return `${proto}://${host}`.replace(/\/$/, "");
  }
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export function buildAgentApiUrls(clipId: string, origin = "") {
  const base = origin.replace(/\/$/, "");
  const q = `id=${encodeURIComponent(clipId)}`;
  const contextUrl = `${base}${AGENT_CONTEXT_ENDPOINT}?${q}`;
  const transcriptUrl = `${base}${AGENT_TRANSCRIPT_ENDPOINT}?${q}`;
  const frameBase = `${base}${AGENT_FRAME_ENDPOINT}?${q}`;
  return {
    contextUrl,
    transcriptUrl,
    frameUrlTemplate: `${frameBase}&atMs={timestampMs}`,
    frameUrl: (atMs: number) => `${frameBase}&atMs=${safeMs(atMs)}`,
  };
}

export function getAgentClipReadiness(
  status: string | null | undefined,
): AgentClipReadiness {
  if (status === "processing") {
    return {
      state: "preparing",
      retryAfterSeconds: 15,
      instruction:
        "This clip is still processing. Wait 15 seconds, then fetch agentContextUrl again. Do not request frames or draw conclusions until clip.status is ready.",
    };
  }
  if (status === "error") {
    return {
      state: "failed",
      retryAfterSeconds: null,
      instruction: "This clip failed to process. The transcript or frames may be missing.",
    };
  }
  return {
    state: "ready",
    retryAfterSeconds: null,
    instruction: null,
  };
}

export function formatAgentTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(safeMs(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function wordsToAgentSegments(
  words: { text: string; start: number; end: number }[],
): AgentTranscriptSegment[] {
  const segments: AgentTranscriptSegment[] = [];
  let buf: { text: string; start: number; end: number }[] = [];
  const flush = () => {
    if (!buf.length) return;
    const startMs = safeMs(buf[0].start * 1000);
    const endMs = Math.max(startMs, safeMs(buf[buf.length - 1].end * 1000));
    const start = formatAgentTimestamp(startMs);
    const end = formatAgentTimestamp(endMs);
    segments.push({
      startMs,
      endMs,
      timestamp: start,
      range: `${start}-${end}`,
      text: buf.map((w) => w.text).join(" "),
    });
    buf = [];
  };
  for (const w of words) {
    if (!buf.length) {
      buf.push(w);
      continue;
    }
    const t0 = buf[0].start;
    const tooLong = buf.map((x) => x.text).join(" ").length > 140;
    if (w.start - t0 >= 10 || tooLong) flush();
    buf.push(w);
  }
  flush();
  return segments;
}

function isNearExisting(
  frames: AgentFrameSuggestion[],
  atMs: number,
  minGapMs: number,
): boolean {
  return frames.some((frame) => Math.abs(frame.atMs - atMs) < minGapMs);
}

function addFrame(
  frames: AgentFrameSuggestion[],
  atMs: number,
  reason: string,
  minGapMs: number,
) {
  const normalized = safeMs(atMs);
  if (isNearExisting(frames, normalized, minGapMs)) return;
  frames.push({
    atMs: normalized,
    timestamp: formatAgentTimestamp(normalized),
    reason,
  });
}

export function buildRecommendedFrames({
  durationMs,
  chapters,
  segments,
  maxFrames = 10,
}: {
  durationMs?: number | null;
  chapters?: { startMs: number; title: string }[] | null;
  segments?: AgentTranscriptSegment[] | null;
  maxFrames?: number;
}): AgentFrameSuggestion[] {
  const frames: AgentFrameSuggestion[] = [];
  const duration = safeMs(durationMs ?? 0);
  const minGapMs = duration > 0 ? Math.max(3000, duration / 40) : 3000;

  addFrame(frames, 0, "opening frame", minGapMs);

  for (const chapter of chapters ?? []) {
    if (frames.length >= maxFrames) break;
    addFrame(
      frames,
      chapter.startMs,
      `chapter: ${chapter.title.slice(0, 80)}`,
      minGapMs,
    );
  }

  for (const segment of segments ?? []) {
    if (frames.length >= maxFrames) break;
    addFrame(
      frames,
      segment.startMs,
      `transcript: ${segment.text.slice(0, 80)}`,
      minGapMs,
    );
  }

  if (duration > 0) {
    for (const ratio of [0.25, 0.5, 0.75]) {
      if (frames.length >= maxFrames) break;
      addFrame(
        frames,
        duration * ratio,
        `${Math.round(ratio * 100)}% mark`,
        minGapMs,
      );
    }
  }

  return frames
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, Math.max(0, maxFrames));
}

export function nextAgentTranscriptStartMs(endMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, safeMs(endMs) + 1);
}

export function pageAgentTranscriptSegments(
  segments: AgentTranscriptSegment[],
  window: {
    startMs?: number;
    endMs?: number;
    startIndex?: number;
    maxSegments: number;
  },
) {
  const matching = segments
    .map((segment, segmentIndex) => ({ ...segment, segmentIndex }))
    .filter(
      (segment) =>
        (window.startIndex === undefined ||
          segment.segmentIndex >= window.startIndex) &&
        (window.startMs === undefined || segment.endMs >= window.startMs) &&
        (window.endMs === undefined || segment.startMs <= window.endMs),
    );
  const page = matching.slice(0, window.maxSegments);
  const truncated = matching.length > page.length;
  const last = page[page.length - 1];
  return {
    segments: page.map(({ segmentIndex: _i, ...segment }) => segment),
    truncated,
    ...(truncated && last
      ? {
          nextStartIndex: last.segmentIndex + 1,
          nextStartMs: nextAgentTranscriptStartMs(last.endMs),
        }
      : {}),
  };
}

export function buildAgentDiscoveryPayload({
  recordingId,
  title,
  status,
  agentContextUrl,
}: {
  recordingId: string;
  title: string;
  status: string | null | undefined;
  agentContextUrl: string;
}) {
  const readiness = getAgentClipReadiness(status);
  return {
    type: "agent-native.clip.discovery" as const,
    version: CLIP_AGENT_CONTEXT_VERSION,
    clipId: recordingId,
    title,
    recordingStatus: status ?? "unknown",
    agentReadiness: readiness,
    agentContextUrl,
    instructions:
      readiness.instruction ??
      "Fetch agentContextUrl for the transcript and JPEG frame URLs; this works without a browser. Use apis.transcript for the complete transcript. Fetch recommendedFrames / apis.frame.urlTemplate to SEE the screen, not just read the transcript.",
  };
}

export function discoveryMarkup(origin: string, clipId: string): string {
  const api = buildAgentApiUrls(clipId, origin);
  const payload = buildAgentDiscoveryPayload({
    recordingId: clipId,
    title: "Clip",
    status: "unknown",
    agentContextUrl: api.contextUrl,
  });
  const href = escapeHtmlAttribute(api.contextUrl);
  return `<link rel="alternate" type="application/json" href="${href}" title="Agent-readable clip context"><script type="application/agent-native+json" id="clips-agent-context">${safeJsonForHtml(payload)}</script>`;
}

export function injectClipAgentDiscovery(
  html: string,
  origin: string,
  clipId: string,
): string {
  if (html.includes('id="clips-agent-context"')) return html;
  const markup = discoveryMarkup(origin, clipId);
  if (html.includes("</head>")) return html.replace("</head>", `${markup}</head>`);
  return markup + html;
}

export function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

export function buildPublicAgentContext({
  origin,
  clip,
  words,
}: {
  origin: string;
  clip: ClipAgentSource;
  words: { text: string; start: number; end: number }[];
}) {
  const api = buildAgentApiUrls(clip.id, origin);
  const durationMs = safeMs(clip.duration * 1000);
  const readiness = getAgentClipReadiness(clip.status);
  const clipIsReady = readiness.state === "ready";
  const agentSegments = wordsToAgentSegments(words);
  const chapters = (clip.chapters ?? []).map((ch) => ({
    startMs: safeMs(ch.t * 1000),
    title: ch.title,
  }));
  const suggestedFrames = !clipIsReady
    ? []
    : buildRecommendedFrames({
        durationMs,
        chapters,
        segments: agentSegments,
      }).map((frame) => ({
        ...frame,
        url: api.frameUrl(frame.atMs),
      }));
  const transcriptStatus = words.length
    ? "ready"
    : clip.status === "processing"
      ? "pending"
      : "missing";

  const instructions = [
    ...(readiness.instruction ? [readiness.instruction] : []),
    ...(clipIsReady
      ? [
          "Use transcript.segments for timestamped spoken context.",
          "Use the HTTP URLs in apis for browser-independent access. For complete transcript text, use apis.transcript.",
          "This clip is readable as both text (transcript) and images (JPEG frames) — you can hear AND see it.",
          "To SEE the screen, GET apis.frame.urlTemplate with atMs (returns image/jpeg). Start with recommendedFrames, then fetch additional frames around transcript timestamps that matter for the task.",
        ]
      : []),
    ...(transcriptStatus === "pending"
      ? [
          "The transcript is still pending. Wait 15 seconds and fetch apis.context.url or apis.transcript.url again before telling the user no transcript exists.",
        ]
      : []),
  ];

  return {
    type: "agent-native.clip.context" as const,
    version: CLIP_AGENT_CONTEXT_VERSION,
    instructions,
    clip: {
      id: clip.id,
      title: clip.name,
      description: clip.summary ?? null,
      publicPageUrl: `${origin.replace(/\/$/, "")}/clips/${encodeURIComponent(clip.id)}`,
      thumbnailUrl: clip.hasThumb
        ? `${origin.replace(/\/$/, "")}/api/clips/${encodeURIComponent(clip.id)}/thumb`
        : null,
      durationMs,
      duration: clip.duration ? `${Math.round(clip.duration)}s` : null,
      status: clip.status,
      agentReadiness: readiness,
      createdAt: new Date(clip.createdAt).toISOString(),
      updatedAt: new Date(clip.updatedAt).toISOString(),
    },
    apis: {
      context: { method: "GET", url: api.contextUrl },
      transcript: { method: "GET", url: api.transcriptUrl },
      ...(clipIsReady
        ? {
            frame: {
              method: "GET",
              urlTemplate: api.frameUrlTemplate,
              query: {
                atMs: "Video timestamp in milliseconds. The endpoint returns image/jpeg.",
              },
            },
          }
        : {}),
    },
    transcript: {
      status: transcriptStatus,
      language: null,
      failureReason: null,
      retryAfterSeconds: transcriptStatus === "pending" ? 15 : null,
      fullText: words.map((w) => w.text).join(" "),
      segments: agentSegments,
      segmentCount: agentSegments.length,
    },
    chapters,
    recommendedFrames: suggestedFrames,
  };
}
