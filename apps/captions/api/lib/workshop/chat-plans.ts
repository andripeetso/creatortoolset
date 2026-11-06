import { isHookId, type EditOp } from "./doc";
import { jsonObject } from "./plans";
import type { DocKind, SourcePart } from "./types";

/** What one chat turn must return. Strict: an unusable answer moves to the next provider. */
export interface TurnPlan {
  reply: string;
  edits: EditOp[];
  /** Parts of sources the model wants pulled in before it finishes the turn. */
  fetch?: Array<{ source: string; parts: SourcePart[] }>;
  newDocument?: { kind: Exclude<DocKind, "notes">; title: string };
  revertTo?: string;
  /** A library search the model wants run, results go back to the author as suggestions. */
  search?: string;
  /** Web research: quick runs now and feeds back into the turn; deep becomes a proposal. */
  research?: { question: string; depth: "quick" | "deep" };
  /** The model wants the whole piece fact-checked — a proposal for the author. */
  audit?: "quick" | "deep";
}

const PARTS = new Set<string>(["slides", "transcript", "caption", "comments"]);

export const isKnowledgeFetchSource = (source: string): boolean => {
  const s = source.trim();
  return /^K\d+$/i.test(s) || /\.(md|txt|markdown|text)$/i.test(s);
};

export const isAccountFetchSource = (source: string): boolean => {
  const s = source.trim();
  return /^account$/i.test(s) || /^instagram$/i.test(s) || /^@[\w.]+$/i.test(s);
};

const NEW_KINDS = new Set<string>(["reel", "carousel", "ad", "free", "youtube"]);
const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const BLOCK_ID = /^b\d{1,5}$/;
const HOOK_ID = /^h\d{1,5}$/;

/** A ? that is not inside a URL — an audience question, not a query string. */
export function isAudienceQuestion(text: string): boolean {
  return /\?/.test(text.replace(/https?:\/\/\S+/gi, ""));
}

/** This turn asked to write or change the post description, not just the piece. */
export function askedForCaption(message: string): boolean {
  return /\b(post descriptions?|descriptions?|write (?:the |a )?captions?|generate (?:the |a )?captions?|(?:the |a |in the |this |my |your )captions?)\b/i.test(message);
}

/** This turn asked to write or change the pinned comment, not just the piece. */
export function askedForPinned(message: string): boolean {
  return /\b(pinned comment|pin(?:ned)? comment|pin it|pin this|the pin|in the pin|first comment)\b/i.test(message);
}

function askedForAnotherTake(message: string): boolean {
  return /\b(another( one)?|different take|try again|not this|other angle)\b/i.test(message);
}

/** The message pastes or quotes the field — they are revising that text, even without naming it. */
function quotesField(message: string, current: string): boolean {
  const text = current.replace(/\s+/g, " ").trim();
  if (text.length < 24) return false;
  return message.replace(/\s+/g, " ").includes(text.slice(0, Math.min(80, text.length)));
}

/** Asked for the caption and nothing about the slides or the pin. */
export function askedOnlyForCaption(message: string): boolean {
  return askedForCaption(message) && !/\b(slides?|blocks?|hooks?|script|pieces?|carousel|reels?|beats?|draft)\b/i.test(message);
}

/**
 * Description and pin are opt-in and never a question. Drafting the piece
 * does not fill them. A question replacing a question is cleared; a
 * question against real text is ignored so a good caption or sell link
 * is not wiped.
 */
export function gateCompanionEdits(
  edits: EditOp[],
  ctx: { message: string; caption: string; pinned: string },
): EditOp[] {
  const captionOnly = askedOnlyForCaption(ctx.message);
  const out: EditOp[] = [];
  for (const e of edits) {
    if (captionOnly && e.op !== "set_caption") continue;
    if (e.op !== "set_caption" && e.op !== "set_pinned") {
      out.push(e);
      continue;
    }
    const next = e.text.trim();
    if (!next) {
      out.push(e);
      continue;
    }
    const current = e.op === "set_caption" ? ctx.caption : ctx.pinned;
    if (isAudienceQuestion(next)) {
      if (isAudienceQuestion(current)) out.push({ op: e.op, text: "" });
      continue;
    }
    const asked =
      e.op === "set_caption"
        ? askedForCaption(ctx.message) || (!!ctx.caption.trim() && (askedForAnotherTake(ctx.message) || quotesField(ctx.message, ctx.caption)))
        : askedForPinned(ctx.message) || quotesField(ctx.message, ctx.pinned);
    if (!asked) continue;
    out.push(e);
  }
  return out;
}

/**
 * The edits for a document the turn just created. Nothing in it exists yet, so
 * an op that names a block or hook of the piece the author was on cannot land:
 * its text becomes a new slide when it is slide text, deletes are dropped, and
 * captions, pinned comments and hooks keep their meaning.
 */
export function editsForNewDocument(edits: EditOp[]): EditOp[] {
  const out: EditOp[] = [];
  for (const e of edits) {
    switch (e.op) {
      case "set_caption":
      case "set_pinned":
      case "append":
      case "add_hook":
        out.push(e);
        break;
      case "replace":
      case "insert_after":
      case "insert_before":
        if (!isHookId(e.id) && e.text.trim()) out.push({ op: "append", text: e.text });
        break;
      case "delete":
        break;
    }
  }
  return out;
}

export function parseEditOp(raw: unknown): EditOp | undefined {
  if (!isRec(raw)) return undefined;
  const op = str(raw.op ?? raw.type, 20);
  const id = str(raw.id ?? raw.block ?? raw.blockId, 12);
  const body = str(raw.text ?? raw.content, 4000);
  if (op === "set_caption" || op === "caption") return { op: "set_caption", text: body };
  if (op === "set_pinned" || op === "pinned") return { op: "set_pinned", text: body };
  if (op === "replace" && (id === "caption" || id === "pinned")) return { op: id === "caption" ? "set_caption" : "set_pinned", text: body };
  if ((op === "add_hook" || op === "append_hook" || op === "set_hook") && body && !HOOK_ID.test(id)) return { op: "add_hook", text: body.slice(0, 400) };
  if ((op === "replace" || op === "set_hook") && HOOK_ID.test(id) && body) return { op: "replace", id, text: body.slice(0, 400) };
  if (op === "delete" && HOOK_ID.test(id)) return { op: "delete", id };
  if (op === "append" && body) return { op, text: body };
  if ((op === "replace" || op === "insert_after" || op === "insert_before") && BLOCK_ID.test(id) && body) return { op, id, text: body };
  if (op === "delete" && BLOCK_ID.test(id)) return { op, id };
  return undefined;
}

/** newDocument as the model wrote it: undefined when malformed. */
export function parseNewDocument(raw: unknown): TurnPlan["newDocument"] {
  if (!isRec(raw)) return undefined;
  const kind = str(raw.kind, 20);
  if (!NEW_KINDS.has(kind)) return undefined;
  return { kind: kind as NonNullable<TurnPlan["newDocument"]>["kind"], title: str(raw.title, 120) || "Untitled" };
}

export function parseTurn(text: string): TurnPlan {
  const o = jsonObject(text);
  const reply = str(o.reply ?? o.message ?? o.answer, 4000);
  const rawEdits = Array.isArray(o.edits) ? o.edits : [];
  const edits: EditOp[] = [];
  for (const raw of rawEdits) {
    const op = parseEditOp(raw);
    if (op) edits.push(op);
  }
  const fetch: NonNullable<TurnPlan["fetch"]> = [];
  for (const raw of Array.isArray(o.fetch) ? o.fetch : []) {
    if (!isRec(raw)) continue;
    const source = str(raw.source ?? raw.ref ?? raw.id, 40);
    const parts = [...new Set((Array.isArray(raw.parts) ? raw.parts : [raw.part]).map((x) => str(x, 20)).filter((x) => PARTS.has(x)))] as SourcePart[];
    if (!source) continue;
    if (isKnowledgeFetchSource(source) || isAccountFetchSource(source)) fetch.push({ source, parts });
    else if (parts.length) fetch.push({ source, parts });
  }
  // needComments from older answers: the same thing as pulling every source's comments
  if (o.needComments === true) fetch.push({ source: "*", parts: ["comments"] });
  const newDocument = parseNewDocument(o.newDocument);
  const revertTo = str(o.revertTo, 12);
  const needComments = fetch.length > 0;
  const rawSearch = str(o.search ?? o.librarySearch, 80);
  const search = rawSearch.length >= 2 ? rawSearch : "";
  let research: TurnPlan["research"];
  if (isRec(o.research)) {
    const question = str(o.research.question ?? o.research.query, 500);
    if (question.length >= 3) research = { question, depth: o.research.depth === "deep" ? "deep" : "quick" };
  } else if (typeof o.research === "string" && o.research.trim().length >= 3) {
    research = { question: str(o.research, 500), depth: "quick" };
  }
  const audit: TurnPlan["audit"] = o.audit === "deep" ? "deep" : o.audit === "quick" || o.audit === true ? "quick" : undefined;
  if (!reply && !edits.length && !newDocument && !revertTo && !search && !needComments && !research && !audit) throw new Error("The model returned neither a reply nor edits");
  return {
    reply: reply || (edits.length ? "Done." : search ? "Let me look in the library." : needComments ? "Pulling that in." : research ? "Let me check that." : audit ? "Worth a fact-check." : ""),
    edits,
    ...(fetch.length ? { fetch } : {}),
    ...(newDocument ? { newDocument } : {}),
    ...(/^v\d{1,5}$/.test(revertTo) ? { revertTo } : {}),
    ...(search ? { search } : {}),
    ...(research ? { research } : {}),
    ...(audit ? { audit } : {}),
  };
}
