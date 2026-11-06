import type { DraftKind } from "./types";

/**
 * What the model must return per draft kind, parsed strictly: an unusable
 * answer throws, which makes completeWithFallback move to the next provider.
 */

export interface ReelPlan {
  title: string;
  hook: { spoken: string; onScreen: string };
  beats: Array<{ label: string; spoken: string; onScreen?: string; visual?: string; seconds?: number }>;
  cta: string;
  caption: string;
  hashtags: string[];
  whyItWorks: string[];
}

export interface CarouselPlan {
  title: string;
  slides: Array<{ n: number; headline: string; body: string; visual?: string }>;
  caption: string;
  hashtags: string[];
  whyItWorks: string[];
}

export interface AdPlan {
  title: string;
  variants: Array<{ angle: string; hook: string; primaryText: string; headline: string; description: string; cta: string }>;
  whyItWorks: string[];
}

export interface FreePlan {
  title: string;
  markdown: string;
}

export type DraftPlan =
  | { kind: "reel"; plan: ReelPlan }
  | { kind: "carousel"; plan: CarouselPlan }
  | { kind: "ad"; plan: AdPlan }
  | { kind: "free"; plan: FreePlan };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";

const strList = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v)
    ? v.map((x) => str(x, each)).filter(Boolean).slice(0, max)
    : typeof v === "string"
      ? v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, max)
      : [];

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;

/** First {…} in the text, fences stripped; a JSON-mode double wrap is unwrapped once. */
export function jsonObject(text: string): Rec {
  let s = text.replace(/^ /, "").trim();
  const fenced = /^```(?:json|markdown|md)?\s*\n?([\s\S]*?)\s*```$/i.exec(s);
  if (fenced) s = fenced[1]!.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON");
  let obj = JSON.parse(s.slice(start, end + 1)) as unknown;
  if (isRec(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 1) {
      const inner = obj[keys[0]!];
      if (typeof inner === "string" && inner.trim().startsWith("{")) {
        try {
          const parsed = JSON.parse(inner) as unknown;
          if (isRec(parsed)) obj = parsed;
        } catch {
          /* leave as is */
        }
      } else if (isRec(inner) && ["plan", "result", "output", "data"].includes(keys[0]!)) {
        obj = inner;
      }
    }
  }
  if (!isRec(obj)) throw new Error("The model did not return a JSON object");
  return obj;
}

const hashtags = (v: unknown) => strList(v, 30, 60).map((h) => h.replace(/^#+/, "")).filter(Boolean);

export function parseReelPlan(text: string): ReelPlan {
  const o = jsonObject(text);
  const hookRaw = isRec(o.hook) ? o.hook : { spoken: o.hook };
  const hook = { spoken: str(hookRaw.spoken, 600), onScreen: str(hookRaw.onScreen ?? hookRaw.on_screen, 120) };
  const beats = (Array.isArray(o.beats) ? o.beats : [])
    .filter(isRec)
    .map((b) => ({
      label: str(b.label, 80),
      spoken: str(b.spoken ?? b.voiceover ?? b.text, 800),
      onScreen: str(b.onScreen ?? b.on_screen, 120) || undefined,
      visual: str(b.visual, 300) || undefined,
      seconds: num(b.seconds),
    }))
    .filter((b) => b.spoken)
    .slice(0, 10);
  if (!hook.spoken || !beats.length) throw new Error("The model returned an unusable reel plan");
  return {
    title: str(o.title, 120) || "Reel script",
    hook,
    beats,
    cta: str(o.cta, 400),
    caption: str(o.caption, 2200),
    hashtags: hashtags(o.hashtags),
    whyItWorks: strList(o.whyItWorks ?? o.why_it_works, 6, 300),
  };
}

export function parseCarouselPlan(text: string): CarouselPlan {
  const o = jsonObject(text);
  const slides = (Array.isArray(o.slides) ? o.slides : [])
    .filter(isRec)
    .map((s, i) => ({
      n: num(s.n) ?? i + 1,
      headline: str(s.headline ?? s.title, 160),
      body: str(s.body ?? s.text, 600),
      visual: str(s.visual, 300) || undefined,
    }))
    .filter((s) => s.headline || s.body)
    .slice(0, 12)
    .map((s, i) => ({ ...s, n: i + 1 }));
  if (slides.length < 2) throw new Error("The model returned an unusable carousel plan");
  return {
    title: str(o.title, 120) || "Carousel",
    slides,
    caption: str(o.caption, 2200),
    hashtags: hashtags(o.hashtags),
    whyItWorks: strList(o.whyItWorks ?? o.why_it_works, 6, 300),
  };
}

export function parseAdPlan(text: string): AdPlan {
  const o = jsonObject(text);
  const variants = (Array.isArray(o.variants) ? o.variants : [])
    .filter(isRec)
    .map((v) => ({
      angle: str(v.angle, 120),
      hook: str(v.hook, 300),
      primaryText: str(v.primaryText ?? v.primary_text ?? v.body, 1500),
      headline: str(v.headline, 120),
      description: str(v.description, 200),
      cta: str(v.cta, 120),
    }))
    .filter((v) => v.primaryText)
    .slice(0, 5);
  if (!variants.length) throw new Error("The model returned an unusable ad plan");
  return {
    title: str(o.title, 120) || "Ad copy",
    variants,
    whyItWorks: strList(o.whyItWorks ?? o.why_it_works, 6, 300),
  };
}

export function parseFreePlan(text: string): FreePlan {
  const o = jsonObject(text);
  const markdown = str(o.markdown ?? o.content ?? o.body, 40_000);
  if (!markdown) throw new Error("The model returned an empty draft");
  return { title: str(o.title, 120) || "Draft", markdown };
}

export const PLAN_PARSERS: { [K in DraftKind]: (text: string) => DraftPlan } = {
  reel: (t) => ({ kind: "reel", plan: parseReelPlan(t) }),
  carousel: (t) => ({ kind: "carousel", plan: parseCarouselPlan(t) }),
  ad: (t) => ({ kind: "ad", plan: parseAdPlan(t) }),
  free: (t) => ({ kind: "free", plan: parseFreePlan(t) }),
};
