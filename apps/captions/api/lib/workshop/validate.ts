import { randomUUID } from "node:crypto";
import { SESSION_STATUSES, type ContextField, type ContextSnippet, type DocKind, type DraftKind, type FileRef, type Framework, type FrameworkRole, type GenerateInput, type ImageRef, type KnowledgeFile, type LibraryPick, type LoadedSource, type PieceQuote, type Project, type ProviderChoice, type Rule, type SessionSource, type SessionStatus, type TurnInput } from "./types";
import { isCarouselTypeId } from "../../../src/lib/carousel-visualize";
import { postedFromUrl } from "./posted";
import { isLanguage } from "../../../contracts/voice";
import { EFFORTS, type Effort, type Selection } from "../../../contracts/providers";
import { PLATFORMS, type SocialPlatform } from "../../../contracts/connectors";
import { parseCarouselLayoutSet, type CarouselLayoutSet } from "../../../src/lib/carousel-layout";

export const LIMITS = {
  companion: 10_000,
  name: 80,
  audience: 600,
  voice: 1200,
  cta: 600,
  projectNotes: 20_000,
  knowledgeFiles: 24,
  knowledgeName: 80,
  knowledgeText: 80_000,
  knowledgeTotal: 160_000,
  summary: 600,
  steps: 12,
  minSteps: 2,
  step: 240,
  whenToUse: 600,
  example: 1500,
  pairsWith: 300,
  ruleText: 800,
  rules: 30,
  docTitle: 120,
  docText: 60_000,
  blocks: 400,
  blockText: 4000,
  hooks: 8,
  hookText: 400,
  snippets: 12,
  /** A pinned line from a source, or words of the piece commented on. */
  snippetText: 20_000,
  /** A typed message; big pastes come as attachments. */
  turnText: 100_000,
  /** One pasted attachment, and all of a message's together. */
  pastedText: 2_000_000,
  pastedTotal: 5_000_000,
  /** Pictures with one message: up to 20 (a carousel), 5 MB each (7 MB as base64), 40 MB together (the body cap is 50). */
  images: 20,
  imageData: 7_000_000,
  imagesTotal: 40_000_000,
  /** Files (PDFs) with one message: up to 5, 10 MB each (14 M as base64), 10 MB together. The body cap is 50 MB for pictures and files both. */
  files: 5,
  fileData: 14_000_000,
  filesTotal: 14_000_000,
  /** Media Library clips with one message (their thumbnails ride with the pictures). */
  libraryClips: 5,
  title: 120,
  query: 200,
  sourceNote: 400,
  sources: 40,
  generateSources: 12,
  frameworks: 3,
  prompt: 4000,
  notes: 200_000,
} as const;

export const DRAFT_KINDS: DraftKind[] = ["reel", "carousel", "ad", "free"];

export function parseSessionStatus(raw: unknown): SessionStatus | undefined {
  return SESSION_STATUSES.includes(raw as SessionStatus) ? (raw as SessionStatus) : undefined;
}

export const okId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z0-9-]{6,40}$/.test(id);

/** A clip a message names: a version (assetId, versionId), a ref (refId) or a source's item (source, kind, externalId); else null. */
function libraryPick(r: Record<string, unknown>): LibraryPick | null {
  if (okId(r.assetId) && okId(r.versionId)) return { assetId: r.assetId, versionId: r.versionId };
  if (typeof r.refId === "string" && /^ext_[a-f0-9]{16}$/.test(r.refId)) return { refId: r.refId };
  const externalId = typeof r.externalId === "number" ? String(r.externalId) : r.externalId;
  if (typeof r.source === "string" && typeof r.kind === "string" && typeof externalId === "string" && r.source && r.kind && externalId) {
    return { source: r.source, kind: r.kind, externalId };
  }
  return null;
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/** Take a field from the body when present, else keep the base value. */
function field(body: Record<string, unknown>, key: string, base: string, max: number): string {
  return key in body ? str(body[key], max) : base;
}

type ProjectFields = Pick<Project, "name" | "audience" | "voice" | "cta" | "notes" | "knowledge" | "color" | "off" | "handles" | "languages"> & {
  accountId?: string | null;
};

/** The colours a project can take (the client maps each to its classes). */
export const PROJECT_COLORS = ["violet", "sky", "emerald", "amber", "rose", "orange", "teal", "pink", "blue", "indigo", "fuchsia", "red", "lime", "cyan", "yellow", "slate"] as const;

function parseAccountId(raw: unknown): string | null {
  if (raw === null || raw === "") return null;
  if (okId(raw)) return raw;
  throw new Error("Unknown account");
}

const HANDLE_RE = /^[A-Za-z0-9._-]{1,60}$/;
const PLATFORM_IDS = new Set<string>(PLATFORMS.map((p) => p.id));

/**
 * A project's handles from the setup form: known platforms only, the @ dropped, trimmed, at most five; a blank value
 * is dropped, a value with other characters is refused by name. Anything that is not an object reads as none.
 */
export function parseHandles(raw: unknown): Partial<Record<SocialPlatform, string>> {
  const out: Partial<Record<SocialPlatform, string>> = {};
  if (!isRec(raw)) return out;
  for (const [platform, value] of Object.entries(raw)) {
    if (Object.keys(out).length >= 5) break;
    if (!PLATFORM_IDS.has(platform) || typeof value !== "string") continue;
    const handle = value.trim().replace(/^@/, "");
    if (!handle) continue;
    if (!HANDLE_RE.test(handle)) throw new Error(`Handle for ${platform}: letters, numbers, dot, dash or underscore`);
    out[platform as SocialPlatform] = handle;
  }
  return out;
}

export function parseKnowledge(raw: unknown, now = Date.now()): KnowledgeFile[] {
  if (!Array.isArray(raw)) return [];
  const out: KnowledgeFile[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const item of raw) {
    if (out.length >= LIMITS.knowledgeFiles) break;
    if (!isRec(item)) continue;
    const text = typeof item.text === "string" ? item.text.slice(0, LIMITS.knowledgeText) : "";
    const name = str(item.name, LIMITS.knowledgeName) || "Note";
    let id = okId(item.id) ? item.id : randomUUID();
    if (seen.has(id)) id = randomUUID();
    seen.add(id);
    const addedAt = typeof item.addedAt === "number" && Number.isFinite(item.addedAt) ? item.addedAt : now;
    const room = LIMITS.knowledgeTotal - used;
    if (room <= 0) break;
    const clipped = text.length <= room ? text : text.slice(0, room);
    out.push({ id, name, text: clipped, addedAt });
    used += clipped.length;
  }
  return out;
}

export function parseProjectInput(raw: unknown, base?: ProjectFields): ProjectFields {
  const body = isRec(raw) ? raw : {};
  const b = base ?? { name: "", audience: "", voice: "", cta: "", notes: "", knowledge: [] };
  const out: ProjectFields = {
    name: field(body, "name", b.name, LIMITS.name),
    audience: field(body, "audience", b.audience, LIMITS.audience),
    voice: field(body, "voice", b.voice, LIMITS.voice),
    cta: field(body, "cta", b.cta, LIMITS.cta),
    notes: field(body, "notes", b.notes, LIMITS.projectNotes),
    knowledge: "knowledge" in body ? parseKnowledge(body.knowledge) : (b.knowledge ?? []),
    accountId: "accountId" in body ? parseAccountId(body.accountId) : b.accountId,
    // always set (none = {}), so a PUT that clears the handles also overwrites the old ones
    handles: "handles" in body ? parseHandles(body.handles) : (b.handles ?? {}),
  };
  const color = "color" in body ? PROJECT_COLORS.find((c) => c === body.color) : b.color;
  if (color) out.color = color;
  else delete out.color;
  const off = "off" in body ? (Array.isArray(body.off) ? [...new Set(body.off.filter(okId))].slice(0, 500) : []) : b.off;
  if (off?.length) out.off = off;
  else delete out.off;
  // none ([] or null) = the person's Voice languages
  const languages = "languages" in body ? (Array.isArray(body.languages) ? [...new Set(body.languages.filter(isLanguage))].slice(0, 5) : []) : b.languages;
  if (languages?.length) out.languages = languages;
  else delete out.languages;
  if (!out.name) throw new Error("Give the project a name");
  return out;
}

/** Steps arrive as an array or as one-per-line text. */
export function parseSteps(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/\r?\n/)
      : [];
  return list
    .map((s) => (typeof s === "string" ? s.trim().replace(/^\d+[.)]\s*/, "").slice(0, LIMITS.step) : ""))
    .filter(Boolean)
    .slice(0, LIMITS.steps);
}

export const FRAMEWORK_ROLES: FrameworkRole[] = ["narrative", "persuasion", "argument"];

export const parseFrameworkRole = (v: unknown, fallback: FrameworkRole = "narrative"): FrameworkRole =>
  FRAMEWORK_ROLES.find((r) => r === v) ?? fallback;

type FrameworkFields = Pick<Framework, "name" | "role" | "summary" | "steps" | "whenToUse" | "pairsWith" | "example">;

export function parseFrameworkInput(raw: unknown, base?: FrameworkFields): FrameworkFields {
  const body = isRec(raw) ? raw : {};
  const b = base ?? { name: "", role: "narrative" as FrameworkRole, summary: "", steps: [], whenToUse: "", pairsWith: undefined, example: undefined };
  const steps = "steps" in body ? parseSteps(body.steps) : b.steps;
  const example = "example" in body ? str(body.example, LIMITS.example) : b.example;
  const pairsWith = "pairsWith" in body ? str(body.pairsWith, LIMITS.pairsWith) : b.pairsWith;
  const out: FrameworkFields = {
    name: field(body, "name", b.name, LIMITS.name),
    role: "role" in body ? parseFrameworkRole(body.role, b.role) : b.role,
    summary: field(body, "summary", b.summary, LIMITS.summary),
    steps,
    whenToUse: field(body, "whenToUse", b.whenToUse, LIMITS.whenToUse),
    pairsWith: pairsWith || undefined,
    example: example || undefined,
  };
  if (!out.name) throw new Error("Give the framework a name");
  if (out.steps.length < LIMITS.minSteps) throw new Error("A framework needs at least two steps");
  return out;
}

type RuleFields = Pick<Rule, "name" | "text" | "on">;

export function parseRuleInput(raw: unknown, base?: RuleFields): RuleFields {
  const body = isRec(raw) ? raw : {};
  const b = base ?? { name: "", text: "", on: true };
  const out: RuleFields = {
    name: field(body, "name", b.name, LIMITS.name),
    text: field(body, "text", b.text, LIMITS.ruleText),
    on: "on" in body ? body.on !== false : b.on,
  };
  if (!out.text) throw new Error("Write the rule");
  if (!out.name) out.name = out.text.slice(0, 40);
  return out;
}

export function parseSources(raw: unknown, now = Date.now()): SessionSource[] {
  if (!Array.isArray(raw)) throw new Error("Sources must be a list");
  const out: SessionSource[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const postId = isRec(item) ? item.postId : item;
    if (!okId(postId) || seen.has(postId)) continue;
    seen.add(postId);
    const note = isRec(item) ? str(item.note, LIMITS.sourceNote) : "";
    const addedAt = isRec(item) && typeof item.addedAt === "number" ? item.addedAt : now;
    out.push({ postId, addedAt, ...(note ? { note } : {}) });
  }
  if (out.length > LIMITS.sources) throw new Error(`A session holds at most ${LIMITS.sources} sources`);
  return out;
}

export interface SessionPatch {
  ai?: Selection | null;
  loaded?: LoadedSource[];
  title?: string;
  query?: string;
  projectId?: string | null;
  status?: SessionStatus;
  pinned?: boolean;
  sources?: SessionSource[];
  notes?: string;
  /** a pasted post link (added to the session's posts, or its version changed), `{ remove }` for "not this post" on one of them,
   *  or null for none of them */
  posted?: { shortcode: string; url: string; version?: string; publication?: "published" | "trial" } | { remove: string } | null;
}

export function parseSessionPatch(raw: unknown): SessionPatch {
  const body = isRec(raw) ? raw : {};
  const out: SessionPatch = {};
  if ("title" in body) out.title = str(body.title, LIMITS.title);
  if ("query" in body) out.query = str(body.query, LIMITS.query);
  if ("projectId" in body) {
    if (body.projectId === null || body.projectId === "") out.projectId = null;
    else if (okId(body.projectId)) out.projectId = body.projectId;
    else throw new Error("Unknown project");
  }
  if ("status" in body) {
    const status = parseSessionStatus(body.status);
    if (!status) throw new Error("Unknown status");
    out.status = status;
  }
  if ("pinned" in body) {
    if (typeof body.pinned !== "boolean") throw new Error("pinned: true or false");
    out.pinned = body.pinned;
  }
  if ("posted" in body) {
    if (body.posted === null) out.posted = null;
    else if (isRec(body.posted) && typeof body.posted.remove === "string" && /^[\w-]{5,}$/.test(body.posted.remove)) out.posted = { remove: body.posted.remove };
    else {
      const raw = isRec(body.posted) ? body.posted.url : body.posted;
      const posted = typeof raw === "string" ? postedFromUrl(raw) : null;
      if (!posted) throw new Error("Paste the post's Instagram link (instagram.com/p/… or /reel/…)");
      const version = isRec(body.posted) ? body.posted.version : undefined;
      if (version !== undefined && (typeof version !== "string" || !VERSION_KEY.test(version))) throw new Error("Unknown version");
      const pub = isRec(body.posted) ? body.posted.publication : undefined;
      if (pub !== undefined && pub !== "published" && pub !== "trial") throw new Error("publication: published or trial");
      out.posted = { ...posted, ...(version ? { version } : {}), ...(pub ? { publication: pub } : {}) };
    }
  }
  if ("sources" in body) out.sources = parseSources(body.sources);
  if ("notes" in body) out.notes = typeof body.notes === "string" ? body.notes.slice(0, LIMITS.notes) : "";
  if ("ai" in body) {
    if (body.ai === null) out.ai = null;
    else {
      const a = isRec(body.ai) ? body.ai : {};
      if (typeof a.instance !== "string" || typeof a.model !== "string" || !EFFORTS.includes(a.effort as Effort)) throw new Error("Pick an AI, a model and an effort");
      out.ai = { instance: a.instance.slice(0, 60), model: a.model.slice(0, 80), effort: a.effort as Effort };
    }
  }
  if ("loaded" in body) {
    // The author can only clear what was pulled; parts are pulled by the AI (or the composer) per turn.
    out.loaded = [];
  }
  return out;
}

export function parseGenerateInput(raw: unknown): GenerateInput {
  const body = isRec(raw) ? raw : {};
  const kind = DRAFT_KINDS.find((k) => k === body.kind);
  if (!kind) throw new Error("Pick what to generate: reel, carousel, ad, or free");
  const prompt = str(body.prompt, LIMITS.prompt);
  const sourceIds = Array.isArray(body.sourceIds)
    ? [...new Set(body.sourceIds.filter(okId))]
    : undefined;
  if (sourceIds && sourceIds.length > LIMITS.generateSources) {
    throw new Error(`Generate from at most ${LIMITS.generateSources} sources at a time`);
  }
  const frameworkIds = Array.isArray(body.frameworkIds)
    ? [...new Set(body.frameworkIds.filter(okId))].slice(0, LIMITS.frameworks)
    : okId(body.frameworkId)
      ? [body.frameworkId]
      : [];
  const ruleIds = Array.isArray(body.ruleIds) ? [...new Set(body.ruleIds.filter(okId))].slice(0, LIMITS.rules) : undefined;
  return {
    kind,
    projectId: okId(body.projectId) ? body.projectId : undefined,
    frameworkIds,
    ruleIds,
    prompt,
    includeNotes: body.includeNotes !== false,
    sourceIds,
  };
}

export function slugFilename(title: string, ext = "md"): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "workshop"}.${ext}`;
}

/* ---- co-writing ---- */

const DOC_KINDS: DocKind[] = ["reel", "carousel", "ad", "free", "youtube", "newsletter", "thread", "article", "notes"];
const CONTEXT_FIELDS: ContextField[] = ["slides", "transcript", "caption", "comments", "description", "source"];

export interface DocCreate {
  kind: Exclude<DocKind, "notes">;
  title: string;
  frameworkIds: string[];
  ruleIds?: string[];
  text: string;
}

const KIND_TITLE: Record<DocKind, string> = { reel: "Reel", carousel: "Carousel", ad: "Ad copy", free: "Draft", youtube: "YouTube script", newsletter: "Newsletter", thread: "Thread", article: "Article", notes: "Notes" };

export function parseDocCreate(raw: unknown): DocCreate {
  const body = isRec(raw) ? raw : {};
  const kind = DOC_KINDS.find((k) => k === body.kind && k !== "notes") as DocCreate["kind"] | undefined;
  if (!kind) throw new Error("Pick what the document is: reel, carousel, ad, free, youtube, newsletter, thread or article");
  return {
    kind,
    title: str(body.title, LIMITS.docTitle) || KIND_TITLE[kind],
    frameworkIds: Array.isArray(body.frameworkIds) ? [...new Set(body.frameworkIds.filter(okId))].slice(0, LIMITS.frameworks) : [],
    ruleIds: Array.isArray(body.ruleIds) ? [...new Set(body.ruleIds.filter(okId))].slice(0, LIMITS.rules) : undefined,
    text: typeof body.text === "string" ? body.text.slice(0, LIMITS.docText) : "",
  };
}

/** A version's key in a document's `captions` and a posting's `version`: a Finals version's id. */
export const VERSION_KEY = /^[\w-]{1,40}$/;

export interface DocPatch {
  caption?: string;
  /** Versions' own post descriptions by key; "" clears one, so the main one shows again. */
  captions?: Record<string, string>;
  pinned?: string;
  title?: string;
  kind?: DocKind;
  frameworkIds?: string[];
  ruleIds?: string[] | null;
  carouselType?: string | null;
  carouselLayouts?: CarouselLayoutSet | null;
  blocks?: Array<{ id?: string; text: string }>;
  hooks?: Array<{ id?: string; text: string }>;
  /** The slides the author locked, by block id. */
  locked?: string[];
}

export function parseDocPatch(raw: unknown, kind?: DocKind): DocPatch {
  const body = isRec(raw) ? raw : {};
  const out: DocPatch = {};
  if ("title" in body) out.title = str(body.title, LIMITS.docTitle);
  if ("kind" in body) {
    const kindPatch = DOC_KINDS.find((k) => k === body.kind);
    if (!kindPatch) throw new Error("Unknown document kind");
    out.kind = kindPatch;
  }
  if ("frameworkIds" in body) out.frameworkIds = Array.isArray(body.frameworkIds) ? [...new Set(body.frameworkIds.filter(okId))].slice(0, LIMITS.frameworks) : [];
  if ("ruleIds" in body) out.ruleIds = body.ruleIds === null ? null : Array.isArray(body.ruleIds) ? [...new Set(body.ruleIds.filter(okId))].slice(0, LIMITS.rules) : null;
  if ("blocks" in body) {
    if (!Array.isArray(body.blocks)) throw new Error("Blocks must be a list");
    // a reel is one script page like notes: a save must not cut it to a slide's length
    const maxText = kind === "notes" || kind === "reel" ? LIMITS.notes : LIMITS.blockText;
    const maxBlocks = kind === "notes" ? 1 : LIMITS.blocks;
    out.blocks = body.blocks
      .filter(isRec)
      .slice(0, maxBlocks)
      .map((b) => ({ ...(typeof b.id === "string" && /^b\d{1,5}$/.test(b.id) ? { id: b.id } : {}), text: typeof b.text === "string" ? b.text.slice(0, maxText) : "" }));
  }
  if ("locked" in body) out.locked = Array.isArray(body.locked) ? [...new Set(body.locked.filter((x): x is string => typeof x === "string" && /^b\d{1,5}$/.test(x)))].slice(0, LIMITS.blocks) : [];
  if ("caption" in body) out.caption = typeof body.caption === "string" ? body.caption.slice(0, LIMITS.companion) : "";
  if ("pinned" in body) out.pinned = typeof body.pinned === "string" ? body.pinned.slice(0, LIMITS.companion) : "";
  if (isRec(body.captions)) {
    out.captions = Object.fromEntries(
      Object.entries(body.captions)
        .filter(([k]) => VERSION_KEY.test(k))
        .slice(0, 26)
        .map(([k, v]) => [k, typeof v === "string" ? v.slice(0, LIMITS.companion) : ""]),
    );
  }
  if ("hooks" in body) {
    if (!Array.isArray(body.hooks)) throw new Error("Hooks must be a list");
    out.hooks = body.hooks
      .filter(isRec)
      .slice(0, LIMITS.hooks)
      .map((b) => ({ ...(typeof b.id === "string" && /^h\d{1,5}$/.test(b.id) ? { id: b.id } : {}), text: typeof b.text === "string" ? b.text.slice(0, LIMITS.hookText) : "" }));
  }
  if ("carouselType" in body) {
    if (body.carouselType === null || body.carouselType === "") out.carouselType = null;
    else if (isCarouselTypeId(body.carouselType)) out.carouselType = body.carouselType;
    else throw new Error("Unknown carousel type");
  }
  if ("carouselLayouts" in body) {
    out.carouselLayouts = body.carouselLayouts === null ? null : parseCarouselLayoutSet(body.carouselLayouts);
  }
  return out;
}

export interface LayoutRequest {
  typeId?: string;
  slide?: number;
  regenerate?: boolean;
  pick?: number;
}

export function parseLayoutRequest(raw: unknown): LayoutRequest {
  const body = isRec(raw) ? raw : {};
  const out: LayoutRequest = {};
  if (isCarouselTypeId(body.typeId)) out.typeId = body.typeId;
  if (body.regenerate === true) out.regenerate = true;
  if (typeof body.slide === "number" && Number.isInteger(body.slide) && body.slide >= 1 && body.slide <= 16) {
    out.slide = body.slide;
  }
  if (typeof body.pick === "number" && Number.isInteger(body.pick) && body.pick >= 0 && body.pick <= 2) {
    out.pick = body.pick;
  }
  return out;
}

export function parseSnippets(raw: unknown): ContextSnippet[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextSnippet[] = [];
  for (const item of raw.slice(0, LIMITS.snippets)) {
    if (!isRec(item) || !okId(item.postId)) continue;
    const field = CONTEXT_FIELDS.find((f) => f === item.field);
    const text = str(item.text, LIMITS.snippetText);
    if (!field || !text) continue;
    const slide = typeof item.slide === "number" && Number.isInteger(item.slide) && item.slide >= 0 ? item.slide : undefined;
    out.push({ postId: item.postId, handle: str(item.handle, 40) || "creator", field, text, ...(slide !== undefined ? { slide } : {}) });
  }
  return out;
}

export function parseQuotes(raw: unknown): PieceQuote[] {
  if (!Array.isArray(raw)) return [];
  const out: PieceQuote[] = [];
  for (const q of raw.slice(0, 12)) {
    if (!isRec(q)) continue;
    const text = str(q.text, LIMITS.snippetText);
    if (!text) continue;
    const comment = str(q.comment, LIMITS.turnText);
    out.push({
      text,
      ...(typeof q.blockId === "string" && /^[bh]\d{1,5}$/.test(q.blockId) ? { blockId: q.blockId } : {}),
      ...(typeof q.slide === "number" && Number.isInteger(q.slide) && q.slide >= 0 && q.slide < 1000 ? { slide: q.slide } : {}),
      ...(comment ? { comment } : {}),
      ...(q.from === "reply" ? { from: "reply" as const } : {}),
      ...(q.field === "script" || q.field === "hook" || q.field === "caption" || q.field === "pinned" ? { field: q.field } : {}),
      // Instagram shortcodes: upper case and underscores, so not okId
      ...(typeof q.postId === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(q.postId) ? { postId: q.postId } : {}),
      ...(str(q.handle, 40) ? { handle: str(q.handle, 40) } : {}),
    });
  }
  return out;
}

export function parsePasted(raw: unknown): Array<{ name: string; text: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; text: string }> = [];
  let total = 0;
  for (const p of raw.slice(0, 20)) {
    if (!isRec(p) || typeof p.text !== "string" || !p.text.trim()) continue;
    if (p.text.length > LIMITS.pastedText) throw new Error(`A pasted text is over ${LIMITS.pastedText.toLocaleString("en-US")} characters`);
    total += p.text.length;
    if (total > LIMITS.pastedTotal) throw new Error("The pasted texts are too big together");
    out.push({ name: str(p.name, 80) || `Pasted text ${out.length + 1}`, text: p.text });
  }
  return out;
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const isImageType = (t: unknown): t is ImageRef["type"] => IMAGE_TYPES.includes(t as ImageRef["type"]);

/** Pictures with a message, base64 (the page shrinks them to what Claude reads first, ≤ 1568 px). */
export function parseImages(raw: unknown): Array<{ name: string; type: ImageRef["type"]; data: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; type: ImageRef["type"]; data: string }> = [];
  let total = 0;
  for (const p of raw.slice(0, LIMITS.images)) {
    if (!isRec(p) || typeof p.data !== "string" || !isImageType(p.type) || !/^[A-Za-z0-9+/]+=*$/.test(p.data)) continue;
    if (p.data.length > LIMITS.imageData) throw new Error("A picture is too big: send it under 5 MB");
    total += p.data.length;
    if (total > LIMITS.imagesTotal) throw new Error("The pictures are too big together");
    out.push({ name: str(p.name, 80) || `Image ${out.length + 1}`, type: p.type, data: p.data });
  }
  return out;
}

const FILE_TYPES = ["application/pdf"] as const;
const isFileType = (t: unknown): t is FileRef["type"] => FILE_TYPES.includes(t as FileRef["type"]);

/** Files with a message (a PDF the AI reads from the Mac folder): base64, allow-listed, checked to be what they say, capped. A bad one is refused, never dropped. */
export function parseFiles(raw: unknown): Array<{ name: string; type: FileRef["type"]; data: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; type: FileRef["type"]; data: string }> = [];
  let total = 0;
  for (const p of raw.slice(0, LIMITS.files)) {
    if (!isRec(p)) throw new Error("A file did not come through: send it again");
    const name = str(p.name, 80) || `File ${out.length + 1}`;
    if (!isFileType(p.type)) throw new Error(`${name} can't be read yet: send a picture, a text file or a PDF`);
    if (typeof p.data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(p.data) || p.data.length % 4 !== 0) throw new Error(`${name} did not come through: send it again`);
    if (p.data.length > LIMITS.fileData) throw new Error(`${name} is too big: send it under 10 MB`);
    if (Buffer.from(p.data.slice(0, 8), "base64").subarray(0, 4).toString("latin1") !== "%PDF") throw new Error(`${name} is not a PDF`);
    total += p.data.length;
    if (total > LIMITS.filesTotal) throw new Error("The files are too big together: 10 MB");
    out.push({ name, type: p.type, data: p.data });
  }
  return out;
}

export function parseTurnInput(raw: unknown): TurnInput {
  const body = isRec(raw) ? raw : {};
  if (!okId(body.docId)) throw new Error("Pick a document to write in");
  const pasted = parsePasted(body.pasted);
  const refs = (Array.isArray(body.pastedRefs) ? body.pastedRefs : [])
    .filter(isRec)
    .filter((r) => okId(r.id))
    .slice(0, 20)
    .map((r) => ({ id: r.id as string, name: str(r.name, 80) || "Pasted text", chars: typeof r.chars === "number" ? Math.max(0, Math.floor(r.chars)) : 0 }));
  const images = parseImages(body.images);
  const files = parseFiles(body.files);
  const fileRefs = (Array.isArray(body.fileRefs) ? body.fileRefs : [])
    .filter(isRec)
    .filter((r) => okId(r.id) && isFileType(r.type))
    .slice(0, LIMITS.files)
    .map((r) => ({ id: r.id as string, name: str(r.name, 80) || "File", type: r.type as FileRef["type"], bytes: typeof r.bytes === "number" ? Math.max(0, Math.floor(r.bytes)) : 0 }));
  const imageRefs = (Array.isArray(body.imageRefs) ? body.imageRefs : [])
    .filter(isRec)
    .filter((r) => okId(r.id) && isImageType(r.type))
    .slice(0, LIMITS.images)
    .map((r) => ({ id: r.id as string, name: str(r.name, 80) || "Image", type: r.type as ImageRef["type"] }));
  const quotes = parseQuotes(body.quotes);
  const library = (Array.isArray(body.library) ? body.library : [])
    .filter(isRec)
    .map(libraryPick)
    .filter((r): r is LibraryPick => r !== null)
    .slice(0, LIMITS.libraryClips);
  // Only citation chips (⟦1⟧…) is not a message: it gets the words a pictures-only one gets
  const typed = str(body.text, LIMITS.turnText);
  const words = typed.replace(/⟦\d+⟧/g, "").trim();
  const text = words ? typed : pasted.length || refs.length ? "Read what I pasted." : images.length || imageRefs.length || files.length || fileRefs.length || quotes.length || library.length ? "Look at these." : "";
  if (!text) throw new Error("Say something first");
  const retryOf = (Array.isArray(body.retryOf) ? body.retryOf : []).filter(okId).slice(0, 4);
  const reading =
    isRec(body.reading) && okId(body.reading.postId)
      ? { postId: body.reading.postId, ...(typeof body.reading.slide === "number" ? { slide: Math.max(0, Math.floor(body.reading.slide)) } : {}) }
      : undefined;
  return { docId: body.docId, text, context: parseSnippets(body.context), reading, deep: body.deep === true, comments: body.comments === true, mine: body.mine === true, ...(body.scope === "slight" || body.scope === "rewrite" ? { scope: body.scope } : {}), ...(quotes.length ? { quotes } : {}), ...(pasted.length ? { pasted } : {}), ...(refs.length ? { pastedRefs: refs } : {}), ...(images.length ? { images } : {}), ...(imageRefs.length ? { imageRefs } : {}), ...(files.length ? { files } : {}), ...(fileRefs.length ? { fileRefs } : {}), ...(library.length ? { library } : {}), ...(str(body.web, 600) ? { web: str(body.web, 600) } : {}), ...(retryOf.length ? { retryOf } : {}) };
}

export interface AuditInput {
  /** The document the audit belongs to in the conversation (and the one checked, unless postId is given). */
  docId: string;
  postId?: string;
  depth: "quick" | "deep";
}

export function parseAuditInput(raw: unknown): AuditInput {
  const body = isRec(raw) ? raw : {};
  if (!okId(body.docId)) throw new Error("Pick a document first");
  return { docId: body.docId, postId: okId(body.postId) ? body.postId : undefined, depth: body.depth === "deep" ? "deep" : "quick" };
}
