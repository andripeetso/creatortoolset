import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthVars } from "./auth";
import {
  clipFramesDir,
  getClipAgentSource,
  getClipRecordingPath,
  loadWords,
  okId,
} from "./clips";
import {
  buildAgentApiUrls,
  buildPublicAgentContext,
  CLIPS_WEBMCP_MAX_TRANSCRIPT_SEGMENTS,
  clipIdFromPath,
  getAgentClipReadiness,
  injectClipAgentDiscovery,
  pageAgentTranscriptSegments,
  parseTimestampMs,
  requestOrigin,
  safeMs,
  wantsAgentJson,
  wordsToAgentSegments,
} from "./lib/clip-agent-context";
import { ClipFrameError, extractClipJpegFrame } from "./lib/clip-frame";

export const clipAgentApp = new Hono<{ Variables: AuthVars }>();

function originOf(c: Context): string {
  return requestOrigin(c.req.url, { get: (name) => c.req.header(name) });
}

function agentJsonHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=30",
  };
}

async function loadPublished(id: string | undefined) {
  if (!id || !okId(id)) return null;
  return getClipAgentSource(id);
}

clipAgentApp.get("/agent-context.json", async (c) => {
  const clip = await loadPublished(c.req.query("id"));
  if (!clip) {
    return c.json({ error: "Not found" }, 404);
  }
  const words = await loadWords(clip.id);
  return c.json(
    buildPublicAgentContext({
      origin: originOf(c),
      clip,
      words,
    }),
    200,
    agentJsonHeaders(),
  );
});

clipAgentApp.get("/agent-transcript.json", async (c) => {
  const clip = await loadPublished(c.req.query("id"));
  if (!clip) {
    return c.json({ error: "Not found" }, 404);
  }
  let startMs: number | undefined;
  let endMs: number | undefined;
  let startIndex: number | undefined;
  let maxSegments: number | undefined;
  try {
    const rawStart = c.req.query("startMs");
    const rawEnd = c.req.query("endMs");
    const rawIndex = c.req.query("startIndex");
    const rawMax = c.req.query("maxSegments");
    if (rawStart) {
      const n = Number(rawStart);
      if (!Number.isFinite(n) || n < 0) throw new Error("startMs");
      startMs = Math.round(n);
    }
    if (rawEnd) {
      const n = Number(rawEnd);
      if (!Number.isFinite(n) || n < 0) throw new Error("endMs");
      endMs = Math.round(n);
    }
    if (rawIndex) {
      const n = Number(rawIndex);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error("startIndex");
      startIndex = n;
    }
    if (rawMax) {
      const n = Number(rawMax);
      if (
        !Number.isInteger(n) ||
        n < 1 ||
        n > CLIPS_WEBMCP_MAX_TRANSCRIPT_SEGMENTS
      ) {
        throw new Error("maxSegments");
      }
      maxSegments = n;
    }
    if (startMs !== undefined && endMs !== undefined && endMs < startMs) {
      throw new Error("endMs");
    }
  } catch {
    return c.json({ error: "Invalid transcript window" }, 400);
  }

  const words = await loadWords(clip.id);
  const agentSegments = wordsToAgentSegments(words);
  const origin = originOf(c);
  const api = buildAgentApiUrls(clip.id, origin);
  const readiness = getAgentClipReadiness(clip.status);
  const clipIsReady = readiness.state === "ready";
  const hasWindow =
    startMs !== undefined ||
    endMs !== undefined ||
    startIndex !== undefined ||
    maxSegments !== undefined;
  const window = hasWindow
    ? {
        startMs,
        endMs,
        startIndex,
        maxSegments: maxSegments ?? CLIPS_WEBMCP_MAX_TRANSCRIPT_SEGMENTS,
      }
    : null;
  const page = window
    ? pageAgentTranscriptSegments(agentSegments, window)
    : null;

  return c.json(
    {
      type: "agent-native.clip.transcript",
      recording: {
        id: clip.id,
        title: clip.name,
        durationMs: safeMs(clip.duration * 1000),
        status: clip.status,
        agentReadiness: readiness,
      },
      apis: {
        context: { method: "GET", url: api.contextUrl },
        transcript: { method: "GET", url: api.transcriptUrl },
        ...(clipIsReady
          ? { frame: { method: "GET", urlTemplate: api.frameUrlTemplate } }
          : {}),
      },
      transcript: {
        status: words.length
          ? "ready"
          : clip.status === "processing"
            ? "pending"
            : "missing",
        ...(window
          ? {
              segments: page?.segments ?? [],
              segmentCount: agentSegments.length,
              returnedSegmentCount: page?.segments.length ?? 0,
              truncated: page?.truncated ?? false,
              ...(page?.nextStartIndex !== undefined
                ? { nextStartIndex: page.nextStartIndex }
                : {}),
              ...(page?.nextStartMs !== undefined
                ? { nextStartMs: page.nextStartMs }
                : {}),
            }
          : {
              fullText: words.map((w) => w.text).join(" "),
              segments: agentSegments,
              segmentCount: agentSegments.length,
            }),
      },
      instructions: [
        "Use this HTTP transcript endpoint directly; it works without a browser.",
        ...(readiness.instruction ? [readiness.instruction] : []),
      ],
    },
    200,
    agentJsonHeaders(),
  );
});

clipAgentApp.get("/agent-frame.jpg", async (c) => {
  const id = c.req.query("id");
  const clip = await loadPublished(id);
  if (!clip) return c.json({ error: "Not found" }, 404);
  if (clip.status !== "ready") {
    return c.json({ error: "Clip is not ready" }, 409);
  }
  const src = await getClipRecordingPath(clip.id);
  if (!src) return c.json({ error: "Not ready" }, 409);

  const durationMs = safeMs(clip.duration * 1000);
  const requested = parseTimestampMs(
    c.req.query("atMs"),
    c.req.query("tSeconds"),
  );
  const atMs =
    durationMs > 0 ? Math.min(requested, Math.max(0, durationMs - 1)) : requested;

  try {
    const jpeg = await extractClipJpegFrame({
      src,
      cacheDir: clipFramesDir(clip.id),
      atMs,
    });
    return new Response(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=300",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err) {
    const isFrame = err instanceof ClipFrameError;
    const status =
      isFrame && err.code === "FFMPEG_UNAVAILABLE"
        ? 503
        : isFrame && err.code === "NO_VIDEO"
          ? 422
          : 422;
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      status,
    );
  }
});

export async function clipPageAgentResponse(
  c: Context,
): Promise<Response | null> {
  const id = clipIdFromPath(c.req.path);
  if (!id) return null;
  const accept = c.req.header("accept") ?? "";
  if (wantsAgentJson(accept)) {
    const clip = await loadPublished(id);
    if (!clip) return c.json({ error: "Not found" }, 404);
    const words = await loadWords(clip.id);
    return c.json(
      buildPublicAgentContext({
        origin: originOf(c),
        clip,
        words,
      }),
      200,
      agentJsonHeaders(),
    );
  }
  return null;
}

export function injectClipPageHtml(
  html: string,
  url: string,
  headers: { get: (name: string) => string | undefined },
  pathname: string,
): string {
  const id = clipIdFromPath(pathname);
  if (!id) return html;
  return injectClipAgentDiscovery(html, requestOrigin(url, headers), id);
}

export { clipIdFromPath, wantsAgentJson };
