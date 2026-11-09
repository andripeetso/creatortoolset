import type { Comment } from "../instagram/types";
import { QUESTION_MIN } from "../instagram/comment-judge";
import { OUTSIDE } from "./folder";

/**
 * Answering the post's comments on a share link. Its own thread, apart from the session's chat, but it reads that chat: "a lot of caveats
 * come out that might not be reflected in the post but gives the why". It only answers; nothing is edited.
 */

export interface AnswerMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  /** The comment Reply was clicked on. */
  commentId?: string;
  usage?: { tokens: number; costUsd: number };
}

/** sessions/<id>/answers.json */
export interface AnswersFile {
  comments: Comment[];
  fetchedAt?: number;
  /** The posts they were read from, in the session's order; a different set is read again. */
  shortcodes?: string[];
  /** Files saved before a session could have several posts: the one post they were read from. Read as `shortcodes`. */
  shortcode?: string;
  thread: AnswerMessage[];
}

/** One comment (or reply) as the share page lists it. */
export interface ListedComment {
  id: string;
  user: string;
  text: string;
  at: number;
  likes: number;
  question: boolean;
  /** The account already replied under it. */
  answered: boolean;
  /** Under which comment, for a reply. */
  parentId?: string;
}

/** A real question to answer: the judge's read, or a question mark when it hasn't judged. */
export const isQuestion = (c: Comment) => (c.judged ? c.judged.needsAnswer >= QUESTION_MIN : c.text.includes("?"));

export function listComments(comments: Comment[], handle?: string): ListedComment[] {
  const mine = (c: Comment) => !!handle && c.user.username.toLowerCase() === handle;
  const out: ListedComment[] = [];
  const row = (c: Comment, answered: boolean, parentId?: string): ListedComment => ({
    id: c.id,
    user: c.user.username,
    text: c.text,
    at: c.createdAt,
    likes: c.likeCount,
    question: !mine(c) && isQuestion(c),
    answered,
    ...(parentId ? { parentId } : {}),
  });
  for (const c of comments) {
    if (mine(c)) continue;
    const replies = c.replies ?? [];
    out.push(row(c, replies.some(mine)));
    replies.forEach((r, i) => {
      if (!mine(r)) out.push(row(r, replies.slice(i + 1).some(mine), c.id));
    });
  }
  return out;
}

export interface AnswerPromptInput {
  /** Each piece: its kind, title, the slides or script, the post description, the pinned comment. */
  pieces: string[];
  notes: string;
  /** The session's chat, oldest first, pasted text included. */
  chat: Array<{ role: "user" | "assistant"; text: string }>;
  comments: Comment[];
  handle?: string;
  /** The account's earlier replies to comments on its posts. */
  replies: Array<{ comment: string; reply: string }>;
  thread: AnswerMessage[];
  question: string;
  /** The comment Reply was clicked on. */
  comment?: Comment;
}

/** The session's chat is long; its newest messages go in up to this many characters. */
export const CHAT_BUDGET = 150_000;

const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");
const commentLine = (c: Comment) => `@${c.user.username}: ${c.text}`;

export function buildAnswerPrompt(input: AnswerPromptInput): { system: string; user: string } {
  const system = `The author posted this and is answering the comments on it. You see the post as written, the author's notes, the conversation the post was made in (the research, the caveats and the reasons behind its lines), the comments, and the author's earlier replies to comments on their posts. Answer what the author asks. When they click Reply on a comment, write the reply they could post under it. You can't change the post or anything in the session. Plain text.`;
  const parts: string[] = [];
  parts.push(`# The post\n\n${input.pieces.join("\n\n---\n\n") || "(no text)"}`);
  if (input.notes.trim()) parts.push(`# The author's notes\n\n${input.notes.trim()}`);
  let room = CHAT_BUDGET;
  const kept: string[] = [];
  for (const m of [...input.chat].reverse()) {
    const line = `${m.role === "user" ? "Author" : "AI"}: ${m.text.trim()}`;
    if (line.length > room) break;
    room -= line.length;
    kept.unshift(line);
  }
  if (kept.length) {
    const hidden = input.chat.length - kept.length;
    parts.push(`# The conversation the post was made in${hidden ? ` (${hidden === 1 ? "1 earlier message is" : `${hidden} earlier messages are`} not shown)` : ""}\n\n${kept.join("\n\n")}`);
  }
  if (input.comments.length) {
    const rows = input.comments.flatMap((c) => [commentLine(c), ...(c.replies ?? []).map((r) => `  ↳ ${commentLine(r)}`)]);
    parts.push(`# Comments on the post${input.handle ? ` (@${input.handle} is the author)` : ""}\n\n${OUTSIDE}\n\n${quote(rows.join("\n"))}`);
  }
  if (input.replies.length) {
    parts.push(`# The author's earlier replies to comments\n\n${input.replies.map((r) => `${quote(r.comment)}\nAuthor: ${r.reply}`).join("\n\n")}`);
  }
  if (input.thread.length) {
    parts.push(`# This side chat so far\n\n${input.thread.map((m) => `${m.role === "user" ? "Author" : "You"}: ${m.text}`).join("\n\n")}`);
  }
  const ask = input.comment
    ? `Reply to this comment:\n${quote([commentLine(input.comment), ...(input.comment.replies ?? []).map((r) => `  ↳ ${commentLine(r)}`)].join("\n"))}${input.question ? `\n\nAuthor: ${input.question}` : ""}`
    : `Author now: ${input.question}`;
  parts.push(ask);
  return { system, user: parts.join("\n\n") };
}
