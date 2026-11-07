import { ask, choice } from "../jev";

/**
 * "What works on your account": Jev labels every post with a hook type,
 * a format and a call to action from fixed lists, and code compares how
 * the posts behind each label performed. Fixed lists (not free-text tags)
 * are what make the labels countable.
 */

export const HOOKS = {
  question: "Opens with a question to the viewer.",
  "bold claim": "Opens with a strong or surprising statement presented as fact.",
  "myth or mistake": "Opens by calling out a common belief, mistake or warning.",
  story: "Opens with a personal story or moment (\"My kid…\", \"When we…\").",
  "how-to promise": "Promises to show how to do something or what to do.",
  "result or proof": "Opens with a result, milestone, study or before-and-after.",
  "relatable moment": "Opens with a situation the audience recognises from their own life.",
  "direct callout": "Speaks straight to a group (\"If you…\", \"Parents of…\", \"Every runner…\").",
} as const;

export const FORMATS = {
  "talking head": "The creator speaking to camera explains or argues a point.",
  demonstration: "Shows something being done, step by step.",
  "story or vlog": "Follows a personal story or a slice of family life.",
  "list or tips": "A numbered list or set of tips.",
  "reaction or reply": "Responds to a comment, another video, a claim or a trend.",
  "research explainer": "Walks through a study, statistic or expert finding.",
  "product or program": "About the creator's own program, app, guide or an offer.",
} as const;

export const CTAS = {
  "comment keyword": "Asks viewers to comment a word to get something sent to them.",
  follow: "Asks viewers to follow.",
  "link in bio": "Sends viewers to the bio, profile or a link.",
  "save or share": "Asks viewers to save or share the post.",
  "question to answer": "Asks viewers to answer a question in the comments.",
  none: "No call to action.",
} as const;

export type Hook = keyof typeof HOOKS;
export type Format = keyof typeof FORMATS;
export type Cta = keyof typeof CTAS;

export interface PostLabel {
  hook: Hook;
  format: Format;
  cta: Cta;
  /** Jev's confidence in each pick, 0–1. */
  confidence: { hook: number; format: number; cta: number };
  /** Version of the lists above, so a change relabels old posts. */
  v: number;
}

export const LABELS_VERSION = 1;

/** Posts per Jev request (three questions each). */
const BATCH = 10;

/**
 * Label posts from their text (caption, plus transcript when there is one). `creator` is the account's own line (its
 * handle and bio), never one fixed creator. The lists' wording is generic; their keys and
 * LABELS_VERSION are unchanged, so existing labels stand.
 */
export async function labelPosts(
  key: string,
  posts: { id: string; text: string }[],
  creator: string,
  signal?: AbortSignal,
): Promise<Map<string, PostLabel>> {
  const out = new Map<string, PostLabel>();
  const batches: { id: string; text: string }[][] = [];
  for (let i = 0; i < posts.length; i += BATCH) batches.push(posts.slice(i, i + BATCH));
  await Promise.all(
    batches.map(async (batch) => {
      const questions: Record<string, ReturnType<typeof choice>> = {};
      batch.forEach((p, k) => {
        const quoted = `Post ${k + 1}:\n"""${p.text.slice(0, 1500)}"""`;
        // the opening decides the hook; the rest is context, not a rule
        questions[`hook${k}`] = choice(`${quoted}\nWhich hook does this post open with? Judge the first line or two; the rest is context.`, HOOKS);
        questions[`format${k}`] = choice(`${quoted}\nWhat format is this post?`, FORMATS);
        questions[`cta${k}`] = choice(`${quoted}\nWhat does the post ask viewers to do? Pick "none" unless it clearly asks.`, CTAS);
      });
      const answers = await ask(key, { creator }, questions, signal);
      batch.forEach((p, k) => {
        const pick = <T extends string>(key: string, allowed: Record<T, string>, fallback: T) => {
          const a = answers[`${key}${k}`];
          const c = a?.choice as T | undefined;
          return {
            value: c && c in allowed ? c : fallback,
            confidence: typeof a?.confidence === "number" ? a.confidence : 0,
          };
        };
        const hook = pick("hook", HOOKS, "bold claim");
        const format = pick("format", FORMATS, "talking head");
        const cta = pick("cta", CTAS, "none");
        out.set(p.id, {
          hook: hook.value,
          format: format.value,
          cta: cta.value,
          confidence: { hook: hook.confidence, format: format.confidence, cta: cta.confidence },
          v: LABELS_VERSION,
        });
      });
    }),
  );
  return out;
}

export interface PerformanceRow {
  label: string;
  posts: number;
  /** Median of each post's views ÷ the median views of comparable posts. */
  lift: number;
  verdict: "better" | "worse" | "similar" | "too few";
  /** Shortcodes of the best-performing posts with this label. */
  top: string[];
}

export interface PerformanceInput {
  id: string;
  /** Posts are only compared within the same group (e.g. "reel/public"). */
  group: string;
  views: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Fewer posts than this and a label says "too few" instead of a verdict. */
export const MIN_POSTS = 5;

/**
 * How each label performs. Each post's lift is its views over the median
 * views of its group (so trial reels aren't compared with public ones);
 * a label's lift is the median lift of its posts.
 */
export function performanceBy(
  posts: PerformanceInput[],
  labelOf: (id: string) => string | undefined,
): PerformanceRow[] {
  const groupMedian = new Map<string, number>();
  const byGroup = new Map<string, number[]>();
  for (const p of posts) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p.views]);
  for (const [g, views] of byGroup) groupMedian.set(g, median(views));

  const rows = new Map<string, { lifts: number[]; posts: { id: string; lift: number }[] }>();
  for (const p of posts) {
    const label = labelOf(p.id);
    const base = groupMedian.get(p.group) ?? 0;
    if (!label || base <= 0) continue;
    const lift = p.views / base;
    const row = rows.get(label) ?? { lifts: [], posts: [] };
    row.lifts.push(lift);
    row.posts.push({ id: p.id, lift });
    rows.set(label, row);
  }
  return [...rows]
    .map(([label, r]) => {
      const lift = median(r.lifts);
      const verdict: PerformanceRow["verdict"] =
        r.lifts.length < MIN_POSTS ? "too few" : lift >= 1.3 ? "better" : lift <= 0.75 ? "worse" : "similar";
      return {
        label,
        posts: r.lifts.length,
        lift: Math.round(lift * 100) / 100,
        verdict,
        top: r.posts.sort((a, b) => b.lift - a.lift).slice(0, 3).map((x) => x.id),
      };
    })
    .sort((a, b) => b.posts - a.posts);
}
