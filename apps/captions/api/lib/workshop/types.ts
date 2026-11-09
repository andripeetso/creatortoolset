import type { Selection } from "../../../contracts/providers";
import type { SocialPlatform } from "../../../contracts/connectors";
import { canMove, move, type Moves } from "../transition";
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
  /** Where it posts: a handle per platform (typed in setup; saved only, nothing is fetched). Missing on old records. */
  handles?: Partial<Record<SocialPlatform, string>>;
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
  /** Installed from a community pack (api/lib/packs.ts). An untouched copy has updatedAt === createdAt. */
  from?: { pack: string; version: string };
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

export { SESSION_STATUSES, TURN_STOPPED, type SessionStatus } from "../../../contracts/workshop-statuses";
import type { SessionStatus } from "../../../contracts/workshop-statuses";

/**
 * Every move a session's status may make. The pipeline is free (the status menu picks any stage), Shelved is parked:
 * it leaves only to Writing (Unshelve). PATCH answers 409 to a refused move; an automatic writer (a posting, a note,
 * a share) skips it, so a shelved session never moves on by itself.
 */
export const SESSION_MOVES: Moves<SessionStatus> = {
  draft: ["writing", "ready", "production", "editing", "toPost", "published", "shelved"],
  writing: ["draft", "ready", "production", "editing", "toPost", "published", "shelved"],
  ready: ["draft", "writing", "production", "editing", "toPost", "published", "shelved"],
  production: ["draft", "writing", "ready", "editing", "toPost", "published", "shelved"],
  editing: ["draft", "writing", "ready", "production", "toPost", "published", "shelved"],
  toPost: ["draft", "writing", "ready", "production", "editing", "published", "shelved"],
  published: ["draft", "writing", "ready", "production", "editing", "toPost", "shelved"],
  shelved: ["writing"],
};
/** The script is settled (Ready on): the kept-share stats count these pieces as finished. */
export const SESSION_FINISHED: readonly SessionStatus[] = ["ready", "production", "editing", "toPost", "published"];
/** Filmed or later with no post yet: the sessions index lists these as waiting for a post (Ready is not filmed yet). */
export const SESSION_WAITING: readonly SessionStatus[] = ["production", "editing", "toPost", "published"];

/**
 * The one writer of a session's status (call it inside the session's updateSession callback, so the check and the
 * write share its lock). `skipIllegal`: an automatic writer (a posting, a note, a share) leaves the status alone
 * instead of throwing. `at`: the time to stamp (a note's own mtime for a note sync). Returns false when skipped.
 */
export function setSessionStatus(
  m: { status?: SessionStatus; statusAt?: number },
  to: SessionStatus,
  what: string,
  { skipIllegal = false, at = Date.now() }: { skipIllegal?: boolean; at?: number } = {},
): boolean {
  const from = m.status ?? "draft";
  if (skipIllegal && !canMove(SESSION_MOVES, from, to)) return false;
  m.status = move(SESSION_MOVES, from, to, what);
  m.statusAt = at;
  return true;
}

/** One of the author's posts that a session became: its Instagram shortcode and link, who added it and when. `version` is the
 *  version it is (a Finals version's key), when one is named. */
export interface Posting {
  shortcode: string;
  url: string;
  by: "auto" | "you";
  at: number;
  version?: string;
}

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
  /** This session's own AI provider pick (Admin → Your AI is the default). */
  ai?: Selection;
  /** Parts of sources the AI (or the author) pulled into the conversation; slide text is always in. */
  loaded?: LoadedSource[];
  /** The Claude session on the Mac that holds this conversation: the next Mac turn resumes it when it can (see resumableClaude). */
  claudeSession?: ClaudeSession;
  /** The posts this session became, one per post (matched from the author's posts or pasted as links). `postings[0]` is also `posted`,
   *  which older readers still use; a session saved before `postings` existed has only `posted` (see `postingsOf`). */
  postings?: Posting[];
  /** The first of `postings`, kept for readers that know one post. */
  posted?: Posting;
  /** Pinned to the top of the sidebar and the list (right-click, Pin). */
  pinned?: boolean;
  /** Posts the author marked as not this session's, so the matcher never picks them again. */
  postedNot?: string[];
  /** The Obsidian note this session is linked to (vault-relative path, the note's mtime when last seen). */
  note?: { path: string; mtime: number };
  /** When the status last changed (the note sync compares it with the note's mtime). */
  statusAt?: number;
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

export type DocKind = DraftKind | "youtube" | "newsletter" | "thread" | "article" | "notes";

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

/** A version's own post description: a companion plus the name it goes by in Finals ("A · Haidt 12 s"). */
export interface VersionCaption extends Companion {
  label?: string;
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
  /** One post description per version, by the version's key; `caption` stays the main one, which a version without its own uses. */
  captions?: Record<string, VersionCaption>;
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

/**
 * A Media Library clip sent with a message (api/library/attach.ts). The AI gets its thumbnail, description and a
 * transcript excerpt, read at turn time as the author; never the file.
 */
export interface LibraryRef {
  kind: "library";
  assetId: string;
  versionId: string;
  title: string;
}

/** A Media Library clip from a library source (a plug-in's clip), kept by its external ref id (api/library/refs.ts). */
export interface ExternalLibraryRef {
  kind: "external";
  refId: string;
  title: string;
}

/** A clip a message keeps: a version of the library, or a source's clip. */
export type ClipRef = LibraryRef | ExternalLibraryRef;

/** A source's clip named by its source, kind and id, as a link made before the move carries it (the id is the source's own). */
export interface ExternalClipLink {
  source: string;
  kind: string;
  externalId: string;
}

/** A clip a message sends, before the server checks it: a version of the library, an external ref, or a source's clip. */
export type LibraryPick = { assetId: string; versionId: string } | { refId: string } | ExternalClipLink;

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
  /** Media Library clips sent with the message. */
  library?: ClipRef[];
  /** A web search the author approved for this turn. */
  web?: string;
  /** The turn writes this Finals version's own post description (its key in `captions`): the writer sees and sets
   *  it as the piece's post description. */
  captionFor?: string;
  /** Sent by Creator Toolset itself (a Finals version's description when the finals arrived), not typed by him. */
  auto?: boolean;
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
  /** Media Library clips, by id: the server checks the author may read each and fills in its title. */
  library?: LibraryPick[];
  /** A retry of an approved web search. */
  web?: string;
  /** The turn writes this Finals version's own post description (its key in `captions`). */
  captionFor?: string;
  /** A retry: the failed question and reply, removed in the same write that starts this turn. */
  retryOf?: string[];
}
