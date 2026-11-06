import { ask, choice, noul, typesafeConfigured, yes } from "../jev";
import { annotateLowValue } from "./comment-filter";
import type { Comment, CommentJudgment } from "./types";

/**
 * Jev (TypeSafe) reads each comment on a post and answers three closed
 * questions about it: what kind of comment it is, how likely it is worth
 * the creator's time, and how likely it is a real question the creator
 * could answer. The two likelihoods are probabilities (0–1), so code
 * hides comments under a threshold and ranks the rest.
 */

export const COMMENT_KINDS = {
  question: "Asks the creator something they could answer (advice, how, why, what about my situation).",
  pushback: "Disagrees, doubts or challenges the post or the creator.",
  story: "Shares the commenter's own experience or their child's.",
  praise: "Thanks, agrees or compliments, without much else.",
  keyword: "Just a word or two replying to a call to action to get something sent to them (a guide, a link, a program) — e.g. \"Guide\", \"Blueprint\", \"Recipe\".",
  other: "Tags a friend, jokes, emoji or a short reaction.",
  spam: "Promotion, bots, scams or unrelated links.",
} as const;

export type CommentKind = keyof typeof COMMENT_KINDS;
export type { CommentJudgment };

/**
 * Under this "worth reading" probability a judged comment is hidden (one
 * click shows it). Set from 100 real comments: below it sat emoji, tags,
 * "Beautiful", spam and keyword replies, plus a few one-line jabs.
 */
export const WORTH_MIN = 0.2;
/** A comment counts as a question to answer from this probability. */
export const QUESTION_MIN = 0.6;

/** Comments per Jev request (three questions each). */
const BATCH = 20;

/** Who posted it: the post's own handle (a library post is someone else's), never one fixed creator. */
const creatorLine = (handle?: string) => (handle ? `@${handle}, the creator who posted this.` : "The creator who posted this.");

/** Words the caption asks people to comment ("Comment BABY MOVEMENT and…"). */
export function captionKeywords(caption: string | undefined): string[] {
  const out: string[] = [];
  const re = /comment\s+["“']?([A-Za-z][A-Za-z ]{0,24}?)["”']?(?=\s+(?:and|to|for|below|if|&)|[,.!:\n]|$)/gi;
  for (const m of (caption ?? "").matchAll(re)) out.push(m[1].trim().toLowerCase());
  return out;
}

const bare = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, "").trim();

/** Judge a post's comments. Returns judgments keyed by comment id. */
export async function judgeComments(
  post: { caption?: string; handle?: string },
  comments: { id: string; text: string }[],
  signal?: AbortSignal,
): Promise<Map<string, CommentJudgment>> {
  const out = new Map<string, CommentJudgment>();
  const todo = comments.filter((c) => c.text.trim());
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const questions: Record<string, ReturnType<typeof noul> | ReturnType<typeof choice>> = {};
    batch.forEach((c, k) => {
      const quoted = `Comment ${k + 1}: "${c.text.slice(0, 600)}"`;
      questions[`kind${k}`] = choice(
        `${quoted}\nWhat kind of comment is this?`,
        COMMENT_KINDS,
      );
      questions[`worth${k}`] = noul(
        `${quoted}\nIs this comment worth the creator's time to read — a real question, a thoughtful story, useful pushback or specific feedback — rather than a generic reaction, tag, emoji or spam?`,
      );
      questions[`answer${k}`] = noul(
        `${quoted}\nIs this a genuine question the creator could answer (for this commenter or in a reply video), not rhetorical and not aimed at another commenter?`,
      );
    });
    const answers = await ask(
      { creator: creatorLine(post.handle), post: (post.caption ?? "").slice(0, 800) },
      questions,
      signal,
    );
    const keywords = captionKeywords(post.caption);
    batch.forEach((c, k) => {
      const picked = answers[`kind${k}`]?.choice as CommentKind | undefined;
      // the caption named the keyword and the comment is just that word
      const kind: CommentKind = keywords.includes(bare(c.text))
        ? "keyword"
        : picked && picked in COMMENT_KINDS
          ? picked
          : "other";
      out.set(c.id, {
        kind,
        worth: yes(answers[`worth${k}`]),
        needsAnswer: yes(answers[`answer${k}`]),
      });
    });
  }
  return out;
}

export interface CommentsTally {
  filteredOut: number;
  questions: number;
  keywords: number;
}

/**
 * Mark a post's comments: Jev judges any comment (or reply) not judged
 * yet, and its "worth reading" score decides what's hidden. Without a
 * TypeSafe key, or when Jev fails, the word-count filter decides as
 * before. Mutates the comments in place, like annotateLowValue.
 */
export async function annotateComments(
  comments: Comment[],
  post: { caption?: string; handle?: string },
  signal?: AbortSignal,
): Promise<CommentsTally> {
  annotateLowValue(comments);
  const all: Comment[] = [];
  const walk = (list: Comment[]) => {
    for (const c of list) {
      all.push(c);
      if (c.replies?.length) walk(c.replies);
    }
  };
  walk(comments);
  const todo = all.filter((c) => !c.judged);
  if (todo.length && typesafeConfigured()) {
    try {
      const judged = await judgeComments(post, todo, signal);
      for (const c of todo) {
        const j = judged.get(c.id);
        if (j) c.judged = j;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn(`[comments] Jev judge failed, keeping the word filter: ${e instanceof Error ? e.message : e}`);
    }
  }
  const tally: CommentsTally = { filteredOut: 0, questions: 0, keywords: 0 };
  for (const c of all) {
    if (c.judged) c.lowValue = c.judged.worth < WORTH_MIN;
    if (c.lowValue) tally.filteredOut++;
    if (c.judged?.kind === "keyword") tally.keywords++;
    if (c.judged && c.judged.needsAnswer >= QUESTION_MIN) tally.questions++;
  }
  return tally;
}
