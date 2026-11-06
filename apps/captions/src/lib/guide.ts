/**
 * Structured step-by-step guides generated from a clip.
 * Stored as documents/<id>/guide.json; body.md is a text projection.
 */

export type DocKind = "brief" | "guide";

export const GUIDE_VERSION = 1;
export const GUIDE_MAX_STEPS = 12;
export const GUIDE_ASSET = /^[a-z0-9-]+\.jpe?g$/i;

export interface GuideSource {
  clipId: string;
  startMs: number;
  endMs: number;
}

export interface GuideMedia {
  assetId: string;
  requestedMs: number;
  actualMs: number;
  alt: string;
}

export interface GuideStep {
  id: string;
  title: string;
  instruction: string;
  source: GuideSource;
  media: GuideMedia[];
}

export interface GuideDoc {
  version: typeof GUIDE_VERSION;
  purpose: string;
  prerequisites: string[];
  verification: string[];
  steps: GuideStep[];
}

export interface GuidePlanStep {
  title: string;
  instruction: string;
  startSec: number;
  endSec: number;
  atSec: number;
}

export interface GuidePlan {
  title: string;
  purpose: string;
  prerequisites: string[];
  verification: string[];
  steps: GuidePlanStep[];
}

export function parseDocKind(raw: unknown): DocKind {
  return raw === "guide" ? "guide" : "brief";
}

export function isGuideAssetName(name: string): boolean {
  return GUIDE_ASSET.test(name);
}

export function guideAssetUrl(docId: string, assetId: string): string {
  return `/api/documents/${encodeURIComponent(docId)}/assets/${encodeURIComponent(assetId)}`;
}

export function clipRangeHref(
  clipId: string,
  startSec?: number,
  endSec?: number,
): string {
  const q = new URLSearchParams();
  if (startSec != null && Number.isFinite(startSec)) {
    q.set("t", String(Math.max(0, startSec)));
  }
  if (endSec != null && Number.isFinite(endSec) && endSec > (startSec ?? 0)) {
    q.set("end", String(endSec));
  }
  const qs = q.toString();
  return qs ? `/clips/${clipId}?${qs}` : `/clips/${clipId}`;
}

function jsonObject(text: string): Record<string, unknown> {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Guide model returned no JSON");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

function strings(raw: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const it of raw) {
    if (typeof it !== "string") continue;
    const t = it.trim().slice(0, itemMax);
    if (t) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

function num(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseGuidePlan(text: string, durationSec: number): GuidePlan {
  const obj = jsonObject(text);
  const duration = Math.max(0, durationSec);
  const title =
    typeof obj.title === "string" ? obj.title.trim().slice(0, 120) : "";
  const purpose =
    typeof obj.purpose === "string" ? obj.purpose.trim().slice(0, 800) : "";
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  const steps: GuidePlanStep[] = [];
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const stTitle =
      typeof rec.title === "string" ? rec.title.trim().slice(0, 80) : "";
    const instruction =
      typeof rec.instruction === "string"
        ? rec.instruction.trim().slice(0, 600)
        : "";
    if (!stTitle || !instruction) continue;
    let start = num(rec.startSec) ?? 0;
    let end = num(rec.endSec) ?? start + 4;
    start = Math.max(0, Math.min(duration || start, start));
    end = Math.max(start + 0.8, Math.min(duration || end, end));
    if (duration > 0 && end > duration) end = duration;
    if (end <= start) end = Math.min((duration || start + 4), start + 4);
    let at = num(rec.atSec);
    if (at == null) at = start + Math.min(1.2, (end - start) * 0.45);
    at = Math.max(start, Math.min(Math.max(start, end - 0.05), at));
    steps.push({ title: stTitle, instruction, startSec: start, endSec: end, atSec: at });
    if (steps.length >= GUIDE_MAX_STEPS) break;
  }
  if (!steps.length) throw new Error("The guide had no usable steps");
  return {
    title: title || steps[0].title,
    purpose,
    prerequisites: strings(obj.prerequisites, 8, 200),
    verification: strings(obj.verification, 8, 200),
    steps,
  };
}

export function planToGuide(
  plan: GuidePlan,
  clipId: string,
  mediaFor: (index: number, step: GuidePlanStep) => GuideMedia[],
): GuideDoc {
  return {
    version: GUIDE_VERSION,
    purpose: plan.purpose,
    prerequisites: plan.prerequisites,
    verification: plan.verification,
    steps: plan.steps.map((step, i) => ({
      id: `step-${i + 1}`,
      title: step.title,
      instruction: step.instruction,
      source: {
        clipId,
        startMs: Math.round(step.startSec * 1000),
        endMs: Math.round(step.endSec * 1000),
      },
      media: mediaFor(i, step),
    })),
  };
}

export function guideToMarkdown(title: string, guide: GuideDoc): string {
  const parts = [`# ${title}`];
  if (guide.purpose) parts.push(guide.purpose);
  if (guide.prerequisites.length) {
    parts.push("## Before you start", ...guide.prerequisites.map((p) => `- ${p}`));
  }
  guide.steps.forEach((step, i) => {
    parts.push(`## ${i + 1}. ${step.title}`, step.instruction);
  });
  if (guide.verification.length) {
    parts.push("## Check your work", ...guide.verification.map((p) => `- ${p}`));
  }
  return parts.join("\n\n");
}

export function parseStoredGuide(raw: unknown): GuideDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.version !== GUIDE_VERSION || !Array.isArray(rec.steps)) return null;
  const steps: GuideStep[] = [];
  for (const s of rec.steps) {
    if (!s || typeof s !== "object") continue;
    const st = s as Record<string, unknown>;
    const source = st.source as Record<string, unknown> | undefined;
    const clipId = typeof source?.clipId === "string" ? source.clipId : "";
    const startMs = num(source?.startMs);
    const endMs = num(source?.endMs);
    const title = typeof st.title === "string" ? st.title : "";
    const instruction = typeof st.instruction === "string" ? st.instruction : "";
    const id = typeof st.id === "string" ? st.id : `step-${steps.length + 1}`;
    if (!clipId || startMs == null || endMs == null || !title || !instruction) {
      continue;
    }
    const media: GuideMedia[] = [];
    if (Array.isArray(st.media)) {
      for (const m of st.media) {
        if (!m || typeof m !== "object") continue;
        const md = m as Record<string, unknown>;
        if (typeof md.assetId !== "string" || !isGuideAssetName(md.assetId)) continue;
        media.push({
          assetId: md.assetId,
          requestedMs: num(md.requestedMs) ?? 0,
          actualMs: num(md.actualMs) ?? num(md.requestedMs) ?? 0,
          alt: typeof md.alt === "string" ? md.alt : title,
        });
      }
    }
    steps.push({
      id,
      title: title.slice(0, 80),
      instruction: instruction.slice(0, 600),
      source: { clipId, startMs, endMs },
      media,
    });
  }
  if (!steps.length) return null;
  return {
    version: GUIDE_VERSION,
    purpose: typeof rec.purpose === "string" ? rec.purpose : "",
    prerequisites: strings(rec.prerequisites, 8, 200),
    verification: strings(rec.verification, 8, 200),
    steps,
  };
}

/** Merge title/instruction edits onto existing steps; keep ids, media, ranges. */
export function mergeGuideEdits(current: GuideDoc, patch: unknown): GuideDoc {
  if (!patch || typeof patch !== "object") return current;
  const rec = patch as Record<string, unknown>;
  const purpose =
    typeof rec.purpose === "string"
      ? rec.purpose.trim().slice(0, 800)
      : current.purpose;
  const byId = new Map(
    (Array.isArray(rec.steps) ? rec.steps : [])
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => [String(s.id ?? ""), s]),
  );
  return {
    ...current,
    purpose,
    steps: current.steps.map((step) => {
      const next = byId.get(step.id);
      if (!next) return step;
      const title =
        typeof next.title === "string" && next.title.trim()
          ? next.title.trim().slice(0, 80)
          : step.title;
      const instruction =
        typeof next.instruction === "string" && next.instruction.trim()
          ? next.instruction.trim().slice(0, 600)
          : step.instruction;
      return { ...step, title, instruction };
    }),
  };
}
