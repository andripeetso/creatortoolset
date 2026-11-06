/**
 * Inline markdown used by the document reader and carousel cards.
 * Marks: **bold**, *italic*, mixed _*emphasis*_, [links](url).
 */

export type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "strongem"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "image"; text: string; href: string };

export function isSafeHref(href: string): boolean {
  return href.startsWith("/") || href.startsWith("https://") || href.startsWith("http://");
}

// Longer / mixed marks first so _*without*_ is not leftover underscores around *without*.
// The picture alternative is last: the scan reaches its "!" before the link's "[", so ![alt](url) is never read as a link.
const TOKEN =
  /\[([^\]]+)\]\(([^)]+)\)|\*\*\*([^*\n]+)\*\*\*|_\*([^*\n]+)\*_|\*_([^_\n]+)_\*|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|!\[([^\]\n]*)\]\(([^)\s]+)\)/g;

/** Pictures of a piece only: our own session picture route, never another address. */
export const isPictureHref = (href: string): boolean => href.startsWith("/api/workshop/sessions/");

export function parseInlineMarkdown(text: string): InlinePart[] {
  const out: InlinePart[] = [];
  let last = 0;
  const re = new RegExp(TOKEN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    if (m[10] != null && m[11] != null) {
      if (isPictureHref(m[11])) out.push({ kind: "image", text: m[10], href: m[11] });
      else out.push({ kind: "text", text: m[0] });
    } else if (m[1] != null && m[2] != null) {
      if (isSafeHref(m[2])) out.push({ kind: "link", text: m[1], href: m[2] });
      else out.push({ kind: "text", text: m[0] });
    } else if (m[3] != null) out.push({ kind: "strongem", text: m[3] });
    else if (m[4] != null || m[5] != null) out.push({ kind: "strongem", text: (m[4] ?? m[5])! });
    else if (m[6] != null || m[7] != null) out.push({ kind: "strong", text: (m[6] ?? m[7])! });
    else if (m[8] != null || m[9] != null) out.push({ kind: "em", text: (m[8] ?? m[9])! });
    else out.push({ kind: "text", text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  if (!out.length && text) out.push({ kind: "text", text });
  return out;
}

export function stripInlineMarkdown(text: string): string {
  return parseInlineMarkdown(text)
    .filter((p) => p.kind !== "image")
    .map((p) => p.text)
    .join("");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A slide's text as HTML for the clipboard: paragraphs on blank lines, line breaks kept, emphasis as <strong>/<em>. */
function lineHtml(line: string): string {
  return parseInlineMarkdown(line)
    .map((p) => {
      const t = escapeHtml(p.text);
      if (p.kind === "image") return "";
      if (p.kind === "strong") return `<strong>${t}</strong>`;
      if (p.kind === "em") return `<em>${t}</em>`;
      if (p.kind === "strongem") return `<strong><em>${t}</em></strong>`;
      if (p.kind === "link") return `<a href="${escapeHtml(p.href)}">${t}</a>`;
      return t;
    })
    .join("");
}

export function markdownToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(lineHtml).join("<br>")}</p>`)
    .join("");
}

/**
 * The same for the clipboard: every line break as `<br>`, so a blank line stays a
 * blank line where it's pasted.
 */
export function markdownToClipboardHtml(text: string): string {
  return `<div>${text.trim().split("\n").map(lineHtml).join("<br>")}</div>`;
}

/** Plain text as it's posted: the emphasis marks dropped, every line break kept. */
export const markdownToPlain = (text: string): string => text.split("\n").map(stripInlineMarkdown).join("\n").trim();

/**
 * ⌘B / ⌘I in a plain text field: wrap the selection in ** or *, or take the
 * marks off when it already has them. Spaces at the selection's edges stay outside the marks.
 */
export function toggleMark(text: string, start: number, end: number, mark: "**" | "*"): { text: string; start: number; end: number } {
  const n = mark.length;
  const sel = text.slice(start, end);
  // single * must not be half of a ** (bold) around the selection
  const around = (at: number) => text.slice(at, at + n) === mark && (n === 2 || (text[at - 1] !== "*" && text[at + 1] !== "*") || text.slice(at - 2, at + 1) === "***" || text.slice(at, at + 3) === "***");
  if (sel && start >= n && around(start - n) && around(end)) {
    return { text: text.slice(0, start - n) + sel + text.slice(end + n), start: start - n, end: end - n };
  }
  if (sel.length > 2 * n && sel.startsWith(mark) && sel.endsWith(mark) && (n === 2 || !sel.startsWith("**") || sel.startsWith("***"))) {
    const inner = sel.slice(n, -n);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  const lead = sel.length - sel.trimStart().length;
  const trail = sel.length - sel.trimEnd().length;
  const s = start + lead;
  const e = end - trail;
  if (e <= s) return { text: text.slice(0, start) + mark + mark + text.slice(start), start: start + n, end: start + n };
  return { text: text.slice(0, s) + mark + text.slice(s, e) + mark + text.slice(e), start: s + n, end: e + n };
}
