import { randomUUID } from "node:crypto";
import type { Tag, TagKind } from "./types";

const KINDS: TagKind[] = ["topic", "format", "hook", "cta", "audience", "custom"];

export const TAGS_SYSTEM = `You tag Instagram research material for a private library. Return JSON only:
{"tags":[{"label":"short kebab or 1-3 word label","kind":"topic|format|hook|cta|audience","confidence":0.0}]}
Kinds:
- topic: subject matter (fitness, cooking, travel)
- format: how it's made (talking-head, b-roll, carousel-tips, greentext)
- hook: opening device (text-on-screen, question, shock, face-closeup)
- cta: ask (follow, comment-prompt, link-in-bio, none)
- audience: who it is for when obvious
3–8 tags. Labels lowercase. No hashtags. No commentary.`;

export function parseTagsPayload(text: string): Tag[] {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON in the answer");
  const obj = JSON.parse(stripped.slice(start, end + 1)) as { tags?: unknown };
  if (!Array.isArray(obj.tags)) throw new Error("tags array missing");
  const out: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of obj.tags) {
    const tag = coerceTag(raw, "ai");
    if (!tag) continue;
    const key = tag.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= 12) break;
  }
  if (!out.length) throw new Error("the model returned no usable tags");
  return out;
}

export function coerceTag(raw: unknown, source: Tag["source"]): Tag | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { label?: unknown; kind?: unknown; confidence?: unknown; id?: unknown };
  const label = typeof rec.label === "string" ? rec.label.trim().replace(/^#/, "").slice(0, 40) : "";
  if (label.length < 2) return null;
  const kind: TagKind = KINDS.includes(rec.kind as TagKind) ? (rec.kind as TagKind) : "custom";
  const confidence =
    typeof rec.confidence === "number" && rec.confidence >= 0 && rec.confidence <= 1
      ? rec.confidence
      : undefined;
  return {
    id: typeof rec.id === "string" && rec.id ? rec.id : `t_${randomUUID().slice(0, 8)}`,
    label,
    kind,
    source,
    confidence,
  };
}

/** User tags win on the same label; otherwise newest AI tag replaces older AI. */
export function mergeTags(existing: Tag[] | undefined, incoming: Tag[]): Tag[] {
  const map = new Map<string, Tag>();
  for (const t of existing ?? []) map.set(t.label.toLowerCase(), t);
  for (const t of incoming) {
    const key = t.label.toLowerCase();
    const prev = map.get(key);
    if (prev?.source === "user" && t.source === "ai") continue;
    map.set(key, t);
  }
  return [...map.values()];
}

export function tagsHaystack(tags: Tag[] | undefined): string {
  return (tags ?? []).map((t) => `${t.kind}:${t.label} ${t.label}`).join(" ");
}
