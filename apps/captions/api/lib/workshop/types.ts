import type { Selection } from "../../../contracts/providers";
/** Content Workshop records. Mirrored for the browser in src/lib/workshop.ts. */

/** A dropped .md/.txt (or a written note) that stays in every generation. */
export interface KnowledgeFile {
  id: string;
  name: string;
  text: string;
  addedAt: number;
  /** What the AI that read it filed it as (KnowledgeSource); missing on old project files. */
  kind?: SourceKind;
  title?: string;
  about?: string;
  uses?: string[];
  sections?: SourceSection[];
}

export type { KnowledgeSource, SourceKind, SourceSection } from "../../../contracts/knowledge";
import type { SourceKind, SourceSection } from "../../../contracts/knowledge";

export interface Project {
  id: string;
  owner: string;
  name: string;
  audience: string;
  voice: string;
  cta: string;
  notes: string;
  /** Always-on dump: brand docs, research, how we work. Missing on old records. */
  knowledge?: KnowledgeFile[];
  /** Analyzer account this brand is — usually the user's "my account". */
  accountId?: string;
  /** Its colour (PROJECT_COLORS key), so the current project shows at a glance; missing = picked from the id. */
  color?: string;
  /** Frameworks and rules (ids) switched off for this project; everything of the account is on unless listed. */
  off?: string[];
  createdAt: number;
  updatedAt: number;
}

/**
 * How a framework stacks: one narrative shape sets the order of a piece,
 * one persuasion formula shapes the ask inside it, one argument structure
 * shapes the reasoning. At most one of each role per piece.
 */
export type FrameworkRole = "narrative" | "persuasion" | "argument";

export interface Framework {
  id: string;
  owner: string;
  name: string;
  role: FrameworkRole;
  summary: string;
  steps: string[];
  whenToUse: string;
  /** Which other frameworks it combines well with (free text). */
  pairsWith?: string;
  example?: string;
  /** Set on the starter frameworks so they are not re-seeded after deletion. */
  seedKey?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A writing rule that applies inside any framework (priority, one useful
 * idea, earn the next line…). Rules that are on go into every generation
 * unless a run switches them off.
 */
export interface Rule {
  id: string;
  owner: string;
  name: string;
  text: string;
  on: boolean;
  seedKey?: string;
  createdAt: number;
  updatedAt: number;
}

export type DraftKind = "reel" | "carousel" | "ad" | "free";
export type DraftStatus = "generating" | "ready" | "error";

export interface DraftMeta {
  id: string;
  kind: DraftKind;
  title: string;
  projectId?: string;
  /** Several can be combined; the first sets the overall order. */
  frameworkIds: string[];
  /** Rules applied to this draft (ids); absent means every rule that was on. */
  ruleIds?: string[];
  prompt: string;
  includeNotes: boolean;
  sourceIds: string[];
  status: DraftStatus;
  error?: string;
  warning?: string;
  chars: number;
  /** the Claude calls that wrote it: tokens and API-equivalent cost */
  usage?: { tokens: number; costUsd: number };
  createdAt: number;
  finishedAt?: number;
}

export interface SessionSource {
  postId: string;
  note?: string;
  addedAt: number;
}

/** Where a session sits in the writing pipeline. Missing on old records = draft. */
/** Idea → Writing → Ready → In Production (filming) → Editing → Ready to post → Published, or Shelved. */
export type SessionStatus = "draft" | "writing" | "production" | "ready" | "editing" | "toPost" | "published" | "shelved";

export interface SessionMeta {
  id: string;
  owner: string;
  title: string;
  query: string;
  projectId?: string;
  status?: SessionStatus;
  sources: SessionSource[];
  /** Newest first. */
  drafts: DraftMeta[];
  /** Kept on old sessions (before AI providers); not read. */
  model?: ProviderChoice;
  /** This session's own AI provider pick (Admin → AI providers is the default). */
  ai?: Selection;
  /** Parts of sources the AI (or the author) pulled into the conversation; slide text is always in. */
  loaded?: LoadedSource[];
  /** The Claude session on the Mac that holds this conversation: the next Mac turn resumes it when it can (see resumableClaude). */
  claudeSession?: ClaudeSession;
  /** The post this session became: matched from the author's posts (`posted.ts`) or a link the author pasted. */
  posted?: { shortcode: string; url: string; by: "auto" | "you"; at: number };
  /** Pinned to the top of the sidebar and the list (right-click, Pin). */
  pinned?: boolean;
  /** Posts the author marked as not this session's, so the matcher never picks them again. */
  postedNot?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Claude's session on the Mac for a Workshop session (the Mac relay keeps its folder and transcript). */
export interface ClaudeSession {
  id: string;
  /** the provider and model that holds it ("scope:instance:model"); a switch to another starts over with the chat as history, a handover */
  provider?: string;
  /** when the turn that left it ended */
  at: number;
  /** the assistant message that ended that turn: resumed only while it is still the reply before the new message */
  after: string;
  /** the sources the session has seen; one removed since makes the session start over */
  sources: string[];
  /** a fingerprint of the project and frameworks it was given; a change makes it start over */
  context: string;
  /** how big the session was after that turn (tokens); past RESUME_MAX_TOKENS the next turn starts over */
  tokens?: number;
}

export type ProviderChoice = string;

export type SourcePart = "slides" | "transcript" | "caption" | "comments";

export interface LoadedSource {
  postId: string;
  parts: SourcePart[];
  at: number;
}

export interface GenerateInput {
  kind: DraftKind;
  projectId?: string;
  frameworkIds: string[];
  ruleIds?: string[];
  prompt: string;
  includeNotes: boolean;
  sourceIds?: string[];
}

/* ---- co-writing: documents and chat ---- */

export type DocKind = DraftKind | "youtube" | "notes";

export interface Block {
  /** b1, b2… stable within a document. */
  id: string;
  text: string;
  /** Who wrote the current text. "user" blocks are the author's own wording — the model reads them as its strongest voice signal. */
  author: "ai" | "user";
  at: number;
}

/** The post description or the pinned comment: one text with an author, like a block. */
export interface Companion {
  text: string;
  author: "ai" | "user";
  at: number;
}

export interface Version {
  /** v1, v2… */
  id: string;
  at: number;
  label: string;
  /** Named by the author so it survives the auto cap and is easy to restore. */
  kept?: boolean;
  blocks: Block[];
  /** Reel opening alternatives (h1, h2…). */
  hooks?: Block[];
  caption?: Companion;
  pinned?: Companion;
}

export interface Document {
  id: string;
  sessionId: string;
  kind: DocKind;
  title: string;
  frameworkIds: string[];
  ruleIds?: string[];
  /** How the reader moves through a carousel (explainer, conversation, …). */
  carouselType?: string;
  /** Picked 4:5 card layouts + image wells for Visualize. Stale when hash no longer matches the copy. */
  carouselLayouts?: { hash: string; pick: number; variants: unknown[][]; usage?: { tokens: number; costUsd: number } };
  blocks: Block[];
  /** Reel opening alternatives (h1, h2…). Empty means the script has no extra hook cards. */
  hooks?: Block[];
  /** Optional companions: post description (caption) and pinned comment. */
  caption?: Companion;
  pinned?: Companion;
  /** Oldest first. Auto snapshots are capped; kept named ones stay. */
  versions: Version[];
  nextBlock: number;
  nextHook?: number;
  nextVersion: number;
  /** Slides (block ids) the author approved and locked: a turn's edits to them are refused. */
  locked?: string[];
  /** The author edited since the last snapshot. */
  dirty?: boolean;
  /** The version whose blocks equal the current text; unset once anything changed. */
  headVersion?: string;
  /** The author's recent edits, kept so the model can learn from them. */
  userEdits?: UserEdit[];
  createdAt: number;
  updatedAt: number;
}

/** One change the author made by hand: what the block was, what they made it. */
export interface UserEdit {
  blockId: string;
  /** Missing when the author added the block. */
  from?: string;
  fromAuthor?: "ai" | "user";
  /** Missing when the author deleted the block. */
  to?: string;
  at: number;
  /** A turn has already read this edit. */
  seen?: boolean;
}


export type ContextField = "slides" | "transcript" | "caption" | "comments" | "description" | "source";

/** A highlighted passage from a source, pinned into the conversation with where it came from. */
export interface ContextSnippet {
  postId: string;
  handle: string;
  slide?: number;
  field: ContextField;
  text: string;
}

/** The author pointed at part of the piece (select → Comment). */
export interface PieceQuote {
  blockId?: string;
  /** 0-based slide or part. */
  slide?: number;
  text: string;
  comment?: string;
  /** Cited from one of the AI's chat replies, not the piece. */
  from?: "reply";
  /** Which field of the piece the words are in, when it isn't a slide (a reel's script, a hook, the post description, the pinned comment). */
  field?: "script" | "hook" | "caption" | "pinned";
  /** A video cited in the message box: its post (a session source, or any post), its handle, and its hook as the text. */
  postId?: string;
  handle?: string;
}

/** One thing a turn did: pulled sources, read a file, searched the web, wrote. */
export interface TurnStep {
  label: string;
  at: number;
  /** When the next step began, or the turn ended. */
  end?: number;
}

/** A big paste the author attached to a message; its text lives in the session's pasted/ folder. */
export interface PastedRef {
  id: string;
  name: string;
  chars: number;
}

/** Pictures sent with a message, kept in sessions/<id>/images/<id>, in the order they go. */
export interface ImageRef {
  id: string;
  name: string;
  type: "image/jpeg" | "image/png" | "image/webp";
}

/** A file sent with a message (a PDF the AI reads from the Mac folder), kept in sessions/<id>/files/<id>.<ext>. */
export interface FileRef {
  id: string;
  name: string;
  type: "application/pdf";
  bytes: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  docId: string;
  context?: ContextSnippet[];
  reading?: { postId: string; slide?: number };
  /** Sent with a user message: deep research runs before the answer; comments were asked for by hand. */
  deep?: boolean;
  comments?: boolean;
  /** "My words only": build from what the author said; the page highlights every word they didn't. */
  mine?: boolean;
  /** How much this message may change (the composer's slider): unset = normal. */
  scope?: "slight" | "rewrite";
  /** Parts of the piece the author selected and commented on with this message. */
  quotes?: PieceQuote[];
  /** Big pastes sent as attachments: kept whole in sessions/<id>/pasted/<pid>.md, never cut. */
  pasted?: PastedRef[];
  images?: ImageRef[];
  /** Other files sent with the message (PDFs), in the order they go after the pictures. */
  files?: FileRef[];
  /** A web search the author approved for this turn. */
  web?: string;
  status?: "thinking" | "done" | "error";
  error?: string;
  /** While thinking: what is happening, and who is answering. */
  stage?: "packing" | "thinking" | "writing" | "applying" | "searching" | "researching";
  provider?: string;
  /** Claude on the Mac: measured tokens and what the API would have charged for this turn. */
  /** Measured tokens and API-equivalent cost; a Mac folder turn adds its prompt size, time, cache reads and whether the Claude session was resumed. */
  usage?: { tokens: number; costUsd: number };
  edits?: { docId: string; blockIds: string[]; versionBefore?: string; versionAfter?: string; created?: boolean };
  revertedTo?: string;
  /** What the model pulled from the sources during this turn. */
  fetched?: Array<{ handle: string; parts: SourcePart[] }>;
  /** A library search the model ran, and what it found beyond the session's sources. */
  search?: string;
  hits?: unknown[];
  /** An accuracy audit: set while it runs, filled with the result when done. */
  audit?: AuditMeta;
  /** Web research the model asked for (quick, inline) or the author ran (deep). */
  research?: ResearchNote;
  /** Something slow the model wants to run — the author says yes or no. */
  proposal?: Proposal;
  /** Rules the edited draft clearly breaks, per Jev (see rule-check.ts). */
  flags?: Array<{ id: string; name: string; p: number }>;
  /** What the turn did, step by step, each with its own time. */
  steps?: TurnStep[];
  /** "Read as a follower": another model's read of the piece, made with only the piece in front of it (review.ts). */
  review?: { model: string };
  /** What the app noticed about the turn (read-through, searches, locked slides left alone): under the reply, never in its words. */
  notes?: string[];
}

export interface ResearchNote {
  question: string;
  depth: "quick" | "deep";
  status: "running" | "done";
  answer?: string;
  citations?: string[];
  model?: string;
}

export interface Proposal {
  kind: "audit" | "research";
  depth: "quick" | "deep";
  question?: string;
  reason?: string;
  status: "open" | "accepted" | "declined";
}

export interface Chat {
  messages: ChatMessage[];
}

/* ---- accuracy audit: claims checked against sources on the web ---- */

export type AuditVerdict = "supported" | "partly" | "contradicted" | "unverifiable";

export interface AuditClaim {
  id: string;
  /** A block id ("b3") for documents, "slide 2" for posts. */
  where?: string;
  claim: string;
  verdict: AuditVerdict;
  confidence: number;
  evidence: string;
  sources: Array<{ url: string; title?: string }>;
  /** An accurate rewording, when the claim needs one. */
  fix?: string;
}

export interface AuditResult {
  /** 0–100, 100 = every claim supported as written. */
  score: number;
  summary: string;
  claims: AuditClaim[];
  /** Every page the research drew on. */
  citations: string[];
  /** Set when the piece was longer than the audit reads: how many characters it checked of the whole. */
  covered?: { chars: number; total: number };
}

export interface AuditTarget {
  type: "document" | "post";
  id: string;
  title: string;
}

/** Lives on the assistant message that carries the audit. */
export interface AuditMeta {
  target: AuditTarget;
  depth: "quick" | "deep";
  model?: string;
  tokens?: number;
  costUsd?: number;
  result?: AuditResult;
  /** Claim ids whose fix was applied to the document. */
  applied?: string[];
}

export interface TurnInput {
  docId: string;
  text: string;
  context?: ContextSnippet[];
  reading?: { postId: string; slide?: number };
  deep: boolean;
  comments: boolean;
  mine: boolean;
  scope?: "slight" | "rewrite";
  quotes?: PieceQuote[];
  pasted?: Array<{ name: string; text: string }>;
  /** A retry: pastes this session already keeps. */
  pastedRefs?: PastedRef[];
  images?: Array<{ name: string; type: ImageRef["type"]; data: string }>;
  /** A retry: pictures this session already keeps. */
  imageRefs?: ImageRef[];
  /** Files (base64), after the pictures in the order they go. */
  files?: Array<{ name: string; type: FileRef["type"]; data: string }>;
  /** A retry: files this session already keeps. */
  fileRefs?: FileRef[];
  /** A retry of an approved web search. */
  web?: string;
  /** A retry: the failed question and reply, removed in the same write that starts this turn. */
  retryOf?: string[];
}
