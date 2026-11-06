/**
 * Pack a word-level transcript into [mm:ss] lines for clip analysis.
 * Long recordings stay within `max` by sampling across the whole
 * timeline — never by cutting off the second half.
 */

export const CLIP_TRANSCRIPT_CHARS = 48_000;

export function timedTranscript(
  words: { text: string; start: number }[],
  max = CLIP_TRANSCRIPT_CHARS,
): string {
  const parts: string[] = [];
  let buf: string[] = [];
  let t0 = 0;
  const flush = () => {
    if (!buf.length) return;
    const mm = Math.floor(t0 / 60);
    const ss = Math.floor(t0 % 60);
    parts.push(
      `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}] ${buf.join(" ")}`,
    );
    buf = [];
  };
  for (const w of words) {
    if (!buf.length) t0 = w.start;
    buf.push(w.text);
    if (w.start - t0 >= 10 || buf.join(" ").length > 140) flush();
  }
  flush();
  return fitLines(parts, max);
}

/**
 * Duration buckets for the chapter rail. Longer is not denser — a
 * 16-minute review should still scan in one glance, and an hour
 * should not become a table of contents.
 *
 *   < 2 min   optional, at most 3
 *   2–8 min   3–5
 *   8–20 min  5–8   (16-min reviews live here)
 *   20–40 min 6–10
 *   40+ min   7–12  hard ceiling
 */
export function chapterCountRange(durationSec: number): { min: number; max: number } {
  const m = Math.max(0, durationSec) / 60;
  if (m < 2) return { min: 0, max: 3 };
  if (m < 8) return { min: 3, max: 5 };
  if (m < 20) return { min: 5, max: 8 };
  if (m < 40) return { min: 6, max: 10 };
  return { min: 7, max: 12 };
}

/** Keep first and last if the model overshoots the hard cap. */
export function capChapters<T extends { t: number }>(chapters: T[], max: number): T[] {
  if (chapters.length <= max) return chapters;
  if (max <= 0) return [];
  const sorted = [...chapters].sort((a, b) => a.t - b.t);
  if (max === 1) return [sorted[0]];
  const out: T[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (sorted.length - 1)) / (max - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(sorted[idx]);
  }
  return out;
}

function fitLines(parts: string[], max: number): string {
  if (!parts.length) return "";
  const full = parts.join("\n");
  if (full.length <= max) return full;
  let lo = 2;
  let hi = parts.length;
  let best = [parts[0], parts[parts.length - 1]].join("\n");
  if (best.length > max) return best.slice(0, max);
  while (lo <= hi) {
    const n = Math.floor((lo + hi) / 2);
    const text = sampleEven(parts, n).join("\n");
    if (text.length <= max) {
      best = text;
      lo = n + 1;
    } else {
      hi = n - 1;
    }
  }
  return best;
}

function sampleEven(parts: string[], n: number): string[] {
  if (n >= parts.length) return parts;
  if (n <= 1) return [parts[0]];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(parts[Math.round((i * (parts.length - 1)) / (n - 1))]);
  }
  return out;
}
