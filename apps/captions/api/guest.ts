import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./lib/env";
import type { SessionUser } from "./users";

/**
 * Guest mode ("Try as guest", no account) runs the real engines —
 * Deepgram, and the AI caption pass on the API key only when an admin
 * switched it on for guests (Admin → AI providers; ai.ts) — under caps, so a
 * stranger can try all of Caption Studio without running up the bill. Worst case at these caps:
 * 60 guest minutes a day ≈ $0.26 of Deepgram. Every guest transcription
 * lands in guest-log.jsonl; Admin → Guests lists it.
 */
export const GUEST_CLIP_S = 180;
/** Words one guest AI request may carry: 3 minutes of fast speech, with room. */
export const GUEST_MAX_WORDS = 1200;
export const GUEST_LIMITS = {
  guestSeconds: 10 * 60, // one guest's cloud transcription per day
  allSeconds: 60 * 60, // all guests together
  guestAi: 40, // AI requests per guest per day
  allAi: 300,
  // Review uploads, kept 7 days: at most ~70 GB of guest videos on the server
  guestBytes: 2 * 1024 ** 3,
  allBytes: 10 * 1024 ** 3,
  // Audio Enhancer (NVIDIA Studio Voice only; sessions deleted an hour after they're done)
  guestEnhance: 10 * 60,
  allEnhance: 60 * 60,
};

/** What a guest sees when the API key or Deepgram is out of credits. */
export const GUEST_OUT_OF_CREDITS =
  "Free guest uses have run out for now — they'll be topped up soon. Try again later, or sign in with an account.";

const LOG = path.join(env.dataDir, "guest-log.jsonl");

// ponytail: in-memory day counters, a server restart resets today's
// usage; persist them if restarts ever get frequent
let day = "";
const used = new Map<string, number>();

const today = () => new Date().toISOString().slice(0, 10);
function counter(key: string): number {
  if (day !== today()) {
    day = today();
    used.clear();
  }
  return used.get(key) ?? 0;
}

/**
 * Charge a guest's request against today's caps, or say why not. Charged
 * up front (requests race otherwise); a failed run keeps its charge.
 */
export function takeGuest(
  user: SessionUser,
  kind: "seconds" | "ai" | "bytes" | "enhance",
  amount: number,
): string | null {
  const mine = `${kind}:${user.username}`;
  const all = `${kind}:*`;
  const [mineCap, allCap] =
    kind === "seconds"
      ? [GUEST_LIMITS.guestSeconds, GUEST_LIMITS.allSeconds]
      : kind === "bytes"
        ? [GUEST_LIMITS.guestBytes, GUEST_LIMITS.allBytes]
        : kind === "enhance"
          ? [GUEST_LIMITS.guestEnhance, GUEST_LIMITS.allEnhance]
          : [GUEST_LIMITS.guestAi, GUEST_LIMITS.allAi];
  if (counter(all) + amount > allCap) {
    return "Guest mode has hit its limit for today — sign in with an account, or try again tomorrow";
  }
  if (counter(mine) + amount > mineCap) {
    return "You've used today's guest allowance — sign in with an account, or come back tomorrow";
  }
  used.set(mine, counter(mine) + amount);
  used.set(all, counter(all) + amount);
  return null;
}

export interface GuestRun {
  at: number;
  guest: string;
  file: string;
  seconds: number;
  text: string;
}

export async function logGuestRun(run: GuestRun): Promise<void> {
  await appendFile(LOG, JSON.stringify(run) + "\n").catch((e) =>
    console.warn(`[guest] log write failed: ${e}`),
  );
}

/** Admin → Guests: the newest runs and today's usage against the caps. */
export async function guestOverview() {
  const lines = await readFile(LOG, "utf-8").then(
    (t) => t.split("\n"),
    () => [],
  );
  const runs: GuestRun[] = [];
  for (const line of lines.slice(-500).reverse()) {
    try {
      if (line) runs.push(JSON.parse(line));
    } catch {
      /* a torn last line */
    }
  }
  return {
    runs,
    today: { seconds: counter("seconds:*"), ai: counter("ai:*") },
    limits: GUEST_LIMITS,
  };
}
