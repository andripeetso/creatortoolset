import type { Comment } from "./types";

/**
 * Source packs for generation: one post's Markdown, trimmed so a handful of
 * long reels with hundreds of comments still fit one model call.
 */

export const PACK_DEFAULTS = {
  perPost: 12_000,
  total: 40_000,
  topComments: 40,
  repliesPer: 2,
  /** A shortened pack never drops below this many characters (header + caption + hook survive). */
  minKeep: 1_500,
};

export interface PackBudget {
  perPost?: number;
  total?: number;
  minKeep?: number;
}

export const SHORTENED_NOTE = "_[Source shortened to fit the reading budget]_";

/**
 * The comments worth reading: no junk, most worth reading first (Jev's
 * score when there is one, then likes), a couple of replies each.
 */
export function selectTopComments(
  list: Comment[],
  max = PACK_DEFAULTS.topComments,
  repliesPer = PACK_DEFAULTS.repliesPer,
): Comment[] {
  const score = (c: Comment) => c.judged?.worth ?? -1;
  const byWorth = (a: Comment, b: Comment) =>
    score(b) - score(a) ||
    b.likeCount - a.likeCount ||
    b.replyCount - a.replyCount ||
    a.createdAt - b.createdAt;
  return list
    .filter((c) => !c.lowValue)
    .sort(byWorth)
    .slice(0, max)
    .map((c) => ({
      ...c,
      replies: (c.replies ?? []).filter((r) => !r.lowValue).sort(byWorth).slice(0, repliesPer),
    }));
}

export function truncateMarkdown(md: string, max: number): { text: string; truncated: boolean } {
  if (md.length <= max) return { text: md, truncated: false };
  let cut = md.lastIndexOf("\n", max);
  if (cut < max * 0.6) cut = max;
  return { text: `${md.slice(0, cut).trimEnd()}\n\n${SHORTENED_NOTE}\n`, truncated: true };
}

export interface Packable {
  chars: number;
  markdown: string;
}

/**
 * Cap each pack, then share the total budget: small packs are left alone,
 * big ones give up characters in proportion to their size above the floor.
 */
export function fitPacks<T extends Packable>(
  packs: T[],
  budget: PackBudget = {},
): { packs: (T & { truncated: boolean })[]; warning?: string } {
  const perPost = budget.perPost ?? PACK_DEFAULTS.perPost;
  const total = budget.total ?? PACK_DEFAULTS.total;
  const minKeep = Math.min(budget.minKeep ?? PACK_DEFAULTS.minKeep, perPost);
  const apply = (p: T, max: number): T & { truncated: boolean } => {
    const { text, truncated } = truncateMarkdown(p.markdown, max);
    return { ...p, markdown: text, chars: text.length, truncated };
  };
  let out = packs.map((p) => apply(p, perPost));
  const sum = out.reduce((n, p) => n + p.chars, 0);
  if (sum > total) {
    const floors = out.map((p) => Math.min(p.chars, minKeep));
    if (floors.reduce((n, f) => n + f, 0) > total) {
      throw new Error("Too many sources for one generation — remove some");
    }
    const flexible = out.filter((p, i) => p.chars > floors[i]!);
    const fixed = out.filter((p, i) => p.chars <= floors[i]!).reduce((n, p) => n + p.chars, 0);
    const spare = total - fixed - flexible.length * minKeep;
    const above = flexible.reduce((n, p) => n + (p.chars - minKeep), 0);
    out = out.map((p, i) => {
      if (p.chars <= floors[i]!) return p;
      const share = above > 0 ? (spare * (p.chars - minKeep)) / above : 0;
      return apply(p, Math.floor(minKeep + share));
    });
  }
  const shortened = out.filter((p) => p.truncated).length;
  return {
    packs: out,
    warning: shortened
      ? `${shortened} of ${out.length} source${out.length === 1 ? "" : "s"} shortened to fit the ${Math.round(total / 1000)}k-character reading budget.`
      : undefined,
  };
}
