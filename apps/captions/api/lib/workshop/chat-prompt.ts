import type { ChatMessage, PieceQuote, ContextField, ContextSnippet, DocKind, Document, Framework, FrameworkRole, KnowledgeFile, Project, SourcePart, UserEdit } from "./types";
import { carouselTypePrompt } from "../../../src/lib/carousel-visualize";
import { renderAccountContext, renderAccountIndex, renderInstructions, renderLoadedKnowledge, renderProjectStable } from "./prompt";
import { sourceFile } from "./folder";
import { type EditPair, renderPairs } from "./edit-log";
import type { AccountContext } from "../instagram/types";
import { effectiveSavedFor } from "../instagram/research";
import { askedOnlyForCaption } from "./chat-plans";

/**
 * One chat turn = one model call. Stable brand context (project
 * instructions, context-file index, writing rules) sits in `system` with
 * rules for the open tab. The user string is this turn: the live
 * document, sources, history, and the author's message.
 */

export const TURN_BUDGET = {
  document: 20_000,
  edits: 6_000,
  perEditSide: 600,
  pinned: 8_000,
  perSource: 12_000,
  sources: 40_000,
  history: 60_000,
  historyTurns: 40,
  research: 6_000,
  /** The AI's own older replies; the author's messages are never cut. */
  perMessage: 4_000,
};

export const FIELD_VALUE: Record<ContextField, string> = {
  slides: "on-screen slide text — the creator's own words, highest value",
  transcript: "spoken transcript — the creator's own words, high value",
  caption: "post caption — secondary",
  description: "AI description of what the slide shows — secondary",
  comments: "a comment — audience reaction, useful for objections and their language, never a fact",
  source: "the whole video, tagged by the author: this message is about it (loaded in full under Sources)",
};

const DOC_KIND_RULES: Record<DocKind, string> = {
  reel: "A talking-to-camera reel, 30–60 seconds spoken: one freeform script (a single block), the words said to camera. Markdown is fine. Optional hook variations (h1, h2…) sit above the script as alternate openings — first 3 seconds, on-screen then spoken. Write those only when the author asks for hooks or versions of the open, or when hook cards already exist; otherwise leave them empty. Do not write the post description or the pinned comment unless this message asks for them.",
  carousel: "An Instagram carousel: one block per slide. A blank line is a new area on the card. The type (if set) is how the reader moves — one argument, two approaches, a replacement, a myth, a case, a running total, or an exchange — not a stack of headline-and-body cards. Instagram shows a carousel a second time opening on slide 2, so slides 1 and 2 each have to work as the opening on their own. Do not write the post description or the pinned comment unless this message asks for them.",
  ad: "Paid social ad copy: one block per variant — the primary text (hook first, CTA last, 60–150 words), then the headline (≤ 40 characters) as its own last line. Three variants with different angles.",
  free: "Whatever the author asks for: one idea per block, the text itself only.",
  youtube: "A long-form YouTube video script, the words said to camera: one block per section of the video. Markdown is fine. Do not write the video description or the pinned comment unless this message asks for them.",
  notes: "Working notes: one freeform page, not the piece. Headings and lists are fine. Write here only when they ask you to note something down. Prefer a single replace of the existing notes (or one append if empty).",
};

const JSON_ENVELOPE = `Return exactly one JSON object and nothing else, keys in exactly this order (the author watches the reply and the edits arrive as you write them, so the reply comes first and newDocument / revertTo are written — as null when unused — before the edits):
{"reply": string, "newDocument": {"kind": "reel"|"carousel"|"ad"|"free"|"youtube", "title": string} | null, "revertTo": "v3" | null, "edits": [op, ...], "fetch": [{"source": "S2", "parts": ["transcript","comments"]}] | null, "search": string | null, "research": {"question": string, "depth": "quick"|"deep"} | null, "audit": "quick"|"deep"|null}`;

const OPS_BLOCK: Record<DocKind, string> = {
  reel: `Ops: {"op":"replace","id":"b3","text":"…"} · {"op":"insert_after","id":"b3","text":"…"} · {"op":"insert_before","id":"b3","text":"…"} · {"op":"append","text":"…"} · {"op":"delete","id":"b3"} · {"op":"add_hook","text":"…"} · {"op":"replace","id":"h1","text":"…"} · {"op":"delete","id":"h1"} · {"op":"set_caption","text":"…"} · {"op":"set_pinned","text":"…"} (an empty text clears caption/pinned)`,
  carousel: `Ops: {"op":"replace","id":"b3","text":"…"} · {"op":"insert_after","id":"b3","text":"…"} · {"op":"insert_before","id":"b3","text":"…"} · {"op":"append","text":"…"} · {"op":"delete","id":"b3"} · {"op":"set_caption","text":"…"} · {"op":"set_pinned","text":"…"} (an empty text clears caption/pinned)`,
  ad: `Ops: {"op":"replace","id":"b3","text":"…"} · {"op":"insert_after","id":"b3","text":"…"} · {"op":"insert_before","id":"b3","text":"…"} · {"op":"append","text":"…"} · {"op":"delete","id":"b3"} · {"op":"set_caption","text":"…"} · {"op":"set_pinned","text":"…"} (an empty text clears caption/pinned)`,
  free: `Ops: {"op":"replace","id":"b3","text":"…"} · {"op":"insert_after","id":"b3","text":"…"} · {"op":"insert_before","id":"b3","text":"…"} · {"op":"append","text":"…"} · {"op":"delete","id":"b3"} · {"op":"set_caption","text":"…"} · {"op":"set_pinned","text":"…"} (an empty text clears caption/pinned)`,
  youtube: `Ops: {"op":"replace","id":"b3","text":"…"} · {"op":"insert_after","id":"b3","text":"…"} · {"op":"insert_before","id":"b3","text":"…"} · {"op":"append","text":"…"} · {"op":"delete","id":"b3"} · {"op":"set_caption","text":"…"} · {"op":"set_pinned","text":"…"} (an empty text clears caption/pinned)`,
  notes: `Ops: {"op":"replace","id":"b3","text":"…"} · {"op":"append","text":"…"} · {"op":"delete","id":"b3"}`,
};

// What each field is for and when it is written. How it should read comes from the author's posts and the author's rewrites, never from here.
const DESCRIPTION_RULES = `- The post description (set_caption) and the pinned comment (set_pinned) are written when this message asks for them, one of each, into the field. A caption marked [you] is theirs: keep their wording and add what they asked.
- What the description is for: the slides state a claim boldly, and the description balances it and cites the sources. The slides carry the claim; the description is where a reader who wants more finds who found it, how solid it is and what it leaves open. Instagram shows its first line under the post and stops at 2,200 characters. Their own posted captions show how theirs read.
- The pinned comment is usually empty: the author uses it to sell or to put a fact in the first comment.`;

const KIND_RULES: Record<DocKind, string> = {
  reel: `This tab is a talking-to-camera reel: one freeform script (a single block), the words said to camera. Markdown is fine. Replace the existing page (or append if empty), do not split it into beats.
- Do not call add_hook while drafting the script unless this message asks for hook versions or hook cards already exist. When asked for another hook or a hook variation, call add_hook on this reel — do not create a new document.
${DESCRIPTION_RULES}`,
  carousel: `This tab is an Instagram carousel: one slide per block, one idea per block. A blank line is a new area on the card. Keep ids exactly as given. Prefer replace / insert over rewriting everything. Instagram shows a carousel a second time opening on slide 2, so slides 1 and 2 each have to work as the opening on their own.
${DESCRIPTION_RULES}`,
  ad: `This tab is paid social ad copy: one variant per block — the primary text (hook first, CTA last, 60–150 words), then the headline (≤ 40 characters) as its own last line. Three variants with different angles. One idea per block. Keep ids exactly as given. Prefer replace / insert over rewriting everything.
- Post description and pinned comment only if this message asks for them.`,
  free: `This tab is free-form: one idea per block, the text itself only. Keep ids exactly as given.
- Post description and pinned comment only if this message asks for them.`,
  youtube: `This tab is a long-form YouTube video script: the words said to camera, one block per section of the video. Keep ids exactly as given. Prefer replace / insert over rewriting everything.
- Video description (set_caption) and pinned comment only if this message asks for them.`,
  notes: `This tab is working notes: one freeform page, not the piece. Headings and lists are fine. Write here only when they ask you to note something down. Prefer a single replace of the existing notes (or one append if empty). Do not call set_caption or set_pinned.`,
};

/** How the pieces of a turn work. Not writing rules. */
const SHARED_RULES = `How this works:
- The document holds only the piece: plain text. No labels like "Slide 1" or "Beat 1", no notes, no commentary, no caveats. Analysis, notes and caveats go in the reply (or the Notes document, only when asked for notes).
- If the message is not something you can act on — a test, a greeting, one unclear word — answer in a sentence and make no edits.
- Blocks marked [you] carry the author's own wording. You may edit them when the request needs it; keep what their wording was doing. Never undo a change the author made. When the author has edited your text, work out what they changed and why.
- Blocks marked locked are ones the author approved: the app refuses any replace or delete on them, so build around them.
- When asked to try or apply a framework, apply it to the existing document and name what changed, so it can be reverted.
- When asked for another piece or a separate document (a carousel version, an ad version), set newDocument and put the edits (append) into it.
- When asked to revert, set revertTo to the version id (kept versions are named snapshots they want to return to) and change nothing else.
- Facts, numbers, studies and quotes come from the sources, the context files, the web research you ask for or the author. Never claim to have checked something you did not.`;

/** Without the folder (Claude on the API key): sources and context files arrive by fetch. */
const FETCH_RULES = `- Sources: you get an index of every source in the session — what each one has — with its on-screen slide text loaded. When you need more of a source, set fetch with the parts you want; they come back to you in this same turn (say what you are pulling, make no edits yet, finish when they arrive). Slide text and transcript are the creator's own words; the caption is secondary; comments are the audience talking — objections and their language, never facts. What you pull stays loaded for the rest of the session, so pull a part once. "*" as the source means every source.
- Sources marked kept for format are layout examples: their structure, pacing and hook device, not their topic or claims. Sources marked as the author's own post are their scripts.
- To look for more material in the author's library, set search to a short topic query (2–5 words); the results go back to the author as suggestions to add.
- To check something on the web, set research with one precise question: "quick" (about a minute) or "deep" (5–15 minutes of reading). Either one is asked of the author first and runs only if they say yes, so finish your answer without it. When a whole piece should be fact-checked claim by claim, set audit ("quick" or "deep").
- Project instructions are always-on. Context files are an index (K1, K2…), not loaded until you fetch [{"source":"K1"}] (or the file name); they are reference material, not a brief. Linked Instagram is an index — fetch [{"source":"account"}] for live followers, mix and bio.`;

/** On the Mac: a Claude Code session in a folder with everything. */
const FOLDER_GUIDE = `Your folder (Read, Glob and Grep it; it is everything there is):
- account.md — the author's Instagram account as the live snapshot shows it: followers, posts, posting pace, mix, bio.
- my-posts/INDEX.md — every post on the author's account, newest first, with views and saves + shares per 1,000 views (what people kept and sent on: the clearest sign a post landed), where the numbers came from, how each post opened, and the most saved and shared ones on top. my-posts/<date>-<code>.md — one post in full.
- channels/ — the project's other platforms (YouTube, TikTok, Facebook, X), when connected: followers and each recent post with its numbers.
- sources/ — this session's sources in full (S1, S2…), comments included.
- context/ — the author's knowledge (books, studies, old scripts, examples, brand facts): reference material, not a brief and not a list of angles to use. context/INDEX.md: what each file is, what it answers, its parts by line.
- sessions/ — every Workshop session: the pieces as they stand, the author's edits to the AI's text, and everything they said. THIS SESSION is marked.
- library/INDEX.md — the author's whole Analyzer library (other creators' posts they kept), a file per post.
- pasted/ — everything the author pasted into a Workshop chat as an attachment, whole.
- my-edits/INDEX.md — every time the author rewrote the AI's text: what it wrote and what they made it. The clearest evidence of how they want things said.
Look before you answer: what has the author already posted on this, how did it do, what have they said about it in earlier sessions. Their followers have seen what they posted: an angle they already used is old news to them unless the author asks for a remake. Then think it through yourself. You don't search the web on your own (owner: "it should ask me before launching a web search"): to check something on the web, set research to one precise question ("quick" about a minute, "deep" 5–15 minutes) and the author decides whether it runs. Your last message is the JSON object and nothing else; fetch stays null (everything is in the folder). search sends the author library suggestions; audit becomes a proposal.`;

const INTRO = `You are co-writing with the author. What they want from you is a piece they would post as it stands, in their own voice, that their followers save and send on. The document is the deliverable and nothing else: the script, the slides, the copy. Everything else — analysis, options, objections, questions, reasoning — goes in the reply, and only when the author asks or it is needed to do what they asked. You edit the document in place through operations; you never paste the piece into the reply. English.`;

/** System prompt for the open document tab. */
export function chatSystemFor(kind: DocKind, folder = false): string {
  return `${INTRO}\n\n${JSON_ENVELOPE}\n${OPS_BLOCK[kind]}\n\n${KIND_RULES[kind]}\n\n${SHARED_RULES}\n${folder ? `\n${FOLDER_GUIDE}` : FETCH_RULES}`;
}

/** @deprecated Use chatSystemFor(doc.kind). Reel-shaped, for tests that still import the constant. */
export const CHAT_SYSTEM = chatSystemFor("reel");

export interface TurnPromptInput {
  project?: Pick<Project, "name" | "audience" | "voice" | "cta" | "notes" | "knowledge">;
  /** Linked Instagram — listed, not loaded, until fetch account. */
  account?: AccountContext | null;
  /** Live snapshot pulled this turn via fetch account. */
  loadedAccount?: AccountContext | null;
  /** Context files pulled this turn via fetch K1 / filename. */
  loadedKnowledge?: KnowledgeFile[];
  frameworks: Array<Pick<Framework, "name" | "role" | "summary" | "steps" | "whenToUse">>;
  rules: string[];
  doc: Document;
  /** The session's other written pieces (another format of the same idea): read here, edits go to doc only. */
  others?: Document[];
  pinned: ContextSnippet[];
  /** Every source in the session: what it has, what is loaded (as markdown), which one is open. */
  sources: SourceView[];
  /** Findings from the web research the model asked for earlier in this turn. */
  research?: { question: string; answer: string; citations: string[] };
  history: ChatMessage[];
  message: string;
  /** "My words only": build the piece from what the author said, the app highlights every word they didn't. */
  mine?: boolean;
  /** The composer's slider: how much this message may change (unset = normal). */
  scope?: "slight" | "rewrite";
  /** Parts of the piece the author selected and commented on with this message. */
  quotes?: PieceQuote[];
  /** How the author rewrote the AI's text before (edit-log.ts): descriptions when asked for one, slides/hooks/script always. */
  rewrites?: { descriptions: EditPair[]; pieces: EditPair[] };
  /** The author's own posts closest to this piece in words, most saved and shared first (closest.ts). */
  closestPosts?: Array<{ date: string; keptPer1k?: number; file?: string; text: string }>;
  /** Asked for the post description: the author's own posted captions, most saved first, and how long theirs run. */
  captionExamples?: { examples: Array<{ text: string; keptPer1k: number }>; median: number; p90: number };
  /** A web search the author approved for this turn: the Mac session has WebSearch/WebFetch for it. */
  web?: string;
  /** Big pastes attached to this message, whole: a file in the folder on the Mac, inline otherwise. */
  pasted?: Array<{ name: string; text: string; file?: string }>;
  /** Pictures with this message, in order: a file in the folder on the Mac, else they ride along as images. */
  images?: Array<{ name: string; file?: string }>;
  /** Files with this message (PDFs), after the pictures: a file in the folder on the Mac. */
  files?: Array<{ name: string; file: string }>;
  /** Claude on the Mac reads a folder (folder.ts): sources and context files are files there, nothing is cut. */
  folder?: { contextFiles: string[] };
  /** The Mac's Claude session for this conversation is resumed: it holds the history and the sources it saw, so this turn
   * carries the new message, the document and what changed (newSources: sources added since its last turn). */
  resumed?: { newSources: Array<{ ref: string; handle: string }> };
}

/** What changed since a resumed session's last turn, as facts: the author's edits (listed above) and the sources added. */
function changedNote(doc: Document, newSources: Array<{ ref: string; handle: string }>): string {
  const edited = [...new Set((doc.userEdits ?? []).filter((e) => !e.seen).map((e) => e.blockId))];
  const lines = [
    ...(edited.length ? [`- the author edited: ${edited.join(", ")} (listed above)`] : []),
    ...newSources.map((s) => `- new source ${s.ref} (@${s.handle}), in ${sourceFile(s.ref, s.handle)}`),
  ];
  return lines.length ? `CHANGED since your last turn:\n${lines.join("\n")}` : "CHANGED since your last turn: no edits by the author, no new sources.";
}

export interface SourceView {
  /** S1, S2… the handle the model uses in fetch. */
  ref: string;
  /** The post's id, so a video cited in the message box finds its S-number. */
  postId?: string;
  handle: string;
  kind: string;
  url: string;
  note?: string;
  hook: string;
  has: { slides: number; transcript: number; caption: number; comments: number };
  loaded: SourcePart[];
  /** The loaded parts, packed. */
  markdown: string;
  savedFor?: Array<"content" | "format">;
  /** This post is from the author's (or the project's) own Instagram. */
  own?: boolean;
  open?: boolean;
  openSlide?: number;
  /** The author tagged this source in the message. */
  tagged?: boolean;
}

const PART_WORD: Record<SourcePart, string> = { slides: "slide text", transcript: "transcript", caption: "caption", comments: "comments" };

function keptForHead(savedFor?: Array<"content" | "format">): string {
  const tags = effectiveSavedFor(savedFor);
  const content = tags.includes("content");
  const format = tags.includes("format");
  if (format && content) return "\n  kept for: content and format";
  if (format) return "\n  kept for: format (layout only — do not use the topic or claims)";
  return "\n  kept for: content";
}

/** One source's line in the index: what it has, what is loaded. */
export function renderSourceHead(v: SourceView): string {
  const has: string[] = [];
  if (v.has.slides) has.push(`slide text ${v.has.slides} chars`);
  if (v.has.transcript) has.push(`transcript ${v.has.transcript} words`);
  if (v.has.caption) has.push(`caption ${v.has.caption} chars`);
  if (v.has.comments) has.push(`comments ${v.has.comments}`);
  const open = `${v.tagged ? " — tagged by the author: this message is about this one" : ""}${v.open ? ` — open on the author's screen${v.openSlide !== undefined ? ` at slide ${v.openSlide + 1}` : ""}` : ""}`;
  return `${v.ref} · @${v.handle} · ${v.kind} · ${v.url}${open}\n  hook: ${v.hook || "(none)"}\n  has: ${has.length ? has.join(" · ") : "nothing readable yet"}\n  loaded: ${v.loaded.length ? v.loaded.map((p) => PART_WORD[p]).join(", ") : "nothing"}${keptForHead(v.savedFor)}${v.own ? "\n  author's own post — remake this script, keep their voice" : ""}${v.note ? `\n  how to use it: ${v.note}` : ""}`;
}

const ROLE_WORD: Record<FrameworkRole, string> = {
  narrative: "shape — sets the order of the whole piece",
  persuasion: "persuasion — shapes how it asks",
  argument: "argument — shapes the reasoning",
};

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max).trimEnd()}\n…[shortened]`);
const quote = (s: string) => `«${cut(s, TURN_BUDGET.perEditSide).replace(/\n/g, " ")}»`;

export function renderDocument(doc: Document): string {
  const lines: string[] = [];
  if (doc.kind === "reel") {
    const hooks = doc.hooks ?? [];
    if (hooks.length) {
      lines.push("Hook variations:");
      for (const h of hooks) lines.push(`[${h.id} · ${h.author === "user" ? "you" : "ai"}] ${h.text}`);
    } else {
      lines.push("Hook variations: (none — leave empty unless this message asks for openings, or the author added cards)");
    }
  }
  lines.push(...doc.blocks.map((b) => `[${b.id} · ${b.author === "user" ? "you" : "ai"}${doc.locked?.includes(b.id) ? " · locked" : ""}] ${b.text}`));
  if (doc.kind !== "notes") {
    lines.push(doc.caption ? `[caption · ${doc.caption.author === "user" ? "you" : "ai"}] ${doc.caption.text}` : "[caption] (empty — leave empty unless this message asks for the description)");
    lines.push(doc.pinned ? `[pinned · ${doc.pinned.author === "user" ? "you" : "ai"}] ${doc.pinned.text}` : "[pinned] (empty — leave empty unless selling or occupying a comment)");
  }
  const listed = [...doc.versions].reverse();
  const recent = listed.slice(0, 8);
  const extraKept = listed.filter((v) => v.kept && !recent.some((r) => r.id === v.id));
  const latestId = listed[0]?.id;
  const versions = [...extraKept, ...recent].map((v) => {
    const where = v.id === doc.headVersion ? " (current)" : v.id === latestId ? " (latest)" : "";
    return `${v.id}${v.kept ? " kept" : ""}${where} — ${v.label}`;
  });
  return [
    `Document "${doc.title}" (${doc.kind})${doc.blocks.length ? "" : " — empty"}`,
    ...lines,
    ...(doc.kind === "notes"
      ? []
      : [versions.length ? `Versions: ${versions.join("; ")}${doc.headVersion || !doc.versions.length ? "" : " — the text has been edited since the latest"}` : "Versions: none yet"]),
  ].join("\n");
}

/** The author's edits, newest last: what the block was, what they made it. */
export function renderUserEdits(edits: UserEdit[]): string {
  const fresh = edits.filter((e) => !e.seen);
  const old = edits.filter((e) => e.seen);
  const line = (e: UserEdit) => {
    if (e.from === undefined) return `- ${e.blockId} added: ${quote(e.to ?? "")}`;
    if (e.to === undefined) return `- ${e.blockId} deleted (was ${e.fromAuthor === "user" ? "theirs" : "yours"}: ${quote(e.from)})`;
    return `- ${e.blockId} was (${e.fromAuthor === "user" ? "theirs" : "yours"}): ${quote(e.from)} → now: ${quote(e.to)}`;
  };
  const parts: string[] = [];
  if (fresh.length) {
    parts.push(
      `The author's edits since your last turn — work out why each was made (voice and rhythm, a fact, a logic fix, cutting fluff) and write everything else that way; never undo them:\n${fresh.map(line).join("\n")}`,
    );
  }
  if (old.length) parts.push(`Earlier edits you have already taken in:\n${old.map(line).join("\n")}`);
  return cut(parts.join("\n\n"), TURN_BUDGET.edits);
}

export function buildTurnPrompt(input: TurnPromptInput): { system: string; user: string } {
  const captionOnly = askedOnlyForCaption(input.message);
  const folder = input.folder;
  const systemBits: string[] = [chatSystemFor(input.doc.kind, !!folder)];
  const p = input.project;
  if (folder) {
    if (p) systemBits.push(renderInstructions(p));
    if (input.account) systemBits.push(`Author's Instagram: @${input.account.username} — every post is in my-posts/.`);
    if (folder.contextFiles.length) systemBits.push(`Context files: ${folder.contextFiles.map((f) => `context/${f}`).join(", ")}`);
  } else if (p) systemBits.push(renderProjectStable(p, input.account));
  else if (input.account) systemBits.push(renderAccountIndex(input.account));
  if (input.rules.length) systemBits.push(`Rules (they always apply):\n${input.rules.map((r) => `- ${r}`).join("\n")}`);

  const resumed = input.resumed;
  const blocks: string[] = [];
  if (input.loadedAccount && !resumed) blocks.push(renderAccountContext(input.loadedAccount));
  if (input.loadedKnowledge?.length && !resumed) blocks.push(renderLoadedKnowledge(input.loadedKnowledge));
  if (!captionOnly && folder && !input.frameworks.length && input.doc.kind !== "notes") blocks.push("Frameworks on this document: none picked by the author. All of theirs are in frameworks/ (INDEX.md: what each is and when it fits; a file each).");
  if (!captionOnly && input.frameworks.length) {
    blocks.push(
      [
        `Frameworks on this document (${input.frameworks.length}) — the shape sets the order, every step of each must be present:`,
        ...input.frameworks.map((f) => `${f.name} (${ROLE_WORD[f.role]})${f.summary ? ` — ${f.summary}` : ""}\n${f.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`),
      ].join("\n"),
    );
  }
  blocks.push(`Deliverable: ${DOC_KIND_RULES[input.doc.kind]}`);
  const typeLine = carouselTypePrompt(input.doc.carouselType);
  if (typeLine) blocks.push(typeLine);
  for (const o of input.others ?? []) blocks.push(`Another piece in this session, for reading (edits go only to the document below):\n${cut(renderDocument(o), TURN_BUDGET.document)}`);
  blocks.push(folder ? renderDocument(input.doc) : cut(renderDocument(input.doc), TURN_BUDGET.document));
  if (input.doc.userEdits?.length) blocks.push(renderUserEdits(input.doc.userEdits));
  if (input.pinned.length) {
    let used = 0;
    const items: string[] = [];
    for (const s of input.pinned) {
      const where = `@${s.handle}${s.slide !== undefined ? `, slide ${s.slide + 1}` : ""} — ${FIELD_VALUE[s.field]}`;
      const line = `- (${where})\n  ${s.text.replace(/\n/g, "\n  ")}`;
      if (used + line.length > TURN_BUDGET.pinned) break;
      items.push(line);
      used += line.length;
    }
    blocks.push(`Pinned by the author from the sources:\n${items.join("\n")}`);
  }
  if (resumed) {
    blocks.push(changedNote(input.doc, resumed.newSources));
  } else if (folder && input.sources.length) {
    blocks.push(`Sources in this session (${input.sources.length}), each in full in sources/:\n\n${input.sources.map((v) => `${renderSourceHead(v)}\n  file: ${sourceFile(v.ref, v.handle)}`).join("\n\n")}`);
  } else if (input.sources.length) {
    let used = 0;
    const items: string[] = [];
    for (const v of input.sources) {
      const head = renderSourceHead(v);
      const includeBody = !captionOnly || v.loaded.length > 0;
      const body = includeBody && v.markdown.trim() ? cut(v.markdown.trim(), TURN_BUDGET.perSource) : "";
      if (body && used + body.length > TURN_BUDGET.sources) {
        items.push(`${head}\n  (loaded text not shown this turn — budget; fetch again if you need it)`);
        continue;
      }
      items.push(body ? `${head}\n${body}` : head);
      used += body.length;
    }
    blocks.push(`Sources in this session (${input.sources.length}) — fetch pulls more parts of one (or "*" for all):\n\n${items.join("\n\n")}`);
  } else {
    blocks.push("Sources in this session: none — the author has not added any.");
  }
  if (input.research) {
    const sources = input.research.citations.slice(0, 12).map((u, i) => `[${i + 1}] ${u}`);
    blocks.push(
      `Research findings you asked for (from the web, this turn) — question: ${input.research.question}\n${cut(input.research.answer, TURN_BUDGET.research)}${sources.length ? `\nSources: ${sources.join("  ")}` : ""}\nUse them now: answer or edit with what they support, and say what they do not.`,
    );
  }
  // Newest first into the budget, so a long session drops its oldest turns, never the last ones. The author's words are never cut.
  // The folder turn too; the
  // whole conversation stays in sessions/, and every note of theirs is listed in full below.
  const recent = resumed ? [] : input.history.slice(-TURN_BUDGET.historyTurns);
  if (recent.length) {
    let used = 0;
    const lines: string[] = [];
    for (const m of [...recent].reverse()) {
      const who = m.role === "user" ? "Author" : m.review ? "A follower's read (another model, shown only the piece)" : "You";
      const note = m.role === "assistant" && m.edits?.blockIds.length ? ` (edited ${m.edits.blockIds.join(", ")})` : m.revertedTo ? ` (reverted to ${m.revertedTo})` : "";
      const pointed =
        (m.role === "user" && m.quotes?.length ? ` ${m.quotes.map((q) => `[about «${q.text}»${q.comment ? `: ${q.comment}` : ""}]`).join(" ")}` : "") +
        (m.role === "user" && m.pasted?.length ? ` [pasted: ${m.pasted.map((p) => `${p.name}, ${p.chars.toLocaleString("en-US")} characters${folder ? ", in pasted/" : ""}`).join("; ")}]` : "") +
        (m.role === "user" && m.images?.length ? ` [${m.images.length === 1 ? "a picture" : `${m.images.length} pictures`}: ${m.images.map((im) => im.name).join(", ")}]` : "") +
        (m.role === "user" && m.files?.length ? ` [${m.files.length === 1 ? "a file" : `${m.files.length} files`}: ${m.files.map((f) => f.name).join(", ")}]` : "");
      const line = `${who}${note}: ${m.role === "user" ? m.text : cut(m.text, TURN_BUDGET.perMessage)}${pointed}`;
      if (lines.length && used + line.length > TURN_BUDGET.history) break;
      lines.unshift(line);
      used += line.length;
    }
    // Say how many older messages are left out (the 40-turn slice or the budget); on the Mac they are in sessions/.
    const hidden = input.history.length - lines.length;
    const earlier = hidden
      ? ` (${hidden} earlier message${hidden === 1 ? "" : "s"} of this session ${hidden === 1 ? "is" : "are"} not shown here${folder ? "; the whole conversation is in this session's file in sessions/" : ""})`
      : "";
    blocks.push(`Conversation so far${earlier}:\n${lines.join("\n")}`);
  }
  // Their earlier notes on this piece sit right above the new one, so the newest note never quietly replaces the rest
  //. Every turn, a resumed one
  // too: restating every instruction so far each turn won back part of what models lose over long chats (Laban et al. 2025).
  const said = input.history.filter((m) => m.role === "user" && m.text.trim()).map((m) => m.text.trim());
  if (said.length >= 2) {
    blocks.push(`Everything the author said about this piece before this message, in their words. Each one still stands unless they took it back:\n${said.map((t) => `- ${t.replace(/\n+/g, " ")}`).join("\n")}`);
  }
  if (input.mine) {
    blocks.push(
      "My words only: the author wants this built from their own words, the messages in this conversation and this one. Pick, trim, order and join their sentences; don't write sentences of your own. Where two of their lines need a join, use as few words as you can. The app highlights every word they did not say.",
    );
  }
  if (input.closestPosts?.length && !resumed) {
    blocks.push(
      `The author's own posts closest to this piece, most saved and shared first:\n${input.closestPosts
        .map((p) => `--- ${p.date}${p.keptPer1k !== undefined ? ` · ${p.keptPer1k.toFixed(1)} saves + shares per 1,000 views` : ""}${p.file ? ` · ${p.file}` : ""}\n${cut(p.text.trim(), 700)}`)
        .join("\n")}\n---`,
    );
  }
  // the author's own setting for this message: how much of the piece it may change
  if (input.scope === "slight") blocks.push("Slight changes (the author's setting for this message): change only what this message points at, as little as it takes. Every other block, the caption and the hooks stay exactly as they are.");
  if (input.scope === "rewrite") blocks.push("Rewrite (the author's setting for this message): the whole piece is open, its opening and its order included.");
  if (input.rewrites?.pieces.length && !resumed) blocks.push(renderPairs(input.rewrites.pieces, "slides, hooks and scripts"));
  if (input.rewrites?.descriptions.length && !resumed) blocks.push(renderPairs(input.rewrites.descriptions, "post descriptions"));
  if (input.captionExamples?.examples.length) {
    const c = input.captionExamples;
    blocks.push(
      `How the author's own posted captions look, most saved and shared first (theirs run about ${c.median.toLocaleString("en-US")} characters; 9 in 10 are under ${c.p90.toLocaleString("en-US")}):\n${c.examples
        .map((e) => `---\n${e.text.trim()}`)
        .join("\n")}\n---`,
    );
  }
  if (input.web) {
    blocks.push(`The author approved one web search for this turn: «${input.web}». Search for it (WebSearch, WebFetch), then answer with what you found, and say what it doesn't support.`);
  }
  // Pasted slides in an empty carousel go in as written, never as a review.
  const intoEmpty =
    input.doc.kind !== "notes" && !input.doc.blocks.some((b) => b.text.trim())
      ? `\n\nThis ${input.doc.kind === "free" ? "document" : input.doc.kind} is still empty. If ${input.images?.length ? "these are" : "the paste is"} the piece itself (its slides or its script), put it in as written first: one block per slide${input.images?.length ? ", the words exactly as they are on each picture" : ""}, without labels like "Slide 1". If it is a different kind of piece than this tab, set newDocument of that kind. Then answer the message.`
      : "";
  if (input.pasted?.length) {
    blocks.push(
      `The author pasted this with the message, whole:\n\n${input.pasted
        .map((p) => (p.file ? `- ${p.name} (${p.text.length.toLocaleString("en-US")} characters): read ${p.file}` : `### ${p.name}\n${p.text}`))
        .join("\n\n")}${input.images?.length ? "" : intoEmpty}`,
    );
  }
  if (input.images?.length) {
    // the editor's slides as JPEGs, in the order they go
    const n = input.images.length;
    blocks.push(
      `The author attached ${n === 1 ? "a picture" : `${n} pictures`} with this message${n > 1 ? ", in this order" : ""}:\n${input.images
        .map((im, i) => `${i + 1}. ${im.name}${im.file ? `: read ${im.file} (the Read tool shows you the picture)` : ` (image ${i + 1} above)`}`)
        .join("\n")}\nLook at every one before you answer.${intoEmpty}`,
    );
  }
  if (input.files?.length) {
    const n = input.files.length;
    blocks.push(
      `The author attached ${n === 1 ? "a file" : `${n} files`} with this message:\n${input.files.map((f) => `- ${f.name}: read ${f.file} (the Read tool reads PDFs)`).join("\n")}`,
    );
  }
  if (input.quotes?.length) {
    const unit = input.doc.kind === "carousel" ? "slide" : "part";
    blocks.push(
      `The author cited these with this message${/⟦\d+⟧/.test(input.message) ? " (⟦n⟧ in their message is where citation n stands)" : ""}:\n${input.quotes
        .map((q, i) => {
          const n_ = `⟦${i + 1}⟧ `;
          if (q.from === "reply") return `- ${n_}from your earlier reply: «${q.text}»${q.comment ? `\n  their note: ${q.comment.replace(/\n+/g, " ")}` : ""}`;
          if (q.postId) {
            // a video: its source number when it is one of this session's sources, else its handle
            const src = input.sources.find((v) => v.postId === q.postId);
            const who = src ? `source ${src.ref} (@${src.handle})` : `@${q.handle ?? "creator"}`;
            return `- ${n_}${who}: «${q.text}»${q.comment ? `\n  their note: ${q.comment.replace(/\n+/g, " ")}` : ""}`;
          }
          const where = q.blockId ? input.doc.blocks.findIndex((b) => b.id === q.blockId) : -1;
          const n = where >= 0 ? where + 1 : q.slide !== undefined ? q.slide + 1 : 0;
          const hook = q.field === "hook" && q.blockId ? input.doc.hooks?.findIndex((h) => h.id === q.blockId) ?? -1 : -1;
          const field = q.field === "caption" ? "the post description" : q.field === "pinned" ? "the pinned comment" : q.field === "script" ? "the script" : q.field === "hook" ? `hook ${hook >= 0 ? hook + 1 : ""}`.trim() : "";
          const label = field || (n ? `${unit} ${n}${q.blockId ? ` (${q.blockId})` : ""}` : "");
          return `- ${n_}${label ? `${label}: ` : ""}«${q.text}»${q.comment ? `\n  their note: ${q.comment.replace(/\n+/g, " ")}` : ""}`;
        })
        .join("\n")}`,
    );
  }
  blocks.push(`Author now: ${input.message}`);
  return { system: systemBits.join("\n\n"), user: blocks.join("\n\n") };
}

/** The message is about the audience — comments go in without the author flipping the toggle. */
export function wantsComments(text: string): boolean {
  return /\b(comments?|commenters?|commenting|objections?|oppositions?|push-?back|complain\w*|what (do|are|were) people|people (say|said|think|ask|asking|complain)|audience|replies|reactions?|feedback|faq|questions? (people|they|viewers) (ask|have))\b/i.test(text);
}
