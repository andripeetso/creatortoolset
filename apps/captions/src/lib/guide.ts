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

/**
 * The Guide Builder editor's save label. `edits` counts what was typed, `tried` is the count a save has gone out for,
 * `saved` the count the server has, `out` the saves on their way. Saved only when the server has all of it; nothing
 * after a save that failed (its error is on the page).
 */
export const saveLabel = (s: { edits: number; tried: number; saved: number; out: number }) =>
  s.out > 0 || s.edits > s.tried ? "Saving…" : s.saved < s.edits ? "" : "Saved";

/**
 * One guide's saves, in the order asked. What is typed waits `wait` ms and replaces what was waiting; requests go out
 * one at a time, so the answers come back in order and the text typed last is the text sent last. `replace` runs an
 * action that takes the guide's text from the server (Regenerate): what was typed before it is saved first, nothing is
 * sent while it runs, and what is typed meanwhile is dropped when it succeeds (when it fails, that is kept and saved
 * after it). `counts` is what saveLabel reads; `to.changed` is told when it changes.
 */
export function guideSaves<P, R>(
  to: { send: (patch: P) => Promise<R>; saved: (answer: R) => void; failed: (error: unknown) => void; changed: (counts: Parameters<typeof saveLabel>[0]) => void },
  wait = 700,
) {
  const counts = { edits: 0, tried: 0, saved: 0, out: 0 };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let waiting: P | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  // one at a time: each waits for the one before it, whatever that one's answer
  const inTurn = <T>(job: () => Promise<T>): Promise<T> => {
    const done = tail.then(job);
    tail = done.catch(() => {});
    return done;
  };
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // `at`: how much of what was typed this request carries (0: none of it). True when the server has it.
  const go = async (patch: P, at: number) => {
    try {
      const answer = await to.send(patch);
      counts.saved = Math.max(counts.saved, at);
      to.saved(answer);
      return true;
    } catch (e) {
      to.failed(e);
      return false;
    } finally {
      counts.out--;
      to.changed(counts);
    }
  };
  /** What was typed goes now, in its turn (Save, leaving the guide). */
  const flush = () => {
    stopTimer();
    return inTurn(async () => {
      // read when its turn comes: what was typed while it waited goes with it, once
      const patch = waiting;
      if (patch === null) return;
      waiting = null;
      counts.tried = counts.edits;
      counts.out++;
      to.changed(counts);
      // refused or offline: it waits again (no timer), so Save, or leaving the guide, sends it once more
      if (!(await go(patch, counts.edits)) && waiting === null) waiting = patch;
    });
  };
  return {
    counts,
    flush,
    /** Text was typed: `patch` carries all of it. */
    type(patch: P) {
      waiting = patch;
      counts.edits++;
      to.changed(counts);
      stopTimer();
      timer = setTimeout(() => void flush(), wait);
    },
    /** A change that is not the text (the name, sharing). */
    save(patch: P) {
      counts.out++;
      to.changed(counts);
      return inTurn(async () => void (await go(patch, 0)));
    },
    replace<T>(run: () => Promise<T>): Promise<T> {
      void flush();
      return inTurn(async () => {
        const result = await run();
        stopTimer();
        waiting = null;
        counts.tried = counts.saved = counts.edits;
        to.changed(counts);
        return result;
      });
    },
  };
}
