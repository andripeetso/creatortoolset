import { Hono } from "hono";
import type { AuthVars } from "./auth";
import {
  AiProviderError,
  aiFor,
  anyAiConfigured,
  OUT_OF_TOKENS_CODE,
  type ProviderOpts,
} from "./ai-complete";
import { GUEST_MAX_WORDS, GUEST_OUT_OF_CREDITS, takeGuest } from "./guest";
import { splitPoints, thoughtMarks } from "./lib/cadence-lines";
import { MAX_SCRIPT_CHARS, scriptCheckOpts, scriptEdits } from "./lib/script-check";
import { bumpUsage } from "./users";

/**
 * Optional AI caption-cadence pass, on Caption Studio's AI provider (Admin →
 * AI providers) — the client groups captions into spoken thoughts
 * automatically after transcription (and on demand via the transcript
 * panel). Gated per account like cloud transcription: admins always may;
 * other users only when the admin has unlocked cloud for them. Guests get it
 * only on the API key, when an admin switched that on, within their caps
 * (guest.ts).
 *
 * The endpoint takes the flat word list and returns one thought mark per
 * word (see api/lib/cadence-lines.ts). The marks don't depend on the
 * caption box: the client lays them out for whatever size the box is.
 * Timing never changes — words keep their transcribed timestamps, only
 * the grouping moves.
 */
export const aiApp = new Hono<{ Variables: AuthVars }>();

export const mayUse = (u: AuthVars["user"]) =>
  (u.role === "admin" || u.cloud || u.role === "guest") && anyAiConfigured(u);

/** Caption Studio's provider for this caller (a guest: the API key when switched on). */
export const providerFor = (u: AuthVars["user"]): ProviderOpts => aiFor(u, "captions", "Caption Studio");

/** Why a guest's AI request is refused (too big, or over today's caps), else null. */
export function guestRefusal(u: AuthVars["user"], words: number): string | null {
  if (u.role !== "guest") return null;
  if (words > GUEST_MAX_WORDS) {
    return "Guest mode handles videos up to 3 minutes — sign in with an account for longer ones";
  }
  return takeGuest(u, "ai", 1);
}

aiApp.get("/available", (c) =>
  c.json({ available: anyAiConfigured(c.get("user")), allowed: mayUse(c.get("user")) })
);

interface InWord {
  text: string;
  start: number;
  end: number;
}

/** In-flight model calls keyed by account + client request id. */
const activeCadenceRequests = new Map<string, AbortController>();

const validRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9-]{6,80}$/.test(value);

export function aiFailJson(e: unknown, fallback: string, user: AuthVars["user"]) {
  const err = e instanceof AiProviderError ? e : null;
  return {
    error:
      user.role === "guest" && err?.code === OUT_OF_TOKENS_CODE
        ? GUEST_OUT_OF_CREDITS
        : e instanceof Error ? e.message : fallback,
    ...(err?.code === OUT_OF_TOKENS_CODE ? { code: OUT_OF_TOKENS_CODE } : {}),
  };
}

aiApp.delete("/segment/:requestId", (c) => {
  const requestId = c.req.param("requestId");
  if (!validRequestId(requestId)) return c.json({ error: "Invalid request id" }, 400);
  const requestKey = `${c.get("user").username}:${requestId}`;
  activeCadenceRequests.get(requestKey)?.abort();
  return c.json({ ok: true });
});

aiApp.post("/segment", async (c) => {
  if (!anyAiConfigured(c.get("user"))) {
    return c.json({ error: "AI caption pass not configured" }, 501);
  }
  if (!mayUse(c.get("user"))) {
    const guest = c.get("user").role === "guest";
    return c.json(
      {
        error: guest
          ? "The AI caption pass is not available in guest mode — sign in with an account"
          : "The AI caption pass is locked for your account — ask the admin",
        code: "CLOUD_LOCKED",
      },
      403
    );
  }

  const body = (await c.req.json().catch(() => null)) as {
    words?: InWord[];
    requestId?: string;
  } | null;
  const words = body?.words;
  if (!Array.isArray(words) || words.length === 0) {
    return c.json({ error: "No words" }, 400);
  }
  if (
    !words.every(
      (w) =>
        w &&
        typeof w.text === "string" &&
        typeof w.start === "number" &&
        typeof w.end === "number"
    )
  ) {
    return c.json({ error: "Malformed words" }, 400);
  }
  const refusal = guestRefusal(c.get("user"), words.length);
  if (refusal) return c.json({ error: refusal, code: "GUEST_LIMIT" }, 429);
  const requestId = validRequestId(body?.requestId) ? body.requestId : null;
  const requestKey = requestId
    ? `${c.get("user").username}:${requestId}`
    : null;
  const controller = new AbortController();
  if (requestKey) {
    activeCadenceRequests.get(requestKey)?.abort();
    activeCadenceRequests.set(requestKey, controller);
  }

  try {
    const marks = await thoughtMarks(words, {
      signal: controller.signal,
      provider: providerFor(c.get("user")),
    });
    bumpUsage(c.get("user").username, { aiRuns: 1 });
    return c.json({ marks });
  } catch (e) {
    if (controller.signal.aborted) {
      return c.json({ error: "Cadence matching was stopped" }, 408);
    }
    return c.json(aiFailJson(e, "AI caption pass failed", c.get("user")), 502);
  } finally {
    if (requestKey && activeCadenceRequests.get(requestKey) === controller) {
      activeCadenceRequests.delete(requestKey);
    }
  }
});

/**
 * Split points for thought lines too wide for the caption box: the client
 * sends only those lines and the box width, right after a match or when
 * the box gets narrower. The thoughts themselves never change here.
 */
aiApp.post("/split", async (c) => {
  if (!anyAiConfigured(c.get("user"))) {
    return c.json({ error: "AI caption pass not configured" }, 501);
  }
  if (!mayUse(c.get("user"))) {
    return c.json({ error: "The AI caption pass is locked for your account", code: "CLOUD_LOCKED" }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as {
    lines?: unknown;
    maxChars?: unknown;
  } | null;
  const lines = body?.lines;
  const maxChars = body?.maxChars;
  if (
    !Array.isArray(lines) ||
    lines.length === 0 ||
    lines.length > 1000 ||
    !lines.every(
      (l) => Array.isArray(l) && l.length > 1 && l.every((t) => typeof t === "string"),
    ) ||
    typeof maxChars !== "number" ||
    maxChars < 8 ||
    maxChars > 200
  ) {
    return c.json({ error: "Malformed lines" }, 400);
  }
  const refusal = guestRefusal(c.get("user"), (lines as string[][]).flat().length);
  if (refusal) return c.json({ error: refusal, code: "GUEST_LIMIT" }, 429);
  try {
    const splits = await splitPoints(lines as string[][], Math.floor(maxChars), {
      signal: c.req.raw.signal,
      provider: providerFor(c.get("user")),
    });
    return c.json({ splits });
  } catch (e) {
    return c.json(aiFailJson(e, "AI caption pass failed", c.get("user")), 502);
  }
});

/**
 * Script check: the transcript read against the script the video was
 * filmed from (api/lib/script-check.ts). Answers vetted word edits; the
 * client spreads their timing and applies them.
 */
aiApp.post("/script-check", async (c) => {
  if (!anyAiConfigured(c.get("user"))) {
    return c.json({ error: "AI caption pass not configured" }, 501);
  }
  if (!mayUse(c.get("user"))) {
    return c.json(
      { error: "The script check is locked for your account — ask the admin", code: "CLOUD_LOCKED" },
      403
    );
  }
  const body = (await c.req.json().catch(() => null)) as {
    script?: unknown;
    words?: unknown;
  } | null;
  const script = typeof body?.script === "string" ? body.script.trim() : "";
  if (!script) return c.json({ error: "No script" }, 400);
  if (script.length > MAX_SCRIPT_CHARS) {
    return c.json({ error: `The script is too long (max ${MAX_SCRIPT_CHARS.toLocaleString("en")} characters)` }, 400);
  }
  const words = body?.words;
  if (!Array.isArray(words) || words.length === 0) {
    return c.json({ error: "No words" }, 400);
  }
  if (
    !words.every(
      (w) =>
        w &&
        typeof w.text === "string" &&
        (w.confidence === undefined || typeof w.confidence === "number")
    )
  ) {
    return c.json({ error: "Malformed words" }, 400);
  }
  const refusal = guestRefusal(c.get("user"), words.length);
  if (refusal) return c.json({ error: refusal, code: "GUEST_LIMIT" }, 429);
  try {
    const edits = await scriptEdits(
      script,
      words as { text: string; confidence?: number }[],
      scriptCheckOpts(c.get("user"), { signal: c.req.raw.signal, provider: providerFor(c.get("user")) })
    );
    bumpUsage(c.get("user").username, { aiRuns: 1 });
    return c.json({ edits });
  } catch (e) {
    if (c.req.raw.signal.aborted) {
      return c.json({ error: "The script check was stopped" }, 408);
    }
    return c.json(aiFailJson(e, "Script check failed", c.get("user")), 502);
  }
});

