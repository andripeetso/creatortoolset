import { useEffect, useState } from "react";
import type { FindHit } from "@/lib/instagram";
import type { SocialPlatform } from "@contracts/connectors";
import type { Selection } from "@contracts/providers";
import { SESSION_STATUSES as STAGE_IDS, TURN_STOPPED, type SessionStatus } from "@contracts/workshop-statuses";
/**
 * Client for the Content Workshop (api/workshop.ts): research sessions on
 * top of the Content Analyzer library — sources, notes, drafts.
 */
import type { InstagramPost } from "./instagram";
import type { CarouselLayoutSet } from "./carousel-layout";
import { pieceMarkdown } from "./workshop-markdown";
import { forgetCached, putCached, readCached } from "./local-cache";
import { appendProjectId, projectBody, useWorkspace } from "./workspace";

export interface KnowledgeFile {
  id: string;
  name: string;
  text: string;
  addedAt: number;
}

export interface WorkshopProject {
  id: string;
  owner: string;
  name: string;
  audience: string;
  voice: string;
  cta: string;
  notes: string;
  knowledge?: KnowledgeFile[];
  /** Analyzer account this brand is — usually the user's "my account". */
  accountId?: string;
  /** Its colour (a PROJECT_COLORS key in lib/workspace); missing = picked from the id. */
  color?: string;
  /** Frameworks and rules (ids) switched off for this project. */
  off?: string[];
  /** Where the brand posts: a handle per platform. Saved only, never fetched. */
  handles?: Partial<Record<SocialPlatform, string>>;
  /** The languages spoken in its videos; missing = the person's Voice languages. */
  languages?: string[];
  createdAt: number;
  updatedAt: number;
}

export type ProjectFields = Pick<
  WorkshopProject,
  "name" | "audience" | "voice" | "cta" | "notes" | "knowledge" | "color" | "off" | "handles" | "languages"
> & {
  accountId?: string | null;
};

export const PROJECT_NOTES_MAX = 20_000; // the server keeps 20,000 (validate.ts LIMITS.projectNotes); 2,000 cut instructions

/** Fold the old audience/voice/CTA fields into instructions so they stay editable. */
export function foldProjectInstructions(p: Pick<WorkshopProject, "audience" | "voice" | "cta" | "notes">): string {
  const parts = [
    p.notes.trim(),
    p.audience.trim() ? `Audience: ${p.audience.trim()}` : "",
    p.voice.trim() ? `Voice: ${p.voice.trim()}` : "",
    p.cta.trim() ? `CTA: ${p.cta.trim()}` : "",
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, PROJECT_NOTES_MAX);
}

export function knowledgeSizeLabel(n: number): string {
  return n < 1000 ? `${n} chars` : `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
}

export type FrameworkRole = "narrative" | "persuasion" | "argument";

export const FRAMEWORK_ROLES: { id: FrameworkRole; label: string; hint: string }[] = [
  { id: "narrative", label: "Shape", hint: "Sets the order of the whole piece — pick one" },
  { id: "persuasion", label: "Persuasion", hint: "Shapes how the piece asks — pick one, optional" },
  { id: "argument", label: "Argument", hint: "Shapes the reasoning — optional" },
];

export interface WorkshopFramework {
  id: string;
  owner: string;
  name: string;
  role: FrameworkRole;
  summary: string;
  steps: string[];
  whenToUse: string;
  pairsWith?: string;
  example?: string;
  seedKey?: string;
  createdAt: number;
  updatedAt: number;
}

export type FrameworkFields = Pick<WorkshopFramework, "name" | "role" | "summary" | "steps" | "whenToUse" | "pairsWith" | "example">;

export interface WorkshopRule {
  id: string;
  owner: string;
  name: string;
  text: string;
  /** Applied to every generation unless a run switches it off. */
  on: boolean;
  seedKey?: string;
  createdAt: number;
  updatedAt: number;
}

export type RuleFields = Pick<WorkshopRule, "name" | "text" | "on">;

export type DraftKind = "reel" | "carousel" | "ad" | "free";
export type DraftStatus = "generating" | "ready" | "error";

export interface DraftMeta {
  id: string;
  kind: DraftKind;
  title: string;
  projectId?: string;
  frameworkIds: string[];
  ruleIds?: string[];
  prompt: string;
  includeNotes: boolean;
  sourceIds: string[];
  status: DraftStatus;
  error?: string;
  warning?: string;
  chars: number;
  usage?: { tokens: number; costUsd: number };
  createdAt: number;
  finishedAt?: number;
}

export interface SessionSource {
  postId: string;
  note?: string;
  addedAt: number;
}

/** The stages, their moves and TURN_STOPPED live with the server (contracts/workshop-statuses.ts); only the labels are here. */
export { TURN_STOPPED };
export type { SessionStatus };

const SESSION_LABELS: Record<SessionStatus, string> = {
  draft: "Idea",
  writing: "Writing",
  ready: "Ready",
  production: "In Production",
  editing: "Editing",
  toPost: "Ready to post",
  published: "Published",
  shelved: "Shelved",
};

export const SESSION_STATUSES: { id: SessionStatus; label: string }[] = STAGE_IDS.map((id) => ({ id, label: SESSION_LABELS[id] }));

export function sessionStatusOf(status: SessionStatus | undefined): SessionStatus {
  return status ?? "draft";
}

/**
 * The statuses to set, in order, to bring a session from `from` back to `to` (an Undo). A shelved session is only ever
 * picked up as Writing (the server's SESSION_MOVES), so going back further takes two.
 */
export const statusSteps = (from: SessionStatus, to: SessionStatus): SessionStatus[] =>
  from === "shelved" && to !== "writing" ? ["writing", to] : [to];

export function sessionStatusLabel(status: SessionStatus | undefined): string {
  const id = sessionStatusOf(status);
  return SESSION_STATUSES.find((s) => s.id === id)?.label ?? "Idea";
}

export interface SessionMeta {
  id: string;
  owner: string;
  title: string;
  query: string;
  projectId?: string;
  status?: SessionStatus;
  sources: SessionSource[];
  drafts: DraftMeta[];
  /** This session's AI pick (instance, model, effort); none = the AI providers' default. Admins only. */
  ai?: Selection;
  /** Parts of sources the AI pulled into the conversation; slide text is always in. */
  loaded?: LoadedSource[];
  /** The posts this session became: matched by their words, or links the author pasted. `posted` is the first of them. */
  postings?: SessionPosting[];
  /** The first of `postings`, kept for readers that know one post. */
  posted?: SessionPosting;
  /** Pinned to the top (sidebar "Pinned" group, first in the list). */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SessionPosting {
  shortcode: string;
  url: string;
  by: "auto" | "you";
  at: number;
  /** The version this post is, by its key (a Finals version); none = not named. */
  version?: string;
}

/** A session's postings: its list, or (saved before the list existed) the one `posted`. */
export const postingsOfSession = (s: { postings?: SessionPosting[]; posted?: SessionPosting }): SessionPosting[] =>
  s.postings ?? (s.posted ? [s.posted] : []);

export interface SessionRecord extends SessionMeta {
  notes: string;
  /** The sources still in the library, in session order. */
  posts: InstagramPost[];
  /** Claude usage of the project's other sessions; the page adds this session's live. */
  projectUsageElsewhere?: { tokens: number; costUsd: number; turns: number; sessions: number };
}

/** Tokens and API-equivalent cost Claude on the Mac measured over these messages. */
export function usageTally(messages: Array<{ usage?: { tokens: number; costUsd: number } }>) {
  return messages.reduce((t, m) => (m.usage ? { tokens: t.tokens + m.usage.tokens, costUsd: t.costUsd + m.usage.costUsd, turns: t.turns + 1 } : t), { tokens: 0, costUsd: 0, turns: 0 });
}

/** "8 s", "2 min 40 s". */
export const durationLabel = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
};

/** A finished turn in one line: "Read 7 files · searched the web 2× · 2 min 40 s". */
export function stepsSummary(steps: Array<{ label: string; at: number; end?: number }>): string {
  const reads = steps.filter((x) => /^Read /.test(x.label)).length;
  const looks = steps.filter((x) => /^(Searched (?!the web)|Looked for )/.test(x.label)).length;
  const web = steps.filter((x) => /^(Searched the web|Checking on the web|Deep research on the web)/.test(x.label)).length;
  const pulled = steps.filter((x) => x.label.startsWith("Pulled from the sources")).length;
  const first = steps[0]?.at ?? 0;
  const last = steps.reduce((t, x) => Math.max(t, x.end ?? x.at), first);
  return [
    reads ? `read ${reads} file${reads === 1 ? "" : "s"}` : "",
    looks ? `searched the folder ${looks}×` : "",
    pulled ? "pulled sources" : "",
    web ? `searched the web${web > 1 ? ` ${web}×` : ""}` : "",
    durationLabel(last - first),
  ]
    .filter(Boolean)
    .join(" · ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** "1.2M tokens" / "238.7k tokens". */
export const tokensLabel = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1000).toFixed(1)}k`);

export interface SessionRow extends Omit<SessionMeta, "drafts" | "sources"> {
  sourceIds: string[];
  sourceCount: number;
  draftCount: number;
  generating: boolean;
  projectName?: string;
  /** What the session makes: its pieces' kinds (the server's `pieceKinds`). */
  kinds?: PieceKind[];
  /** A share link is on. */
  shared?: boolean;
}

export interface SessionPatch {
  title?: string;
  query?: string;
  projectId?: string | null;
  status?: SessionStatus;
  sources?: Array<Pick<SessionSource, "postId" | "note"> & Partial<SessionSource>>;
  notes?: string;
  /** Only an empty list is accepted: it forgets what was pulled. */
  loaded?: [];
  /** null clears the session's pick back to the default. */
  ai?: Selection | null;
  /** a post's Instagram link (added, or its version changed with `version`), `{ remove }` for "not this post" on one post, or
   *  null for "not this post" on all of them */
  posted?: string | null | { url: string; version?: string } | { remove: string };
  pinned?: boolean;
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

export const DRAFT_KINDS: { id: DraftKind; label: string; hint: string }[] = [
  { id: "reel", label: "Reel script", hint: "Hook variations and a spoken script, caption" },
  { id: "carousel", label: "Carousel", hint: "Slide-by-slide headline and body, hook slide, CTA slide" },
  { id: "ad", label: "Ad copy", hint: "Three angles: primary text, headline, description, CTA" },
  { id: "free", label: "Anything else", hint: "Whatever the brief asks for" },
];

export const MAX_GENERATE_SOURCES = 12;
export const MAX_SESSION_SOURCES = 40;
export const WORKSHOP_HOME = "/workshop";
export const sessionPath = (id: string) => `${WORKSHOP_HOME}/sessions/${id}`;

/** A failed request carries its HTTP status, so the page can tell "never saved" (4xx) from "maybe saved" (network, 5xx). */
async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw Object.assign(new Error(j?.error || `Request failed (${res.status})`), { status: res.status });
  return j as T;
}

const jsonInit = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** What refetches the availability: a Workshop change, and a computer or an AI coming online or going quiet. */
export const AVAILABILITY_LIVE = { topic: ["workshop", "devices", "providers"] };
export const getWorkshopAvailability = () =>
  fetch("/api/workshop/availability").then((r) => json<{ ai: boolean; research: boolean; library: number; /** Admins only: Claude on the Mac is online. */ mac?: boolean }>(r));

export const listProjects = () => fetch("/api/workshop/projects").then((r) => json<WorkshopProject[]>(r));
export const createProject = async (fields: Partial<ProjectFields>) => {
  const p = await fetch("/api/workshop/projects", jsonInit(fields)).then((r) => json<WorkshopProject>(r));
  await useWorkspace.getState().load();
  return p;
};
export const patchProject = async (id: string, fields: Partial<ProjectFields>) => {
  const p = await fetch(`/api/workshop/projects/${id}`, jsonInit(fields, "PATCH")).then((r) => json<WorkshopProject>(r));
  await useWorkspace.getState().load();
  return p;
};
export const deleteProject = async (id: string) => {
  const out = await fetch(`/api/workshop/projects/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
  await useWorkspace.getState().load();
  return out;
};

/** A new project's facts, drafted from its Instagram bio and posts, for the author to rewrite. */
/** A project's instructions drafted from what the person gave: text (its links are read), .docx/.odt/.epub files, Instagram accounts. */
export const draftProjectNotes = (input: { name: string; text?: string; accountIds?: string[]; files?: Array<{ name: string; data: string }> }) =>
  fetch("/api/workshop/projects/draft-notes", jsonInit(input)).then((r) => json<{ notes: string }>(r));

export const listFrameworks = () =>
  fetch("/api/workshop/frameworks").then((r) => json<WorkshopFramework[]>(r));
export type FrameworkInput = Omit<Partial<FrameworkFields>, "steps"> & { steps?: string[] | string };

export const createFramework = (fields: FrameworkInput) =>
  fetch("/api/workshop/frameworks", jsonInit(fields)).then((r) => json<WorkshopFramework>(r));
export const patchFramework = (id: string, fields: FrameworkInput) =>
  fetch(`/api/workshop/frameworks/${id}`, jsonInit(fields, "PATCH")).then((r) => json<WorkshopFramework>(r));
export const deleteFramework = (id: string) =>
  fetch(`/api/workshop/frameworks/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));

export type { KnowledgeSource, SourceKind, SourceSection } from "@contracts/knowledge";
export { SOURCE_KINDS } from "@contracts/knowledge";
import type { KnowledgeSource } from "@contracts/knowledge";

/** The account's knowledge (api/workshop.ts "knowledge"): every project reads it unless kept to one or switched off. */
export const listSources = () => fetch("/api/workshop/sources").then((r) => json<KnowledgeSource[]>(r));
/** One of: text, a .docx/.odt/.epub (`file`, base64), or a scan's pages (`pages`, base64 JPEGs). */
export const addSource = (input: { name: string; text?: string; file?: string; pages?: string[]; more?: boolean; projectId?: string }) =>
  fetch("/api/workshop/sources", jsonInit(input)).then((r) => json<KnowledgeSource>(r));
/** A scan's pages in batches of 30 (each request stays well under the server's 50 MB), read after the last. */
export async function addScan(name: string, pages: string[], onBatch?: (sent: number) => void): Promise<KnowledgeSource> {
  const BATCH = 30;
  let s = await addSource({ name, pages: pages.slice(0, BATCH), more: pages.length > BATCH });
  for (let i = BATCH; i < pages.length; i += BATCH) {
    onBatch?.(i);
    s = await fetch(`/api/workshop/sources/${s.id}/pages`, jsonInit({ pages: pages.slice(i, i + BATCH), more: i + BATCH < pages.length })).then((r) => json<KnowledgeSource>(r));
  }
  return s;
}
export const addSourceLink = (url: string, projectId?: string) =>
  fetch("/api/workshop/sources/link", jsonInit({ url, projectId })).then((r) => json<KnowledgeSource>(r));
export const patchSource = (id: string, fields: Partial<Omit<KnowledgeSource, "projectId">> & { projectId?: string | null }) =>
  fetch(`/api/workshop/sources/${id}`, jsonInit(fields, "PATCH")).then((r) => json<KnowledgeSource>(r));
export const readSourceAgain = (id: string) => fetch(`/api/workshop/sources/${id}/read`, jsonInit({})).then((r) => json<KnowledgeSource>(r));
export const deleteSource = (id: string) => fetch(`/api/workshop/sources/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
export const sourceTextUrl = (id: string) => `/api/workshop/sources/${id}/text`;

export const listRules = () => fetch("/api/workshop/rules").then((r) => json<WorkshopRule[]>(r));
export const createRule = (fields: Partial<RuleFields>) =>
  fetch("/api/workshop/rules", jsonInit(fields)).then((r) => json<WorkshopRule>(r));
export const patchRule = (id: string, fields: Partial<RuleFields>) =>
  fetch(`/api/workshop/rules/${id}`, jsonInit(fields, "PATCH")).then((r) => json<WorkshopRule>(r));
export const deleteRule = (id: string) =>
  fetch(`/api/workshop/rules/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));

export const listSessions = () => {
  const params = new URLSearchParams();
  appendProjectId(params);
  const qs = params.toString();
  return fetch(`/api/workshop/sessions${qs ? `?${qs}` : ""}`).then((r) => json<SessionRow[]>(r));
};
export const createSession = (input: { title?: string; query?: string; projectId?: string; sourceIds?: string[]; notes?: string } = {}) =>
  fetch("/api/workshop/sessions", jsonInit({ ...input, ...projectBody(input.projectId) })).then((r) => json<SessionRecord>(r));
export const getSession = (id: string) =>
  fetch(`/api/workshop/sessions/${id}`).then((r) => json<SessionRecord>(r));
export const patchSession = (id: string, patch: SessionPatch) =>
  fetch(`/api/workshop/sessions/${id}`, jsonInit(patch, "PATCH")).then((r) => json<SessionMeta>(r));
export const deleteSession = (id: string) =>
  fetch(`/api/workshop/sessions/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
/** The menu's Duplicate: a copy under a new id (not the chat or share links). */
export const duplicateSession = (id: string) =>
  fetch(`/api/workshop/sessions/${id}/duplicate`, { method: "POST" }).then((r) => json<SessionRecord>(r));
/** The menu's Regenerate title: a new name from the session's main piece. */
export const regenerateSessionTitle = (id: string) =>
  fetch(`/api/workshop/sessions/${id}/name`, { method: "POST" }).then((r) => json<{ title: string }>(r));
export const exportUrl = (id: string) => `/api/workshop/sessions/${id}/export.md`;
export const fetchExportMarkdown = (id: string) =>
  fetch(exportUrl(id)).then(async (r) => {
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error || `Request failed (${r.status})`);
    }
    return r.text();
  });

/** A custom export (the Workshop's Export menu → Edit exports…). The built-in Obsidian Markdown comes first, with id "obsidian". */
export interface WorkshopExport {
  id: string;
  name: string;
  target: "download" | "plugin";
  folder: string;
  filename: string;
  template: string;
}
export const listExports = () => fetch("/api/workshop/exports").then((r) => json<WorkshopExport[]>(r));
export const saveExports = (exports: WorkshopExport[]) => fetch("/api/workshop/exports", jsonInit(exports, "PUT")).then((r) => json<WorkshopExport[]>(r));
/** Runs an export on a session: a download answers the file (or, with several pieces, their names); a plugin export queues them. */
export const runExport = (sessionId: string, exportId: string, query: string) => fetch(`/api/workshop/sessions/${sessionId}/export/${exportId}?${query}`, { method: "POST" });

export const generateDraft = (sessionId: string, input: GenerateInput) =>
  fetch(`/api/workshop/sessions/${sessionId}/generate`, jsonInit(input)).then((r) =>
    json<{ draft: DraftMeta }>(r),
  );
export const listDrafts = (sessionId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/drafts`).then((r) => json<DraftMeta[]>(r));
export const getDraft = (sessionId: string, draftId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/drafts/${draftId}`).then((r) =>
    json<{ draft: DraftMeta; markdown: string }>(r),
  );
export const deleteDraft = (sessionId: string, draftId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/drafts/${draftId}`, { method: "DELETE" }).then((r) =>
    json<{ ok: true }>(r),
  );

export const draftKindLabel = (kind: DraftKind) => DRAFT_KINDS.find((k) => k.id === kind)?.label ?? kind;

/* ---- co-writing: documents and chat ---- */

export type DocKind = DraftKind | "youtube" | "newsletter" | "thread" | "article" | "notes";
/** A piece's kind: every document kind but the notes. */
export type PieceKind = Exclude<DocKind, "notes">;

export interface Block {
  id: string;
  text: string;
  author: "ai" | "user";
  at: number;
}

export interface VersionInfo {
  id: string;
  at: number;
  label: string;
  kept?: boolean;
}

/** The post description or the pinned comment: one text with an author, like a block. */
export interface Companion {
  text: string;
  author: "ai" | "user";
  at: number;
}

export interface WorkshopDocument {
  id: string;
  sessionId: string;
  kind: DocKind;
  title: string;
  frameworkIds: string[];
  /** Slides you locked: the AI's edits to them are refused. */
  locked?: string[];
  ruleIds?: string[];
  /** How the reader moves through a carousel (explainer, conversation, …). */
  carouselType?: string;
  /** Picked 4:5 card layouts + image wells for Visualize. Stale when hash no longer matches the copy. */
  carouselLayouts?: CarouselLayoutSet;
  blocks: Block[];
  /** Reel opening alternatives. Empty means the script has no extra hook cards. */
  hooks?: Block[];
  /** Written together with the content: the caption under the post, and the comment pinned on top. */
  caption?: Companion;
  /** One post description per version, by the version's key; `caption` is the main one. */
  captions?: Record<string, Companion>;
  pinned?: Companion;
  versions: VersionInfo[];
  dirty?: boolean;
  /** The version the current text equals; unset once anything changed. */
  headVersion?: string;
  createdAt: number;
  updatedAt: number;
}

/** The parts of a source the AI can pull, in value order. */
export type SourcePart = "slides" | "transcript" | "caption" | "comments";
export const PART_LABELS: Record<SourcePart, string> = { slides: "on-screen text", transcript: "transcript", caption: "caption", comments: "comments" };
export interface LoadedSource {
  postId: string;
  parts: SourcePart[];
  at: number;
}

export type ContextField = "slides" | "transcript" | "caption" | "comments" | "description" | "source";

/** Words you cited (of the piece, or of an AI reply): they go with your next chat message. */
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
  /** The browser's own: which chip in the message box this is (never sent). */
  id?: string;
}

export interface ContextSnippet {
  postId: string;
  handle: string;
  slide?: number;
  field: ContextField;
  text: string;
}

export const CONTEXT_FIELD_LABELS: Record<ContextField, string> = {
  slides: "on-screen text",
  transcript: "transcript",
  caption: "caption",
  comments: "comment",
  description: "description",
  source: "whole video",
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  docId: string;
  context?: ContextSnippet[];
  reading?: { postId: string; slide?: number };
  /** Deep research ran before this message was answered. */
  deep?: boolean;
  comments?: boolean;
  /** "My words only": build from what you said; the page highlights every word you didn't. */
  mine?: boolean;
  /** The slider: how much this message could change (unset = normal). */
  scope?: ChangeScope;
  /** Parts of the piece you selected and commented on with this message. */
  quotes?: PieceQuote[];
  /** Big pastes attached to this message (kept whole on the server). */
  pasted?: Array<{ id: string; name: string; chars: number }>;
  /** Pictures sent with it, in order. */
  images?: ImageRef[];
  /** Files sent with it (PDFs), after the pictures. */
  files?: FileRef[];
  /** Media Library clips sent with the message (the AI reads their thumbnail, description and transcript). */
  library?: Array<{ kind: "library"; assetId: string; versionId: string; title: string } | { kind: "external"; refId: string; title: string }>;
  status?: "thinking" | "done" | "error";
  error?: string;
  /** While thinking: what is happening, and who is answering. */
  stage?: "packing" | "thinking" | "writing" | "applying" | "searching" | "researching";
  provider?: string;
  /** Measured tokens and API-equivalent cost. */
  usage?: { tokens: number; costUsd: number };
  edits?: { docId: string; blockIds: string[]; versionBefore?: string; versionAfter?: string; created?: boolean };
  revertedTo?: string;
  /** App-written notes: read-through findings, searches, slides left as locked. Not part of the reply text. */
  notes?: string[];
  /** What the AI pulled from the sources during this turn. */
  fetched?: Array<{ handle: string; parts: SourcePart[] }>;
  /** A library search the AI ran, and what it found beyond the session's sources. */
  search?: string;
  hits?: FindHit[];
  /** An accuracy audit: set while it runs, filled with the result when done. */
  audit?: AuditMeta;
  /** Web research the AI asked for (quick, inline) or you ran (deep). */
  research?: ResearchNote;
  /** Something slow the AI wants to run — you say yes or no. */
  proposal?: Proposal;
  /** Rules the edited draft clearly breaks, per Jev. */
  flags?: Array<{ id: string; name: string; p: number }>;
  /** "Read as a follower": another model's read, made with only the piece in front of it. */
  review?: { model: string };
  /** A web search you approved for this turn. */
  web?: string;
  /** What the turn did, step by step, each with its own time. */
  steps?: Array<{ label: string; at: number; end?: number }>;
}

export interface ResearchNote {
  question: string;
  depth: AuditDepth;
  status: "running" | "done";
  answer?: string;
  citations?: string[];
  model?: string;
}

export interface Proposal {
  kind: "audit" | "research";
  depth: AuditDepth;
  question?: string;
  reason?: string;
  status: "open" | "accepted" | "declined";
}

/* ---- accuracy audit ---- */

export type AuditVerdict = "supported" | "partly" | "contradicted" | "unverifiable";
export type AuditDepth = "quick" | "deep";

export interface AuditClaim {
  id: string;
  where?: string;
  claim: string;
  verdict: AuditVerdict;
  confidence: number;
  evidence: string;
  sources: Array<{ url: string; title?: string }>;
  fix?: string;
}

export interface AuditResult {
  score: number;
  summary: string;
  claims: AuditClaim[];
  citations: string[];
}

export interface AuditTarget {
  type: "document" | "post";
  id: string;
  title: string;
}

export interface AuditMeta {
  target: AuditTarget;
  depth: AuditDepth;
  model?: string;
  tokens?: number;
  result?: AuditResult;
  applied?: string[];
}

export const VERDICTS: Record<AuditVerdict, { label: string; className: string; rank: number }> = {
  contradicted: { label: "Contradicted", className: "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200", rank: 0 },
  partly: { label: "Partly", className: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200", rank: 1 },
  unverifiable: { label: "Unverifiable", className: "border-border bg-muted text-muted-foreground", rank: 2 },
  supported: { label: "Supported", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200", rank: 3 },
};

export const AUDIT_DEPTHS: { id: AuditDepth; label: string; hint: string }[] = [
  { id: "quick", label: "Quick check", hint: "About a minute — the main claims against the first sources found" },
  { id: "deep", label: "Deep research", hint: "5–15 minutes — reads dozens of pages, finds primary sources" },
];

export const startAudit = (sessionId: string, input: { docId: string; postId?: string; depth: AuditDepth }) =>
  fetch(`/api/workshop/sessions/${sessionId}/audits`, jsonInit(input)).then((r) => json<{ ask: ChatMessage; reply: ChatMessage }>(r));
/** A paste attached to a sent message, as text. */
export const pastedUrl = (sessionId: string, pid: string) => `/api/workshop/sessions/${sessionId}/pasted/${pid}`;

/* ---- pictures with a message ---- */

export interface ImageRef {
  id: string;
  name: string;
  type: "image/jpeg" | "image/png" | "image/webp";
}
/** A file sent with a message, as the server keeps it (a PDF the AI reads from the Mac folder). */
export interface FileRef {
  id: string;
  name: string;
  type: "application/pdf";
  bytes: number;
}
/** A file waiting in the message box: base64 with no data: prefix. */
export interface PendingFile {
  id: string;
  name: string;
  type: FileRef["type"];
  bytes: number;
  data: string;
}
/** A PDF over this is refused here (the server takes 10 MB). */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** A text file over this many characters is refused here (the server's pasted limit). */
export const TEXT_ATTACH_MAX = 2_000_000;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|srt|vtt|html?|xml|ya?ml|js|jsx|ts|tsx|log)$/i;
const TEXT_TYPES = ["application/json", "application/xml", "application/x-yaml", "application/javascript", "application/x-subrip"];
/** What the message box does with a dropped, picked or pasted file: a picture, a text read in the browser, a PDF, or refused. */
export function attachKind(file: File): "picture" | "text" | "pdf" | "refused" {
  if (file.type.startsWith("image/")) return "picture";
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
  if (TEXT_EXT.test(file.name) || file.type.startsWith("text/") || TEXT_TYPES.includes(file.type)) return "text";
  return "refused";
}
/** A file as base64 with no data: prefix. */
export function fileBase64(file: File): Promise<string> {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",", 2)[1] ?? "");
    r.onerror = () => no(new Error(`Couldn't read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export interface PendingImage {
  id: string;
  name: string;
  type: ImageRef["type"];
  /** base64, no data: prefix */
  data: string;
  url: string;
}
export const imageUrl = (sessionId: string, iid: string) => `/api/workshop/sessions/${sessionId}/images/${iid}`;
/** A picture for a piece's text: shrunk here like a chat picture, stored by the session; returns its id. */
export async function uploadPicture(sessionId: string, file: File): Promise<ImageRef> {
  if (!file.type.startsWith("image/")) throw new Error("That isn't a picture");
  const pic = await shrinkImage(file);
  return fetch(`/api/workshop/sessions/${sessionId}/media`, jsonInit({ name: pic.name, type: pic.type, data: pic.data })).then((r) => json<ImageRef>(r));
}

/** Files in slide order: the number in the name ("3.jpg", "Slide 3.png", "Untitled design (2).jpg"), else as given. */
export function inSlideOrder<T extends { name: string }>(files: T[]): T[] {
  const n = (f: T) => Number(/\d+/.exec(f.name)?.[0] ?? Infinity);
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => n(a.f) - n(b.f) || a.i - b.i)
    .map((x) => x.f);
}

/** A picture as Claude reads it: at most 1568 px on the long side (what it looks at anyway), JPEG. */
export async function shrinkImage(file: File, max = 1568): Promise<PendingImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff"; // a transparent PNG gets white, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error(`Couldn't read ${file.name}`))), "image/jpeg", 0.9));
  const data = await new Promise<string>((ok) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",", 2)[1] ?? "");
    r.readAsDataURL(blob);
  });
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name || "Pasted image", type: "image/jpeg", data, url: URL.createObjectURL(blob) };
}
/** Pastes this long become an attachment chip instead of filling the message box. */
export const PASTE_AS_FILE = 1500;
/** "Ask about this": a side chat about one slide or the selected words; it only answers. */
/** One Claude answer's tokens and API-equivalent cost, shown under the answer. */
export type AskUsage = { tokens: number; costUsd: number };
export const askUsageText = (u: AskUsage) => `${(u.tokens / 1000).toFixed(1)}k tokens · $${u.costUsd.toFixed(2)} API-equivalent`;
export const askAbout = (
  sessionId: string,
  docId: string,
  input: { blockId?: string; text: string; start?: number; end?: number; question: string; history: Array<{ role: "user" | "assistant"; text: string }> },
) => fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/ask`, jsonInit(input)).then((r) => json<{ answer: string; usage?: AskUsage }>(r));
/** "Other ways to say this": three versions of the selected words on one slide. */
export const lineOptions = (sessionId: string, docId: string, input: { blockId?: string; text: string; start: number; end: number }) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/lines`, jsonInit(input)).then((r) => json<{ options: string[]; usage?: AskUsage }>(r));
/** "Read as a follower": Claude Fable reads the open piece the way a follower would; its read lands in the chat. */
export const startReview = (sessionId: string, docId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/reviews`, jsonInit({ docId })).then((r) => json<{ ask: ChatMessage; reply: ChatMessage }>(r));
export const respondProposal = (sessionId: string, messageId: string, action: "accept" | "decline", depth?: AuditDepth, question?: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat/${messageId}/proposal`, jsonInit({ action, depth, ...(question ? { question } : {}) })).then((r) => json<{ message: ChatMessage; ask?: ChatMessage; reply?: ChatMessage }>(r));
export const applyAuditFix = (sessionId: string, messageId: string, claimId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat/${messageId}/apply-fix`, jsonInit({ claimId })).then((r) => json<{ doc: WorkshopDocument; messageId: string; claimId: string }>(r));
export const applyAuditFixes = (sessionId: string, messageId: string, claimIds: string[]) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat/${messageId}/apply-fixes`, jsonInit({ claimIds })).then((r) => json<{ doc: WorkshopDocument; messageId: string; applied: string[] }>(r));

const FIX_WHERE = /^(b\d{1,5}|h\d{1,5}|caption|pinned)$/;
export const isAuditFixWhere = (where?: string): where is string => !!where && FIX_WHERE.test(where);

export function claimPlaceLabel(doc: { kind: DocKind; blocks: Array<{ id: string }>; hooks?: Array<{ id: string }> } | undefined, where?: string): string {
  if (!where) return "";
  if (where === "caption") return "Post description";
  if (where === "pinned") return "Pinned comment";
  if (doc?.kind === "notes") return "Notes";
  if (where.startsWith("h")) {
    const i = doc?.hooks?.findIndex((h) => h.id === where) ?? -1;
    return i >= 0 ? `Hook ${i + 1}` : "Hook";
  }
  const i = doc?.blocks.findIndex((b) => b.id === where) ?? -1;
  if (doc && i >= 0) {
    if (doc.kind === "reel") return "Script";
    const u = docUnit(doc.kind).one;
    return `${u[0]!.toUpperCase()}${u.slice(1)} ${i + 1}`;
  }
  return where;
}

/** Canned turns from the description field. Caption-only: no slides, no pin. */
export const WRITE_POST_DESCRIPTION = "Write the post description";
export const ANOTHER_POST_DESCRIPTION = "Another take of the post description";

export function auditFixCount(audit: AuditMeta): number {
  const applied = new Set(audit.applied ?? []);
  return (audit.result?.claims ?? []).filter((c) => c.fix && isAuditFixWhere(c.where) && !applied.has(c.id)).length;
}

/** Score of the piece as it stands: applied rewordings count as supported. */
export function liveAuditScore(audit: Pick<AuditMeta, "applied" | "result">): number {
  const r = audit.result;
  if (!r) return 0;
  const applied = new Set(audit.applied ?? []);
  if (!applied.size) return r.score;
  const claims = r.claims;
  if (!claims.length) return r.score;
  let pts = 0;
  for (const c of claims) {
    const v = applied.has(c.id) ? "supported" : c.verdict;
    pts += v === "supported" ? 1 : v === "partly" ? 0.5 : v === "unverifiable" ? 0.25 : 0;
  }
  return Math.round((pts / claims.length) * 100);
}

export interface TurnInput {
  docId: string;
  text: string;
  context?: ContextSnippet[];
  reading?: { postId: string; slide?: number };
  deep?: boolean;
  comments?: boolean;
  mine?: boolean;
  scope?: ChangeScope;
  quotes?: PieceQuote[];
  /** Big pastes, sent whole as attachments. */
  pasted?: Array<{ name: string; text: string }>;
  /** A retry: pastes the server already keeps from the first try. */
  pastedRefs?: Array<{ id: string; name: string; chars: number }>;
  /** Pictures (base64), in the order they go. */
  images?: Array<{ name: string; type: ImageRef["type"]; data: string }>;
  /** A retry: pictures the server already keeps. */
  imageRefs?: ImageRef[];
  /** Files (PDFs, base64), after the pictures. */
  files?: Array<{ name: string; type: FileRef["type"]; data: string }>;
  /** A retry: files the server already keeps. */
  fileRefs?: FileRef[];
  /** Media Library clips, by id. */
  library?: Array<{ assetId: string; versionId: string } | { refId: string }>;
  /** A retry of a web search you approved. */
  web?: string;
  /** A retry: the server removes these messages in the same write that appends the new pair. */
  retryOf?: string[];
}

export const DOC_KINDS: { id: Exclude<DocKind, "notes">; label: string }[] = [
  { id: "reel", label: "Reel" },
  { id: "carousel", label: "Carousel" },
  { id: "ad", label: "Ad copy" },
  { id: "free", label: "Anything else" },
  { id: "youtube", label: "YouTube script" },
  { id: "newsletter", label: "Newsletter / email" },
  { id: "thread", label: "X post / thread" },
  { id: "article", label: "Article / blog" },
];

let makesOnce: Promise<string[]> | null = null;
/** DOC_KINDS with the kinds the person makes (work-prefs `makes`, setup's "What will you make?") first, for the new-piece menus. */
export function useDocKinds(): typeof DOC_KINDS {
  const [makes, setMakes] = useState<string[]>([]);
  useEffect(() => {
    makesOnce ??= fetch("/api/work-prefs")
      .then((r) => (r.ok ? (r.json() as Promise<{ makes?: string[] }>) : { makes: [] }))
      .then((w) => w.makes ?? [])
      .catch(() => []);
    void makesOnce.then(setMakes);
  }, []);
  return makes.length ? [...DOC_KINDS].sort((a, b) => Number(!makes.includes(a.id)) - Number(!makes.includes(b.id))) : DOC_KINDS;
}

export const KIND_STOCK_TITLE: Record<Exclude<DocKind, "notes">, string> = {
  reel: "Reel",
  carousel: "Carousel",
  ad: "Ad copy",
  free: "Draft",
  youtube: "YouTube script",
  newsletter: "Newsletter",
  thread: "Thread",
  article: "Article",
};

const STOCK_TITLES = ["Script", "Reel", "Reel script", "Carousel", "Ad copy", "Draft", "Free-form", "Free form", "YouTube script", "YouTube", "Newsletter", "Thread", "Article", "Anything else", "Notes"];

/** True when the title is still the kind's default (or the old "Script N" names). */
export function isStockDocTitle(title: string): boolean {
  const t = title.trim();
  if (!t) return true;
  return STOCK_TITLES.some((n) => t.toLowerCase() === n.toLowerCase() || new RegExp(`^${n}\\s+\\d+$`, "i").test(t));
}

export function docTabLabel(doc: { title: string; kind: DocKind }): string {
  if (doc.kind === "notes") return doc.title || "Notes";
  return isStockDocTitle(doc.title) ? docKindLabel(doc.kind) : doc.title;
}

export function docUnit(kind: DocKind): { one: string; many: string } {
  if (kind === "carousel") return { one: "slide", many: "slides" };
  if (kind === "reel") return { one: "script", many: "script" };
  if (kind === "ad") return { one: "line", many: "lines" };
  if (kind === "thread") return { one: "post", many: "posts" };
  if (kind === "free" || kind === "youtube" || kind === "newsletter" || kind === "article") return { one: "section", many: "sections" };
  return { one: "note", many: "notes" };
}

export function countUnits(kind: DocKind, n: number): string {
  if (kind === "notes") return "notes";
  if (kind === "reel") return "script";
  const u = docUnit(kind);
  return `${n} ${n === 1 ? u.one : u.many}`;
}

/** What a turn edited, in the document's words — companions are not beats. */
export function editSummary(kind: DocKind, blockIds: string[]): string {
  if (kind === "notes") return "the notes";
  const hooks = blockIds.filter((id) => /^h\d/.test(id));
  const blocks = blockIds.filter((id) => id !== "caption" && id !== "pinned" && !/^h\d/.test(id));
  const bits: string[] = [];
  if (hooks.length) bits.push(`${hooks.length} hook ${hooks.length === 1 ? "variation" : "variations"}`);
  if (blocks.length) bits.push(kind === "reel" ? "the script" : countUnits(kind, blocks.length));
  if (blockIds.includes("caption")) bits.push("the post description");
  if (blockIds.includes("pinned")) bits.push("the pinned comment");
  return bits.join(" and ") || countUnits(kind, 0);
}

export const docKindLabel = (kind: DocKind) => (kind === "notes" ? "Notes" : kind === "reel" || kind === "carousel" || kind === "ad" || kind === "free" ? draftKindLabel(kind) : DOC_KINDS.find((k) => k.id === kind)!.label);

export const listDocuments = (sessionId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs`).then((r) => json<WorkshopDocument[]>(r));
export const createDocument = (sessionId: string, input: { kind: Exclude<DocKind, "notes">; title?: string; frameworkIds?: string[]; ruleIds?: string[]; text?: string }) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs`, jsonInit(input)).then((r) => json<WorkshopDocument>(r));
/** The Finals versions linked to this piece of the session (Finals' link): one post-description tab each. */
export const listFinalsForDoc = (sessionId: string, docId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/finals`).then((r) => json<{ versions: { key: string; label: string }[] }>(r)).then((x) => x.versions);
export const getDocument = (sessionId: string, docId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}`).then((r) => json<WorkshopDocument>(r));
export const patchDocument = (
  sessionId: string,
  docId: string,
  patch: { title?: string; kind?: DocKind; frameworkIds?: string[]; ruleIds?: string[] | null; carouselType?: string | null; carouselLayouts?: CarouselLayoutSet | null; blocks?: Array<{ id?: string; text: string }>; hooks?: Array<{ id?: string; text: string }>; caption?: string; captions?: Record<string, string>; pinned?: string; locked?: string[] },
) => fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}`, jsonInit(patch, "PATCH")).then((r) => json<WorkshopDocument>(r));
export const generateCarouselLayouts = (
  sessionId: string,
  docId: string,
  input: { typeId?: string; slide?: number; regenerate?: boolean; pick?: number } = {},
) => fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/layouts`, jsonInit(input)).then((r) => json<WorkshopDocument>(r));
export const revertDocument = (sessionId: string, docId: string, versionId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/revert`, jsonInit({ versionId })).then((r) => json<WorkshopDocument>(r));
export const keepDocument = (sessionId: string, docId: string, input: { name?: string; versionId?: string; kept?: boolean } = {}) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/keep`, jsonInit(input)).then((r) => json<WorkshopDocument>(r));
export const deleteDocument = (sessionId: string, docId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
export const restoreDocument = (sessionId: string, docId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/restore`, { method: "POST" }).then((r) => json<WorkshopDocument>(r));
export const documentExportUrl = (sessionId: string, docId: string) => `/api/workshop/sessions/${sessionId}/docs/${docId}/export.md`;

export const listChat = (sessionId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat`).then((r) => json<ChatMessage[]>(r));
export const sendTurn = (sessionId: string, input: TurnInput) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat`, jsonInit(input)).then((r) => json<{ ask: ChatMessage; reply: ChatMessage }>(r));
export const deleteChatMessage = (sessionId: string, messageId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat/${messageId}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
/** Stops a running turn; its partial edits are undone and the message ends as "Stopped". */
export const stopTurn = (sessionId: string, messageId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/chat/${messageId}/stop`, { method: "POST" }).then((r) => json<{ ok: true }>(r));
/** Blocks of one saved version; with `blockIds`, only those. A pruned version answers 404 "gone". */
export const getVersion = (sessionId: string, docId: string, versionId: string, blockIds?: string[]) =>
  fetch(`/api/workshop/sessions/${sessionId}/docs/${docId}/versions/${versionId}${blockIds?.length ? `?blocks=${blockIds.map(encodeURIComponent).join(",")}` : ""}`).then((r) =>
    json<{ id: string; blocks: Array<{ id: string; text: string }> }>(r),
  );

/** The document as markdown, for copy and download. */
export const documentMarkdown = (doc: WorkshopDocument, opts?: { frontmatter?: boolean }) => pieceMarkdown(doc, opts);

/** Reorder a list of ids by moving one a step up or down. */
export function moveId(ids: string[], id: string, dir: -1 | 1): string[] {
  const at = ids.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) return ids;
  const next = [...ids];
  next.splice(at, 1);
  next.splice(to, 0, id);
  return next;
}

export const STAGE_LABELS: Record<NonNullable<ChatMessage["stage"]>, string> = {
  packing: "Packing the sources",
  thinking: "Reading and thinking",
  writing: "Writing",
  applying: "Applying the edits",
  searching: "Searching the library",
  researching: "Reading sources on the web",
};

export type TurnDocChange =
  | { kind: "reverted"; version: string }
  | { kind: "created" | "edited"; docId: string; blocks: number; versionBefore?: string };

/**
 * What a finished turn did to the document. A provider tag is not an edit —
 * replies that only talk, search, or propose have no `edits` object.
 */
export function turnDocChange(m: Pick<ChatMessage, "edits" | "revertedTo">): TurnDocChange | null {
  if (m.revertedTo) return { kind: "reverted", version: m.revertedTo };
  const edits = m.edits;
  if (!edits?.docId) return null;
  return {
    kind: edits.created ? "created" : "edited",
    docId: edits.docId,
    blocks: Array.isArray(edits.blockIds) ? edits.blockIds.length : 0,
    versionBefore: edits.versionBefore,
  };
}

/* ---- the composer's context (pinned, quotes, deep, my words): kept per session, so a reload keeps it ---- */

/** How much a message may change the piece: the composer's slider. */
export type ChangeScope = "slight" | "rewrite";
const SCOPE_KEY = "workshop:scope";
/** The slider stays where the author left it, on this browser. */
export const readScope = (): ChangeScope | undefined => {
  const v = localStorage.getItem(SCOPE_KEY);
  return v === "slight" || v === "rewrite" ? v : undefined;
};
export const saveScope = (v: ChangeScope | undefined) => (v ? localStorage.setItem(SCOPE_KEY, v) : localStorage.removeItem(SCOPE_KEY));

export interface ComposerContext {
  pinned: ContextSnippet[];
  quotes: PieceQuote[];
  deep: boolean;
  mine: boolean;
}

const COMPOSER_CONTEXT_MAX = 50_000; // characters of JSON; a bigger context is dropped rather than half-stored

export function readComposerContext(key: string): Partial<ComposerContext> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as Partial<ComposerContext> | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function saveComposerContext(key: string, ctx: ComposerContext): void {
  const json = JSON.stringify(ctx);
  const empty = !ctx.pinned.length && !ctx.quotes.length && !ctx.deep && !ctx.mine;
  try {
    if (empty || json.length > COMPOSER_CONTEXT_MAX) localStorage.removeItem(key);
    else localStorage.setItem(key, json);
  } catch {
    // storage is full: the context lasts until reload
  }
}

/* ---- share links: pieces for freelancers and team, no account ---- */

export interface WorkshopShareLink {
  token: string;
  owner: string;
  sessionId: string;
  /** The whole session: every piece, new ones too. */
  all?: boolean;
  docIds: string[];
  title: string;
  createdAt: number;
  progress?: ShareProgress;
  deliveries?: ShareDelivery[];
  /** Making a link answers the session's status after it (sharing moves a draft or writing session to production). */
  status?: SessionStatus;
}

/** A shared piece as the share page gets it: text, hooks, description and the picked slide layouts. */
export interface SharedPiece {
  id: string;
  kind: DocKind;
  title: string;
  carouselType?: string;
  carouselLayouts?: WorkshopDocument["carouselLayouts"];
  blocks: Array<{ id: string; text: string }>;
  hooks: Array<{ id: string; text: string }>;
  caption: string;
  pinned: string;
  updatedAt: number;
}

export const listShares = (sessionId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/shares`).then((r) => json<{ shares: WorkshopShareLink[] }>(r)).then((r) => r.shares);
export const createShare = (sessionId: string, docIds: string[], title?: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/shares`, jsonInit({ docIds, ...(title ? { title } : {}) })).then((r) => json<WorkshopShareLink>(r));
/** The one link for the whole session (the same link every time). */
export const shareSession = (sessionId: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/shares`, jsonInit({ all: true })).then((r) => json<WorkshopShareLink>(r));
export const stopShare = (sessionId: string, token: string) =>
  fetch(`/api/workshop/sessions/${sessionId}/shares/${token}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r));
export const workshopShareUrl = (token: string) => `${window.location.origin}/ws/${token}`;

/** What the freelancer marked and delivered on a share link. */
export interface ShareProgress {
  state: "producing" | "done";
  by?: string;
  at: number;
}
export interface ShareDelivery {
  id: string;
  name: string;
  size: number;
  type: string;
  by?: string;
  note?: string;
  at: number;
}
/** Plays in the page; `download` saves it. */
export const shareDeliveryUrl = (token: string, id: string, download = false) => `/api/workshop-share/${token}/deliveries/${id}${download ? "?download=1" : ""}`;
/** Every delivered file in slide order as one ZIP (the iPhone app puts each in Photos). */
export const shareDeliveriesZipUrl = (token: string) => `/api/workshop-share/${token}/deliveries.zip`;

// ---- a session's saved copies (lib/local-cache): the session, its pieces and its chat, each painted at once and live
/** A session's saved copies, and the topics that refetch them: any Workshop change, and its own (a reply while it runs: api/lib/workshop/job.ts). */
export const sessionKeys = (id: string) => ({
  session: `workshop/s/${id}`,
  docs: `workshop/s/${id}/docs`,
  chat: `workshop/s/${id}/chat`,
  live: { topic: ["workshop", `workshop/s/${id}`] },
});
/** The sessions kept with their contents, most recently opened or warmed first; older ones are dropped (every saved copy is read into memory at start). */
export const SAVED_SESSIONS = 30;
const SAVED_INDEX = "workshop/saved";

/** Puts a session first among the kept ones and drops the copies past SAVED_SESSIONS. */
export function keepSession(user: string | null | undefined, id: string) {
  if (!user || !id) return;
  const next = [id, ...(readCached<string[]>(user, SAVED_INDEX) ?? []).filter((x) => x !== id)];
  for (const gone of next.slice(SAVED_SESSIONS)) forgetCached(`workshop/s/${gone}`);
  putCached(user, SAVED_INDEX, next.slice(0, SAVED_SESSIONS));
}
