import type { PostCreator, Slide } from "./types";

/**
 * Clean-up for the on-screen text the vision pass returns. Text-card
 * carousels repeat the creator's header (name, @handle, verified badge),
 * page counters and swipe hints on every slide; the model dutifully
 * transcribes them. Those lines are noise for research, so they are
 * stripped: exact creator lines anywhere, known noise lines, and lines
 * that repeat across most slides of the same post.
 */

export interface CreatorHint {
  username?: string;
  fullName?: string;
}

const NOISE_LINES = [
  /^(swipe|keep swiping|swipe (left|right|to see more|for more)|next slide|continue)[\s.!→›»>]*$/i,
  /^[→←›»«<>➡⬅➔⇒⇐▶◀\s.]+$/,
  /^\d{1,2}\s*(\/|of)\s*\d{1,2}$/i,
  /^page\s+\d+(\s*(\/|of)\s*\d+)?$/i,
  /^(save|share|follow|like|comment|repost)( this( post| one)?)?( for later)?( me| us)?[\s.!]*$/i,
  /^\[illegible\]$/i,
];

export function normalizeLine(line: string): string {
  return line
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

export function isCreatorLine(line: string, creator: CreatorHint): boolean {
  const n = normalizeLine(line);
  if (!n) return true;
  const handle = normalizeLine(creator.username ?? "");
  const name = normalizeLine(creator.fullName ?? "");
  const squashed = n.replace(/\s+/g, "");
  if (handle) {
    if (n === handle || squashed === handle.replace(/\s+/g, "")) return true;
    if (name && (n === `${name} ${handle}` || n === `${handle} ${name}`)) return true;
  }
  if (name && n === name) return true;
  return false;
}

export function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return NOISE_LINES.some((re) => re.test(t));
}

/** Drop creator-header and noise lines from one slide's text. */
export function cleanSlideText(text: string, creator: CreatorHint): string {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() && (isCreatorLine(line, creator) || isNoiseLine(line))) continue;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Lines that appear on most slides of a multi-slide post are layout
 * chrome (a series title, a footer CTA), not content. Needs at least
 * three slides to judge; returns the texts with those lines removed.
 */
export function stripSharedLines(texts: Array<string | undefined>): Array<string | undefined> {
  const present = texts.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  if (present.length < 3) return texts;
  const counts = new Map<string, number>();
  for (const t of present) {
    const seen = new Set<string>();
    for (const line of t.split("\n")) {
      const n = normalizeLine(line);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(present.length * 0.6));
  const shared = new Set([...counts].filter(([, c]) => c >= threshold).map(([n]) => n));
  if (!shared.size) return texts;
  return texts.map((t) => {
    if (!t) return t;
    const kept = t.split("\n").filter((line) => !shared.has(normalizeLine(line)) || !line.trim());
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  });
}

function firstLine(text: string | undefined): string | undefined {
  const line = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : undefined;
}

/**
 * Apply the full clean-up to a post's slides in place. Returns true when
 * any slide changed, so callers can persist only when needed.
 */
export function cleanPostSlideText(slides: Slide[], creator: PostCreator): boolean {
  const hint: CreatorHint = { username: creator.username, fullName: creator.fullName };
  const cleaned = slides.map((s) =>
    s.vision.onScreenText ? cleanSlideText(s.vision.onScreenText, hint) : s.vision.onScreenText,
  );
  const shared = stripSharedLines(cleaned);
  let changed = false;
  slides.forEach((s, i) => {
    const next = shared[i] || undefined;
    if (next !== s.vision.onScreenText) {
      s.vision = { ...s.vision, onScreenText: next };
      changed = true;
    }
    if (s.index === 0 && s.vision.hook) {
      const hook = s.vision.hook.trim();
      if (isCreatorLine(hook, hint) || isNoiseLine(hook)) {
        const replacement = firstLine(next);
        s.vision = { ...s.vision, hook: replacement };
        changed = true;
      }
    }
  });
  return changed;
}
