/**
 * Compose pass: copy is already written. The model only picks a text
 * layout and an image-well size from the kit allowed for this type.
 */

import {
  allowedCompose,
  clampCompose,
  fallbackLayout,
  isCardLayout,
  isImageWellPick,
  resolveCarouselType,
  rolesForCarousel,
  splitSlideAreas,
  type CardLayout,
  type CarouselTypeId,
  type ImageWellPick,
  type SlideCompose,
} from "./carousel-visualize";

export { isCardLayout };
export type { CardLayout, ImageWellPick, SlideCompose };

export const LAYOUT_KIT: { id: CardLayout; hint: string }[] = [
  { id: "cover", hint: "hero, optional support, kicker" },
  { id: "teaching", hint: "one thought, stacked areas" },
  { id: "twoCol", hint: "two sides — only if the copy has two sides" },
  { id: "replace", hint: "familiar phrase vs what to do" },
  { id: "myth", hint: "belief as headline, correction under" },
  { id: "case", hint: "place/period + practice" },
  { id: "thread", hint: "them:/you: messages" },
  { id: "closer", hint: "takeaway" },
];

export const WELL_KIT: { id: ImageWellPick; hint: string }[] = [
  { id: "none", hint: "text only" },
  { id: "banner", hint: "full-width band" },
  { id: "square", hint: "inset square" },
  { id: "tall", hint: "portrait well" },
  { id: "strip", hint: "thin band" },
  { id: "pair", hint: "two wells, one per side" },
];

export interface CarouselLayoutSet {
  hash: string;
  pick: number;
  variants: SlideCompose[][];
  /** the Claude call that made the latest layout: tokens and API-equivalent cost */
  usage?: { tokens: number; costUsd: number };
}

const AREA_MAX = 120;
const AREA_N = 4;
const LINE_MAX = 280;

export function layoutSourceHash(typeId: string, texts: string[]): string {
  const src = `${typeId}\0${texts.map((t) => t.replace(/\s+/g, " ").trim()).join("\0")}`;
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function compactSlideLine(n: number, text: string): string {
  const areas = splitSlideAreas(text)
    .slice(0, AREA_N)
    .map((a) => a.replace(/\s+/g, " ").trim().slice(0, AREA_MAX))
    .filter(Boolean);
  return `${n}|${areas.join(" || ") || "(empty)"}`.slice(0, LINE_MAX);
}

function keyOf(row: SlideCompose[]): string {
  return row.map((c) => `${c.layout}:${c.well}`).join(",");
}

export function parseComposeCell(raw: unknown): { layout: CardLayout; well?: ImageWellPick } | null {
  if (typeof raw === "string") {
    return isCardLayout(raw) ? { layout: raw } : null;
  }
  if (Array.isArray(raw) && raw.length >= 1) {
    const layout = raw[0];
    if (!isCardLayout(layout)) return null;
    return isImageWellPick(raw[1]) ? { layout, well: raw[1] } : { layout };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (!isCardLayout(o.layout)) return null;
    return isImageWellPick(o.well) ? { layout: o.layout, well: o.well } : { layout: o.layout };
  }
  return null;
}

export function coerceCompose(raw: unknown, n: number, fallback: SlideCompose[], typeId: CarouselTypeId): SlideCompose[] {
  const ids = Array.isArray(raw) ? raw : [];
  const roles = rolesForCarousel(typeId, n);
  const out: SlideCompose[] = [];
  for (let i = 0; i < n; i++) {
    const role = roles[i] ?? "explain";
    const parsed = parseComposeCell(ids[i]);
    const base = parsed ?? fallback[i] ?? { layout: fallbackLayout(role), well: "none" as const };
    out.push(clampCompose(typeId, role, i + 1, base));
  }
  return out;
}

export function liveCompose(set: CarouselLayoutSet | undefined | null, hash: string, n: number): SlideCompose[] | undefined {
  if (!set || set.hash !== hash || n < 1) return undefined;
  const row = set.variants[set.pick] ?? set.variants[0];
  if (!row || row.length !== n || !row.every((c) => isCardLayout(c.layout) && isImageWellPick(c.well))) return undefined;
  return row;
}

function extractJson(text: string): Record<string, unknown> {
  let s = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i.exec(s);
  if (fenced) s = fenced[1]!.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON");
  const obj = JSON.parse(s.slice(start, end + 1)) as unknown;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("The model did not return a JSON object");
  return obj as Record<string, unknown>;
}

export function parseLayoutVariants(text: string, n: number, fallback: SlideCompose[], typeId: CarouselTypeId): SlideCompose[][] {
  const o = extractJson(text);
  const v = o.v ?? o.variants;
  if (!Array.isArray(v) || !v.length) throw new Error("Need layout variants");
  const rows = v.slice(0, 3).map((row) => coerceCompose(row, n, fallback, typeId));
  const uniq: SlideCompose[][] = [rows[0]!];
  for (const row of rows.slice(1)) {
    if (keyOf(row) !== keyOf(uniq[0]!)) uniq.push(row);
  }
  return uniq;
}

export function parseOneCompose(text: string, fallback: SlideCompose, typeId: CarouselTypeId, n: number, roleIndex: number): SlideCompose {
  const o = extractJson(text);
  const layout = o.layout ?? o.pick;
  const cell = isCardLayout(layout)
    ? { layout, well: isImageWellPick(o.well) ? o.well : undefined }
    : parseComposeCell(o);
  const roles = rolesForCarousel(typeId, n);
  const role = roles[roleIndex] ?? "explain";
  return clampCompose(typeId, role, roleIndex + 1, cell ?? fallback);
}

export function parseCarouselLayoutSet(raw: unknown): CarouselLayoutSet | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Bad layout set");
  const o = raw as Record<string, unknown>;
  const hash = typeof o.hash === "string" ? o.hash.slice(0, 16) : "";
  if (!/^[0-9a-f]{1,16}$/i.test(hash)) throw new Error("Bad layout hash");
  const variants = Array.isArray(o.variants)
    ? o.variants
        .slice(0, 3)
        .map((row) =>
          Array.isArray(row)
            ? row
                .slice(0, 16)
                .map(parseComposeCell)
                .filter((c): c is { layout: CardLayout; well?: ImageWellPick } => !!c)
                .map((c) => ({ layout: c.layout, well: c.well ?? "none" }))
            : [],
        )
        .filter((row) => row.length > 0)
    : [];
  if (!variants.length) throw new Error("Need layout variants");
  const pickRaw = o.pick;
  const pick =
    typeof pickRaw === "number" && Number.isInteger(pickRaw) ? Math.max(0, Math.min(variants.length - 1, pickRaw)) : 0;
  return { hash, pick, variants };
}

function allowedLine(type: CarouselTypeId): string {
  const midRole =
    type === "compare"
      ? "choice"
      : type === "replace"
        ? "replace"
        : type === "myths"
          ? "myth"
          : type === "cases"
            ? "case"
            : type === "conversation"
              ? "message"
              : "explain";
  const mid = allowedCompose(type, midRole);
  if (type === "conversation") return `thread only. wells ${mid.wells.join("|")}`;
  const cov = allowedCompose(type, "cover");
  const clo = allowedCompose(type, "close");
  return `cover ${cov.layouts.join("|")}/${cov.wells.join("|")}; mid ${mid.layouts.join("|")}/${mid.wells.join("|")}; close ${clo.layouts.join("|")}/${clo.wells.join("|")}`;
}

export function buildLayoutPrompt(input: {
  typeId?: string | null;
  shapes?: string[];
  slides: Array<{ text: string }>;
  slide?: number;
  current?: SlideCompose[];
}): { system: string; user: string } {
  const type = resolveCarouselType(input.typeId);
  const layouts = LAYOUT_KIT.map((k) => `${k.id}: ${k.hint}`).join("\n");
  const wells = WELL_KIT.map((k) => `${k.id}: ${k.hint}`).join("\n");
  const system = `Read the copy. Pick a text layout and a photo well from the kit allowed for this type. Do not change the type. Conversation stays a thread. Two columns only when the slide has two sides. Do not pick a layout the copy cannot fill. Wells are photo holes of different sizes — pick the size that makes this slide interesting to look at and keep reading, not a shuffle.
Allowed: ${allowedLine(type.id)}
${layouts}
${wells}
JSON only. All slides: {"v":[[[layout,well],...],[second variation]]}. One slide: {"layout":"teaching","well":"banner"}.`;
  const n = input.slides.length;
  const lines = input.slides.map((s, i) => compactSlideLine(i + 1, s.text));
  const shapes = (input.shapes ?? []).filter(Boolean).slice(0, 4).join(", ");
  const head = [`type: ${type.id} — ${type.summary}`, shapes ? `shapes: ${shapes}` : "", `n:${n}`]
    .filter(Boolean)
    .join("\n");
  if (input.slide && input.slide >= 1 && input.slide <= n) {
    const now = input.current?.map((c, j) => `${j + 1}:${c.layout}/${c.well}`).join(" ") ?? "";
    return { system, user: `${head}\nnow:${now}\nredo ${input.slide}\n${lines[input.slide - 1]}` };
  }
  return { system, user: `${head}\n${lines.join("\n")}` };
}
