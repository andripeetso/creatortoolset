/**
 * Plain-Markdown rendering of an Instagram post. Shared by the browser
 * (Copy as Markdown) and the server (Content Workshop source packs), so
 * it must stay free of imports, DOM and locale-dependent formatting.
 */

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export type MarkdownKind = "reel" | "post" | "carousel";

export interface MarkdownSlide {
  index: number;
  kind: "image" | "video";
  durationS?: number;
  caption?: string;
  vision: { hook?: string; onScreenText?: string; description?: string; textKind?: "none" | "captions" | "text" };
}

export interface MarkdownPost {
  url: string;
  kind: MarkdownKind;
  platform?: "youtube";
  creator: { username: string };
  takenAt: number;
  caption: string;
  counts: { likes?: number; comments?: number; plays?: number };
  slides: MarkdownSlide[];
  idea?: { title: string; takeaway: string };
}

export interface MarkdownComment {
  text: string;
  likeCount: number;
  user: { username: string };
  replies?: MarkdownComment[];
}

export function fmtCount(n: number | undefined): string {
  if (n === undefined || n === null) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 10e6 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 10e3 ? 0 : 1)}K`;
  return String(n);
}

export function fmtMmSs(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const kindLabel = (k: MarkdownKind) =>
  k === "reel" ? "Reel" : k === "carousel" ? "Carousel" : "Post";

/** YYYY-MM-DD, identical on every machine. */
export function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Split timed words into readable paragraphs (pauses and sentence ends). */
export function transcriptParagraphs(words: TranscriptWord[]): TranscriptWord[][] {
  if (!words.length) return [];
  const SENTENCE_END = /[.!?…]["')\]]*$/;
  const paras: TranscriptWord[][] = [];
  let cur: TranscriptWord[] = [];
  let sentences = 0;
  const flush = () => {
    if (!cur.length) return;
    paras.push(cur);
    cur = [];
    sentences = 0;
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end >= 1.4 && cur.length >= 6) flush();
    cur.push(w);
    if (SENTENCE_END.test(w.text)) {
      sentences++;
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0);
      if (sentences >= 3 || (sentences >= 2 && chars >= 180) || chars >= 420) flush();
    } else if (cur.length >= 72) {
      flush();
    }
  }
  flush();
  return paras;
}

/** "[mm:ss] text" lines, one per paragraph — for copying. */
export function timedTranscriptText(words: TranscriptWord[]): string {
  return transcriptParagraphs(words)
    .map((p) => `[${fmtMmSs(p[0].start)}] ${p.map((w) => w.text).join(" ")}`)
    .join("\n\n");
}

/** Everything worth reading from a post as plain Markdown. */
/** The parts of a post a pack can carry, in value order. */
export type SourcePart = "slides" | "transcript" | "caption" | "comments";
export const SOURCE_PARTS: SourcePart[] = ["slides", "transcript", "caption", "comments"];

export function postToMarkdown(
  post: MarkdownPost,
  transcripts: Record<number, TranscriptWord[]>,
  comments: MarkdownComment[] = [],
  opts: { parts?: SourcePart[] } = {},
): string {
  const has = (part: SourcePart) => !opts.parts || opts.parts.includes(part);
  const lines: string[] = [];
  const where =
    post.platform === "youtube"
      ? post.kind === "reel" ? "YouTube Short" : "YouTube video"
      : `Instagram ${kindLabel(post.kind).toLowerCase()}`;
  lines.push(`# @${post.creator.username} — ${where}`);
  lines.push("");
  lines.push(`Source: ${post.url}`);
  if (post.takenAt) lines.push(`Published: ${isoDate(post.takenAt)}`);
  const counts: string[] = [];
  if (post.counts.plays !== undefined) counts.push(`${fmtCount(post.counts.plays)} plays`);
  if (post.counts.likes !== undefined) counts.push(`${fmtCount(post.counts.likes)} likes`);
  if (post.counts.comments !== undefined) counts.push(`${fmtCount(post.counts.comments)} comments`);
  if (counts.length) lines.push(`Numbers: ${counts.join(" · ")}`);
  if (post.idea?.title) {
    lines.push(`Idea: ${post.idea.title}`);
    if (post.idea.takeaway) lines.push(`Takeaway: ${post.idea.takeaway}`);
  }
  if (has("caption")) {
    lines.push("");
    lines.push("## Caption");
    lines.push("");
    lines.push(post.caption.trim() || "_No caption._");
  }
  if (has("slides") || has("transcript")) {
    lines.push("");
    lines.push("## Slides");
    for (const s of post.slides) {
      const words = has("transcript") ? transcripts[s.index] : undefined;
      if (!has("slides") && !words?.length) continue;
      lines.push("");
      lines.push(`### Slide ${s.index + 1} (${s.kind}${s.durationS ? `, ${fmtMmSs(s.durationS)}` : ""})`);
      if (has("slides")) {
        if (s.caption) lines.push(`Slide caption: ${s.caption}`);
        if (s.vision.hook) lines.push(`Hook: ${s.vision.hook}`);
        if (s.vision.onScreenText) {
          lines.push("");
          // subtitles say what the transcript says: no context of their own
          lines.push(s.vision.textKind === "captions" ? "On-screen text (only subtitles of what is said):" : "On-screen text:");
          lines.push("");
          lines.push(s.vision.onScreenText);
        }
        if (s.vision.description) {
          lines.push("");
          lines.push(`Description: ${s.vision.description}`);
        }
      }
      if (words?.length) {
        lines.push("");
        lines.push("Transcript:");
        lines.push("");
        lines.push(timedTranscriptText(words));
      }
    }
  }
  if (has("comments") && comments.length) {
    lines.push("");
    lines.push("## Comments");
    lines.push("");
    const walk = (list: MarkdownComment[], depth: number) => {
      for (const cm of list) {
        const pad = "  ".repeat(depth);
        lines.push(`${pad}- **@${cm.user.username}** (${cm.likeCount} likes): ${cm.text.replace(/\s+/g, " ")}`);
        if (cm.replies?.length) walk(cm.replies, depth + 1);
      }
    };
    walk(comments, 0);
  }
  return lines.join("\n") + "\n";
}
