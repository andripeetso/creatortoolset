/**
 * Models sometimes wrap the document in JSON or a fence. The stored
 * body should be markdown the editor can render.
 */

const MD_KEYS = ["markdown", "body", "content", "text", "document"] as const;

export function parseDocumentMarkdown(text: string): string {
  let s = text.replace(/^\uFEFF/, "").trim();
  if (!s) return "";

  const fenced = /^```(?:json|markdown|md)?\s*\n?([\s\S]*?)\s*```$/i.exec(s);
  if (fenced) s = fenced[1].trim();

  const fromJson = markdownFromJson(s);
  if (fromJson != null) return fromJson.trim();

  const extracted = extractMarkdownField(s);
  if (extracted != null) return extracted.trim();

  return s;
}

/** First `# heading` vs the rest of the page. */
export function splitDocumentTitle(body: string): {
  title: string | null;
  rest: string;
} {
  const md = parseDocumentMarkdown(body);
  const m = /^#\s+(.+)\n*/.exec(md);
  if (!m) return { title: null, rest: md };
  return { title: m[1].trim(), rest: md.slice(m[0].length) };
}

export function withDocumentTitle(rest: string, name: string): string {
  const title = name.trim().replace(/\s+/g, " ").slice(0, 120);
  const body = rest.replace(/^\uFEFF/, "").trim();
  if (!title) return body;
  return body ? `# ${title}\n\n${body}` : `# ${title}`;
}

export const CLIP_HREF = /\[([^\]]+)\]\(\/clips\/([a-z0-9-]{6,40})\)/i;

/** Videos for clip links; leftover text keeps the title, not a second link. */
export function extractClipEmbeds(text: string): {
  clips: { id: string; title: string }[];
  rest: string;
} {
  const clips: { id: string; title: string }[] = [];
  const finder = new RegExp(CLIP_HREF, "gi");
  let m: RegExpExecArray | null;
  while ((m = finder.exec(text))) {
    clips.push({ id: m[2], title: m[1] });
  }
  if (!clips.length) return { clips, rest: text };

  const standalone = new RegExp(
    `^${CLIP_HREF.source}(?:\\s*[—–-]\\s*(.*))?$`,
    "i",
  ).exec(text.trim());
  if (standalone) return { clips, rest: (standalone[3] || "").trim() };
  return {
    clips,
    rest: text.replace(new RegExp(CLIP_HREF, "gi"), "$1").trim(),
  };
}

function markdownFromJson(s: string): string | null {
  if (s[0] !== "{" && s[0] !== '"') return null;
  try {
    return markdownFromValue(JSON.parse(s) as unknown);
  } catch {
    return null;
  }
}

function markdownFromValue(j: unknown): string | null {
  if (typeof j === "string") {
    const nested = markdownFromJson(j.trim());
    return nested ?? j;
  }
  if (j && typeof j === "object") {
    const rec = j as Record<string, unknown>;
    for (const k of MD_KEYS) {
      if (typeof rec[k] === "string") return rec[k];
    }
  }
  return null;
}

/** Salvage {"markdown":"..."} when the model appends junk and JSON.parse fails. */
function extractMarkdownField(s: string): string | null {
  if (s[0] !== "{") return null;
  const m = /"(?:markdown|body|content|text|document)"\s*:\s*"/i.exec(s);
  if (!m) return null;
  return unescapeJsonString(s, m.index + m[0].length);
}

function unescapeJsonString(s: string, start: number): string | null {
  let out = "";
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const n = s[++i];
      if (n === undefined) break;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === '"' || n === "\\" || n === "/") out += n;
      else if (n === "u") {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += n;
      } else out += n;
      continue;
    }
    if (c === '"') return out;
    out += c;
  }
  return out.length ? out : null;
}
