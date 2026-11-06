/**
 * Copy/save markdown for workshop documents. Shared by the browser
 * (preview / copy) and the server (export.md), so it stays free of
 * imports, DOM, and locale-dependent formatting.
 */

export type ExportDocKind = "reel" | "carousel" | "ad" | "free" | "youtube" | "notes";

const KIND_SUFFIX: Record<ExportDocKind, string> = {
  reel: "Reel",
  carousel: "Carousel",
  ad: "Ad",
  free: "Draft",
  youtube: "YouTube",
  notes: "Notes",
};

const SKIP_STEM = new Set(["", "untitled", "untitled session", "workshop session"]);
const STOCK_STEM = /^(script|reel|reel script|carousel|ad copy|draft|free-form|free form|notes)(\s+\d+)?$/i;

/** Letters and digits only, case kept — TinyStory stays TinyStory. */
export function camelStem(name: string | undefined): string {
  return (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .slice(0, 80);
}

function usableTitle(title: string | undefined): string {
  const t = (title ?? "").trim();
  if (SKIP_STEM.has(t.toLowerCase()) || STOCK_STEM.test(t)) return "";
  return t;
}

/** ProjectName + Carousel/Reel, camelCase kept. Does not double the suffix. */
export function exportStem(projectName: string | undefined, kind: ExportDocKind, fallbackTitle?: string): string {
  const suffix = KIND_SUFFIX[kind];
  const stem = camelStem(projectName) || camelStem(usableTitle(fallbackTitle));
  if (!stem) return suffix;
  return stem.toLowerCase().endsWith(suffix.toLowerCase()) ? stem : `${stem}${suffix}`;
}

export function exportFilename(projectName: string | undefined, kind: ExportDocKind, fallbackTitle?: string, ext = "md"): string {
  return `${exportStem(projectName, kind, fallbackTitle)}.${ext}`;
}

export interface PieceDoc {
  kind: ExportDocKind;
  blocks: Array<{ text: string }>;
  hooks?: Array<{ text: string }> | null;
  caption?: { text: string } | null;
  pinned?: { text: string } | null;
}

function carouselCards(blocks: Array<{ text: string }>): string[] {
  return blocks.map((b) => b.text.trim()).filter(Boolean);
}

/** YAML frontmatter with the card count — carousel exports only. */
export function cardsFrontmatter(n: number): string {
  return `---\ncards: ${n}\n---\n\n`;
}

const HOOK_RULE = "=== === === === ===";

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The session title as a Mac file name: only / and : change. */
/**
 * A picture inside a piece: `![alt](/api/workshop/sessions/<session>/images/<id>)`.
 * Groups: 1 alt, 2 session id, 3 picture id. Use with matchAll or replace (global).
 */
// short in the text the author reads; the address is filled in where it's shown
export const PICTURE_TOKEN = /!\[([^\]\n]*)\]\(pic:([a-z0-9-]{6,40})\)/g;

/** The token the editor inserts; brackets and parentheses are kept out of the alt text. */
export const pictureToken = (alt: string, id: string) => `![${alt.replace(/[[\]()\n]/g, "").trim()}](pic:${id})`;
/** Where a session's picture is served. */
export const pictureUrl = (sessionId: string, id: string) => `/api/workshop/sessions/${sessionId}/images/${id}`;
/** The text with each picture token pointing at its address, for markdown rendering. */
export const withPictureUrls = (text: string, sessionId: string) =>
  text.replace(PICTURE_TOKEN, (_all, alt: string, id: string) => `![${alt}](${pictureUrl(sessionId, id)})`);

/** Picture ids in the order they first appear in the text. */
export function pictureIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PICTURE_TOKEN)) if (!out.includes(m[2]!)) out.push(m[2]!);
  return out;
}

/**
 * A field's text cut at its picture tokens: text, picture, text, … Always starts and ends
 * with a text part (maybe ""), so text parts sit at even indexes. `start` = offset in the whole text.
 */
export type FieldSegment =
  | { kind: "text"; text: string; start: number }
  | { kind: "picture"; alt: string; id: string; token: string; start: number };

export function splitPictures(text: string): FieldSegment[] {
  const out: FieldSegment[] = [];
  let at = 0;
  for (const m of text.matchAll(PICTURE_TOKEN)) {
    const start = m.index ?? 0;
    out.push({ kind: "text", text: text.slice(at, start), start: at });
    out.push({ kind: "picture", alt: m[1] ?? "", id: m[2]!, token: m[0], start });
    at = start + m[0].length;
  }
  out.push({ kind: "text", text: text.slice(at), start: at });
  return out;
}

/** The whole text with segment `index` replaced by `text` (a text part's new words, or "" to take a picture out). Everything else is kept exactly. */
export function joinParts(parts: FieldSegment[], index: number, text: string): string {
  return parts.map((p, i) => (i === index ? text : p.kind === "text" ? p.text : p.token)).join("");
}

/** The stretches of [start, start + length) that the ranges cover, shifted to that part's own offsets. */
export function rangesIn(ranges: Array<[number, number]>, start: number, length: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of ranges) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, start + length);
    if (hi > lo) out.push([lo - start, hi - start]);
  }
  return out;
}

export function obsidianFilename(title: string | undefined, fallback = "Untitled"): string {
  const name = (title ?? "").trim().replace(/[/:]/g, "-") || fallback;
  return `${name}.md`;
}

/**
 * An Obsidian script note: frontmatter (selector.Media = the author's vault's custom-selectors option), the hook lines (// each), then the
 * script's paragraphs. Nothing else. `day` is YYYY-MM-DD.
 */
export function reelObsidianMarkdown(input: {
  day: string;
  status: string;
  hooks?: Array<{ text: string }> | null;
  blocks: Array<{ text: string }>;
}): string {
  const head = `---\nchange: ${input.day}\ndetails:\nselector.Status: ${input.status}\nselector.Media: 🎞️ Reel\n---\n`;
  const hooks = (input.hooks ?? []).map((h) => oneLine(h.text)).filter(Boolean).map((t) => `// ${t}`).join("\n");
  const script = input.blocks
    .flatMap((b) => b.text.split(/\n\s*\n/))
    .map((p) => p.trim())
    .filter(Boolean)
    .join("\n\n");
  return `${head}${[hooks, script].filter(Boolean).join("\n\n")}\n`;
}

/**
 * A carousel as one of the author's Obsidian notes (SampleTexts.md: `details: CAROUSEL`): the same frontmatter, then each
 * slide's text, slides apart by a `---` line.
 */
export function carouselObsidianMarkdown(input: { day: string; status: string; blocks: Array<{ text: string }> }): string {
  const head = `---\nchange: ${input.day}\ndetails: CAROUSEL\nselector.Status: ${input.status}\nselector.Media: 🎪 Carousel\n---\n`;
  const slides = input.blocks.map((b) => b.text.trim()).filter(Boolean).join("\n\n---\n\n");
  return `${head}${slides}\n`;
}

/** The spoken script as written. Legacy multi-block reels join with a blank line. */
function reelScript(blocks: Array<{ text: string }>): string {
  return blocks
    .map((b) => b.text.replace(/\s+$/, ""))
    .filter((t) => t.trim())
    .join("\n\n");
}

function reelHookBlock(hooks: Array<{ text: string }>): string {
  const lines = hooks.map((h) => oneLine(h.text)).filter(Boolean);
  if (!lines.length) return "";
  return `${HOOK_RULE}\n\n${lines.map((text, i) => `//HOOK${i + 1}: ${text}`).join("\n\n")}`;
}

/**
 * The piece as markdown. Carousel slides become labeled cards separated
 * by a rule. Pass frontmatter: false when nesting under a session export
 * that already carries the card count at the top of the file.
 */
export function pieceMarkdown(doc: PieceDoc, opts: { frontmatter?: boolean } = {}): string {
  const cards = carouselCards(doc.blocks);
  const body =
    doc.kind === "carousel" && cards.length
      ? cards.map((text, i) => `## Card ${i + 1}\n\n${text}`).join("\n\n---\n\n")
      : doc.kind === "reel"
        ? reelScript(doc.blocks)
        : cards.join("\n\n");
  const parts = [doc.kind === "reel" ? reelHookBlock(doc.hooks ?? []) : "", body].filter(Boolean);
  if (doc.caption?.text.trim()) parts.push(`## Post description\n\n${doc.caption.text.trim()}`);
  if (doc.pinned?.text.trim()) parts.push(`## Pinned comment\n\n${doc.pinned.text.trim()}`);
  const md = `${parts.filter(Boolean).join("\n\n")}\n`;
  if (doc.kind === "carousel" && opts.frontmatter !== false) return `${cardsFrontmatter(cards.length)}${md}`;
  return md;
}
