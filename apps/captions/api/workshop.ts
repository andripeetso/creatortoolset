import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { checkDraft } from "./lib/workshop/rule-check";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { notifyWorkshopOwner, sendFile } from "./review";
import { inSlideOrder, storedZip, type Delivery } from "./lib/workshop/deliveries";
import path from "node:path";
import { sessionOf, type AuthVars } from "./auth";
import { AiProviderError, aiFor as route, completeWithFallback, streamWithFallback, type ProviderOpts, type StreamHooks } from "./ai-complete";
import type { Selection } from "../contracts/providers";
import { MAC_MISS, MacClaudeError, streamMacClaude, type MacErrorKind, type MacOpts, type MacSession, type MacUsage } from "./lib/mac-claude";
import { env } from "./lib/env";
import type { SessionUser, UserRecord } from "./users";
import { findOwnPost, findPostsForUser, libraryCountFor, libraryForWorkshop, mineAccountId, scopeOldAnalyzer, ownAccountContextFor, ownPostComments, ownPostsForWorkshop, packPostsForUser, postsForUser, sourceIndexForUser, transcribeForUser } from "./instagram";
import { liveEnd, listen, liveText } from "./lib/workshop/live";
import { type Folder, frameworkFiles, libraryFiles, outsideWords, keptPer1k, ownPostFiles, pastedFile, postFile, pastedWords, sessionFile, sessionsIndex, sessionText, slug, sourceFile } from "./lib/workshop/folder";
import { linkCandidates, matchPosted, postingsOf, postWords, postedFromUrl, setPostings, tfidf } from "./lib/workshop/posted";
import { finished, keptByWeek, keptShare } from "./lib/workshop/kept";
import { closestPairs, closestPosts } from "./lib/workshop/closest";
import { providerSettings, routeFor } from "./lib/providers";
import { isOnline } from "./lib/devices";
import type { AccountContext, Comment } from "./lib/instagram/types";
import { annotateComments } from "./lib/instagram/comment-judge";
import { buildAnswerPrompt, listComments, type AnswerMessage, type AnswersFile } from "./lib/workshop/answers";
import { perplexityComplete, type ResearchAnswer, type ResearchDepth } from "./lib/research/perplexity";
import { keyFor } from "./my-keys";
import { AUDIT_JSON_SCHEMA, AUDIT_SYSTEM, MAC_RESEARCH, MAX_AUDIT_CHARS, RESEARCH_QUESTION_SYSTEM, auditEdits, auditSummaryText, documentAudit, parseAuditResult, postAuditText, splitSources } from "./lib/workshop/audit";
import { partialTurn } from "./lib/workshop/stream-json";
import { bumpUsage, findUser } from "./users";
import type { ClaudeSession, ClipRef, FileRef, ImageRef, PastedRef, TurnStep } from "./lib/workshop/types";
import { ATTACH_EXT, attachedFile } from "./lib/workshop/attached";
import type { AuditMeta, AuditTarget, Chat, ChatMessage, DocKind, Document, DraftKind, DraftMeta, Framework, KnowledgeFile, KnowledgeSource, LoadedSource, Posting, Project, Proposal, ResearchNote, Rule, SessionMeta, SessionStatus, SourcePart } from "./lib/workshop/types";
import { type AuditInput, LIMITS, okId, parseAuditInput, parseDocCreate, parseDocPatch, parseFrameworkInput, parseGenerateInput, parseLayoutRequest, parseProjectInput, PROJECT_COLORS, parseRuleInput, parseSessionPatch, parseSources, parseTurnInput } from "./lib/workshop/validate";
import { setSessionStatus, TURN_STOPPED } from "./lib/workshop/types";
import { readWorkPrefs } from "./work-prefs";
import { emitEvent, onEvent } from "./lib/events";
import { IllegalTransition } from "./lib/transition";
import { pluginCheckPosted } from "./lib/plugin";
import {
  getWorkspace,
  inProject,
  onFor,
  ownedProjects,
  readUserMarker,
  resolveProjectId,
  setCurrentProjectId,
  writeUserMarker,
} from "./lib/workshop/workspace";
import { ORIGINAL_SEED_KEYS, RETIRED_SEED_KEYS, SEED_FRAMEWORKS, extraFrameworkCopyIds, missingSeeds, planRuleSeedSync, ruleSeedAt } from "./lib/workshop/seeds";
import { attachment, buildExportMarkdown, demoteHeadings, KIND_TITLE, obsidianExports, obsidianPieces, obsidianStatus, sessionStatusOf, type ObsidianPiece } from "./lib/workshop/export";
import { BUILTIN_EXPORT, exportFile, listExports, parseExports, pieceFromNote, renderTemplate, SYNCED_STATUSES, type PendingExport, type WorkshopExport } from "./lib/workshop/notes";
import { cardsFrontmatter, exportFilename, exportStem, pictureIds, PICTURE_TOKEN, pieceMarkdown } from "../src/lib/workshop-markdown";
import { PICTURE_EXT, PICTURE_TYPES, parsePictureUpload } from "./lib/workshop/pictures";
import { ZipFile } from "yazl";
import { buildGeneratePrompt, clipLoadedKnowledge, matchKnowledge, renderAccountContext } from "./lib/workshop/prompt";
import { OCR_BATCH, OCR_SYSTEM, READ_SYSTEM, SOURCE_LIMITS, asKnowledge, knowledgeIndex, knowledgePath, ocrPrompt, parseReading, parseSourcePatch, readPrompt } from "./lib/workshop/sources";
import { documentText, webPageText } from "./lib/workshop/source-files";
import { parseYoutubeUrl } from "./lib/youtube/url";
import { channelFiles } from "./connectors";
import { fetchYoutubeViaApify } from "./lib/youtube/fetch";
import { PLAN_PARSERS } from "./lib/workshop/plans";
import { renderDraft } from "./lib/workshop/render";
import { applyEdits, docToMarkdown, keep, markEditsSeen, newDocument, onVersion, revert, setVersionKept, snapshot, userEdit } from "./lib/workshop/doc";
import { captionExamplesFor } from "./lib/workshop/caption-examples";
import { askedForCaption, askedOnlyForCaption, editsForNewDocument, isAccountFetchSource, gateCompanionEdits, parseTurn, type TurnPlan } from "./lib/workshop/chat-plans";
import { packInstructions } from "./lib/packs";
import { buildTurnPrompt, wantsComments } from "./lib/workshop/chat-prompt";
import { REVIEW_MODEL, audienceOf, buildReviewPrompt, type ReviewPost } from "./lib/workshop/review";
import { readThrough } from "./lib/workshop/readthrough";
import { type EditPair, editsFile, mergeLog, pairsOf } from "./lib/workshop/edit-log";
import { buildLinesPrompt, parseLines } from "./lib/workshop/lines";
import { buildAsidePrompt } from "./lib/workshop/aside";
import { clipContext, externalLibraryRef, libraryRef } from "./library/attach";
import { finalsLinkedTo, linkFinalsPiece } from "./library/finals";
import { libraryDb } from "./library/db";
import { libraryRole } from "./library/access";
import { resolveCarouselType, visualizeCarousel } from "../src/lib/carousel-visualize";
import {
  buildLayoutPrompt,
  coerceCompose,
  layoutSourceHash,
  parseLayoutVariants,
  parseOneCompose,
  type CarouselLayoutSet,
  type SlideCompose,
} from "../src/lib/carousel-layout";

/**
 * Every Workshop call goes to the Workshop's AI provider (Admin → Your AI; the session's own pick first),
 * on the paired Mac. There is no
 * API-key fallback for accounts: a Mac that is off or a run that fails says so. A request with no user
 * (carousel layouts) runs on the default.
 */
const workshopAi = (user: SessionUser, own?: Selection): ProviderOpts => route(user, "workshop", "Workshop", own);
// the Workshop's own route: an account on an Anthropic key has AI elsewhere, but not here (aiFor onApiKey)
const aiOn = (user: SessionUser) => !workshopAi(user).off;
/** Which provider and model answer this session: a resumed Mac session belongs to exactly one. */
const providerKey = (user: SessionUser, own?: Selection) => {
  const p = workshopAi(user, own).mac?.provider;
  return p ? `${p.scope ?? "workspace"}:${p.instance}:${p.model}` : "";
};

/** A Mac error's kind (a stop, a limit, gone…), wherever it was wrapped. */
const macErrorKind = (e: unknown): MacErrorKind | undefined =>
  e instanceof MacClaudeError ? e.kind : e instanceof AiProviderError && e.cause instanceof MacClaudeError ? e.cause.kind : undefined;
const sumUsage = (a: MacUsage | undefined, b: MacUsage): MacUsage => ({
  tokens: (a?.tokens ?? 0) + b.tokens,
  costUsd: (a?.costUsd ?? 0) + b.costUsd,
  cacheRead: (a?.cacheRead ?? 0) + (b.cacheRead ?? 0),
});
/** A Mac folder turn resumes its session only within this time (Claude's prompt cache is gone after it anyway). */
const RESUME_IDLE_MS = 24 * 3_600_000;
/**
 * A kept Claude session this big starts over: the next turn is a fresh one, rebuilt from the folder. Nothing is summarized: the author's words stay the author's.
 */
const RESUME_MAX_TOKENS = 100_000;

/** The Workshop runs on a provider on the Mac for this user (accounts), not the API key (guests, demo). */
const onMac = (user: SessionUser, own?: Selection) => !!workshopAi(user, own).only?.includes("mac");
/** The asker's Perplexity key (their own, or the server's for the platform admin), or "" */
const perplexityFor = (user: SessionUser) => keyFor(user, "PERPLEXITY_API_KEY").key;
const researchFor = (user: SessionUser) => !!perplexityFor(user) || onMac(user);
const RESEARCH_OFF = "Research needs an AI of your own (Settings → Your AI) or your Perplexity key in Settings → My API keys";
const researchLabel = (user: SessionUser) => (onMac(user) ? "Claude (Mac)" : "Perplexity");
const macLabel = (u?: MacUsage) => (u ? `Claude (Mac) · ${(u.tokens / 1000).toFixed(1)}k tokens · $${u.costUsd.toFixed(2)} API-equivalent` : "Claude (Mac)");

/**
 * Web research and the accuracy audit: an admin's go to Claude with web
 * search on the Mac while it is on (deep ones as background work), Perplexity
 * otherwise or when the Mac misses. The same answer either way.
 */
async function webResearch(
  user: SessionUser,
  system: string,
  prompt: string,
  opts: { depth: ResearchDepth; jsonSchema?: Record<string, unknown>; signal?: AbortSignal },
): Promise<ResearchAnswer & { usage?: MacUsage }> {
  if (opts.signal?.aborted) throw new Error("Stopped");
  if (onMac(user)) {
    try {
      let usage: MacUsage | undefined;
      const rules = MAC_RESEARCH[opts.depth] + (opts.jsonSchema ? "" : MAC_RESEARCH.sources);
      const text = await streamMacClaude(system + rules, prompt, opts.signal, () => {}, (u) => (usage = u), {
        provider: workshopAi(user).mac?.provider,
        web: true,
        background: opts.depth === "deep",
        label: opts.jsonSchema ? "Workshop accuracy check" : "Workshop research",
      });
      const { content, citations } = opts.jsonSchema ? { content: text, citations: [] } : splitSources(text);
      return { content, citations, searchResults: [], model: macLabel(usage), tokens: usage?.tokens ?? 0, usage };
    } catch (e) {
      // only when Claude never took the question (unclaimed, or its limit): a Claude that answered is not run again on Perplexity
      if (opts.signal?.aborted || !(e instanceof MacClaudeError && MAC_MISS.has(e.kind)) || !perplexityFor(user)) throw e;
      console.warn(`[workshop] Claude research failed, Perplexity instead: ${errorMessage(e)}`);
    }
  }
  const key = perplexityFor(user);
  if (!key) throw new Error(RESEARCH_OFF);
  return perplexityComplete(system, prompt, { key, depth: opts.depth, jsonSchema: opts.jsonSchema, signal: opts.signal });
}

/**
 * Content Workshop — research sessions on top of the Instagram Analyzer
 * library: pick sources, take notes, generate reels / carousels / ads for
 * a project with a storytelling framework, export markdown.
 *
 * $DATA_DIR/workshop/
 *   users/<username>.json         { seededAt }
 *   projects/<id>.json            Project
 *   frameworks/<id>.json          Framework
 *   sessions/<id>/meta.json       SessionMeta
 *   sessions/<id>/notes.md
 *   sessions/<id>/drafts/<id>.md  rendered draft (+ .json plan)
 */
export const workshopApp = new Hono<{ Variables: AuthVars }>();
// the restart pass runs before the first request, so no read ever has to tidy a stale state
workshopApp.use("*", async (_c, next) => {
  await reconcileRestart();
  await next();
});

const WS_ROOT = path.join(env.dataDir, "workshop");
const DIRS = {
  users: path.join(WS_ROOT, "users"),
  projects: path.join(WS_ROOT, "projects"),
  frameworks: path.join(WS_ROOT, "frameworks"),
  rules: path.join(WS_ROOT, "rules"),
  sessions: path.join(WS_ROOT, "sessions"),
  sources: path.join(WS_ROOT, "sources"),
};
for (const dir of Object.values(DIRS)) void mkdir(dir, { recursive: true }).catch(() => {});

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const canSee = (owner: string, user: SessionUser) => user.role === "admin" || owner === user.username;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

/** Every record in a flat <dir>/<id>.json store that the user may see, newest first. */
async function listRecords<T extends { owner: string; updatedAt: number }>(
  dir: string,
  user: SessionUser,
): Promise<T[]> {
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names) {
    const rec = await readJson<T>(path.join(dir, name));
    if (rec && canSee(rec.owner, user)) out.push(rec);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ---- projects ---- */

const projectPath = (id: string) => path.join(DIRS.projects, `${id}.json`);

async function readProject(id: string, user: SessionUser): Promise<Project | null> {
  if (!okId(id)) return null;
  const p = await readJson<Project>(projectPath(id));
  return p && canSee(p.owner, user) ? p : null;
}

/* ---- knowledge: the account's sources, every project reads them unless kept to one or switched off ---- */

const sourcePath = (id: string) => path.join(DIRS.sources, `${id}.json`);
const sourceTextPath = (id: string) => path.join(DIRS.sources, `${id}.txt`);
/** A scan's pages, waiting to be read (removed as they are). */
const sourcePagesDir = (id: string) => path.join(DIRS.sources, id);
const readSourceText = (id: string) => readFile(sourceTextPath(id), "utf-8").catch(() => "");
const lineCount = (text: string) => text.split("\n").length;

async function readSource(id: string, user: SessionUser): Promise<KnowledgeSource | null> {
  if (!okId(id)) return null;
  const s = await readJson<KnowledgeSource>(sourcePath(id));
  return s && s.owner === user.username ? s : null;
}

async function writeSource(s: KnowledgeSource, text?: string): Promise<void> {
  if (text !== undefined) {
    await mkdir(DIRS.sources, { recursive: true });
    await writeFile(sourceTextPath(s.id), text);
  }
  await writeJsonAtomic(sourcePath(s.id), s);
}

/** Every change to a source's record: read, change and write under the source's own lock, so a rename and a read's progress never overwrite each other. */
function patchSource(id: string, change: (s: KnowledgeSource) => KnowledgeSource, text?: string): Promise<KnowledgeSource | null> {
  return chained(`source:${id}`, async () => {
    const cur = await readJson<KnowledgeSource>(sourcePath(id));
    if (!cur) return null;
    const next = change(cur);
    await writeSource(next, text);
    return next;
  });
}
/** Sources being read in this process: a second read of one waits for the first. */
const inRead = new Set<string>();

/**
 * The account's sources, oldest first. A project's context files from before (Project.knowledge) move in once,
 * kept to that project, so another brand never reads them.
 */
async function listSources(user: SessionUser): Promise<KnowledgeSource[]> {
  for (const p of await ownedProjects(user.username)) {
    if (!p.knowledge?.length) continue;
    for (const k of p.knowledge) {
      if (!k.text.trim()) continue;
      const now = Date.now();
      const id = okId(k.id) ? k.id : randomUUID();
      if (await readJson(sourcePath(id))) continue; // moved already (a form open since then saved it back)
      await writeSource({ id, owner: user.username, name: k.name, projectId: p.id, chars: k.text.length, status: "new", createdAt: k.addedAt || now, updatedAt: now }, k.text);
    }
    await writeJsonAtomic(projectPath(p.id), { ...p, knowledge: [], updatedAt: Date.now() });
    console.log(`[workshop] ${user.username}: ${p.knowledge.length} context files of "${p.name}" moved into Knowledge`);
  }
  return (await listRecords<KnowledgeSource>(DIRS.sources, user))
    .filter((s) => s.owner === user.username)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** What a project's AI reads: the account's sources that are not another project's, minus the ones it switched off. */
async function knowledgeFor(user: SessionUser, project: Project): Promise<KnowledgeFile[]> {
  const mine = onFor((await listSources(user)).filter((s) => !s.projectId || s.projectId === project.id), project);
  return Promise.all(mine.map(async (s) => asKnowledge(s, await readSourceText(s.id))));
}

/** A project as the prompts read it: its knowledge filled in from the account's sources. */
async function projectForAi(id: string | undefined, user: SessionUser): Promise<Project | null> {
  const p = id ? await readProject(id, user) : null;
  return p && { ...p, knowledge: await knowledgeFor(user, p) };
}

/**
 * Read a source once and file it (kind, what it is, what it answers, its sections by line), in the background on the
 * account's provider. Edits the author made meanwhile are kept only where the read has nothing.
 */
async function fileSource(user: SessionUser, id: string): Promise<void> {
  if (inRead.has(id)) return;
  inRead.add(id);
  try {
    await fileSourceOnce(user, id);
  } finally {
    inRead.delete(id);
  }
}

async function fileSourceOnce(user: SessionUser, id: string): Promise<void> {
  const s = await readSource(id, user);
  if (!s) return;
  let text = await readSourceText(id);
  await patchSource(id, (cur) => ({ ...cur, status: "reading", startedAt: Date.now(), error: undefined }));
  let usage: MacUsage | undefined;
  try {
    const ai = route(user, "workshop", "Knowledge");
    // a scan: the user's AI writes out its pages first, a batch at a time, kept as it goes
    const pages = (await readdir(sourcePagesDir(id)).catch(() => [] as string[])).filter((n) => n.endsWith(".jpg")).sort();
    for (let i = 0; i < pages.length; i += OCR_BATCH) {
      const batch = pages.slice(i, i + OCR_BATCH);
      const files: Record<string, string> = {};
      for (const n of batch) files[`pages/${n}`] = `base64:${(await readFile(path.join(sourcePagesDir(id), n))).toString("base64")}`;
      const got = await completeWithFallback(OCR_SYSTEM, ocrPrompt(batch, i), undefined, (t) => t.trim(), {
        ...ai,
        mac: { ...ai.mac, label: "Knowledge", background: true, files },
        onUsage: (u) => (usage = sumUsage(usage, u)),
      });
      text += `${text ? "\n\n" : ""}${got}`;
      // progress only: a rename made meanwhile is kept, and a deleted source is not written back
      if (!(await patchSource(id, (cur) => ({ ...cur, chars: text.length, readCost: usage?.costUsd, startedAt: Date.now() }), text))) return;
      for (const n of batch) await rm(path.join(sourcePagesDir(id), n), { force: true });
    }
    if (pages.length) await rm(sourcePagesDir(id), { recursive: true, force: true });
    if (!text.trim()) throw new Error("No text came out of it");
    const lines = lineCount(text);
    // ponytail: the whole text goes to the Mac on each read; fine for one file at a time
    const filing = await completeWithFallback(READ_SYSTEM, readPrompt(s.name, lines), undefined, (t) => parseReading(t, lines), {
      ...ai,
      mac: { ...ai.mac, label: "Knowledge", background: true, files: { "source.txt": text } },
      onUsage: (u) => (usage = sumUsage(usage, u)),
    });
    // deleted while it was read: patchSource finds nothing and writes nothing
    await patchSource(id, (cur) => ({ ...cur, ...filing, status: "read", error: undefined, readAt: Date.now(), readCost: usage?.costUsd, updatedAt: Date.now() }));
  } catch (e) {
    await patchSource(id, (cur) => ({ ...cur, status: "failed", error: errorMessage(e).slice(0, 300), readCost: usage?.costUsd, updatedAt: Date.now() }));
    console.warn(`[workshop] reading "${s.name}" failed: ${errorMessage(e)}`);
  }
}

/* ---- frameworks ---- */

const frameworkPath = (id: string) => path.join(DIRS.frameworks, `${id}.json`);

/** Rows written before roles existed get the seed's role, or narrative. */
function withRole(f: Framework): Framework {
  if (f.role) return f;
  const seed = f.seedKey ? SEED_FRAMEWORKS.find((s) => s.seedKey === f.seedKey) : undefined;
  return { ...f, role: seed?.role ?? "narrative", pairsWith: f.pairsWith ?? seed?.pairsWith };
}

async function readFramework(id: string, user: SessionUser): Promise<Framework | null> {
  if (!okId(id)) return null;
  const f = await readJson<Framework>(frameworkPath(id));
  return f && canSee(f.owner, user) ? withRole(f) : null;
}

/** The seeded frameworks this user still has. */
async function ownedSeeded(username: string): Promise<Framework[]> {
  let names: string[] = [];
  try {
    names = (await readdir(DIRS.frameworks)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Framework[] = [];
  for (const name of names) {
    const fw = await readJson<Framework>(path.join(DIRS.frameworks, name));
    if (fw?.owner === username && fw.seedKey) out.push(fw);
  }
  return out;
}

/** Withdrawn seeds leave the library unless the user edited them. */
async function retireSeeds(username: string): Promise<void> {
  for (const fw of await ownedSeeded(username)) {
    if (fw.seedKey && RETIRED_SEED_KEYS.includes(fw.seedKey) && fw.updatedAt === fw.createdAt) {
      await rm(frameworkPath(fw.id), { force: true });
    }
  }
}

/**
 * Starter frameworks land once per key per user: new seeds reach existing
 * users, and a deleted seed never comes back because its key stays listed.
 */
async function ensureSeeds(username: string): Promise<void> {
  const seen = (await readUserMarker(username)) ?? {};
  let seeded = seen.seeded ?? [];
  if (seen.seededAt && !seen.seeded) {
    seeded = [...new Set([...ORIGINAL_SEED_KEYS, ...(await ownedSeeded(username)).map((f) => f.seedKey!)])];
  }
  if (seeded.some((k) => RETIRED_SEED_KEYS.includes(k))) await retireSeeds(username);
  const owned = await ownedSeeded(username);
  const extras = extraFrameworkCopyIds(owned);
  for (const id of extras) await rm(frameworkPath(id), { force: true });
  const have = new Set([...seeded, ...owned.filter((f) => f.seedKey && !extras.includes(f.id)).map((f) => f.seedKey!)]);
  const toAdd = missingSeeds(have);
  if (!toAdd.length && !extras.length && seen.seeded) return;
  const now = Date.now();
  for (const [i, seed] of toAdd.entries()) {
    const fw: Framework = { id: randomUUID(), owner: username, ...seed, createdAt: now - i, updatedAt: now - i };
    await writeJsonAtomic(frameworkPath(fw.id), fw);
  }
  await writeUserMarker(username, {
    ...seen,
    seededAt: seen.seededAt ?? now,
    seeded: [...have, ...toAdd.map((s) => s.seedKey)],
  });
}

/* ---- rules ---- */

const rulePath = (id: string) => path.join(DIRS.rules, `${id}.json`);

async function readRule(id: string, user: SessionUser): Promise<Rule | null> {
  if (!okId(id)) return null;
  const r = await readJson<Rule>(rulePath(id));
  return r && canSee(r.owner, user) ? r : null;
}

async function ownedRules(username: string): Promise<Rule[]> {
  let names: string[] = [];
  try {
    names = (await readdir(DIRS.rules)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Rule[] = [];
  for (const name of names) {
    const rule = await readJson<Rule>(path.join(DIRS.rules, name));
    if (rule?.owner === username) out.push(rule);
  }
  return out;
}

/**
 * Starter rules land once per key per user. Later visits rewrite untouched
 * copies, drop merged keys, and skip any key the user already had (deleted
 * ones stay listed so they never come back).
 */
async function ensureRuleSeeds(username: string): Promise<void> {
  const marker = path.join(DIRS.users, `${username}.rules.json`);
  const seen = await readJson<{ seeded?: string[] }>(marker);
  const seeded = seen?.seeded ?? [];
  const owned = await ownedRules(username);
  const plan = planRuleSeedSync(owned, seeded);
  if (!plan.toAdd.length && !plan.retireIds.length && !plan.refresh.length && !plan.adopt.length && seen) return;
  const byId = new Map(owned.map((r) => [r.id, r]));
  for (const id of plan.retireIds) await rm(rulePath(id), { force: true });
  for (const item of plan.refresh) {
    const rule = byId.get(item.id);
    if (rule) await writeJsonAtomic(rulePath(rule.id), { ...rule, name: item.name, text: item.text, createdAt: item.createdAt, updatedAt: item.updatedAt });
  }
  for (const item of plan.adopt) {
    const rule = byId.get(item.id);
    if (rule) {
      await writeJsonAtomic(rulePath(rule.id), {
        ...rule,
        seedKey: item.seedKey,
        name: item.name,
        ...(item.text !== undefined ? { text: item.text } : {}),
        ...(item.createdAt !== undefined ? { createdAt: item.createdAt, updatedAt: item.updatedAt } : {}),
      });
    }
  }
  for (const seed of plan.toAdd) {
    const at = ruleSeedAt(seed.seedKey);
    const rule: Rule = { id: randomUUID(), owner: username, ...seed, on: true, createdAt: at, updatedAt: at };
    await writeJsonAtomic(rulePath(rule.id), rule);
  }
  await writeJsonAtomic(marker, {
    seeded: [...new Set([...seeded, ...plan.adopt.map((a) => a.seedKey), ...plan.toAdd.map((s) => s.seedKey)])],
  });
}

/** The rules a draft runs under: the ids it asked for, else every rule that is on. */
async function rulesFor(user: SessionUser, ruleIds: string[] | undefined, project?: Project | null): Promise<Rule[]> {
  await ensureRuleSeeds(user.username); // retired starters leave before a turn reads them
  const all = (await listRecords<Rule>(DIRS.rules, user)).filter((r) => r.owner === user.username).sort((a, b) => a.createdAt - b.createdAt);
  if (ruleIds) return all.filter((r) => ruleIds.includes(r.id));
  return onFor(all, project).filter((r) => r.on);
}

/* ---- sessions ---- */

const sessionDir = (id: string) => path.join(DIRS.sessions, id);
const sessionMetaPath = (id: string) => path.join(sessionDir(id), "meta.json");
const notesPath = (id: string) => path.join(sessionDir(id), "notes.md");
const draftMdPath = (id: string, draftId: string) => path.join(sessionDir(id), "drafts", `${draftId}.md`);
const draftJsonPath = (id: string, draftId: string) => path.join(sessionDir(id), "drafts", `${draftId}.json`);

/** Drafts whose generation is running in this process. */
const generating = new Set<string>();
const chains = new Map<string, Promise<unknown>>();

/** Serialize read-modify-write per session so notes, sources and drafts never clobber each other. */
function chained<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    id,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

const RESTART_MSG = "Interrupted by a server restart — regenerate.";

async function readSession(id: string): Promise<SessionMeta | null> {
  if (!okId(id)) return null;
  return readJson<SessionMeta>(sessionMetaPath(id));
}

/**
 * What a restart ended: a draft still generating, a reply still thinking, a source still being read. Nothing runs
 * across a restart, so each is marked failed once, before the first request (the workshop middleware awaits it).
 */
let restarted: Promise<void> | undefined;
function reconcileRestart(): Promise<void> {
  return (restarted ??= (async () => {
    for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
      if (!okId(id)) continue;
      await chained(id, async () => {
        const meta = await readJson<SessionMeta>(sessionMetaPath(id));
        if (meta?.drafts.some((d) => d.status === "generating")) {
          for (const d of meta.drafts) {
            if (d.status !== "generating") continue;
            d.status = "error";
            d.error = RESTART_MSG;
          }
          await writeJsonAtomic(sessionMetaPath(id), meta);
        }
        const chat = await readJson<Chat>(chatPath(id));
        if (chat?.messages.some((m) => m.status === "thinking")) {
          for (const m of chat.messages) {
            if (m.status !== "thinking") continue;
            m.status = "error";
            m.error = TURN_RESTART_MSG;
          }
          await writeJsonAtomic(chatPath(id), chat);
        }
      });
    }
    for (const f of await readdir(DIRS.sources).catch(() => [] as string[])) {
      const id = f.endsWith(".json") ? f.slice(0, -".json".length) : "";
      if (!okId(id)) continue;
      const s = await readJson<KnowledgeSource>(sourcePath(id));
      if (s?.status === "reading") await patchSource(id, (cur) => ({ ...cur, status: "failed", error: "The read never finished" }));
    }
  })().catch((e) => console.error("[workshop] restart pass", errorMessage(e))));
}

async function ownedSession(id: string, user: SessionUser): Promise<SessionMeta | null> {
  const meta = await readSession(id);
  return meta && canSee(meta.owner, user) ? meta : null;
}

/**
 * `touch: false` keeps `updatedAt`, which orders the list and the sidebar: only work on the session moves it up, never
 * opening it, its search box, a status, a pin or a rename.
 */
async function updateSession(
  id: string,
  fn: (meta: SessionMeta) => void | Promise<void>,
  { touch = true }: { touch?: boolean } = {},
): Promise<SessionMeta | null> {
  return chained(id, async () => {
    const meta = await readSession(id);
    if (!meta) return null;
    const from = meta.status ?? "draft";
    await fn(meta);
    if (touch) meta.updatedAt = Date.now();
    await writeJsonAtomic(sessionMetaPath(id), meta);
    // events fire after the write; only a real change of status emits, so a publish is announced once
    const to = meta.status ?? "draft";
    if (to !== from) {
      emitEvent("session.status", { id, owner: meta.owner, from, to });
      if (to === "published") emitEvent("session.published", { id, owner: meta.owner, from });
    }
    return meta;
  });
}

async function readNotes(id: string): Promise<string> {
  try {
    return await readFile(notesPath(id), "utf-8");
  } catch {
    return "";
  }
}

async function writeNotes(id: string, text: string): Promise<void> {
  await mkdir(sessionDir(id), { recursive: true });
  const tmp = `${notesPath(id)}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, notesPath(id));
}

async function readDraftMarkdown(id: string, draftId: string): Promise<string | null> {
  try {
    return await readFile(draftMdPath(id, draftId), "utf-8");
  } catch {
    return null;
  }
}

/* ---- documents + chat (co-writing) ---- */

const docsDir = (id: string) => path.join(sessionDir(id), "docs");
const docPath = (id: string, docId: string) => path.join(docsDir(id), `${docId}.json`);
const trashPath = (id: string, docId: string) => `${docPath(id, docId)}.deleted`;
const chatPath = (id: string) => path.join(sessionDir(id), "chat.json");
/** Big pastes the author attached to messages, one file each, kept whole. */
const pastedPath = (id: string, pid: string) => path.join(sessionDir(id), "pasted", `${pid}.md`);
/** Pictures sent with messages, one file each, in sessions/<id>/images/. */
const IMAGE_EXT: Record<ImageRef["type"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const imagePath = (id: string, im: Pick<ImageRef, "id" | "type">) => path.join(sessionDir(id), "images", `${im.id}.${IMAGE_EXT[im.type]}`);
/** Files sent with messages (PDFs), one file each, in sessions/<id>/files/. */
const filePath = (id: string, f: Pick<FileRef, "id" | "type">) => path.join(sessionDir(id), "files", `${f.id}.${ATTACH_EXT[f.type]}`);

/** A picture a piece holds (the editor's Add picture): stored in the session's images/ like a chat picture; found by id and whichever type it is. */
async function pieceImage(sessionId: string, iid: string): Promise<ImageRef | null> {
  if (!okId(iid)) return null;
  for (const type of PICTURE_TYPES) {
    const ref: ImageRef = { id: iid, name: "", type };
    if (await stat(imagePath(sessionId, ref)).then(() => true, () => false)) return ref;
  }
  return null;
}

/** The stored type of every picture a piece's text uses (a gone picture is left out). */
async function pieceTypes(sessionId: string, docs: Document[]): Promise<Map<string, ImageRef["type"]>> {
  const types = new Map<string, ImageRef["type"]>();
  for (const id of docs.flatMap((d) => [...(d.hooks ?? []), ...d.blocks, ...(d.caption ? [d.caption] : []), ...(d.pinned ? [d.pinned] : [])]).flatMap((b) => pictureIds(b.text))) {
    if (types.has(id)) continue;
    const ref = await pieceImage(sessionId, id);
    if (ref) types.set(id, ref.type);
  }
  return types;
}

/**
 * The current session's piece pictures as files the AI can Read (pieces/<doc>/<n>.<ext>, "base64:" bytes), listed in
 * pieces/INDEX.md next to the address the text uses. The text keeps the address, so a piece the AI rewrites keeps its
 * pictures working.
 */
async function piecePictures(sessionId: string, docs: Document[], files: Folder): Promise<Document[]> {
  const index: string[] = [];
  for (const d of docs) {
    const texts = [...(d.hooks ?? []), ...d.blocks].map((b) => b.text);
    const seen = new Set<string>();
    const dir = `pieces/${slug(d.title, 30)}-${d.id.slice(0, 6)}`;
    for (const t of texts) {
      for (const m of t.matchAll(PICTURE_TOKEN)) {
        const [token, alt, id] = m as unknown as [string, string, string];
        if (seen.has(id)) continue;
        seen.add(id);
        const ref = await pieceImage(sessionId, id);
        const bytes = ref ? await readFile(imagePath(sessionId, ref)).catch(() => null) : null;
        if (!ref || !bytes) continue;
        const file = `${dir}/${seen.size}.${PICTURE_EXT[ref.type]}`;
        files[file] = `base64:${bytes.toString("base64")}`;
        index.push(`- ${token} (${alt || "picture"}) → ${file}`);
      }
    }
  }
  if (index.length) files["pieces/INDEX.md"] = `# Pictures in this session's pieces\n\nEach picture as written in the piece, and the file that holds it.\n\n${index.join("\n")}\n`;
  return docs;
}
async function readPasted(sessionId: string, refs: PastedRef[] | undefined): Promise<Array<PastedRef & { text: string }>> {
  const out: Array<PastedRef & { text: string }> = [];
  for (const r of refs ?? []) {
    const text = okId(r.id) ? await readFile(pastedPath(sessionId, r.id), "utf-8").catch(() => "") : "";
    if (text) out.push({ ...r, text });
  }
  return out;
}
/** Assistant messages whose turn is running in this process. */
const chatting = new Set<string>();
/** The one test for "a reply is running": the chat says thinking and this process is still writing it. */
const turnRunning = (m: ChatMessage) => m.status === "thinking" && chatting.has(m.id);
/** Each running reply's stop: aborting it ends that turn as "Stopped", and nothing is re-run on the API key. */
const stops = new Map<string, AbortController>();
/** The signal a running reply's Stop aborts; released where the reply ends (stops.delete). */
function stopSignal(messageId: string): AbortSignal {
  const stop = new AbortController();
  stops.set(messageId, stop);
  return stop.signal;
}
const TURN_RESTART_MSG = "Interrupted by a server restart — send it again.";

/** What the browser sees: versions without their block payloads. Notes has none. */
/** An AI on an access key (no cookie): what it writes is the AI's text, never the author's words or the author's rewrites (editor.ts does the same). */
const fromAiKey = (c: { req: { header: (name: string) => string | undefined } }) => !!c.req.header("authorization") && !c.req.header("cookie");

function publicDoc(doc: Document) {
  if (doc.kind === "notes") return { ...doc, versions: [], headVersion: undefined };
  return { ...doc, versions: doc.versions.map(({ id, at, label, kept }) => ({ id, at, label, ...(kept ? { kept: true as const } : {}) })) };
}

type Fields = Pick<Document, "blocks" | "hooks" | "caption" | "pinned">;
/** Every text a turn can change, by the id a turn names it with: blocks, hook variations, the post description and the pinned comment. */
function fieldsOf(d: Fields): Array<{ id: string; text: string }> {
  return [...(d.hooks ?? []), ...d.blocks, ...(d.caption ? [{ id: "caption", text: d.caption.text }] : []), ...(d.pinned ? [{ id: "pinned", text: d.pinned.text }] : [])];
}

/** "Slide 2" for a block, so a refused fix can name its slide. */
const slideOf = (doc: Pick<Document, "blocks">, blockId: string) => `Slide ${doc.blocks.findIndex((b) => b.id === blockId) + 1}`;
const lockedNote = (slides: string[]) => `${slides.join(" and ")} ${slides.length === 1 ? "is" : "are"} locked, so ${slides.length === 1 ? "its fix was" : "their fixes were"} not applied.`;

async function listDocs(sessionId: string): Promise<Document[]> {
  let names: string[] = [];
  try {
    names = (await readdir(docsDir(sessionId))).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Document[] = [];
  for (const name of names) {
    const d = await readJson<Document>(path.join(docsDir(sessionId), name));
    if (d) out.push(d);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

async function readDoc(sessionId: string, docId: string): Promise<Document | null> {
  if (!okId(docId)) return null;
  return readJson<Document>(docPath(sessionId, docId));
}

async function writeDoc(doc: Document): Promise<void> {
  await writeJsonAtomic(docPath(doc.sessionId, doc.id), doc);
}

async function updateDoc(
  sessionId: string,
  docId: string,
  fn: (doc: Document) => void | Promise<void>,
): Promise<Document | null> {
  return chained(sessionId, async () => {
    const doc = await readDoc(sessionId, docId);
    if (!doc) return null;
    await fn(doc);
    doc.updatedAt = Date.now();
    await writeDoc(doc);
    return doc;
  });
}

/**
 * First open of a session in the co-writing layout: notes.md becomes the
 * Notes document, finished drafts become documents, and an empty working
 * document exists so the chat has somewhere to write.
 */
async function ensureDocuments(meta: SessionMeta): Promise<Document[]> {
  return chained(meta.id, async () => {
    let docs = await listDocs(meta.id);
    if (docs.some((d) => d.kind === "notes")) return withWorkingDoc(meta, docs);
    const now = Date.now();
    const notes = newDocument(randomUUID(), meta.id, "notes", "Notes", { text: await readNotes(meta.id), author: "user", now });
    await writeDoc(notes);
    const created: Document[] = [notes];
    let i = 1;
    for (const draft of [...meta.drafts].reverse()) {
      if (draft.status !== "ready") continue;
      const md = await readDraftMarkdown(meta.id, draft.id);
      if (!md) continue;
      const doc = newDocument(randomUUID(), meta.id, draft.kind, draft.title || draft.kind, {
        text: md,
        author: "ai",
        frameworkIds: draft.frameworkIds ?? [],
        ruleIds: draft.ruleIds,
        now: now + i++,
      });
      snapshot(doc, "generated draft", now + i);
      await writeDoc(doc);
      created.push(doc);
    }
    // pieces made before the session was first opened (an AI on the Full key) stay listed
    docs = [...docs, ...created].sort((a, b) => a.createdAt - b.createdAt);
    return withWorkingDoc(meta, docs);
  });
}

/** The answers to "What will you make?" that are also a Workshop piece. */
type PieceKind = Exclude<DocKind, "notes" | "free">;
const PIECE_KINDS = new Set<string>(["reel", "carousel", "ad", "youtube", "newsletter", "thread", "article"] satisfies PieceKind[]);

/** A session always has a document to write in besides Notes: the first kind its owner makes (setup's "What will you make?"), else a reel; the kind is switched in the editor. */
async function withWorkingDoc(meta: SessionMeta, docs: Document[]): Promise<Document[]> {
  if (docs.some((d) => d.kind !== "notes")) return docs;
  const kind = readWorkPrefs(meta.owner).makes.find((m): m is PieceKind => PIECE_KINDS.has(m)) ?? "reel";
  const doc = newDocument(randomUUID(), meta.id, kind, KIND_TITLE[kind]);
  await writeDoc(doc);
  return [...docs, doc];
}

/** Remember which parts of which sources were pulled, per post, newest pull first when read back. */
function mergeLoaded(current: LoadedSource[], add: Array<{ postId: string; parts: SourcePart[] }>, now = Date.now()): LoadedSource[] {
  const byId = new Map(current.map((l) => [l.postId, { ...l, parts: [...l.parts] }]));
  for (const a of add) {
    const cur = byId.get(a.postId) ?? { postId: a.postId, parts: [], at: now };
    for (const part of a.parts) if (!cur.parts.includes(part)) cur.parts.push(part);
    cur.at = now;
    byId.set(a.postId, cur);
  }
  return [...byId.values()];
}

async function readChat(sessionId: string): Promise<Chat> {
  return (await readJson<Chat>(chatPath(sessionId))) ?? { messages: [] };
}

async function updateChat(sessionId: string, fn: (chat: Chat) => void): Promise<Chat> {
  return chained(sessionId, async () => {
    const chat = (await readJson<Chat>(chatPath(sessionId))) ?? { messages: [] };
    fn(chat);
    if (chat.messages.length > 200) chat.messages.splice(0, chat.messages.length - 200);
    await writeJsonAtomic(chatPath(sessionId), chat);
    return chat;
  });
}

async function patchMessage(sessionId: string, messageId: string, patch: Partial<ChatMessage>): Promise<void> {
  await updateChat(sessionId, (chat) => {
    chat.messages = chat.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  });
}

/**
 * Puts a turn on the chat in one write: the author's ask and the reply it starts, and the failed pair a retry
 * replaces. False (nothing written) while a reply is still thinking; the check is inside the same write, so two
 * requests cannot both start a turn on one session.
 */
async function startTurn(sessionId: string, pair: ChatMessage[], retryOf: string[] = []): Promise<boolean> {
  let started = false;
  await updateChat(sessionId, (chat) => {
    if (chat.messages.some((m) => m.status === "thinking")) return;
    started = true;
    if (retryOf.length) chat.messages = chat.messages.filter((m) => !retryOf.includes(m.id));
    chat.messages.push(...pair);
    for (const m of pair) if (m.role === "assistant") chatting.add(m.id);
  });
  return started;
}

/**
 * A session nobody named gets a name once the AI has written into it: the author's other sessions' names go along as examples; the reply is the
 * name. A name the author typed is never replaced.
 */
const UNTITLED = /^(untitled( session)?)?$/i;
async function nameSession(sessionId: string, user: SessionUser, docId: string, force = false): Promise<string | null> {
  const meta = await readSession(sessionId);
  if (!meta || (!force && !UNTITLED.test(meta.title.trim()))) return null;
  const doc = await readDoc(sessionId, docId);
  const text = (doc?.blocks ?? []).map((b) => b.text).join("\n\n").trim();
  // force (the menu's Regenerate title) names from whatever is written; the automatic one waits for 12 words
  if (force ? !text : text.split(/\s+/).length < 12) return null;
  const names: string[] = [];
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const m = id === sessionId ? null : await readSession(id);
    if (m?.owner === user.username && !UNTITLED.test(m.title.trim())) names.push(m.title.trim());
  }
  const name = await completeWithFallback(
    "Name this writing session. Reply with the name only.",
    `${names.length ? `The author's other sessions are named:\n${names.slice(0, 15).map((n) => `- ${n}`).join("\n")}\n\n` : ""}The piece:\n${text.slice(0, 2000)}`,
    undefined,
    (t) => {
      const line = t.trim().split("\n")[0]!.replace(/^["'“”*`\s-]+|["'“”*`\s.]+$/g, "").slice(0, 60);
      if (!line) throw new Error("no name");
      return line;
    },
    route(user, "workshop", "Session title"),
  );
  await updateSession(sessionId, (m) => {
    if (force || UNTITLED.test(m.title.trim())) m.title = name;
  });
  return name;
}

/** One chat turn: pack what the author sees, ask, apply the operations, report. Never awaited by a request. */
/** Progress writes while a turn streams: at most one every 400 ms, always in order, the last one flushed. */
function progressWriter(sessionId: string, messageId: string) {
  let pending: Partial<ChatMessage> | null = null;
  let last = 0;
  let chain: Promise<void> = Promise.resolve();
  return (patch: Partial<ChatMessage>, force = false): Promise<void> => {
    pending = { ...(pending ?? {}), ...patch };
    const now = Date.now();
    if (!force && now - last < 400) return chain;
    last = now;
    const p = pending;
    pending = null;
    chain = chain.then(() => patchMessage(sessionId, messageId, p)).catch(() => {});
    return chain;
  };
}

/**
 * Everything the Workshop's Claude on the Mac can read for a turn: every post on the author's account with its
 * numbers, this session's sources in full, the context files, every one of
 * the author's Workshop sessions (pieces, the author's edits, the whole conversation) and the
 * whole Analyzer library. Nothing is cut to a budget; the model looks up
 * what it needs.
 */
async function turnFolder(
  session: SessionMeta,
  user: SessionUser,
  project: Project | null,
  sources: Array<{ id: string; handle: string }>,
  own: Awaited<ReturnType<typeof ownPostsForWorkshop>>,
): Promise<Folder> {
  const files: Folder = {};
  const account = await ownAccountContextFor(user, projectAccount(project));
  if (own) Object.assign(files, ownPostFiles(own.handle, own.posts, account ?? {}));
  if (account) files["account.md"] = `${renderAccountContext(account)}\n`;
  const packs = (await packPostsForUser(sources.map((e) => e.id), user, { perPost: 1e8, total: 1e9 })).packs;
  sources.forEach((e, i) => {
    const pack = packs.find((x) => x.id === e.id);
    if (pack) files[sourceFile(`S${i + 1}`, e.handle)] = outsideWords(pack.markdown);
  });
  // ponytail: every source's whole text rides along each turn; send hashes the Mac caches once books add up
  for (const k of project?.knowledge ?? []) if (k.text.trim()) files[knowledgePath(k.name)] = k.text;
  const knowledge = knowledgeIndex(project?.knowledge ?? []);
  if (knowledge) files["context/INDEX.md"] = knowledge;
  Object.assign(files, channelFiles(user.username, project?.id));
  const projectName = new Map<string, string>();
  const sessions: Array<{ meta: SessionMeta; chat: Chat | null; docs: Document[] }> = [];
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const meta = await readSession(id);
    // this project's sessions only: another brand's pieces and chats stay out
    if (!meta || meta.owner !== user.username || !inProject(meta, session.projectId)) continue;
    if (meta.projectId && !projectName.has(meta.projectId)) projectName.set(meta.projectId, (await readProject(meta.projectId, user))?.name ?? "");
    const chat = await readJson<Chat>(chatPath(id));
    for (const p of await readPasted(id, (chat?.messages ?? []).flatMap((m) => m.pasted ?? []))) files[pastedFile(meta, p)] = pastedWords(p.text);
    sessions.push({ meta, chat, docs: await listDocs(id) });
  }
  for (const { meta, chat, docs } of sessions) {
    // the session being edited gets its pictures as files; the others keep the text only (their pictures would weigh the folder down)
    const shown = meta.id === session.id ? await piecePictures(meta.id, docs, files) : docs;
    files[sessionFile(meta)] = sessionText(meta, meta.projectId ? projectName.get(meta.projectId) : undefined, shown, chat?.messages ?? [], meta.id === session.id);
  }
  const index = sessionsIndex(sessions.map((x) => x.meta), own?.posts ?? []);
  if (index) files["sessions/INDEX.md"] = index;
  Object.assign(files, libraryFiles(await libraryForWorkshop(user, session.projectId)));
  await ensureSeeds(user.username);
  Object.assign(files, frameworkFiles(onFor((await listRecords<Framework>(DIRS.frameworks, user)).filter((f) => f.owner === user.username), project).map(withRole)));
  const log = await readEditLog(session.owner);
  if (log.length) files["my-edits/INDEX.md"] = editsFile(log);
  return files;
}

/** The Mac's Claude session to resume this turn, if it still holds the reply before this message and nothing it was given is gone. */
function resumableClaude(session: SessionMeta, before: string | undefined, sourceIds: string[], context: string, provider: string): ClaudeSession | undefined {
  const cs = session.claudeSession;
  if (!cs || !before || cs.after !== before || Date.now() - cs.at > RESUME_IDLE_MS) return undefined;
  if (cs.provider !== provider) return undefined; // another AI was picked: it starts fresh and reads the chat as history
  if (cs.context !== context || cs.sources.some((id) => !sourceIds.includes(id))) return undefined; // a source or the project changed: start over
  if ((cs.tokens ?? 0) > RESUME_MAX_TOKENS) return undefined; // grown too long: start over from the folder
  return cs;
}
/** The Instagram account a project's work reads: its linked one; a project with none reads none (never another brand's "my account"); no project = "my account". */
const projectAccount = (project: Project | null | undefined): string | null | undefined => (project ? (project.accountId ?? null) : undefined);
const contextKey = (project: Project | null, frameworks: Framework[]) => createHash("sha1").update(JSON.stringify([project, frameworks])).digest("hex");

async function runTurn(session: SessionMeta, user: SessionUser, ask: ChatMessage, assistantId: string): Promise<void> {
  const progress = progressWriter(session.id, assistantId);
  const signal = stopSignal(assistantId);
  let outcome = "Reply ready";
  // Edits applied while the answer streams; undone if the provider fails or the turn does.
  let versionBefore: string | undefined;
  let applied = 0;
  let blockIds: string[] = [];
  /** A Mac folder call was started: a stop or failure after it clears the Mac's Claude session. */
  let macStarted = false;
  // what the turn has used so far, kept even when it is stopped or fails (the message shows it)
  let usage: ChatMessage["usage"];
  /** how big the Mac's Claude session is after its last answer */
  let sessionTokens: number | undefined;
  const addUsage = (u?: MacUsage) => {
    if (u) usage = sumUsage(usage, u);
    if (u?.context) sessionTokens = u.context;
  };
  /** Locked slides the turn tried to change: refused, and said so. */
  const refused = new Set<string>();
  const undoPartial = async () => {
    if (!applied || !versionBefore) return;
    const before = versionBefore;
    await updateDoc(session.id, ask.docId, (d) => {
      revert(d, before);
    }).catch(() => {});
    applied = 0;
    blockIds = [];
  };
  try {
    const read = await readDoc(session.id, ask.docId);
    if (!read) throw new Error("That document is gone");
    // a turn for one Finals version: the writer reads and writes that version's post description as the piece's
    const doc = ask.captionFor ? withVersionCaption(read, ask.captionFor) : read;
    await progress({ stage: "packing" }, true);
    const [project, ...frameworkHits] = await Promise.all([
      projectForAi(session.projectId, user),
      ...doc.frameworkIds.map((id) => readFramework(id, user)),
    ]);
    const frameworks = frameworkHits.filter((f): f is Framework => !!f);
    const rules = await rulesFor(user, doc.ruleIds, project);
    const noteFor = new Map(session.sources.map((s) => [s.postId, s.note]));
    const chat = await readChat(session.id);
    const history = chat.messages.filter((m) => m.id !== ask.id && m.id !== assistantId && m.status !== "error" && m.status !== "thinking" && m.docId === ask.docId);
    const ids = session.sources.map((s) => s.postId);
    let index = await sourceIndexForUser(ids, user);
    const refOf = new Map(index.map((e, i) => [e.id, `S${i + 1}`]));
    const idOf = new Map(index.map((e, i) => [`S${i + 1}`, e.id]));

    // What the model has in front of it: slide text of every source, plus whatever was pulled before.
    let loaded: LoadedSource[] = (await readSession(session.id))?.loaded ?? session.loaded ?? [];
    const fetched: NonNullable<ChatMessage["fetched"]> = [];
    // Every step the turn takes stays on the message with its own time.
    const steps: TurnStep[] = [];
    const step = (label: string) => {
      const now = Date.now();
      const last = steps[steps.length - 1];
      if (last && !last.end) last.end = now;
      steps.push({ label, at: now });
      void progress({ steps: steps.map((x) => ({ ...x })) }, true);
    };
    const pull = async (adds: Array<{ postId: string; parts: SourcePart[] }>) => {
      const fresh = adds.filter((a) => a.parts.some((p) => !loaded.find((l) => l.postId === a.postId)?.parts.includes(p)));
      if (!fresh.length) return false;
      loaded = mergeLoaded(loaded, fresh);
      const snapshotLoaded = loaded;
      await updateSession(session.id, (m) => {
        m.loaded = snapshotLoaded;
      });
      for (const a of fresh) {
        const e = index.find((x) => x.id === a.postId);
        if (e) fetched.push({ handle: e.handle, parts: a.parts });
      }
      const named = fresh.map((a) => index.find((x) => x.id === a.postId)?.handle).filter(Boolean);
      step(`Pulled from the sources: ${[...new Set(named)].map((h) => `@${h}`).join(", ")} (${[...new Set(fresh.flatMap((a) => a.parts))].join(", ")})`);
      return true;
    };
    // A transcript the AI needs but nobody made yet: make it now, then the pull has words in it.
    const transcribeMissing = async (postIds: string[]) => {
      const missing = [...new Set(postIds)].filter((id) => !index.find((e) => e.id === id)?.has.transcript);
      if (!missing.length) return;
      await progress({ stage: "packing" }, true);
      await transcribeForUser(missing, user);
      index = await sourceIndexForUser(ids, user);
    };
    // Sources the author tagged for this message come in whole: transcript and caption.
    const tagged = [...new Set((ask.context ?? []).filter((s) => s.field === "source" && ids.includes(s.postId)).map((s) => s.postId))];
    if (tagged.length) {
      await transcribeMissing(tagged);
      await pull(tagged.map((postId) => ({ postId, parts: ["transcript", "caption"] as SourcePart[] })));
    }
    // Asked about the audience (or comments switched on): the comments come in without a round trip.
    if (!askedOnlyForCaption(ask.text) && (ask.comments === true || wantsComments(ask.text))) {
      await pull(ids.map((postId) => ({ postId, parts: ["comments"] as SourcePart[] })));
    }

    let research: ResearchNote | undefined;
    // Deep research switched on for this message: it runs first, the answer builds on it.
    if (ask.deep && researchFor(user)) {
      step(`Deep research on the web: "${ask.text.slice(0, 160)}"`);
      await progress({ stage: "researching", provider: researchLabel(user), research: { question: ask.text, depth: "deep", status: "running" } }, true);
      const q = `${ask.text}\n\nContext: the piece is "${doc.title}" (${doc.kind})${doc.blocks[0] ? `, opening: ${doc.blocks[0].text.slice(0, 200)}` : ""}.`;
      try {
        const a = await webResearch(user, RESEARCH_QUESTION_SYSTEM, q, { depth: "deep", signal });
        addUsage(a.usage);
        research = { question: ask.text, depth: "deep", status: "done", answer: a.content.slice(0, 8000), citations: a.citations.slice(0, 20), model: a.model };
      } catch (e) {
        if (signal.aborted) throw e;
        research = { question: ask.text, depth: "deep", status: "done", answer: `Research failed: ${errorMessage(e)}`, citations: [] };
      }
    }

    const knowledge = project?.knowledge ?? [];
    let loadedKnowledge: KnowledgeFile[] = [];
    // An approved web search: on the Mac the turn
    // gets the web tools for it below; elsewhere it runs first and the answer builds on its findings.
    const approvedWeb = ask.web?.trim() || "";
    let loadedAccount: AccountContext | null = null;
    const captionOnly = askedOnlyForCaption(ask.text);
    const account = await ownAccountContextFor(user, projectAccount(project), { cadence: false });
    const askPasted = await readPasted(session.id, ask.pasted);
    const askImages: Array<ImageRef & { data: string }> = [];
    for (const im of ask.images ?? []) {
      const data = await readFile(imagePath(session.id, im)).catch(() => null);
      if (data) askImages.push({ ...im, data: data.toString("base64") });
    }
    // Media Library clips: read now, as the author; each thumbnail goes with the pictures, the words into the prompt
    const askLibrary: Array<{ title: string; description?: { text: string; source: "user" | "ai" }; transcript?: string }> = [];
    for (const ref of ask.library ?? []) {
      if (ref.kind === "external") {
        // a source's clip: its title only until the source serves its description and thumbnail (external refs have no file here)
        const kept = await externalLibraryRef(user.username, { refId: ref.refId });
        if (kept) askLibrary.push({ title: kept.title });
        continue;
      }
      const clip = await clipContext(user.username, ref);
      if (!clip) continue;
      const { thumb, ...words } = clip;
      askLibrary.push(words);
      if (thumb) askImages.push({ id: ref.versionId, name: `${clip.title} (library thumbnail)`, type: "image/jpeg", data: thumb });
    }
    // PDFs are read by the Mac only (its folder, or the files it reads without one); the API-key path has no way to read them
    const macReads = onMac(user, session.ai);
    const askFiles: Array<FileRef & { data: string }> = [];
    const unreadFiles: FileRef[] = [];
    for (const f of ask.files ?? []) {
      const data = macReads ? await readFile(filePath(session.id, f)).catch(() => null) : null;
      if (data) askFiles.push({ ...f, data: data.toString("base64") });
      else unreadFiles.push(f);
    }
    const attachments = [...askImages, ...askFiles]; // the folder's attached/ files, numbered in this order
    // Next to the piece: the few of the author's posts and rewrites closest to it (closest.ts), the
    // description rewrites when the author asks for one, the slide/hook/script ones always. The rest is in the folder.
    const own = await ownPostsForWorkshop(user, projectAccount(project)).catch(() => null);
    // asked for the post description: the author's newest reel captions and the captions saved on this session's
    // other pieces (caption-examples.ts), so the writer doesn't copy research footnotes it was shown
    // a turn for one Finals version: every version of the piece with its facts, the one this description is for marked
    const captionVersion = ask.captionFor ? await captionVersionFor(session.id, doc.id, ask.captionFor) : undefined;
    const captionExamples = askedForCaption(ask.text)
      ? captionExamplesFor(own?.posts ?? [], (await listDocs(session.id)).filter((d) => d.id !== doc.id && d.caption?.text.trim()).map((d) => d.caption!.text))
      : undefined;
    const near = [...doc.blocks, ...(doc.hooks ?? [])].map((b) => b.text).concat(history.filter((m) => m.role === "user").map((m) => m.text), ask.text).join("\n");
    // a caption turn reads its piece, the author's captions and the last few messages: no nearby posts, no folder
    const nearPosts = own && !captionOnly ? closestPosts(near, own.posts) : [];
    const editLog = await readEditLog(session.owner);
    const rewrites = {
      descriptions: closestRewrites(near, editLog.filter((p) => p.kind === "description"), session.projectId, 3),
      pieces: closestRewrites(near, editLog.filter((p) => p.kind !== "description" && p.kind !== "pinned"), session.projectId, 4),
    };
    // On the Mac the turn reads a folder with everything; on the API key, the packed prompt below. A caption turn
    // needs none of it: the Mac answers from the prompt (a folder can be megabytes of tokens per turn).
    let folder: Folder | null = null;
    if (onMac(user, session.ai) && !(captionOnly && !approvedWeb)) {
      // the folder is all it reads (no pulls): a source video nobody transcribed yet is transcribed first
      const untranscribed = index.filter((e) => e.kind !== "carousel" && !e.has.transcript).map((e) => e.id);
      if (untranscribed.length) {
        step(`Transcribing ${untranscribed.length === 1 ? "a source video" : `${untranscribed.length} source videos`} first`);
        await transcribeMissing(untranscribed);
      }
      const t = Date.now();
      folder = await turnFolder(session, user, project, index, own).catch((e: unknown) => {
        console.warn(`[workshop] folder not made, packed prompt instead: ${errorMessage(e)}`);
        return null;
      });
      if (folder) {
        // the relay writes "base64:" entries as bytes; Claude's Read tool shows them as pictures
        attachments.forEach((f, i) => (folder![attachedFile(f, i)] = `base64:${f.data}`));
        const chars = Object.values(folder).reduce((n, f) => n + f.length, 0);
        console.log(`[workshop] folder: ${Object.keys(folder).length} files, ${(chars / 1e6).toFixed(1)} MB of text, ${Date.now() - t} ms`);
      }
    }

    // The Mac's Claude session for this conversation, when it holds the reply before this message (see the Mac relay).
    const askAt = chat.messages.findIndex((m) => m.id === ask.id);
    const context = contextKey(project, frameworks);
    const claude = folder ? resumableClaude(session, askAt > 0 ? chat.messages[askAt - 1]!.id : undefined, ids, context, providerKey(user, session.ai)) : undefined;
    // say what sits next to the piece, before the thinking step (a resumed session has it from its first turn)
    if (!captionOnly && !(claude && folder) && (nearPosts.length || rewrites.pieces.length)) {
      step(`Next to this piece: ${nearPosts.length} of your posts${nearPosts.length ? ` (${nearPosts.map((p) => new Date(p.item.takenAt).toISOString().slice(0, 10)).join(", ")})` : ""} and ${rewrites.pieces.length} of your rewrites, the closest to it`);
    }
    let macSeconds = 0;
    let macLast: { session?: MacSession; promptChars: number } | undefined;

    const build = async (resume?: ClaudeSession) => {
      const views = [];
      for (const e of index) {
        const extra = loaded.find((l) => l.postId === e.id)?.parts ?? [];
        const parts = captionOnly ? [...new Set(extra)] : [...new Set<SourcePart>(["slides", ...extra])];
        const pack = parts.length
          ? (await packPostsForUser([e.id], user, { perPost: 12_000, total: 12_000, parts })).packs[0]
          : undefined;
        const own = account
          ? e.accountId === account.id || e.handle.toLowerCase() === account.username.toLowerCase()
          : false;
        views.push({
          ref: refOf.get(e.id)!,
          postId: e.id,
          handle: e.handle,
          kind: e.kind,
          url: e.url,
          note: noteFor.get(e.id),
          hook: e.hook,
          has: e.has,
          loaded: parts,
          markdown: pack?.markdown ?? "",
          savedFor: e.savedFor,
          own: own || undefined,
          open: ask.reading?.postId === e.id || undefined,
          tagged: tagged.includes(e.id) || undefined,
          openSlide: ask.reading?.postId === e.id ? ask.reading.slide : undefined,
          at: loaded.find((l) => l.postId === e.id)?.at ?? 0,
        });
      }
      // Tagged sources first, then the open one, then the most recently pulled ones.
      views.sort((a, b) => Number(!!b.tagged) - Number(!!a.tagged) || Number(!!b.open) - Number(!!a.open) || b.at - a.at);
      const packText = await packInstructions(user.username, "workshop.write", project?.id ?? null);
      const prompt = buildTurnPrompt({
        project: project ?? undefined,
        account: account ?? undefined,
        loadedAccount: loadedAccount ?? undefined,
        loadedKnowledge: loadedKnowledge.length ? loadedKnowledge : undefined,
        frameworks,
        rules: rules.map((r) => r.text),
        packText,
        doc,
        others: (await listDocs(session.id)).filter((d) => d.id !== doc.id && d.kind !== "notes" && d.blocks.some((b) => b.text.trim())),
        pinned: ask.context ?? [],
        sources: views,
        research: research?.answer ? { question: research.question, answer: research.answer, citations: research.citations ?? [] } : undefined,
        history,
        message: ask.text,
        mine: ask.mine,
        scope: ask.scope,
        captionVersion,
        captionExamples,
        rewrites: captionExamples ? rewrites : { descriptions: [], pieces: rewrites.pieces },
        closestPosts: nearPosts.map((p) => ({
          date: new Date(p.item.takenAt).toISOString().slice(0, 10),
          keptPer1k: keptPer1k(p.item),
          file: folder ? postFile(p.item) : undefined,
          text: p.slides?.join("\n") || p.item.caption || "",
        })),
        web: folder ? approvedWeb || undefined : undefined,
        quotes: ask.quotes,
        pasted: askPasted.map((p) => ({ name: p.name, text: p.text, ...(folder ? { file: pastedFile(session, p) } : {}) })),
        images: askImages.map((im, i) => ({ name: im.name, ...(folder || macReads ? { file: attachedFile(im, i) } : {}) })),
        files: askFiles.map((f, j) => ({ name: f.name, file: attachedFile(f, askImages.length + j) })),
        library: askLibrary.length ? askLibrary : undefined,
        folder: folder ? { contextFiles: Object.keys(folder).filter((f) => f.startsWith("context/")).map((f) => f.slice("context/".length)) } : undefined,
        resumed: resume && folder ? { newSources: index.filter((e) => !resume.sources.includes(e.id)).map((e) => ({ ref: refOf.get(e.id)!, handle: e.handle })) } : undefined,
      });
      return prompt;
    };

    // The answer streams: the reply shows as it is written, each finished edit lands in the document at once.
    const hooks: StreamHooks = {
      onStart: async (p) => {
        await undoPartial();
        await progress({ stage: "thinking", provider: p.label, text: "", edits: undefined }, true);
      },
      onDelta: async (text) => {
        const part = partialTurn(text);
        liveText(assistantId, part.reply);
        const patch: Partial<ChatMessage> = { text: part.reply, stage: part.editsReady && part.edits.length ? "writing" : "thinking" };
        if (part.editsReady && part.newDocument === null && !part.revertTo && part.edits.length > applied) {
          if (!applied && steps[steps.length - 1]?.label !== "Writing the piece") step("Writing the piece");
          const fresh = part.edits.slice(applied);
          await updateDoc(session.id, doc.id, (d) => {
            if (!versionBefore) versionBefore = d.headVersion ?? snapshot(d, `${d.dirty ? "your edits " : ""}before: ${ask.text.slice(0, 80)}`).id;
            const r = onVersion(d, ask.captionFor, () => applyEdits(d, gateCompanionEdits(fresh, { message: ask.text, caption: d.caption?.text ?? "", pinned: d.pinned?.text ?? "" })));
            blockIds.push(...r.blockIds);
            for (const x of r.skipped) if (x.reason === "locked" && "id" in x.op) refused.add(x.op.id);
          });
          applied = part.edits.length;
          patch.edits = { docId: doc.id, blockIds: [...blockIds], versionBefore };
        }
        await progress(patch);
      },
      onUsage: addUsage,
    };

    let plan: TurnPlan;
    let provider = "";
    let calls = 0;
    let pulls = 0;
    let macMissed = false;
    for (;;) {
      calls++;
      step(calls === 1 ? (folder ? "Reading your folder and thinking" : "Thinking") : research ? "Thinking again with what the web search found" : "Thinking again with what it pulled");
      let out: { result: TurnPlan; provider: string } | null = null;
      // a provider on the Mac reads the folder; without one (it could not be made) it gets the packed prompt
      if (onMac(user, session.ai)) {
        const t = Date.now();
        // web search runs inside this same session: no second and fourth call for a quick check
        const macTurn = async (resume?: ClaudeSession) => {
          const prompt = await build(resume);
          const got: { session?: MacSession } = {};
          const mac: MacOpts = {
            ...workshopAi(user, session.ai).mac,
            label: "Workshop",
            // no folder: the pictures still go as files the provider reads
            files: folder ?? (attachments.length ? Object.fromEntries(attachments.map((f, i) => [attachedFile(f, i), `base64:${f.data}`])) : undefined),
            web: !!folder && !!approvedWeb,
            onStep: step,
            ...(folder ? { session: { key: session.id, resume: resume?.id }, onSession: (s: MacSession) => (got.session = s) } : {}),
          };
          macStarted = !!folder;
          return { ...(await streamWithFallback(prompt.system, prompt.user, signal, parseTurn, hooks, { only: ["mac"], mac })), prompt, session: got.session };
        };
        // nothing else takes the turn (the rule: a provider that is off or failed is reported, never swapped silently)
        const missed = (e: unknown): never => {
          if (e instanceof MacClaudeError) addUsage(e.usage);
          const kind = macErrorKind(e);
          if (signal.aborted || kind === "stopped") throw new Error("Stopped");
          throw new Error(`${kind === "unclaimed" || kind === "limit" ? errorMessage(e) : `Your AI did not finish this reply (${errorMessage(e)})`}. Retry sends it again.`);
        };
        // the Mac's Claude session is gone (the Mac relay): this same turn runs once more as a new session, and the reply says so
        let lost = false;
        const macOut = await macTurn(claude).catch((e: unknown) => {
          if (macErrorKind(e) !== "gone" || !claude) return missed(e);
          lost = true;
          return macTurn(undefined).catch(missed);
        });
        out = macOut;
        macSeconds += (Date.now() - t) / 1000;
        const macSession = macOut.session && lost ? { ...macOut.session, state: "lost" as const } : macOut.session;
        macLast = { session: macSession, promptChars: macOut.prompt.system.length + macOut.prompt.user.length };
      } else {
        // the API key (a guest or the demo, when switched on): the packed prompt, pictures sent along
        const prompt = await build();
        const pictures = askImages.length ? { images: askImages.map((im) => ({ type: im.type, data: im.data })) } : {};
        out = await streamWithFallback(prompt.system, prompt.user, signal, parseTurn, hooks, { ...workshopAi(user, session.ai), ...pictures });
      }
      plan = out.result;
      provider = out.provider;
      // The model pulls more of a source: a tool call — load it, ask again (at most twice per turn).
      if (plan.fetch?.length && pulls < 2) {
        const kHits: KnowledgeFile[] = [];
        const adds: Array<{ postId: string; parts: SourcePart[] }> = [];
        let gotA = false;
        for (const f of plan.fetch) {
          if (isAccountFetchSource(f.source) && account) {
            const handle = f.source.trim().replace(/^@/, "").toLowerCase();
            const named = handle === "account" || handle === "instagram" || handle === account.username.toLowerCase();
            if (named && !loadedAccount) {
              loadedAccount = await ownAccountContextFor(user, projectAccount(project), { cadence: true });
              if (loadedAccount) {
                gotA = true;
                fetched.push({ handle: `@${loadedAccount.username}`, parts: [] });
              }
            }
            continue;
          }
          const k = matchKnowledge(knowledge, f.source);
          if (k) {
            if (!loadedKnowledge.some((x) => x.id === k.id) && !kHits.some((x) => x.id === k.id)) kHits.push(k);
            continue;
          }
          const postIds = f.source === "*" ? ids : [idOf.get(f.source) ?? (ids.includes(f.source) ? f.source : "")].filter(Boolean);
          if (f.parts.length) adds.push(...postIds.map((postId) => ({ postId, parts: f.parts })));
        }
        const nextK = clipLoadedKnowledge([...loadedKnowledge, ...kHits]);
        const gotK = nextK.length > loadedKnowledge.length;
        await transcribeMissing(adds.filter((a) => a.parts.includes("transcript")).map((a) => a.postId));
        const gotS = await pull(adds);
        if (gotK || gotS || gotA) {
          loadedKnowledge = nextK;
          for (const k of kHits) {
            if (!fetched.some((x) => x.handle === k.name && x.parts.length === 0)) fetched.push({ handle: k.name, parts: [] });
          }
          pulls++;
          await progress({ stage: "packing", text: plan.reply }, true);
          continue;
        }
      }
      // A quick research question is a tool call: run it, hand the findings back, let the model finish.
      if (plan.research?.depth === "quick" && approvedWeb && !research && researchFor(user)) {
        const q = approvedWeb;
        step(`Checking on the web: "${q.slice(0, 200)}"`);
        await progress({ stage: "researching", text: plan.reply }, true);
        try {
          const a = await webResearch(user, RESEARCH_QUESTION_SYSTEM, q, { depth: "quick", signal });
          addUsage(a.usage);
          research = { question: q, depth: "quick", status: "done", answer: a.content.slice(0, 6000), citations: a.citations.slice(0, 20), model: a.model };
        } catch (e) {
          if (signal.aborted) throw e;
          research = { question: q, depth: "quick", status: "done", answer: `Research failed: ${errorMessage(e)}`, citations: [] };
        }
        continue;
      }
      break;
    }
    const lastStep = steps[steps.length - 1];
    if (lastStep && !lastStep.end) lastStep.end = Date.now();
    await progress({}, true);

    let target = doc;
    let created = false;
    // An empty piece of the same kind is the one to fill, not a second one beside it
    //.
    const fresh = plan.newDocument;
    const fillEmpty = !!fresh && fresh.kind === doc.kind && !doc.blocks.some((b) => b.text.trim());
    if (fresh && fillEmpty) {
      await updateDoc(session.id, doc.id, (d) => {
        if (!d.title.trim() || d.title === KIND_TITLE[fresh.kind]) d.title = fresh.title;
      });
    } else if (fresh) {
      await undoPartial();
      target = newDocument(randomUUID(), session.id, fresh.kind, fresh.title, {
        frameworkIds: doc.frameworkIds,
        ruleIds: doc.ruleIds,
      });
      await writeDoc(target);
      created = true;
    }
    let revertedTo: string | undefined;
    if (plan.revertTo && !created) {
      await undoPartial();
      const ok = await updateDoc(session.id, target.id, (d) => {
        if (revert(d, plan.revertTo!)) revertedTo = plan.revertTo;
      });
      if (!ok) throw new Error("That document is gone");
    } else if (plan.edits.length > applied || (created && plan.edits.length)) {
      const rest = created || fillEmpty ? editsForNewDocument(plan.edits) : plan.edits.slice(applied);
      await progress({ stage: "applying" }, true);
      await updateDoc(session.id, target.id, (d) => {
        if (!created && !versionBefore) versionBefore = d.headVersion ?? snapshot(d, `${d.dirty ? "your edits " : ""}before: ${ask.text.slice(0, 80)}`).id;
        const r = onVersion(d, ask.captionFor, () => applyEdits(d, gateCompanionEdits(rest, { message: ask.text, caption: d.caption?.text ?? "", pinned: d.pinned?.text ?? "" })));
        blockIds.push(...r.blockIds);
        for (const x of r.skipped) if (x.reason === "locked" && "id" in x.op) refused.add(x.op.id);
      });
      applied = plan.edits.length;
    }
    let versionAfter: string | undefined;
    if (blockIds.length) {
      await updateDoc(session.id, target.id, (d) => {
        versionAfter = snapshot(d, `after: ${ask.text.slice(0, 80)}`).id;
      });
    }
    await updateDoc(session.id, doc.id, (d) => markEditsSeen(d));
    let hits: unknown[] | undefined;
    if (plan.search) {
      await progress({ stage: "searching" }, true);
      const inSession = new Set(session.sources.map((s) => s.postId));
      hits = (await findPostsForUser(plan.search, user, { limit: 40, projectId: session.projectId })).hits.filter((h) => !inSession.has(h.post.id)).slice(0, 8);
    }
    // a web search the model wants is asked for, never started on its own
    const proposal: Proposal | undefined = plan.audit
      ? { kind: "audit", depth: plan.audit, status: "open" }
      : plan.research && !research && !(plan.research.depth === "quick" && approvedWeb)
        ? { kind: "research", depth: plan.research.depth, question: plan.research.question, status: "open" }
        : undefined;
    const notes: string[] = [];
    if (macLast?.session?.state === "lost") notes.push("Claude's earlier session for this conversation was gone, so this reply read the whole conversation again.");
    if (plan.revertTo && !revertedTo) notes.push(`I could not find version ${plan.revertTo}.`);
    if (plan.search) {
      notes.push(
        hits?.length
          ? `I searched the library for “${plan.search}” — ${hits.length} related post${hits.length === 1 ? "" : "s"} below, add the ones you want.`
          : `I searched the library for “${plan.search}” — nothing beyond what is already in the session.`,
      );
    }
    if ((approvedWeb && !folder && !research) || (ask.deep && !research)) notes.push("Research is not configured on the server, so I could not check that on the web.");
    // a web search the model ran itself is said in the answer, in code (the model may not)
    const searched = steps.filter((x) => x.label.startsWith("Searched the web: ")).map((x) => x.label.slice("Searched the web: ".length));
    if (searched.length) notes.push(`Searched the web for ${searched.join(", ")}.`);
    if (unreadFiles.length) {
      const list = unreadFiles.map((f) => f.name).join(", ");
      notes.push(macReads ? `Not read, the file is no longer in this session: ${list}.` : `Not read: ${list}. PDFs reach the AI only through the Mac, so this reply did not read them.`);
    }
    if (refused.size) {
      const at = (await readDoc(session.id, target.id))?.blocks.map((b) => b.id) ?? [];
      const nums = [...refused].map((id) => at.indexOf(id) + 1).filter((n) => n > 0).sort((a, b) => a - b);
      notes.push(`Left ${nums.length ? `${nums.length > 1 ? "slides" : "slide"} ${nums.join(", ")}` : "your locked slides"} as you locked ${nums.length > 1 ? "them" : "it"}.`);
    }
    // the read-through: the whole piece against what the model never checks, and against the author's posted carousels
    if (blockIds.length || created) {
      const edited = await readDoc(session.id, target.id);
      if (edited) {
        const own = await ownPostsForWorkshop(user, projectAccount(project)).catch(() => null);
        const found = readThrough(edited, { slides: (own?.posts ?? []).flatMap((p) => p.slides ?? []), captions: (own?.posts ?? []).map((p) => p.item.caption ?? "") });
        if (found.length) notes.push(`Read-through:\n${found.map((f) => `- ${f}`).join("\n")}`);
      }
    }
    // the draft changed: check it against its rules (flags only, never blocks)
    let flags: Awaited<ReturnType<typeof checkDraft>> | undefined;
    const tsKey = keyFor(user, "TYPESAFE_API_KEY").key;
    if (tsKey && (blockIds.length || created)) {
      const edited = await readDoc(session.id, target.id);
      if (edited) {
        flags = await checkDraft(tsKey, edited, await rulesFor(user, edited.ruleIds, project)).catch((e) => {
          console.warn(`[workshop] rule check failed: ${errorMessage(e)}`);
          return undefined;
        });
      }
    }
    // The Mac's Claude session holds this turn when the answer came from the Mac and no API call followed: the next turn resumes it.
    if (macLast?.session && !macMissed) {
      const claudeId = macLast.session.id;
      await updateSession(session.id, (m) => {
        m.claudeSession = { id: claudeId, provider: providerKey(user, session.ai), at: Date.now(), after: assistantId, sources: ids, context, tokens: sessionTokens };
      });
    }
    if (macLast) {
      console.log(`[workshop] Mac turn ${assistantId}: session ${macLast.session?.state ?? "none"}, prompt ${macLast.promptChars} chars, $${(usage?.costUsd ?? 0).toFixed(2)} API-equivalent, ${macSeconds.toFixed(1)} s`);
    }

    await patchMessage(session.id, assistantId, {
      text: plan.reply,
      notes: notes.length ? notes : undefined,
      steps: steps.length ? steps : undefined,
      status: "done",
      stage: undefined,
      provider,
      docId: target.id,
      edits: blockIds.length || created ? { docId: target.id, blockIds, versionBefore, versionAfter, created: created || undefined } : undefined,
      revertedTo,
      fetched: fetched.length ? fetched : undefined,
      search: plan.search,
      hits,
      research,
      proposal,
      flags: flags?.length ? flags : undefined,
      usage: usage && { tokens: usage.tokens, costUsd: usage.costUsd },
    });
    bumpUsage(user.username, { aiRuns: calls + (research ? 1 : 0) });
    if (blockIds.length || created) void nameSession(session.id, user, target.id).catch((e) => console.warn(`[workshop] naming ${session.id}: ${errorMessage(e)}`));
  } catch (e) {
    await undoPartial();
    // a Claude session a stop or a failure cut short may hold half a turn: the next turn starts over
    if (macStarted) await updateSession(session.id, (m) => { m.claudeSession = undefined; }).catch(() => {});
    outcome = signal.aborted ? "Stopped" : "Failed";
    await patchMessage(session.id, assistantId, { status: "error", stage: undefined, error: signal.aborted ? TURN_STOPPED : errorMessage(e).slice(0, 300), usage });
    console.warn(`[workshop] turn ${assistantId} failed: ${errorMessage(e)}`);
  } finally {
    chatting.delete(assistantId);
    stops.delete(assistantId);
    liveEnd(assistantId);
    const title = session.title || "Untitled";
    await notifyWorkshopOwner(session.owner, { kind: "workshop", by: "Content Workshop", name: title, text: `${outcome}: ${title}`, href: `/workshop/sessions/${session.id}`, ref: session.id }).catch(() => {});
  }
}

/** The account's posts people saved and sent the most (saves + shares per 1,000 views), with what was said in them. */
async function bestPosts(user: SessionUser, project: Project | null, n: number): Promise<{ handle?: string; best: ReviewPost[] }> {
  const own = await ownPostsForWorkshop(user, projectAccount(project));
  const best = (own?.posts ?? [])
    .map(({ item: i }) => {
      const views = i.insights?.views ?? i.counts.plays ?? 0;
      const kept = (i.insights?.saved ?? 0) + (i.insights?.shares ?? 0);
      return { date: new Date(i.takenAt).toISOString().slice(0, 10), views, keptPer1k: views ? (kept * 1000) / views : 0, text: i.caption || "" };
    })
    .filter((p) => p.views >= 1000 && p.keptPer1k > 0 && p.text.trim())
    .sort((a, b) => b.keptPer1k - a.keptPer1k)
    .slice(0, n);
  return { handle: own?.handle, best };
}

/** A Claude provider for Fable: the Workshop's when it is Claude, else the first Claude that is on. */
function fableProvider(user: SessionUser): MacOpts["provider"] {
  const p = workshopAi(user).mac?.provider;
  if (p?.driver === "claude") return { ...p, model: REVIEW_MODEL };
  const ws = providerSettings();
  // the workspace's Claude answers admins only (lib/providers.ts routeFor)
  if (user.role !== "admin") return p;
  const c = ws.instances.find((i) => i.enabled && i.driver === "claude");
  return c ? { instance: c.id, driver: c.driver, home: c.home, device: c.device ?? "", scope: "workspace", model: REVIEW_MODEL, effort: p?.effort ?? "xhigh" } : p;
}

/** "Read as a follower": Fable on the Mac reads the piece with only the piece, the audience and the author's best posts (review.ts). */
async function runReview(session: SessionMeta, user: SessionUser, messageId: string, docId: string): Promise<void> {
  const signal = stopSignal(messageId);
  try {
    const doc = await readDoc(session.id, docId);
    if (!doc?.blocks.length) throw new Error("That document is empty");
    const project = await projectForAi(session.projectId, user);
    const { handle, best } = await bestPosts(user, project, 8);
    const packText = await packInstructions(user.username, "workshop.review", project?.id ?? null);
    const { system, user: prompt } = buildReviewPrompt({ doc, handle, audience: audienceOf(project), best, packText });
    let usage: MacUsage | undefined;
    const write = progressWriter(session.id, messageId);
    const text = await streamMacClaude(system, prompt, signal, (t) => write({ text: t, stage: "writing" }), (u) => (usage = u), { label: "Workshop follower's read", provider: fableProvider(user), model: REVIEW_MODEL });
    await write({}, true);
    await patchMessage(session.id, messageId, { status: "done", stage: undefined, text: text.trim(), provider: "Claude Fable (Mac)", usage });
    bumpUsage(user.username, { aiRuns: 1 });
  } catch (e) {
    await patchMessage(session.id, messageId, { status: "error", stage: undefined, error: errorMessage(e).slice(0, 300) });
    console.warn(`[workshop] follower's read ${messageId} failed: ${errorMessage(e)}`);
  } finally {
    chatting.delete(messageId);
    stops.delete(messageId);
  }
}

/** Deep research the author confirmed: one long read on the web, the answer becomes a message the next turn can see. */
async function runResearch(session: SessionMeta, user: SessionUser, messageId: string, question: string): Promise<void> {
  const signal = stopSignal(messageId);
  try {
    await patchMessage(session.id, messageId, { stage: "researching", provider: researchLabel(user) });
    const a = await webResearch(user, RESEARCH_QUESTION_SYSTEM, question, { depth: "deep", signal });
    const sources = a.citations.slice(0, 20).map((u, i) => `[${i + 1}] ${u}`);
    if (signal.aborted) throw new Error("Stopped"); // a Stop while the answer was in flight stays a Stop
    await patchMessage(session.id, messageId, {
      status: "done",
      stage: undefined,
      text: `Deep research — ${question}\n\n${a.content.slice(0, 8000)}${sources.length ? `\n\nSources:\n${sources.join("\n")}` : ""}`,
      research: { question, depth: "deep", status: "done", answer: a.content.slice(0, 8000), citations: a.citations.slice(0, 20), model: a.model },
      provider: a.usage ? "Claude (Mac)" : undefined,
      usage: a.usage,
    });
    bumpUsage(user.username, { aiRuns: 1 });
  } catch (e) {
    await patchMessage(session.id, messageId, { status: "error", stage: undefined, error: errorMessage(e).slice(0, 300) });
    console.warn(`[workshop] research ${messageId} failed: ${errorMessage(e)}`);
  } finally {
    chatting.delete(messageId);
    stops.delete(messageId);
  }
}

/** The accuracy audit: the piece goes to the research model, verdicts come back onto the chat message. */
async function runAudit(session: SessionMeta, user: SessionUser, messageId: string, input: AuditInput, target: AuditTarget): Promise<void> {
  const signal = stopSignal(messageId);
  try {
    let text: string;
    let covered: { chars: number; total: number } | undefined;
    if (target.type === "document") {
      const doc = await readDoc(session.id, target.id);
      if (!doc) throw new Error("That document is gone");
      if (!doc.blocks.length) throw new Error("The document is empty — nothing to check");
      ({ text, covered } = documentAudit(doc));
    } else {
      const pack = (await packPostsForUser([target.id], user, { perPost: MAX_AUDIT_CHARS, total: MAX_AUDIT_CHARS, comments: false })).packs[0];
      if (!pack) throw new Error("That source is gone");
      text = postAuditText(pack.handle, pack.kind, pack.markdown);
    }
    await patchMessage(session.id, messageId, { stage: "researching", provider: researchLabel(user) });
    const packText = await packInstructions(user.username, "workshop.review", session.projectId ?? null);
    const system = packText ? `${AUDIT_SYSTEM}\n\n${packText}` : AUDIT_SYSTEM;
    const answer = await webResearch(user, system, text, { depth: input.depth, jsonSchema: AUDIT_JSON_SCHEMA, signal });
    const result = { ...parseAuditResult(answer.content, answer.citations), ...(covered ? { covered } : {}) };
    if (signal.aborted) throw new Error("Stopped");
    await patchMessage(session.id, messageId, {
      status: "done",
      stage: undefined,
      text: auditSummaryText(target.title, result),
      audit: { target, depth: input.depth, model: answer.model, tokens: answer.tokens, costUsd: answer.usage?.costUsd, result },
    });
    bumpUsage(user.username, { aiRuns: 1 });
  } catch (e) {
    await patchMessage(session.id, messageId, { status: "error", stage: undefined, error: errorMessage(e).slice(0, 300) });
    console.warn(`[workshop] audit ${messageId} failed: ${errorMessage(e)}`);
  } finally {
    chatting.delete(messageId);
    stops.delete(messageId);
  }
}

/** What a session makes, for the list: the kinds of
 * its pieces with words in them, else of all its pieces (a new session's empty reel). Notes are not a piece. */
export function pieceKinds(docs: Array<{ kind: Document["kind"]; blocks: Array<{ text: string }>; caption?: { text: string } }>): DraftKind[] {
  const pieces = docs.filter((d): d is typeof d & { kind: DraftKind } => d.kind !== "notes");
  const worded = pieces.filter((d) => d.blocks.some((b) => b.text.trim()) || !!d.caption?.text.trim());
  return [...new Set((worded.length ? worded : pieces).map((d) => d.kind))];
}

function sessionRow(meta: SessionMeta, projectName?: string) {
  const { drafts, sources, ...rest } = meta;
  return {
    ...rest,
    status: meta.status ?? "draft",
    sourceIds: sources.map((s) => s.postId),
    sourceCount: sources.length,
    draftCount: drafts.length,
    generating: drafts.some((d) => d.status === "generating"),
    projectName,
  };
}

/** What Claude on the Mac measured across a list of messages: tokens and API-equivalent cost. */
const usageOf = (messages: ChatMessage[]) =>
  messages.reduce((t, m) => (m.usage ? { tokens: t.tokens + m.usage.tokens, costUsd: t.costUsd + m.usage.costUsd, turns: t.turns + 1 } : t), { tokens: 0, costUsd: 0, turns: 0 });

/** The project's other sessions together; the page adds this session live. */
async function projectUsageElsewhere(meta: SessionMeta, user: SessionUser) {
  if (!meta.projectId) return undefined;
  const total = { tokens: 0, costUsd: 0, turns: 0, sessions: 0 };
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    if (id === meta.id) continue;
    const other = await readSession(id);
    if (!other || other.owner !== user.username || other.projectId !== meta.projectId) continue;
    const u = usageOf((await readJson<Chat>(chatPath(id)))?.messages ?? []);
    if (!u.turns) continue;
    total.tokens += u.tokens;
    total.costUsd += u.costUsd;
    total.turns += u.turns;
    total.sessions++;
  }
  return total;
}

async function sessionRecord(meta: SessionMeta, user: SessionUser) {
  const [notes, posts, usageElsewhere] = await Promise.all([
    readNotes(meta.id),
    postsForUser(
      meta.sources.map((s) => s.postId),
      user,
    ),
    projectUsageElsewhere(meta, user),
  ]);
  return { ...meta, notes, posts, ...(usageElsewhere ? { projectUsageElsewhere: usageElsewhere } : {}) };
}

/* ---- routes ---- */

workshopApp.get("/availability", async (c) => {
  const user = c.get("user");
  // mac: whether the Mac this account's Workshop replies run on is reachable (its own, or the workspace's)
  const route = routeFor(user.username, user.role === "admin", "workshop");
  return c.json({ ai: aiOn(user), research: researchFor(user), library: await libraryCountFor(user), ...(route ? { mac: isOnline(route.device) } : {}) });
});

/**
 * Once, when a second project exists: everything from before
 * was the first brand's, so sessions, rewrites, saved posts and followed accounts with no project go into the project
 * linked to "my account" (else the oldest), and that project links "my account" when none does. After this, a record
 * with no project is shared by every project on purpose.
 */
async function scopeOldRecords(user: SessionUser): Promise<void> {
  if ((await readUserMarker(user.username))?.scopedAt) return;
  const projects = await ownedProjects(user.username);
  if (!projects.length) return;
  const mineId = await mineAccountId(user);
  const target = projects.find((p) => mineId && p.accountId === mineId) ?? [...projects].sort((a, b) => a.createdAt - b.createdAt)[0]!;
  // a project reads only its linked account now, so the first brand links "my account" even while it's the only one
  if (mineId && !target.accountId && !projects.some((p) => p.accountId === mineId)) {
    await writeJsonAtomic(projectPath(target.id), { ...target, accountId: mineId, updatedAt: Date.now() });
  }
  if (projects.length < 2) return;
  const docProject = new Map<string, string>();
  let sessions = 0;
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const meta = await readSession(id);
    if (!meta || meta.owner !== user.username) continue;
    let pid = meta.projectId;
    if (!pid) {
      pid = target.id;
      await updateSession(id, (m) => void (m.projectId ??= target.id), { touch: false });
      sessions++;
    }
    for (const d of await listDocs(id)) docProject.set(d.id, pid);
  }
  const log = await readEditLog(user.username);
  const rewrites = log.filter((p) => !p.projectId).length;
  if (rewrites) await writeJsonAtomic(editLogPath(user.username), log.map((p) => (p.projectId ? p : { ...p, projectId: docProject.get(p.key.split(":")[0]!) ?? target.id })));
  const analyzer = await scopeOldAnalyzer(user, target.id);
  await writeUserMarker(user.username, { ...((await readUserMarker(user.username)) ?? {}), scopedAt: Date.now() });
  console.log(`[workshop] ${user.username}: kept apart into "${target.name}": ${sessions} sessions, ${rewrites} rewrites, ${analyzer.posts} saved posts, ${analyzer.accounts} accounts`);
}

workshopApp.get("/workspace", async (c) => {
  const user = c.get("user");
  await scopeOldRecords(user).catch((e: unknown) => console.warn(`[workshop] keeping projects apart: ${errorMessage(e)}`));
  return c.json(await getWorkspace(user));
});

workshopApp.patch("/workspace", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as { currentProjectId?: unknown } | null;
  const raw = body?.currentProjectId;
  try {
    if (raw === null || raw === "") return c.json(await setCurrentProjectId(user, null));
    if (!okId(raw)) return c.json({ error: "Unknown project" }, 400);
    return c.json(await setCurrentProjectId(user, raw));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 404);
  }
});

// your own projects only: an admin was shown every account's, so two "Tiny Acrobatics"
workshopApp.get("/projects", async (c) => c.json(await ownedProjects(c.get("user").username)));

workshopApp.post("/projects", async (c) => {
  const user = c.get("user");
  try {
    const { accountId, ...fields } = parseProjectInput(await c.req.json().catch(() => null));
    const now = Date.now();
    const project: Project = { id: randomUUID(), owner: user.username, ...fields, createdAt: now, updatedAt: now };
    if (accountId) project.accountId = accountId;
    // a new project takes a colour none of yours has yet
    if (!project.color) {
      const used = new Set((await ownedProjects(user.username)).map((p) => p.color));
      project.color = PROJECT_COLORS.find((c) => !used.has(c)) ?? PROJECT_COLORS[0];
    }
    await writeJsonAtomic(projectPath(project.id), project);
    await scopeOldRecords(user).catch((e: unknown) => console.warn(`[workshop] keeping projects apart: ${errorMessage(e)}`));
    await setCurrentProjectId(user, project.id);
    return c.json(project, 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

/**
 * A new project's setup: the facts a writer
 * needs about the brand, drafted from its Instagram bio and posts, for the author to rewrite. Facts, not a voice.
 */
workshopApp.post("/projects/draft-notes", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as { accountId?: unknown; name?: unknown } | null;
  if (!okId(body?.accountId)) return c.json({ error: "Link the project's Instagram first" }, 400);
  const [account, own] = await Promise.all([ownAccountContextFor(user, body.accountId), ownPostsForWorkshop(user, body.accountId)]);
  if (!account || !own?.posts.length) return c.json({ error: "No posts synced for that account yet: Sync it first" }, 409);
  const views = (p: (typeof own.posts)[number]) => p.item.insights?.views ?? p.item.counts.plays ?? 0;
  const posts = [...own.posts]
    .sort((a, b) => views(b) - views(a))
    .slice(0, 40)
    .map((p) => `- ${new Date(p.item.takenAt).toISOString().slice(0, 10)}, ${views(p)} views: ${(p.slides?.join(" / ") || p.item.caption || "").replace(/\s+/g, " ").slice(0, 400)}`);
  try {
    const notes = await completeWithFallback(
      "From a creator's Instagram bio and posts, write the facts a writer needs about this brand: who it is for, what it offers, where people are sent (a link, a product, a DM word), and the topics it keeps coming back to. Only what the bio and posts say; say so where they don't. Plain short lines, under 1,200 characters. Don't describe how they write.",
      `${typeof body.name === "string" ? `Project: ${body.name.slice(0, 80)}\n\n` : ""}${renderAccountContext(account)}\n\nTheir most-viewed posts (what was said or on the slides):\n${posts.join("\n")}`,
      undefined,
      (t) => {
        const s = t.trim();
        if (!s) throw new Error("empty");
        return s.slice(0, LIMITS.projectNotes);
      },
      route(user, "workshop", "Project setup"),
    );
    return c.json({ notes });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

workshopApp.patch("/projects/:id", async (c) => {
  const user = c.get("user");
  const project = await readProject(c.req.param("id"), user);
  if (!project) return c.json({ error: "Not found" }, 404);
  try {
    const { accountId, ...fields } = parseProjectInput(await c.req.json().catch(() => null), project);
    const next: Project = { ...project, ...fields, updatedAt: Date.now() };
    if (!fields.off) delete next.off;
    if (accountId === null) delete next.accountId;
    else if (accountId) next.accountId = accountId;
    await writeJsonAtomic(projectPath(next.id), next);
    return c.json(next);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.delete("/projects/:id", async (c) => {
  const user = c.get("user");
  const project = await readProject(c.req.param("id"), user);
  if (!project) return c.json({ error: "Not found" }, 404);
  let names: string[] = [];
  try {
    names = await readdir(DIRS.sessions);
  } catch {
    names = [];
  }
  for (const id of names) {
    const meta = await ownedSession(id, user);
    if (meta?.projectId === project.id) {
      await updateSession(id, (m) => {
        delete m.projectId;
      });
    }
  }
  await rm(projectPath(project.id), { force: true });
  const ws = await getWorkspace(user);
  if (ws.currentProjectId === project.id) await setCurrentProjectId(user, ws.projects[0]?.id ?? null);
  return c.json({ ok: true });
});

const noKnowledge = (user: SessionUser) => user.role === "visitor";

workshopApp.get("/sources", async (c) => c.json(await listSources(c.get("user"))));

workshopApp.get("/sources/:id/text", async (c) => {
  const s = await readSource(c.req.param("id"), c.get("user"));
  return s ? c.text(await readSourceText(s.id)) : c.json({ error: "Not found" }, 404);
});

/** A new source with its text (or the scanned pages to read first), filed in the background. */
async function writePages(id: string, pages: string[]): Promise<number> {
  await mkdir(sourcePagesDir(id), { recursive: true });
  const have = (await readdir(sourcePagesDir(id))).filter((n) => n.endsWith(".jpg")).length;
  const room = Math.max(0, SOURCE_LIMITS.scanPages - have);
  for (const [i, b64] of pages.slice(0, room).entries()) await writeFile(path.join(sourcePagesDir(id), `${String(have + i + 1).padStart(4, "0")}.jpg`), Buffer.from(b64, "base64"));
  return have + Math.min(room, pages.length);
}

/** A new source with its text (or a scan's first pages: `more` = further batches follow, read after the last). */
async function newSource(user: SessionUser, name: string, text: string, projectIdRaw: unknown, pages?: string[], more = false): Promise<KnowledgeSource> {
  if ((await listSources(user)).length >= SOURCE_LIMITS.perAccount) throw new Error(`Up to ${SOURCE_LIMITS.perAccount} sources`);
  const projectId = okId(projectIdRaw) && (await readProject(projectIdRaw, user)) ? projectIdRaw : undefined;
  const now = Date.now();
  const s: KnowledgeSource = { id: randomUUID(), owner: user.username, name: name.slice(0, SOURCE_LIMITS.name), chars: text.length, status: "new", createdAt: now, updatedAt: now, ...(projectId ? { projectId } : {}) };
  if (pages?.length) await writePages(s.id, pages);
  await writeSource(s, text.slice(0, SOURCE_LIMITS.chars));
  if (more) return s;
  void fileSource(user, s.id);
  return { ...s, status: "reading", startedAt: now };
}

/**
 * Add one. `text` (the browser reads PDFs, videos and pastes to text), `file` (a .docx/.odt/.epub, base64: read
 * here) or `pages` (a scanned PDF's pages as JPEGs, base64: the user's AI reads them, then files the text).
 */
workshopApp.post("/sources", async (c) => {
  const user = c.get("user");
  if (noKnowledge(user)) return c.json({ error: "Knowledge needs an account" }, 403);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; text?: unknown; file?: unknown; pages?: unknown; more?: unknown; projectId?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "A source needs a name" }, 400);
  try {
    if (typeof body?.file === "string") return c.json(await newSource(user, name, await documentText(name, Buffer.from(body.file, "base64")), body.projectId), 201);
    if (Array.isArray(body?.pages)) {
      const pages = body.pages.filter((p): p is string => typeof p === "string" && p.length > 100);
      if (!pages.length) return c.json({ error: "No pages" }, 400);
      return c.json(await newSource(user, name, "", body.projectId, pages, body.more === true), 201);
    }
    const text = typeof body?.text === "string" ? body.text.replace(/^\uFEFF/, "") : "";
    if (!text.trim()) return c.json({ error: "A source needs some text" }, 400);
    return c.json(await newSource(user, name, text, body?.projectId), 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

/** Add a link: a YouTube video (title, description, captions, on the user's own Apify token) or a web page's text. */
workshopApp.post("/sources/link", async (c) => {
  const user = c.get("user");
  if (noKnowledge(user)) return c.json({ error: "Knowledge needs an account" }, 403);
  const body = (await c.req.json().catch(() => null)) as { url?: unknown; projectId?: unknown } | null;
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  try {
    const yt = parseYoutubeUrl(url);
    if (yt) {
      const { info } = await fetchYoutubeViaApify(yt, { username: user.username });
      const spoken = (info.words ?? []).map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
      const text = [info.caption, info.creator.fullName ? `Channel: ${info.creator.fullName}` : "", url, spoken ? `\nWhat is said:\n${spoken}` : ""].filter(Boolean).join("\n");
      return c.json(await newSource(user, (info.caption.split("\n", 1)[0] || url).slice(0, 100), text, body?.projectId), 201);
    }
    const page = await webPageText(url);
    return c.json(await newSource(user, page.title.slice(0, 100), page.text, body?.projectId), 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

/** A scan's next batch of pages (a request stays under the body limit); the last one (`more` false) starts the read. */
workshopApp.post("/sources/:id/pages", async (c) => {
  const user = c.get("user");
  if (noKnowledge(user)) return c.json({ error: "Knowledge needs an account" }, 403);
  const s = await readSource(c.req.param("id"), user);
  if (!s || s.status !== "new") return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { pages?: unknown; more?: unknown } | null;
  const pages = Array.isArray(body?.pages) ? body.pages.filter((p): p is string => typeof p === "string" && p.length > 100) : [];
  const total = await writePages(s.id, pages);
  if (body?.more === true) return c.json({ ...s, pages: total });
  void fileSource(user, s.id);
  return c.json({ ...s, status: "reading", startedAt: Date.now() });
});

workshopApp.post("/sources/:id/read", async (c) => {
  const user = c.get("user");
  if (noKnowledge(user)) return c.json({ error: "Knowledge needs an account" }, 403);
  const s = await readSource(c.req.param("id"), user);
  if (!s) return c.json({ error: "Not found" }, 404);
  if (s.status === "reading") return c.json(s);
  void fileSource(user, s.id);
  return c.json({ ...s, status: "reading", startedAt: Date.now() });
});

workshopApp.patch("/sources/:id", async (c) => {
  const user = c.get("user");
  const s = await readSource(c.req.param("id"), user);
  if (!s) return c.json({ error: "Not found" }, 404);
  try {
    const { projectId, ...fields } = parseSourcePatch(await c.req.json().catch(() => null), lineCount(await readSourceText(s.id)));
    if (projectId && !(await readProject(projectId, user))) return c.json({ error: "Unknown project" }, 400);
    const next = await patchSource(s.id, (cur) => {
      const x: KnowledgeSource = { ...cur, ...fields, updatedAt: Date.now() };
      if (projectId === null) delete x.projectId;
      else if (projectId) x.projectId = projectId;
      return x;
    });
    return next ? c.json(next) : c.json({ error: "Not found" }, 404);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.delete("/sources/:id", async (c) => {
  const s = await readSource(c.req.param("id"), c.get("user"));
  if (!s) return c.json({ error: "Not found" }, 404);
  await rm(sourcePath(s.id), { force: true });
  await rm(sourceTextPath(s.id), { force: true });
  await rm(sourcePagesDir(s.id), { recursive: true, force: true });
  return c.json({ ok: true });
});

workshopApp.get("/frameworks", async (c) => {
  const user = c.get("user");
  await ensureSeeds(user.username);
  const order = new Map(SEED_FRAMEWORKS.map((s, i) => [s.seedKey, i]));
  return c.json(
    (await listRecords<Framework>(DIRS.frameworks, user))
      .filter((f) => f.owner === user.username)
      .sort((a, b) => (order.get(a.seedKey ?? "") ?? 1000) - (order.get(b.seedKey ?? "") ?? 1000) || a.name.localeCompare(b.name))
      .map(withRole),
  );
});

workshopApp.post("/frameworks", async (c) => {
  const user = c.get("user");
  try {
    const fields = parseFrameworkInput(await c.req.json().catch(() => null));
    const now = Date.now();
    const fw: Framework = { id: randomUUID(), owner: user.username, ...fields, createdAt: now, updatedAt: now };
    await writeJsonAtomic(frameworkPath(fw.id), fw);
    return c.json(fw, 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.patch("/frameworks/:id", async (c) => {
  const user = c.get("user");
  const fw = await readFramework(c.req.param("id"), user);
  if (!fw) return c.json({ error: "Not found" }, 404);
  try {
    const fields = parseFrameworkInput(await c.req.json().catch(() => null), fw);
    const next: Framework = { ...fw, ...fields, updatedAt: Date.now() };
    await writeJsonAtomic(frameworkPath(next.id), next);
    return c.json(next);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.delete("/frameworks/:id", async (c) => {
  const fw = await readFramework(c.req.param("id"), c.get("user"));
  if (!fw) return c.json({ error: "Not found" }, 404);
  await rm(frameworkPath(fw.id), { force: true });
  return c.json({ ok: true });
});

workshopApp.get("/rules", async (c) => {
  const user = c.get("user");
  await ensureRuleSeeds(user.username);
  return c.json((await listRecords<Rule>(DIRS.rules, user)).filter((r) => r.owner === user.username).sort((a, b) => a.createdAt - b.createdAt));
});

workshopApp.post("/rules", async (c) => {
  const user = c.get("user");
  try {
    const fields = parseRuleInput(await c.req.json().catch(() => null));
    const now = Date.now();
    const rule: Rule = { id: randomUUID(), owner: user.username, ...fields, createdAt: now, updatedAt: now };
    await writeJsonAtomic(rulePath(rule.id), rule);
    return c.json(rule, 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.patch("/rules/:id", async (c) => {
  const user = c.get("user");
  const rule = await readRule(c.req.param("id"), user);
  if (!rule) return c.json({ error: "Not found" }, 404);
  try {
    const fields = parseRuleInput(await c.req.json().catch(() => null), rule);
    const next: Rule = { ...rule, ...fields, updatedAt: Date.now() };
    await writeJsonAtomic(rulePath(next.id), next);
    return c.json(next);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.delete("/rules/:id", async (c) => {
  const rule = await readRule(c.req.param("id"), c.get("user"));
  if (!rule) return c.json({ error: "Not found" }, 404);
  await rm(rulePath(rule.id), { force: true });
  return c.json({ ok: true });
});

/** When each user's sessions were last matched to their posts: the list asks at most every 10 minutes. */
const postedChecked = new Map<string, number>();

/** Links each of the user's sessions that has no post yet to the post it clearly became, and marks it published. */
async function linkPosted(user: SessionUser): Promise<void> {
  if (Date.now() - (postedChecked.get(user.username) ?? 0) < 10 * 60_000) return;
  postedChecked.set(user.username, Date.now());
  const open: SessionMeta[] = [];
  const taken = new Set<string>();
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const meta = await readSession(id);
    if (meta?.owner !== user.username) continue;
    for (const p of postingsOf(meta)) taken.add(p.shortcode);
    if (!postingsOf(meta).length && meta.status !== "shelved") open.push(meta); // shelved: never moved on by itself
  }
  // a project can point at another account: match each account's sessions against its own posts
  const byAccount = new Map<string | null | undefined, SessionMeta[]>();
  for (const meta of open) {
    const account = meta.projectId ? projectAccount(await readProject(meta.projectId, user)) : undefined;
    byAccount.set(account, [...(byAccount.get(account) ?? []), meta]);
  }
  for (const [account, metas] of byAccount) {
    const own = await ownPostsForWorkshop(user, account);
    if (!own?.posts.length) continue;
    const candidates = [];
    for (const meta of metas) {
      const text = (await listDocs(meta.id))
        .filter((d) => d.kind !== "notes")
        .flatMap((d) => [...d.blocks.map((b) => b.text), d.caption?.text ?? "", d.pinned?.text ?? ""])
        .join("\n");
      if (text.split(/\s+/).length >= 30) candidates.push({ meta, text });
    }
    for (const [id, post] of matchPosted(candidates, own.posts, taken)) {
      await updateSession(id, (m) => {
        if (postingsOf(m).length) return;
        setPostings(m, [{ shortcode: post.item.shortcode, url: post.item.url, by: "auto", at: Date.now() }]);
        setSessionStatus(m, "published", "matched post", { skipIllegal: true }); // a shelved session stays shelved
      });
      console.log(`workshop: session ${id} became post ${post.item.shortcode} (matched by its words)`);
    }
  }
}

/**
 * A link shared from the phone:
 * is it one of your own posts? Then the sessions it could be, closest words first, so the phone links it with one tap
 * (PATCH the session's `posted`). `own: false` = someone else's post: the phone saves it as research, as before.
 */
workshopApp.post("/own-post", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const link = text.split(/\s+/).map(postedFromUrl).find(Boolean);
  if (!link) return c.json({ own: false });
  // every project's own account, the current project first
  const current = await resolveProjectId(user);
  const projects = (await ownedProjects(user.username)).sort((a, b) => Number(b.id === current) - Number(a.id === current));
  let found: Awaited<ReturnType<typeof findOwnPost>> = null;
  let project: Project | null = null;
  for (const p of projects.length ? projects : [null]) {
    found = await findOwnPost(user, link.shortcode, projectAccount(p));
    project = p;
    if (found) break;
  }
  if (!found) return c.json({ own: false });
  const metas: SessionMeta[] = [];
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const meta = await readSession(id);
    if (meta?.owner === user.username && inProject(meta, project?.id)) metas.push(meta);
  }
  const linked = metas.find((m) => postingsOf(m).some((p) => p.shortcode === link.shortcode));
  // a session that already has another post is still offered (linkCandidates explains why)
  const open = linkCandidates(metas, link.shortcode);
  const texts = await Promise.all(
    open.map(async (m) => (await listDocs(m.id)).filter((d) => d.kind !== "notes").flatMap((d) => [...d.blocks.map((b) => b.text), d.caption?.text ?? "", d.pinned?.text ?? ""]).join("\n")),
  );
  const postText = postWords(found.post);
  const { vec, cos } = tfidf([...texts, postText]);
  const pv = vec(postText);
  // the furthest along first among equals: a post is most likely the session that was waiting to be posted
  const stage = ["toPost", "editing", "production", "ready", "writing", "draft", "published"];
  const candidates = open
    .map((m, i) => ({ id: m.id, title: m.title, status: m.status ?? "draft", score: Math.round(cos(vec(texts[i]), pv) * 100) / 100, updatedAt: m.updatedAt }))
    .sort((a, b) => b.score - a.score || stage.indexOf(a.status) - stage.indexOf(b.status) || b.updatedAt - a.updatedAt)
    .slice(0, 12);
  return c.json({
    own: true,
    projectId: project?.id,
    handle: found.handle,
    url: link.url,
    caption: (found.post.item.caption ?? found.post.item.captionPreview ?? "").slice(0, 300),
    linked: linked ? { id: linked.id, title: linked.title } : null,
    candidates,
  });
});

workshopApp.get("/sessions", async (c) => {
  const user = c.get("user");
  // matching sessions to posts reads the account's posts: it runs beside the list, never in front of it
  void linkPosted(user).catch((e) => console.error(`workshop: matching sessions to posts: ${errorMessage(e)}`));
  const scope = c.req.query("projectId") || "";
  const projectId = okId(scope) ? scope : undefined;
  let names: string[] = [];
  try {
    names = await readdir(DIRS.sessions);
  } catch {
    names = [];
  }
  const projects = new Map((await listRecords<Project>(DIRS.projects, user)).map((p) => [p.id, p.name]));
  // whether a share link is on; stopping one deletes it
  const shared = new Set(Object.values(await readShares()).map((s) => s.sessionId));
  const rows = [];
  for (const id of names) {
    const meta = await ownedSession(id, user);
    if (meta && inProject(meta, projectId)) {
      rows.push({ ...sessionRow(meta, meta.projectId ? projects.get(meta.projectId) : undefined), ...(await summaryParts(meta, user.username)), shared: shared.has(meta.id) });
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(rows);
});

/**
 * How much of the AI's text the author kept, by week (lib/workshop/kept.ts): the number that says whether a change to how
 * the writer works helped or hurt. The author's own sessions only.
 */
workshopApp.get("/kept", async (c) => {
  const user = c.get("user");
  const pieces: Array<{ at: number; share: number }> = [];
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const meta = await readSession(id);
    if (!meta || meta.owner !== user.username || !finished(meta)) continue;
    for (const d of await listDocs(id)) {
      const share = keptShare(d);
      if (share !== undefined) pieces.push({ at: meta.createdAt, share });
    }
  }
  return c.json({ about: "Median share of the AI's text left as it was in finished pieces, by the week the session started.", weeks: keptByWeek(pieces) });
});

/**
 * Every session at a glance, for the Workshop sidebar: asked every few seconds, so each session's pieces and chat are read again only when their
 * files changed (their mtimes are the cache key).
 */
const kindsCache = new Map<string, { at: number; kinds: DraftKind[] }>();
const replyCache = new Map<string, { at: number; working: boolean; last?: string; lastAt?: number }>();
/** Ready to post and the done states: nothing waits on you there, so no dot or badge. */
const QUIET_STATUSES: SessionStatus[] = ["toPost", "published", "shelved"];
async function summaryParts(meta: SessionMeta, username: string): Promise<{ kinds: DraftKind[]; working: boolean; ready: boolean; replyAt?: number }> {
  const [docsAt, chatAt] = await Promise.all([stat(docsDir(meta.id)).then((x) => x.mtimeMs, () => 0), stat(chatPath(meta.id)).then((x) => x.mtimeMs, () => 0)]);
  let k = kindsCache.get(meta.id);
  if (!k || k.at !== docsAt) kindsCache.set(meta.id, (k = { at: docsAt, kinds: pieceKinds(await listDocs(meta.id)) }));
  let r = replyCache.get(meta.id);
  if (!r || r.at !== chatAt) {
    const last = [...(await readChat(meta.id)).messages].reverse().find((m) => m.role === "assistant");
    const working = !!last && turnRunning(last);
    // a reply you stopped isn't news; a finished one or a failure is
    const finished = !!last && !working && !(last.status === "error" && last.error === TURN_STOPPED);
    replyCache.set(meta.id, (r = { at: chatAt, working, last: finished ? last.id : undefined, lastAt: finished ? last.at : undefined }));
  }
  const seen = await seenFor(username);
  // replies from before the account's first look at the sidebar count as seen (else every old session lit up at once)
  const fresh = (r.lastAt ?? 0) >= Number(seen._since ?? 0);
  const quiet = QUIET_STATUSES.includes(meta.status ?? "draft");
  return { kinds: k.kinds, working: r.working, ready: !!r.last && fresh && r.last !== seen[meta.id] && !quiet, ...(r.last ? { replyAt: chatAt } : {}) };
}

/** Which reply of each session the author has seen (the sidebar's dot), one small file per account. */
const seenCache = new Map<string, Record<string, string>>();
const seenPath = (username: string) => path.join(WS_ROOT, "seen", `${username.replace(/[^a-z0-9_-]/gi, "_")}.json`);
async function seenFor(username: string): Promise<Record<string, string>> {
  let s = seenCache.get(username);
  if (!s) {
    s = (await readJson<Record<string, string>>(seenPath(username))) ?? {};
    if (!s._since) {
      s._since = String(Date.now());
      await mkdir(path.dirname(seenPath(username)), { recursive: true });
      await writeJsonAtomic(seenPath(username), s);
    }
    seenCache.set(username, s);
  }
  return s;
}

workshopApp.get("/sessions/summary", async (c) => {
  const user = c.get("user");
  // the same project scope as the sessions list
  const scope = c.req.query("projectId") || "";
  const projectId = okId(scope) ? scope : undefined;
  const out = [];
  for (const id of await readdir(DIRS.sessions).catch(() => [] as string[])) {
    const meta = await ownedSession(id, user);
    if (!meta || !inProject(meta, projectId)) continue;
    out.push({ id: meta.id, title: meta.title, status: meta.status ?? "draft", updatedAt: meta.updatedAt, ...(meta.projectId ? { projectId: meta.projectId } : {}), ...(meta.pinned ? { pinned: true } : {}), ...(await summaryParts(meta, user.username)) });
  }
  c.header("Cache-Control", "no-store");
  return c.json(out.sort((a, b) => b.updatedAt - a.updatedAt));
});

/** The author has seen this reply: its dot goes. */
workshopApp.post("/sessions/:id/seen", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { messageId?: unknown } | null;
  if (typeof body?.messageId !== "string" || !okId(body.messageId)) return c.json({ error: "messageId please" }, 400);
  const seen = await seenFor(user.username);
  if (seen[meta.id] !== body.messageId) {
    seen[meta.id] = body.messageId;
    await mkdir(path.dirname(seenPath(user.username)), { recursive: true });
    await writeJsonAtomic(seenPath(user.username), seen);
  }
  return c.json({ ok: true });
});

/** Mark unread (the menu): the session's newest reply shows its Done dot again. */
workshopApp.delete("/sessions/:id/seen", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const seen = await seenFor(user.username);
  if (meta.id in seen) {
    delete seen[meta.id];
    await mkdir(path.dirname(seenPath(user.username)), { recursive: true });
    await writeJsonAtomic(seenPath(user.username), seen);
  }
  return c.json({ ok: true });
});

workshopApp.post("/sessions", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    const input: Record<string, unknown> = { ...(body ?? {}) };
    delete input.sources; // sourceIds below carry the sources for a new session
    const patch = parseSessionPatch(input);
    const now = Date.now();
    const sources = Array.isArray(body?.sourceIds) ? parseSources(body.sourceIds, now) : [];
    const known = new Set((await postsForUser(sources.map((s) => s.postId), user)).map((p) => p.id));
    const projectId = patch.projectId ?? (await resolveProjectId(user));
    const meta: SessionMeta = {
      id: randomUUID(),
      owner: user.username,
      title: patch.title || "Untitled session",
      query: patch.query ?? "",
      status: patch.status ?? "draft",
      ...(projectId ? { projectId } : {}),
      sources: sources.filter((s) => known.has(s.postId)),
      drafts: [],
      createdAt: now,
      updatedAt: now,
    };
    await writeJsonAtomic(sessionMetaPath(meta.id), meta);
    if (patch.notes !== undefined) await writeNotes(meta.id, patch.notes);
    if (meta.sources.length) void transcribeForUser(meta.sources.map((x) => x.postId), user, 0).catch(() => {});
    return c.json(await sessionRecord(meta, user), 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.get("/sessions/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(await sessionRecord(meta, user));
});

workshopApp.patch("/sessions/:id", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  try {
    const patch = parseSessionPatch(await c.req.json().catch(() => null));
    const next = await updateSession(meta.id, (m) => {
      if (patch.title !== undefined) m.title = patch.title || "Untitled session";
      if (patch.query !== undefined) m.query = patch.query;
      if (patch.projectId === null) delete m.projectId;
      else if (patch.projectId) m.projectId = patch.projectId;
      if (patch.status) setSessionStatus(m, patch.status, "session"); // a refused move throws: 409 below
      if (patch.pinned === true) m.pinned = true;
      else if (patch.pinned === false) delete m.pinned;
      const posted = patch.posted;
      if (posted === null && postingsOf(m).length) {
        // "not this post" on all of them: never matched to them again
        m.postedNot = [...new Set([...(m.postedNot ?? []), ...postingsOf(m).map((p) => p.shortcode)])];
        setPostings(m, []);
      } else if (posted && "remove" in posted) {
        // "not this post" on one: never matched to it again
        m.postedNot = [...new Set([...(m.postedNot ?? []), posted.remove])];
        setPostings(m, postingsOf(m).filter((p) => p.shortcode !== posted.remove));
      } else if (posted) {
        // a pasted link: added, or changed in place when it is already one of the session's posts (its version kept unless named)
        const list = postingsOf(m);
        const old = list.find((p) => p.shortcode === posted.shortcode);
        const version = posted.version ?? old?.version;
        const entry: Posting = { shortcode: posted.shortcode, url: posted.url, by: "you", at: Date.now(), ...(version ? { version } : {}) };
        setPostings(m, old ? list.map((p) => (p.shortcode === posted.shortcode ? entry : p)) : [...list, entry]);
        setSessionStatus(m, "published", "posted", { skipIllegal: true }); // a shelved session stays shelved
      }
      if (patch.sources) {
        m.sources = patch.sources;
        const keep = new Set(m.sources.map((x) => x.postId));
        if (m.loaded) m.loaded = m.loaded.filter((l) => keep.has(l.postId));
      }
      if (patch.loaded) delete m.loaded;
      if (patch.ai === null) delete m.ai;
      else if (patch.ai) m.ai = patch.ai;
    }, { touch: patch.notes !== undefined || !!patch.sources });
    if (!next) return c.json({ error: "Not found" }, 404);
    if (patch.notes !== undefined) await writeNotes(meta.id, patch.notes); // after the status check: a refused PATCH writes nothing
    // a video just added starts its transcript now, so it's there by the time a reply reads the folder
    const added = (patch.sources ?? []).map((x) => x.postId).filter((id) => !meta.sources.some((x) => x.postId === id));
    if (added.length) void transcribeForUser(added, user, 0).catch(() => {});
    // a post pasted or shared: checked now, not at the feed's next run (a plug-in answers; see pluginCheckPosted)
    const posted = patch.posted;
    if (posted && "shortcode" in posted) {
      const project = meta.projectId ? await readProject(meta.projectId, user) : null;
      const check = await pluginCheckPosted(user, meta, projectAccount(project), posted);
      if (check) {
        const { guessed, ...result } = check;
        if (result.version) {
          // the version Finals keys it by: the catalog's match, else his named one, else its guess (then the posting says so)
          await updateSession(meta.id, (m) => {
            setPostings(m, postingsOf(m).map((x) => (x.shortcode === posted.shortcode ? { ...x, version: result.version, guessed: guessed ? true : undefined } : x)));
          });
        }
        return c.json({ ...(await sessionRecord((await readSession(meta.id)) ?? meta, user)), check: result });
      }
    }
    return c.json(next);
  } catch (e) {
    if (e instanceof IllegalTransition) return c.json({ error: e.message }, 409);
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.delete("/sessions/:id", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (meta.drafts.some((d) => d.status === "generating")) {
    return c.json({ error: "A draft is still generating — wait for it to finish" }, 409);
  }
  await rm(sessionDir(meta.id), { recursive: true, force: true });
  return c.json({ ok: true });
});

/** The piece a session is about: the first one with text (its title and kind come from it). */
async function mainPiece(sessionId: string): Promise<Document | null> {
  return (await listDocs(sessionId)).find((d) => d.kind !== "notes" && d.blocks.some((b) => b.text.trim())) ?? null;
}

/** Regenerate title (the menu): a new name from the session's main piece, the same way an untitled session gets one. */
workshopApp.post("/sessions/:id/name", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const piece = await mainPiece(meta.id);
  if (!piece) return c.json({ error: "Write the piece first, then name it" }, 400);
  try {
    const title = await nameSession(meta.id, user, piece.id, true);
    if (!title) return c.json({ error: "Write the piece first, then name it" }, 400);
    return c.json({ title });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

/** Duplicate (the menu): same project, sources, pieces and notes under a new id. Not the chat, share links or the post it became. */
workshopApp.post("/sessions/:id/duplicate", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const now = Date.now();
  const copy: SessionMeta = {
    id: randomUUID(),
    owner: user.username,
    title: `${meta.title.trim() || "Untitled session"} copy`,
    query: meta.query,
    // a copy of a finished or shelved session starts as Writing: nothing has been made from the copy yet
    status: meta.status === "published" || meta.status === "shelved" ? "writing" : (meta.status ?? "draft"),
    ...(meta.projectId ? { projectId: meta.projectId } : {}),
    ...(meta.ai ? { ai: meta.ai } : {}),
    sources: meta.sources,
    drafts: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(sessionMetaPath(copy.id), copy);
  await writeNotes(copy.id, await readNotes(meta.id));
  for (const d of await listDocs(meta.id)) await writeDoc({ ...d, sessionId: copy.id });
  // the conversation comes along,
  // with the pictures, files and pasted text it and the pieces point at; a reply still being written stays behind.
  // The Mac's Claude session doesn't: the copy's first turn starts a new one from this history.
  for (const sub of ["images", "files", "pasted"]) {
    await cp(path.join(sessionDir(meta.id), sub), path.join(sessionDir(copy.id), sub), { recursive: true }).catch(() => {});
  }
  const chat = await readChat(meta.id);
  await writeJsonAtomic(chatPath(copy.id), { messages: chat.messages.filter((m) => m.status !== "thinking") });
  return c.json(await sessionRecord(copy, user), 201);
});

workshopApp.get("/sessions/:id/docs", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json((await ensureDocuments(meta)).map(publicDoc));
});

workshopApp.post("/sessions/:id/docs", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  try {
    const input = parseDocCreate(await c.req.json().catch(() => null));
    const doc = newDocument(randomUUID(), meta.id, input.kind, input.title, {
      frameworkIds: input.frameworkIds,
      ruleIds: input.ruleIds,
      text: input.text,
      author: fromAiKey(c) ? "ai" : "user",
    });
    await writeDoc(doc);
    return c.json(publicDoc(doc), 201);
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.get("/sessions/:id/docs/:docId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const doc = await readDoc(meta.id, c.req.param("docId"));
  if (!doc) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(publicDoc(doc));
});

/** One version's text for the "What changed" panel: only the listed ids (all when none is given); gone once the version is pruned. */
workshopApp.get("/sessions/:id/docs/:docId/versions/:versionId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const doc = await readDoc(meta.id, c.req.param("docId"));
  if (!doc) return c.json({ error: "Not found" }, 404);
  const version = doc.versions.find((v) => v.id === c.req.param("versionId"));
  if (!version) return c.json({ error: "gone" }, 404);
  const want = c.req.query("blocks")?.split(",").filter(Boolean).slice(0, 400);
  c.header("Cache-Control", "no-store");
  return c.json({ id: version.id, blocks: fieldsOf(version).filter((f) => !want || want.includes(f.id)) });
});

/** The author's rewrites of the AI's text, kept for good (edit-log.ts): $DATA_DIR/workshop/users/<name>.edits.json. */
const editLogPath = (username: string) => path.join(DIRS.users, `${username}.edits.json`);
const readEditLog = async (username: string) => (await readJson<EditPair[]>(editLogPath(username))) ?? [];
/** The author's rewrites closest to the piece, this project's first: they're the author's taste in every brand, but its own words come first. */
function closestRewrites(near: string, log: EditPair[], projectId: string | undefined, n: number): EditPair[] {
  const here = log.filter((p) => inProject(p, projectId));
  const got = closestPairs(near, here, n);
  return got.length >= n ? got : [...got, ...closestPairs(near, log.filter((p) => !here.includes(p)), n - got.length)];
}
async function keepRewrites(username: string, doc: Document, projectId?: string): Promise<void> {
  const pairs = pairsOf(doc).map((p) => (projectId ? { ...p, projectId } : p));
  if (!pairs.length) return;
  await writeJsonAtomic(editLogPath(username), mergeLog(await readEditLog(username), pairs)).catch((e: unknown) => console.warn(`[workshop] edit log: ${errorMessage(e)}`));
}

workshopApp.patch("/sessions/:id/docs/:docId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  try {
    const raw = await c.req.json().catch(() => null);
    const byKey = fromAiKey(c);
    const current = await readDoc(meta.id, c.req.param("docId"));
    if (!current) return c.json({ error: "Not found" }, 404);
    const patch = parseDocPatch(raw, current.kind);
    const doc = await updateDoc(meta.id, c.req.param("docId"), (d) => {
      if (patch.title !== undefined) d.title = patch.title || d.title;
      if (patch.kind && d.kind !== "notes") d.kind = patch.kind;
      if (patch.frameworkIds) d.frameworkIds = patch.frameworkIds;
      if (patch.ruleIds === null) delete d.ruleIds;
      else if (patch.ruleIds) d.ruleIds = patch.ruleIds;
      if (patch.carouselType === null) delete d.carouselType;
      else if (patch.carouselType) d.carouselType = patch.carouselType;
      if (patch.carouselLayouts === null) delete d.carouselLayouts;
      else if (patch.carouselLayouts) d.carouselLayouts = patch.carouselLayouts;
      if (patch.locked) {
        const ids = patch.locked.filter((id) => d.blocks.some((b) => b.id === id));
        if (ids.length) d.locked = ids;
        else delete d.locked;
      }
      if (patch.captions) {
        // a version's own post description, typed here; "" clears it, so the main one shows again
        const next = { ...(d.captions ?? {}) };
        for (const [key, text] of Object.entries(patch.captions)) {
          if (text.trim()) next[key] = { text, author: byKey ? "ai" : "user", at: Date.now() };
          else delete next[key];
        }
        if (Object.keys(next).length) d.captions = next;
        else delete d.captions;
      }
      if (patch.blocks || patch.caption !== undefined || patch.pinned !== undefined || patch.hooks !== undefined) {
        userEdit(d, patch.blocks ?? d.blocks.map((b) => ({ id: b.id, text: b.text })), Date.now(), {
          caption: patch.caption,
          pinned: patch.pinned,
          ...(patch.hooks !== undefined ? { hooks: patch.hooks } : {}),
        }, byKey ? "ai" : "user");
      }
    });
    if (!doc) return c.json({ error: "Not found" }, 404);
    if (!byKey && (patch.blocks || patch.caption !== undefined || patch.pinned !== undefined || patch.hooks !== undefined)) await keepRewrites(meta.owner, doc, meta.projectId);
    return c.json(publicDoc(doc));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

/** The Finals versions linked to this piece of the session: a post description is written per version. */
workshopApp.get("/sessions/:id/docs/:docId/finals", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  return c.json({ versions: finalsLinkedTo(meta.id, c.req.param("docId"), (await mainPiece(meta.id))?.id) });
});

/** The piece as a turn for one Finals version sees it: that version's own post description as the piece's (a copy). */
function withVersionCaption(doc: Document, key: string): Document {
  const copy: Document = { ...doc };
  const mine = doc.captions?.[key];
  if (mine) copy.caption = { text: mine.text, author: mine.author, at: mine.at };
  else delete copy.caption;
  return copy;
}

/** The Finals versions of the piece with their facts, when `key` is one of them (else no caption version). */
async function captionVersionFor(sessionId: string, docId: string, key: string) {
  const all = finalsLinkedTo(sessionId, docId, (await mainPiece(sessionId))?.id);
  return all.some((v) => v.key === key) ? { current: key, versions: all } : undefined;
}

// ---- Finals pieces linked to a session, for the library grid: the session status, the piece's post description and
// each version's own (keyed by the piece item id). Only the pieces of libraries the caller owns. The grid (FinalsPage)
// reads this at GET /api/library/workshop.
export interface WorkshopFinal {
  description: string;
  versions: Record<string, { text: string; label?: string; author: "ai" | "user" }>;
  sessionId: string;
  status?: SessionStatus;
}

export async function workshopFinalsFor(username: string): Promise<Record<string, WorkshopFinal>> {
  const out: Record<string, WorkshopFinal> = {};
  const rows = libraryDb()
    .prepare("SELECT id, library_id, workshop_session AS session, workshop_doc AS doc FROM pieces WHERE workshop_session IS NOT NULL AND trashed_at IS NULL")
    .all() as { id: string; library_id: string; session: string; doc: string | null }[];
  for (const row of rows) {
    if (libraryRole(username, row.library_id) !== "owner") continue;
    const meta = await readSession(row.session);
    if (!meta) continue;
    const main = await mainPiece(row.session);
    const doc = (row.doc && (await readDoc(row.session, row.doc))) || main;
    const items = libraryDb().prepare("SELECT id, label, post_description FROM piece_items WHERE piece_id = ? ORDER BY position, id").all(row.id) as {
      id: string;
      label: string | null;
      post_description: string | null;
    }[];
    const versions: WorkshopFinal["versions"] = {};
    for (const it of items) {
      const own = doc?.captions?.[it.id];
      const text = it.post_description?.trim() ? it.post_description : own?.text;
      if (text) versions[it.id] = { text, label: it.label ?? own?.label, author: own?.author ?? "user" };
    }
    out[row.id] = { description: doc?.caption?.text ?? "", versions, sessionId: meta.id, status: meta.status };
  }
  return out;
}

/** Mounted under /api/library (boot.ts), so it sits behind the Media Library tool gate. */
export const workshopLibraryApp = new Hono<{ Variables: AuthVars }>();
workshopLibraryApp.get("/workshop", async (c) => c.json({ pieces: await workshopFinalsFor(c.get("user").username) }));

// ---- Finals → Workshop: one AI post description per linked version. Off unless FINALS_AUTO_DESCRIBE=1 (the owner
// approves a sample first); an asked-once ledger (piece_items.describe_asked_at) keeps each version to one turn.
let finalsDescribeTimer: NodeJS.Timeout | undefined;
let finalsDescribeRun: Promise<void> = Promise.resolve();
// the library tells us a piece changed or was linked: in a moment, the versions without a description get one
onEvent("library.changed", () => {
  if (process.env.FINALS_AUTO_DESCRIBE !== "1") return;
  clearTimeout(finalsDescribeTimer);
  finalsDescribeTimer = setTimeout(() => {
    // ponytail: one run at a time, in order; a busy session is retried on the next library change
    finalsDescribeRun = finalsDescribeRun.then(describeLinkedVersions).catch((e) => console.error("[workshop] finals describe", e));
  }, 2000);
  finalsDescribeTimer.unref?.();
});

async function describeLinkedVersions(): Promise<void> {
  const links = libraryDb()
    .prepare("SELECT DISTINCT workshop_session AS session, workshop_doc AS doc FROM pieces WHERE workshop_session IS NOT NULL AND trashed_at IS NULL")
    .all() as { session: string; doc: string | null }[];
  const seen = new Set<string>();
  for (const link of links) {
    const meta = await readSession(link.session);
    const owner = meta ? findUser(meta.owner) : null;
    const main = await mainPiece(link.session);
    const piece = (link.doc && (await readDoc(link.session, link.doc))) || main;
    if (!meta || !owner || !piece) continue;
    for (const v of finalsLinkedTo(meta.id, piece.id, main?.id)) {
      if (seen.has(v.key)) continue;
      seen.add(v.key);
      const now = (await readDoc(meta.id, piece.id)) ?? piece;
      const asked = libraryDb().prepare("SELECT describe_asked_at AS t FROM piece_items WHERE id = ?").get(v.key) as { t: number | null } | undefined;
      if (now.captions?.[v.key]?.text || asked?.t) continue;
      // the session is busy with another turn: stop here, the next library change tries again
      if (!(await describeVersion(meta, owner, now, v, finalsLinkedTo(meta.id, piece.id, main?.id)))) break;
      libraryDb().prepare("UPDATE piece_items SET describe_asked_at = ? WHERE id = ?").run(Date.now(), v.key);
    }
  }
}

/** One Finals version's post description written as a turn on the session's piece, the way a person asks for it in the
 *  chat: the request says which version and what each version is (mechanical facts), no writing instructions. Its message
 *  is marked `auto`. False when the session is busy with another turn. */
async function describeVersion(
  meta: SessionMeta,
  owner: UserRecord,
  piece: Document,
  v: { key: string; label: string },
  all: Array<{ key: string; label: string; facts: string }>,
): Promise<boolean> {
  const text = [`Write the post description for version ${v.label} in Finals.`, "", "The versions in Finals:", ...all.map((x) => `- ${x.label}: ${x.facts}`)].join("\n");
  const now = Date.now();
  const ask: ChatMessage = { id: randomUUID(), role: "user", text, at: now, docId: piece.id, captionFor: v.key, auto: true, status: "done" };
  const reply: ChatMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, docId: piece.id, status: "thinking" };
  if (!(await startTurn(meta.id, [ask, reply]))) return false;
  await runTurn(meta, sessionOf(owner), ask, reply.id);
  return true;
}

/** Link a Media Library Finals piece to this session (Finals' "Workshop session" link). The account must own both. */
workshopApp.post("/sessions/:id/finals", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { pieceId?: unknown; docId?: unknown } | null;
  if (typeof body?.pieceId !== "string" || !body.pieceId) return c.json({ error: "Send the Finals piece's id" }, 400);
  const docId = typeof body.docId === "string" ? body.docId : undefined;
  if (docId && !(await readDoc(meta.id, docId))) return c.json({ error: "No such piece of this session" }, 404);
  return linkFinalsPiece(body.pieceId, meta.id, docId, user.username) ? c.json({ linked: true }) : c.json({ error: "No such Finals piece of yours" }, 404);
});

workshopApp.post("/sessions/:id/docs/:docId/layouts", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const current = await readDoc(meta.id, c.req.param("docId"));
  if (!current) return c.json({ error: "Not found" }, 404);
  if (current.kind !== "carousel") return c.json({ error: "Layouts are for carousels" }, 400);
  const req = parseLayoutRequest(await c.req.json().catch(() => null));
  const typeId = req.typeId ?? current.carouselType;
  const type = resolveCarouselType(typeId);
  const n = current.blocks.length;
  if (n < 1) return c.json({ error: "Write slides first" }, 400);
  const hash = layoutSourceHash(type.id, current.blocks.map((b) => b.text));
  const cached = current.carouselLayouts?.hash === hash ? (current.carouselLayouts as CarouselLayoutSet) : undefined;

  if (req.pick !== undefined && !req.regenerate && req.slide == null) {
    if (!cached) return c.json({ error: "Generate layouts first" }, 400);
    const pick = Math.min(req.pick, cached.variants.length - 1);
    const doc = await updateDoc(meta.id, current.id, (d) => {
      if (req.typeId) d.carouselType = req.typeId;
      if (d.carouselLayouts?.hash === hash) d.carouselLayouts = { ...d.carouselLayouts, pick };
    });
    if (!doc) return c.json({ error: "Not found" }, 404);
    return c.json(publicDoc(doc));
  }

  if (cached && !req.regenerate && req.slide == null) {
    return c.json(publicDoc(current));
  }

  if (!aiOn(user)) return c.json({ error: "AI is not configured" }, 400);

  const fallback: SlideCompose[] = visualizeCarousel({
    typeId: type.id,
    blocks: current.blocks.map((b) => ({ id: b.id, text: b.text })),
    caption: "x",
  })
    .slides.filter((s) => !s.ghost)
    .map((s) => ({ layout: s.layout, well: s.well ?? "none" }));

  const shapes = (
    await Promise.all(current.frameworkIds.map((id) => readFramework(id, user)))
  )
    .filter((f): f is Framework => !!f)
    .map((f) => f.name);

  try {
    let next: CarouselLayoutSet;
    let usage: MacUsage | undefined;
    if (req.slide && cached) {
      const slide = Math.min(req.slide, n);
      const currentRow = cached.variants[cached.pick] ?? fallback;
      const { system, user: userMsg } = buildLayoutPrompt({
        typeId: type.id,
        shapes,
        slides: current.blocks,
        slide,
        current: coerceCompose(currentRow, n, fallback, type.id),
      });
      const picked = await completeWithFallback(
        system,
        userMsg,
        undefined,
        (t) => parseOneCompose(t, fallback[slide - 1] ?? { layout: "teaching", well: "none" }, type.id, n, slide - 1),
        { ...workshopAi(user, meta.ai), onUsage: (u) => (usage = sumUsage(usage, u)) },
      );
      const variants = cached.variants.map((row) => coerceCompose(row, n, fallback, type.id));
      const pick = Math.min(cached.pick, variants.length - 1);
      const row = [...(variants[pick] ?? fallback)];
      row[slide - 1] = picked;
      variants[pick] = coerceCompose(row, n, fallback, type.id);
      next = { hash, pick, variants, usage };
    } else {
      const { system, user: userMsg } = buildLayoutPrompt({
        typeId: type.id,
        shapes,
        slides: current.blocks,
      });
      const variants = await completeWithFallback(
        system,
        userMsg,
        undefined,
        (t) => parseLayoutVariants(t, n, fallback, type.id),
        { ...workshopAi(user, meta.ai), onUsage: (u) => (usage = sumUsage(usage, u)) },
      );
      next = { hash, pick: 0, variants, usage };
    }
    const doc = await updateDoc(meta.id, current.id, (d) => {
      if (req.typeId) d.carouselType = req.typeId;
      d.carouselLayouts = next;
    });
    if (!doc) return c.json({ error: "Not found" }, 404);
    bumpUsage(user.username, { aiRuns: 1 });
    return c.json(publicDoc(doc));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

workshopApp.post("/sessions/:id/docs/:docId/revert", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { versionId?: unknown } | null;
  const versionId = typeof body?.versionId === "string" && /^v\d{1,5}$/.test(body.versionId) ? body.versionId : "";
  if (!versionId) return c.json({ error: "Which version?" }, 400);
  let ok = false;
  const doc = await updateDoc(meta.id, c.req.param("docId"), (d) => {
    ok = revert(d, versionId);
  });
  if (!doc) return c.json({ error: "Not found" }, 404);
  if (!ok) return c.json({ error: "That version is gone" }, 404);
  return c.json(publicDoc(doc));
});

workshopApp.post("/sessions/:id/docs/:docId/keep", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { name?: unknown; versionId?: unknown; kept?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const versionId = typeof body?.versionId === "string" && /^v\d{1,5}$/.test(body.versionId) ? body.versionId : "";
  const kept = body?.kept !== false;
  let ok = false;
  const doc = await updateDoc(meta.id, c.req.param("docId"), (d) => {
    if (d.kind === "notes") return;
    if (versionId) ok = setVersionKept(d, versionId, kept, name || undefined);
    else if (kept) ok = !!keep(d, name);
  });
  if (!doc) return c.json({ error: "Not found" }, 404);
  if (doc.kind === "notes") return c.json({ error: "Notes has no versions" }, 400);
  if (!ok) return c.json({ error: versionId ? "That version is gone" : "Nothing to keep" }, 404);
  return c.json(publicDoc(doc));
});

workshopApp.delete("/sessions/:id/docs/:docId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const doc = await readDoc(meta.id, c.req.param("docId"));
  if (!doc) return c.json({ error: "Not found" }, 404);
  if (doc.kind === "notes") return c.json({ error: "Notes stay with the session" }, 400);
  await rm(trashPath(meta.id, doc.id), { force: true });
  await rename(docPath(meta.id, doc.id), trashPath(meta.id, doc.id));
  return c.json({ ok: true });
});

workshopApp.post("/sessions/:id/docs/:docId/restore", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const id = c.req.param("docId");
  try {
    await rename(trashPath(meta.id, id), docPath(meta.id, id));
  } catch {
    return c.json({ error: "Nothing to restore" }, 404);
  }
  const doc = await readDoc(meta.id, id);
  if (!doc) return c.json({ error: "Nothing to restore" }, 404);
  return c.json(publicDoc(doc));
});

workshopApp.get("/sessions/:id/docs/:docId/export.md", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const doc = await readDoc(meta.id, c.req.param("docId"));
  if (!doc) return c.json({ error: "Not found" }, 404);
  const project = meta.projectId ? await readProject(meta.projectId, user) : null;
  const title = exportStem(project?.name, doc.kind, doc.title);
  const cards = doc.kind === "carousel" ? doc.blocks.filter((b) => b.text.trim()).length : 0;
  const prefix = doc.kind === "carousel" ? cardsFrontmatter(cards) : "";
  return new Response(`${prefix}# ${title}\n\n${pieceMarkdown(doc, { frontmatter: false })}`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(project?.name, doc.kind, doc.title)}"`,
      "Cache-Control": "no-store",
    },
  });
});

workshopApp.get("/sessions/:id/chat", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json((await readChat(meta.id)).messages);
});

/** The running reply's words as they arrive (server-sent events); 204 when it isn't running here. */
workshopApp.get("/sessions/:id/chat/:messageId/live", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const id = c.req.param("messageId");
  if (!chatting.has(id)) return c.body(null, 204); // 204 tells the browser not to reconnect
  c.header("Cache-Control", "no-store");
  c.header("X-Accel-Buffering", "no"); // nginx passes each event on at once
  return streamSSE(c, async (stream) => {
    await new Promise<void>((done) => {
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000); // proxies close a quiet line
      const stop = () => {
        clearInterval(ping);
        off();
        done();
      };
      const off = listen(id, (e) => {
        if ("end" in e) return void stream.writeSSE({ event: "end", data: "" }).finally(stop);
        void stream.writeSSE({ data: JSON.stringify({ text: e.text }) });
      });
      stream.onAbort(stop);
      if (!chatting.has(id)) stop();
    });
  });
});

workshopApp.post("/sessions/:id/chat", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!aiOn(user)) return c.json({ error: "AI is not configured" }, 400);
  let input;
  try {
    input = parseTurnInput(await c.req.json().catch(() => null));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
  if (!(await readDoc(meta.id, input.docId))) return c.json({ error: "That document is gone" }, 404);
  const library: ClipRef[] = [];
  for (const r of input.library ?? []) {
    const ref = "assetId" in r ? await libraryRef(user.username, r.assetId, r.versionId) : await externalLibraryRef(user.username, r);
    if (!ref) return c.json({ error: "A library clip is gone, or not in your library" }, 404);
    library.push(ref);
  }
  await readChat(meta.id); // a reply a restart left thinking is marked first; the one-turn check is in startTurn
  const pasted: PastedRef[] = [];
  for (const r of input.pastedRefs ?? []) {
    if (await readFile(pastedPath(meta.id, r.id), "utf-8").then(() => true, () => false)) pasted.push(r);
  }
  for (const p of input.pasted ?? []) {
    const id = randomUUID();
    await mkdir(path.dirname(pastedPath(meta.id, id)), { recursive: true });
    await writeFile(pastedPath(meta.id, id), p.text);
    pasted.push({ id, name: p.name, chars: p.text.length });
  }
  const images: ImageRef[] = [];
  for (const r of input.imageRefs ?? []) {
    if (await stat(imagePath(meta.id, r)).then(() => true, () => false)) images.push(r);
  }
  for (const im of input.images ?? []) {
    const ref: ImageRef = { id: randomUUID(), name: im.name, type: im.type };
    await mkdir(path.dirname(imagePath(meta.id, ref)), { recursive: true });
    await writeFile(imagePath(meta.id, ref), Buffer.from(im.data, "base64"));
    images.push(ref);
  }
  const files: FileRef[] = [];
  for (const r of input.fileRefs ?? []) {
    if (await stat(filePath(meta.id, r)).then(() => true, () => false)) files.push(r);
  }
  for (const f of input.files ?? []) {
    const ref: FileRef = { id: randomUUID(), name: f.name, type: f.type, bytes: Buffer.from(f.data, "base64").length };
    await mkdir(path.dirname(filePath(meta.id, ref)), { recursive: true });
    await writeFile(filePath(meta.id, ref), Buffer.from(f.data, "base64"));
    files.push(ref);
  }
  const now = Date.now();
  const ask: ChatMessage = {
    id: randomUUID(),
    role: "user",
    text: input.text,
    at: now,
    docId: input.docId,
    context: input.context?.length ? input.context : undefined,
    reading: input.reading,
    deep: input.deep || undefined,
    comments: input.comments || undefined,
    mine: input.mine || undefined,
    scope: input.scope,
    quotes: input.quotes,
    pasted: pasted.length ? pasted : undefined,
    images: images.length ? images : undefined,
    files: files.length ? files : undefined,
    library: library.length ? library : undefined,
    web: input.web,
    captionFor: input.captionFor,
    status: "done",
  };
  const reply: ChatMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, docId: input.docId, status: "thinking" };
  if (!(await startTurn(meta.id, [ask, reply], input.retryOf))) return c.json({ error: "Still thinking about the last message — wait for it" }, 409);
  void runTurn(meta, user, ask, reply.id);
  return c.json({ ask, reply }, 202);
});

/** Stop a running reply: its turn ends as "Stopped" with partial edits undone, and nothing is re-run on the API key. */
workshopApp.post("/sessions/:id/chat/:messageId/stop", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const id = c.req.param("messageId");
  const running = (await readChat(meta.id)).messages.some((m) => m.id === id && turnRunning(m));
  const stop = running ? stops.get(id) : undefined;
  if (!stop) return c.json({ error: "Nothing is running for that message" }, 404);
  stop.abort();
  return c.json({ ok: true });
});

/** Put an audit on the chat and start it. Returns the two messages, or why it could not start. */
async function beginAudit(meta: SessionMeta, user: SessionUser, input: AuditInput): Promise<{ ask: ChatMessage; reply: ChatMessage } | { error: string; status: 400 | 404 | 409 }> {
  if (!researchFor(user)) return { error: RESEARCH_OFF, status: 400 };
  const doc = await readDoc(meta.id, input.docId);
  if (!doc) return { error: "That document is gone", status: 404 };
  let target: AuditTarget;
  if (input.postId) {
    const post = (await postsForUser([input.postId], user))[0];
    if (!post) return { error: "That source is gone", status: 404 };
    target = { type: "post", id: post.id, title: `@${post.creator.username} — ${post.kind}` };
  } else {
    if (!doc.blocks.length) return { error: "The document is empty — nothing to check", status: 400 };
    target = { type: "document", id: doc.id, title: doc.title };
  }
  await readChat(meta.id);
  const now = Date.now();
  const ask: ChatMessage = {
    id: randomUUID(),
    role: "user",
    text: `Check the accuracy of ${target.type === "document" ? `“${target.title}”` : target.title}${input.depth === "deep" ? " — deep research" : ""}.`,
    at: now,
    docId: input.docId,
    status: "done",
  };
  const reply: ChatMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, docId: input.docId, status: "thinking", audit: { target, depth: input.depth } };
  if (!(await startTurn(meta.id, [ask, reply]))) return { error: "Still working on the last message — wait for it", status: 409 };
  void runAudit(meta, user, reply.id, input, target);
  return { ask, reply };
}

workshopApp.post("/sessions/:id/audits", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  let input: AuditInput;
  try {
    input = parseAuditInput(await c.req.json().catch(() => null));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
  const r = await beginAudit(meta, user, input);
  if ("error" in r) return c.json({ error: r.error }, r.status);
  return c.json(r, 202);
});

/** A picture sent with a message (the tiles on it show it). */
workshopApp.get("/sessions/:id/images/:iid", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  const iid = c.req.param("iid");
  if (!meta || !okId(iid)) return c.json({ error: "Not found" }, 404);
  const im = (await readChat(meta.id)).messages.flatMap((m) => m.images ?? []).find((x) => x.id === iid) ?? (await pieceImage(meta.id, iid));
  if (!im) return c.json({ error: "Not found" }, 404);
  return sendFile(c, imagePath(meta.id, im), im.type);
});

/** A picture for a piece: the editor's Add picture, a paste or a drop. Stored with the session's pictures; the piece's text holds its URL. */
workshopApp.post("/sessions/:id/media", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  let up: ReturnType<typeof parsePictureUpload>;
  try {
    up = parsePictureUpload(await c.req.json().catch(() => null));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
  // a short id: the script shows it as pic:<id>
  let id = randomUUID().slice(0, 8);
  while (await pieceImage(meta.id, id)) id = randomUUID().slice(0, 8);
  const ref: ImageRef = { id, name: up.name, type: up.type };
  await mkdir(path.dirname(imagePath(meta.id, ref)), { recursive: true });
  await writeFile(imagePath(meta.id, ref), up.bytes);
  return c.json(ref, 201);
});

/** A pasted attachment, as text (the chip on a sent message opens it). */
workshopApp.get("/sessions/:id/pasted/:pid", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  const pid = c.req.param("pid");
  if (!meta || !okId(pid)) return c.json({ error: "Not found" }, 404);
  const text = await readFile(pastedPath(meta.id, pid), "utf-8").catch(() => null);
  if (text === null) return c.json({ error: "Not found" }, 404);
  return c.text(text);
});

/** "Other ways to say this": three versions of the words the author selected on one slide; nothing else changes. */
workshopApp.post("/sessions/:id/docs/:docId/lines", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const doc = await readDoc(meta.id, c.req.param("docId"));
  if (!doc || doc.kind === "notes") return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { blockId?: unknown; text?: unknown; start?: unknown; end?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.slice(0, LIMITS.blockText) : "";
  const start = typeof body?.start === "number" ? Math.max(0, Math.floor(body.start)) : -1;
  const end = typeof body?.end === "number" ? Math.min(text.length, Math.floor(body.end)) : -1;
  if (start < 0 || end <= start || !text.slice(start, end).trim()) return c.json({ error: "Select the words you want said another way" }, 400);
  if (!aiOn(user)) return c.json({ error: "AI is not configured on the server" }, 503);
  const notes = (await readChat(meta.id)).messages.filter((m) => m.docId === doc.id && m.role === "user" && m.text.trim()).map((m) => m.text.trim());
  const { system, user: prompt } = buildLinesPrompt({ doc, blockId: typeof body?.blockId === "string" ? body.blockId : undefined, text, start, end, notes });
  try {
    let usage: MacUsage | undefined;
    const options = await completeWithFallback(system, prompt, undefined, parseLines, { ...workshopAi(user, meta.ai), onUsage: (u) => (usage = sumUsage(usage, u)) });
    bumpUsage(user.username, { aiRuns: 1 });
    return c.json({ options, usage });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

/** "Ask about this": a side chat about one slide or a selection; it only answers, nothing is edited or added to the chat. */
workshopApp.post("/sessions/:id/docs/:docId/ask", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const doc = await readDoc(meta.id, c.req.param("docId"));
  if (!doc || doc.kind === "notes") return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = typeof body?.text === "string" ? body.text.slice(0, LIMITS.blockText) : "";
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, LIMITS.turnText) : "";
  if (!text.trim() || !question) return c.json({ error: "Ask something about the slide" }, 400);
  if (!aiOn(user)) return c.json({ error: "AI is not configured on the server" }, 503);
  const start = typeof body?.start === "number" ? Math.max(0, Math.floor(body.start)) : undefined;
  const end = typeof body?.end === "number" ? Math.min(text.length, Math.floor(body.end)) : undefined;
  const history = (Array.isArray(body?.history) ? body!.history : [])
    .filter((m): m is { role: "user" | "assistant"; text: string } => !!m && typeof m === "object" && ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") && typeof (m as { text?: unknown }).text === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
  const project = await projectForAi(meta.projectId, user);
  const { best } = await bestPosts(user, project, 10);
  const { system, user: prompt } = buildAsidePrompt({ doc, blockId: typeof body?.blockId === "string" ? body.blockId : undefined, text, start, end, question, history, best });
  try {
    let usage: MacUsage | undefined;
    const answer = await completeWithFallback(system, prompt, undefined, (t) => {
      if (!t.trim()) throw new Error("Empty answer");
      return t.trim();
    }, { ...workshopAi(user, meta.ai), onUsage: (u) => (usage = sumUsage(usage, u)) });
    bumpUsage(user.username, { aiRuns: 1 });
    return c.json({ answer, usage });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

/** "Read as a follower": the author asks for another model's read of the open piece. */
workshopApp.post("/sessions/:id/reviews", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { docId?: unknown } | null;
  const doc = typeof body?.docId === "string" ? await readDoc(meta.id, body.docId) : null;
  if (!doc || doc.kind === "notes" || !doc.blocks.length) return c.json({ error: "Open a piece with some text first" }, 400);
  if (!onMac(user)) return c.json({ error: "A follower's read runs on Claude Fable through your AI on the Mac" }, 503);
  await readChat(meta.id);
  const now = Date.now();
  const ask: ChatMessage = { id: randomUUID(), role: "user", text: "Read it as a follower would.", at: now, docId: doc.id, status: "done" };
  const reply: ChatMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, docId: doc.id, status: "thinking", stage: "thinking", provider: "Claude Fable (Mac)", review: { model: REVIEW_MODEL } };
  if (!(await startTurn(meta.id, [ask, reply]))) return c.json({ error: "Still working on the last message — wait for it" }, 409);
  void runReview(meta, user, reply.id, doc.id);
  return c.json({ ask, reply }, 202);
});

/** The author answers a proposal the model made: run the audit / deep research, or decline. */
workshopApp.post("/sessions/:id/chat/:messageId/proposal", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const chat = await readChat(meta.id);
  const m = chat.messages.find((x) => x.id === c.req.param("messageId"));
  if (!m?.proposal) return c.json({ error: "No such proposal" }, 404);
  const body = (await c.req.json().catch(() => null)) as { action?: unknown; depth?: unknown; question?: unknown } | null;
  const action = body?.action === "accept" ? "accept" : body?.action === "decline" ? "decline" : null;
  if (!action) return c.json({ error: "accept or decline?" }, 400);
  if (m.proposal.status !== "open") return c.json({ error: "Already answered" }, 409);
  const depth: "quick" | "deep" = body?.depth === "deep" ? "deep" : body?.depth === "quick" ? "quick" : m.proposal.depth;
  const settle = async (status: Proposal["status"]) => {
    const proposal: Proposal = { ...m.proposal!, status, depth };
    await patchMessage(meta.id, m.id, { proposal });
    return { ...m, proposal };
  };
  if (action === "decline") return c.json({ message: await settle("declined") });
  if (m.proposal.kind === "audit") {
    const r = await beginAudit(meta, user, { docId: m.docId, depth });
    if ("error" in r) return c.json({ error: r.error }, r.status);
    return c.json({ message: await settle("accepted"), ...r }, 202);
  }
  if (!researchFor(user)) return c.json({ error: RESEARCH_OFF }, 400);
  const edited = typeof body?.question === "string" ? body.question.trim().slice(0, 600) : "";
  const question = edited || m.proposal.question || "";
  if (!question) return c.json({ error: "The proposal has no question" }, 400);
  const now = Date.now();
  if (depth === "quick") {
    // a quick search the author approved: the next turn searches for it and answers with what it found
    const ask: ChatMessage = { id: randomUUID(), role: "user", text: `Search the web: ${question}`, at: now, docId: m.docId, status: "done", web: question };
    const reply: ChatMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, docId: m.docId, status: "thinking" };
    if (!(await startTurn(meta.id, [ask, reply]))) return c.json({ error: "Still working on the last message — wait for it" }, 409);
    void runTurn(meta, user, ask, reply.id);
    const proposal: Proposal = { ...m.proposal, status: "accepted", depth, question };
    await patchMessage(meta.id, m.id, { proposal });
    return c.json({ message: { ...m, proposal }, ask, reply }, 202);
  }
  const ask: ChatMessage = { id: randomUUID(), role: "user", text: `Run deep research: ${question}`, at: now, docId: m.docId, status: "done" };
  const reply: ChatMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, docId: m.docId, status: "thinking", research: { question, depth: "deep", status: "running" } };
  if (!(await startTurn(meta.id, [ask, reply]))) return c.json({ error: "Still working on the last message — wait for it" }, 409);
  void runResearch(meta, user, reply.id, question);
  return c.json({ message: await settle("accepted"), ask, reply }, 202);
});

workshopApp.post("/sessions/:id/chat/:messageId/apply-fix", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const chat = await readChat(meta.id);
  const m = chat.messages.find((x) => x.id === c.req.param("messageId"));
  const body = (await c.req.json().catch(() => null)) as { claimId?: unknown } | null;
  const claim = m?.audit?.result?.claims.find((x) => x.id === body?.claimId);
  if (!m?.audit || !claim) return c.json({ error: "No such claim" }, 404);
  if (m.audit.target.type !== "document" || !claim.fix || !claim.where || !/^(b\d{1,5}|h\d{1,5}|caption|pinned)$/.test(claim.where)) {
    return c.json({ error: "This claim has no fix that maps to a block" }, 400);
  }
  if (chat.messages.some((x) => x.status === "thinking")) return c.json({ error: "Still working on the last message — wait for it" }, 409);
  let applied = false;
  let locked = false;
  const doc = await updateDoc(meta.id, m.audit.target.id, (d) => {
    const { ops } = auditEdits(d, [claim]);
    if (!ops.length) return;
    // a fix the lock refuses changes nothing: it is tried on a copy first, so no version is left behind
    const trial = applyEdits(structuredClone(d), ops);
    locked = trial.skipped.some((x) => x.reason === "locked");
    if (!trial.blockIds.length) return;
    if (!d.headVersion) snapshot(d, `${d.dirty ? "your edits " : ""}before: audit fix`);
    const r = applyEdits(d, ops);
    if (r.blockIds.length) {
      snapshot(d, `after: audit fix — ${claim.claim.slice(0, 60)}`);
      applied = true;
    }
  });
  if (!doc) return c.json({ error: "That document is gone" }, 404);
  if (!applied) return c.json({ error: locked ? lockedNote([slideOf(doc, claim.where!)]) : "That wording is no longer in the document" }, 400);
  const audit: AuditMeta = { ...m.audit, applied: [...(m.audit.applied ?? []), claim.id] };
  await patchMessage(meta.id, m.id, { audit });
  return c.json({ doc: publicDoc(doc), messageId: m.id, claimId: claim.id });
});

workshopApp.post("/sessions/:id/chat/:messageId/apply-fixes", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const chat = await readChat(meta.id);
  const m = chat.messages.find((x) => x.id === c.req.param("messageId"));
  const body = (await c.req.json().catch(() => null)) as { claimIds?: unknown } | null;
  const ids = Array.isArray(body?.claimIds) ? body.claimIds.filter((x): x is string => typeof x === "string") : [];
  if (!m?.audit?.result) return c.json({ error: "No such audit" }, 404);
  if (m.audit.target.type !== "document") return c.json({ error: "This claim has no fix that maps to a block" }, 400);
  if (chat.messages.some((x) => x.status === "thinking")) return c.json({ error: "Still working on the last message — wait for it" }, 409);
  const already = new Set(m.audit.applied ?? []);
  const wanted = m.audit.result.claims.filter((claim) => ids.includes(claim.id) && !already.has(claim.id) && claim.fix && claim.where && /^(b\d{1,5}|h\d{1,5}|caption|pinned)$/.test(claim.where));
  if (!wanted.length) return c.json({ error: "Nothing to apply" }, 400);
  let appliedIds: string[] = [];
  let lockedBlocks: string[] = [];
  const doc = await updateDoc(meta.id, m.audit.target.id, (d) => {
    const { ops, appliedIds: found } = auditEdits(d, wanted);
    if (!ops.length) return;
    if (!d.headVersion) snapshot(d, `${d.dirty ? "your edits " : ""}before: audit`);
    const r = applyEdits(d, ops);
    // a field is one op, so its claims land together, or a lock refuses them together
    const landed = new Set(r.blockIds);
    const whereOf = new Map(wanted.map((c) => [c.id, c.where ?? ""]));
    lockedBlocks = r.skipped.flatMap((x) => (x.reason === "locked" && "id" in x.op ? [x.op.id] : []));
    appliedIds = found.filter((id) => landed.has(whereOf.get(id) ?? ""));
    if (appliedIds.length) snapshot(d, `after: audit — ${appliedIds.length} ${appliedIds.length === 1 ? "fix" : "fixes"}`);
  });
  if (!doc) return c.json({ error: "That document is gone" }, 404);
  const locked = lockedBlocks.map((b) => slideOf(doc, b));
  if (!appliedIds.length) return c.json({ error: locked.length ? lockedNote(locked) : "Those wordings are no longer in the document" }, 400);
  const applied = [...(m.audit.applied ?? []), ...appliedIds];
  await patchMessage(meta.id, m.id, { audit: { ...m.audit, applied } });
  return c.json({ doc: publicDoc(doc), messageId: m.id, applied, locked });
});

workshopApp.delete("/sessions/:id/chat/:messageId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const id = c.req.param("messageId");
  if (chatting.has(id)) return c.json({ error: "Still thinking" }, 409);
  await updateChat(meta.id, (ch) => {
    ch.messages = ch.messages.filter((m) => m.id !== id);
  });
  return c.json({ ok: true });
});

workshopApp.get("/sessions/:id/export.md", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const posts = new Map((await postsForUser(meta.sources.map((s) => s.postId), user)).map((p) => [p.id, p]));
  const sources = meta.sources.flatMap((s) => {
    const p = posts.get(s.postId);
    return p ? [{ handle: p.creator.username, kind: p.kind, url: p.url, note: s.note }] : [];
  });
  const drafts = [];
  for (const draft of meta.drafts) {
    if (draft.status !== "ready") continue;
    const markdown = await readDraftMarkdown(meta.id, draft.id);
    if (markdown) drafts.push({ draft, markdown });
  }
  const docs = await listDocs(meta.id);
  const notesDoc = docs.find((d) => d.kind === "notes");
  const notes = notesDoc ? docToMarkdown(notesDoc).trim() : await readNotes(meta.id);
  const project = await projectForAi(meta.projectId, user);
  const working = docs.filter((d) => d.kind !== "notes" && d.blocks.length);
  const primary = working[0];
  const heading = primary ? exportStem(project?.name, primary.kind, meta.title) : meta.title || "Workshop session";
  let body = buildExportMarkdown({ ...meta, title: heading }, notes, sources, drafts);
  if (working.length) {
    body += `\n## Documents\n\n${working
      .map((d) => `### ${d.title} — ${d.kind}\n\n${demoteHeadings(demoteHeadings(pieceMarkdown(d, { frontmatter: false }).trim()))}`)
      .join("\n\n")}\n`;
  }
  const carousel = working.find((d) => d.kind === "carousel");
  if (carousel) {
    const n = carousel.blocks.filter((b) => b.text.trim()).length;
    body = `${cardsFrontmatter(n)}${body}`;
  }
  const filename = exportFilename(project?.name, primary?.kind ?? "notes", meta.title);
  // exporting hands the piece on, like sharing
  const status = working.length ? await sharedForProduction(meta) : (meta.status ?? "draft");
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Session-Status": status,
    },
  });
});

/** The reel as an Obsidian script note (`day` = the owner's local date, YYYY-MM-DD). */
workshopApp.get("/sessions/:id/obsidian.md", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const q = c.req.query("day") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
  const docs = await listDocs(meta.id);
  // one note per piece (reel, carousel): `part` picks one; without it, a session with several says how many
  const types = await pieceTypes(meta.id, docs);
  if (!obsidianExports(meta, docs, day, types).length) return c.json({ error: "This session has no reel or carousel with words yet" }, 400);
  // the note says what a share would make it (In Production, not the Ready it had in the Workshop); this read shows
  // that without moving the session: the share route does the move
  const stored = meta.status ?? "draft";
  const status: SessionStatus = ["draft", "writing", "ready"].includes(stored) ? "production" : stored;
  const notes = obsidianExports({ ...meta, status }, docs, day, types);
  const part = Number(c.req.query("part") ?? (notes.length > 1 ? NaN : 0));
  if (!Number.isInteger(part)) return c.json({ parts: notes.map((n) => n.filename) });
  const out = notes[part];
  if (!out) return c.json({ error: "No such piece" }, 404);
  const headers = { "Cache-Control": "no-store", "X-Session-Status": status };
  if (!out.pictures.length) {
    return new Response(out.markdown, { headers: { ...headers, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": attachment(out.filename) } });
  }
  // with pictures: a zip holding one folder, the note and each picture inside it; the embeds point at those names
  const zip = new ZipFile();
  const dir = `${out.filename.replace(/\.md$/, "")}/`;
  zip.addBuffer(Buffer.from(out.markdown, "utf8"), dir + out.filename);
  for (const p of out.pictures) zip.addFile(imagePath(meta.id, { id: p.id, type: p.type }), dir + p.file);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  const name = out.filename.replace(/\.md$/, ".zip");
  return new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { ...headers, "Content-Type": "application/zip", "Content-Disposition": attachment(name) } });
});

/* ---- Obsidian notes (the plugin's sync) and custom exports: the pure parts are in lib/workshop/notes.ts ---- */

const EXPORTS_DIR = path.join(WS_ROOT, "exports");
const PENDING_DIR = path.join(WS_ROOT, "exports-pending");
const exportsFile = (username: string) => path.join(EXPORTS_DIR, `${username}.json`);
const pendingFile = (username: string) => path.join(PENDING_DIR, `${username}.json`);

/** The account's own sessions: a note belongs to its owner, admins included. ponytail: each note's PUT reads every session, add a path index when a vault gets big. */
async function ownSessions(username: string): Promise<SessionMeta[]> {
  let names: string[] = [];
  try {
    names = await readdir(DIRS.sessions);
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const id of names) {
    const meta = await readSession(id);
    if (meta?.owner === username) out.push(meta);
  }
  return out;
}

const storedExports = async (username: string): Promise<WorkshopExport[]> => (await readJson<WorkshopExport[]>(exportsFile(username))) ?? [];
const pendingList = async (username: string): Promise<PendingExport[]> => (await readJson<PendingExport[]>(pendingFile(username))) ?? [];

/** The placeholders a custom export's name and template can use; `title` is the note's name, as the built-in names it. */
function exportVars(piece: ObsidianPiece, status: SessionStatus, day: string): Record<string, string> {
  return {
    title: piece.filename.replace(/\.md$/, ""),
    status: obsidianStatus(status),
    media: piece.media,
    body: piece.body.trim(),
    frontmatter: piece.frontmatter,
    caption: piece.caption,
    date: day,
  };
}

/** A session made from a note: its piece is the note's body, from then on the Workshop's own text (a sync never rewrites it). */
async function sessionFromNote(user: SessionUser, body: Record<string, unknown>, notePath: string, mtime: number, status: SessionStatus | undefined): Promise<SessionMeta> {
  const now = Date.now();
  const id = randomUUID();
  const projectId = await resolveProjectId(user, typeof body.projectId === "string" ? body.projectId : null);
  const meta: SessionMeta = {
    id,
    owner: user.username,
    title: (typeof body.title === "string" && body.title.trim().slice(0, LIMITS.title)) || "Untitled session",
    query: "",
    status: status ?? "draft",
    ...(projectId ? { projectId } : {}),
    sources: [],
    drafts: [],
    note: { path: notePath, mtime },
    statusAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(sessionMetaPath(id), meta);
  const piece = pieceFromNote(typeof body.markdown === "string" ? body.markdown : "", typeof body.media === "string" ? body.media : "");
  const doc = newDocument(randomUUID(), id, piece.kind, KIND_TITLE[piece.kind], { now });
  doc.blocks = piece.blocks.map((text, i) => ({ id: `b${i + 1}`, text, author: "user", at: now }));
  doc.nextBlock = piece.blocks.length + 1;
  if (piece.hooks.length) {
    doc.hooks = piece.hooks.map((text, i) => ({ id: `h${i + 1}`, text, author: "user", at: now }));
    doc.nextHook = piece.hooks.length + 1;
  }
  await writeDoc(doc);
  return meta;
}

/**
 * The Obsidian plugin's note in (upsert by path among the account's sessions; the rules are in lib/workshop/notes.ts):
 * a linked session takes a newer note's status and nothing else; a new one is made only for a synced status or `create: "send"`.
 */
workshopApp.put("/notes", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const notePath = typeof body?.path === "string" ? body.path.trim() : "";
  const mtime = typeof body?.mtime === "number" ? body.mtime : NaN;
  if (!notePath || !Number.isFinite(mtime)) return c.json({ error: "A note needs its path and mtime" }, 400);
  const status = typeof body?.status === "string" ? sessionStatusOf(body.status) : undefined;
  const own = await ownSessions(user.username);
  // linked by path; else an unlinked session of the same name (letters and digits) takes the link, so notes written
  // before the link existed don't come in twice
  const nameKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const noteName = nameKey(typeof body?.title === "string" && body.title.trim() ? body.title : notePath.split("/").pop()!.replace(/\.md$/i, ""));
  const linked = own.filter((s) => s.note?.path === notePath).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    ?? own.filter((s) => !s.note && !!noteName && nameKey(s.title ?? "") === noteName).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  let meta: SessionMeta | null = null;
  if (linked) {
    meta = await updateSession(
      linked.id,
      (m) => {
        m.note = { path: notePath, mtime };
        if (status && status !== m.status && mtime > (m.statusAt ?? 0)) setSessionStatus(m, status, "note", { skipIllegal: true, at: mtime });
      },
      { touch: false },
    );
  } else if (body?.create === "send" || (status && SYNCED_STATUSES.includes(status))) {
    meta = await sessionFromNote(user, body!, notePath, mtime, status);
  }
  // no session for this note (it is not one of the synced statuses, and nobody pressed send): nothing made
  if (!meta) return c.json({ id: null, url: null });
  return c.json({ id: meta.id, status: meta.status ?? "draft", updatedAt: meta.updatedAt, statusAt: meta.statusAt ?? null, url: `/workshop/sessions/${meta.id}` });
});

/** Status changes since `since` (ms) on the account's linked sessions, in the notes' status values (setObsidianStatusLabels), for the plugin to write back. */
workshopApp.get("/notes", async (c) => {
  const since = Number(c.req.query("since")) || 0;
  const rows = (await ownSessions(c.get("user").username))
    .filter((s) => s.note && (s.statusAt ?? 0) > since)
    .map((s) => ({ id: s.id, path: s.note!.path, status: obsidianStatus(s.status), statusAt: s.statusAt ?? 0 }));
  return c.json(rows);
});

/** The account's exports: the built-in Obsidian Markdown first, then its own. */
workshopApp.get("/exports", async (c) => c.json(listExports(await storedExports(c.get("user").username))));

workshopApp.put("/exports", async (c) => {
  const username = c.get("user").username;
  try {
    const next = parseExports(await c.req.json().catch(() => null));
    await writeJsonAtomic(exportsFile(username), next);
    return c.json(listExports(next));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
});

/** Queued plugin files, for the Obsidian plugin to write into the vault (its own account's only). */
workshopApp.get("/exports/pending", async (c) => c.json(await pendingList(c.get("user").username)));

workshopApp.post("/exports/pending/:id/done", async (c) => {
  const username = c.get("user").username;
  return chained(`exports:${username}`, async () => {
    const queue = await pendingList(username);
    const next = queue.filter((p) => p.id !== c.req.param("id"));
    if (next.length === queue.length) return c.json({ error: "Not found" }, 404);
    await writeJsonAtomic(pendingFile(username), next);
    return c.json({ ok: true });
  });
});

/**
 * Run one of the account's exports on a session. A download answers the file (`part` picks one piece, as the built-in
 * does; several pieces without it answer their names). A plugin export queues one file per piece and links the session
 * to the first note's path, which moves it to In Production like a share.
 */
workshopApp.post("/sessions/:id/export/:exportId", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const exp = listExports(await storedExports(user.username)).find((e) => e.id === c.req.param("exportId"));
  if (!exp) return c.json({ error: "No such export" }, 404);
  const q = c.req.query("day") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
  const docs = await listDocs(meta.id);
  const types = await pieceTypes(meta.id, docs);
  if (!obsidianPieces(meta, docs, day, types).length) return c.json({ error: "This session has no reel or carousel with words yet" }, 400);
  const status = await sharedForProduction(meta);
  const files = obsidianPieces({ ...meta, status }, docs, day, types).map((piece) => {
    const vars = exportVars(piece, status, day);
    const name = exportFile(exp, vars);
    // the built-in is the note itself (its frontmatter comes from the vault's format); a custom export fills its template
    const markdown = exp.id === BUILTIN_EXPORT.id ? piece.markdown : `${renderTemplate(exp.template, vars).replace(/\n*$/, "")}\n`;
    return { name, markdown };
  });
  if (exp.target === "download") {
    const part = Number(c.req.query("part") ?? (files.length > 1 ? NaN : 0));
    if (!Number.isInteger(part)) return c.json({ parts: files.map((f) => f.name) });
    const out = files[part];
    if (!out) return c.json({ error: "No such piece" }, 404);
    return new Response(out.markdown, {
      headers: { "Cache-Control": "no-store", "X-Session-Status": status, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": attachment(out.name) },
    });
  }
  const queued: PendingExport[] = files.map((f) => ({
    id: randomUUID(),
    exportId: exp.id,
    path: [exp.folder, f.name].filter(Boolean).join("/"),
    markdown: f.markdown,
    sessionId: meta.id,
  }));
  await chained(`exports:${user.username}`, async () => writeJsonAtomic(pendingFile(user.username), [...(await pendingList(user.username)), ...queued]));
  await updateSession(meta.id, (m) => {
    m.note = { path: queued[0]!.path, mtime: Date.now() };
  }, { touch: false });
  return c.json({ queued: queued.length, path: queued[0]!.path });
});

/* ---- generation ---- */

async function patchDraft(sessionId: string, draftId: string, patch: Partial<DraftMeta>): Promise<void> {
  await updateSession(sessionId, (m) => {
    m.drafts = m.drafts.map((d) => (d.id === draftId ? { ...d, ...patch } : d));
  });
}

/** Pack the sources, ask the model for a plan, render it, store it. Never awaited by a request. */
async function runDraft(session: SessionMeta, draft: DraftMeta, user: SessionUser): Promise<void> {
  try {
    const noteFor = new Map(session.sources.map((s) => [s.postId, s.note]));
    const { packs, warning, missing } = await packPostsForUser(draft.sourceIds, user);
    if (draft.sourceIds.length && !packs.length) {
      throw new Error("None of the selected sources are in the library anymore");
    }
    const [project, ...frameworkHits] = await Promise.all([
      projectForAi(draft.projectId, user),
      ...draft.frameworkIds.map((id) => readFramework(id, user)),
    ]);
    const frameworks = frameworkHits.filter((f): f is Framework => !!f);
    const rules = await rulesFor(user, draft.ruleIds, project);
    const notes = draft.includeNotes ? await readNotes(session.id) : "";
    const { system, user: userMsg } = buildGeneratePrompt({
      kind: draft.kind,
      project: project ?? undefined,
      frameworks,
      rules: rules.map((r) => r.text),
      packText: await packInstructions(user.username, "workshop.write", project?.id ?? null),
      notes,
      prompt: draft.prompt,
      packs: packs.map((p) => ({ ...p, note: noteFor.get(p.id), savedFor: p.savedFor })),
    });
    let usage: MacUsage | undefined;
    const plan = await completeWithFallback(system, userMsg, undefined, PLAN_PARSERS[draft.kind], { ...workshopAi(user, session.ai), onUsage: (u) => (usage = sumUsage(usage, u)) });
    const markdown = renderDraft(plan, {
      projectName: project?.name,
      frameworkNames: frameworks.map((f) => f.name),
      sources: packs.map((p) => ({ handle: p.handle, kind: p.kind, url: p.url })),
      generatedAt: Date.now(),
    });
    await mkdir(path.dirname(draftMdPath(session.id, draft.id)), { recursive: true });
    await writeFile(draftMdPath(session.id, draft.id), markdown);
    await writeJsonAtomic(draftJsonPath(session.id, draft.id), plan);
    const notes2 = [warning, missing.length ? `${missing.length} source(s) were no longer in the library.` : ""]
      .filter(Boolean)
      .join(" ");
    await patchDraft(session.id, draft.id, {
      status: "ready",
      title: plan.plan.title,
      chars: markdown.length,
      warning: notes2 || undefined,
      usage,
      finishedAt: Date.now(),
      error: undefined,
    });
    bumpUsage(user.username, { aiRuns: 1 });
  } catch (e) {
    await patchDraft(session.id, draft.id, { status: "error", error: errorMessage(e).slice(0, 300), finishedAt: Date.now() });
    console.warn(`[workshop] draft ${draft.id} failed: ${errorMessage(e)}`);
  } finally {
    generating.delete(draft.id);
  }
}

workshopApp.post("/sessions/:id/generate", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!aiOn(user)) return c.json({ error: "AI is not configured" }, 400);
  if (meta.drafts.some((d) => d.status === "generating")) {
    return c.json({ error: "A draft is already generating in this session — wait for it" }, 409);
  }
  let input;
  try {
    input = parseGenerateInput(await c.req.json().catch(() => null));
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 400);
  }
  const sessionIds = meta.sources.map((s) => s.postId);
  const sourceIds = (input.sourceIds ?? sessionIds.slice(0, LIMITS.generateSources)).filter((id) =>
    sessionIds.includes(id),
  );
  if (!sourceIds.length && !input.prompt) {
    return c.json({ error: "Add a source or write a brief first" }, 400);
  }
  const draft: DraftMeta = {
    id: randomUUID(),
    kind: input.kind,
    title: "",
    projectId: input.projectId ?? meta.projectId,
    frameworkIds: input.frameworkIds,
    ruleIds: input.ruleIds,
    prompt: input.prompt,
    includeNotes: input.includeNotes,
    sourceIds,
    status: "generating",
    chars: 0,
    createdAt: Date.now(),
  };
  generating.add(draft.id);
  const next = await updateSession(meta.id, (m) => {
    m.drafts = [draft, ...m.drafts];
    if (input.projectId) m.projectId = input.projectId;
  });
  if (!next) {
    generating.delete(draft.id);
    return c.json({ error: "Not found" }, 404);
  }
  void runDraft(next, draft, user);
  return c.json({ draft }, 202);
});

workshopApp.get("/sessions/:id/drafts", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  c.header("Cache-Control", "no-store");
  return c.json(meta.drafts);
});

workshopApp.get("/sessions/:id/drafts/:draftId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const draft = meta.drafts.find((d) => d.id === c.req.param("draftId"));
  if (!draft) return c.json({ error: "Not found" }, 404);
  const markdown = draft.status === "ready" ? await readDraftMarkdown(meta.id, draft.id) : null;
  if (markdown === null) return c.json({ error: draft.status === "generating" ? "Still generating" : draft.error || "Not ready" }, 404);
  return c.json({ draft, markdown });
});

workshopApp.delete("/sessions/:id/drafts/:draftId", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const draftId = c.req.param("draftId");
  const draft = meta.drafts.find((d) => d.id === draftId);
  if (!draft) return c.json({ error: "Not found" }, 404);
  if (draft.status === "generating") return c.json({ error: "Still generating" }, 409);
  await updateSession(meta.id, (m) => {
    m.drafts = m.drafts.filter((d) => d.id !== draftId);
  });
  await rm(draftMdPath(meta.id, draftId), { force: true }).catch(() => {});
  await rm(draftJsonPath(meta.id, draftId), { force: true }).catch(() => {});
  return c.json({ ok: true });
});


/* ---- share links ---- */

/** token → the pieces it opens. Anyone with the link reads them live (no account) until it's stopped. */
interface WorkshopShare {
  owner: string;
  sessionId: string;
  /** The whole session: every piece, new ones too. */
  all?: boolean;
  docIds: string[];
  title: string;
  createdAt: number;
  /** The freelancer's own mark. */
  progress?: { state: "producing" | "done"; by?: string; at: number };
  /** Finals the freelancer uploaded through the link: sessions/<id>/deliveries/<did>/<name>. */
  deliveries?: Delivery[];
}
const SHARES_FILE = path.join(WS_ROOT, "shares.json");
const readShares = async () => (await readJson<Record<string, WorkshopShare>>(SHARES_FILE)) ?? {};

workshopApp.get("/sessions/:id/shares", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const shares = Object.entries(await readShares())
    .filter(([, s]) => s.sessionId === meta.id)
    .map(([token, s]) => ({ token, ...s }))
    .sort((a, b) => b.createdAt - a.createdAt);
  return c.json({ shares });
});

/** Sharing hands the pieces on to production: an idea, writing or ready session moves to In Production, never back. */
async function sharedForProduction(meta: SessionMeta): Promise<SessionStatus> {
  // never back: a session past In Production (Editing, Ready to post), published or shelved stays where it is
  const after = await updateSession(
    meta.id,
    (m) => {
      if (!["production", "editing", "toPost", "published", "shelved"].includes(m.status ?? "draft")) setSessionStatus(m, "production", "share", { skipIllegal: true });
    },
    { touch: false },
  );
  return after?.status ?? meta.status ?? "draft";
}

workshopApp.post("/sessions/:id/shares", async (c) => {
  const user = c.get("user");
  const meta = await ownedSession(c.req.param("id"), user);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { docIds?: unknown; title?: unknown; all?: unknown } | null;
  const docs = (await listDocs(meta.id)).filter((d) => d.kind !== "notes");
  if (body?.all === true) {
    // one link for the whole session: the same link every time it's asked for
    const shares = await readShares();
    const have = Object.entries(shares).find(([, s]) => s.sessionId === meta.id && s.all);
    if (have) return c.json({ token: have[0], ...have[1], status: await sharedForProduction(meta) });
    const token = randomUUID();
    shares[token] = { owner: user.username, sessionId: meta.id, all: true, docIds: [], title: meta.title || "Shared pieces", createdAt: Date.now() };
    await writeJsonAtomic(SHARES_FILE, shares);
    return c.json({ token, ...shares[token], status: await sharedForProduction(meta) });
  }
  const wanted = Array.isArray(body?.docIds) ? body!.docIds.filter((x): x is string => typeof x === "string") : [];
  const docIds = docs.filter((d) => wanted.includes(d.id)).map((d) => d.id);
  if (!docIds.length) return c.json({ error: "Pick at least one piece to share" }, 400);
  const title = (typeof body?.title === "string" && body.title.trim().slice(0, 120)) || (docIds.length === 1 ? docs.find((d) => d.id === docIds[0])!.title : meta.title || "Shared pieces");
  const shares = await readShares();
  const token = randomUUID();
  shares[token] = { owner: user.username, sessionId: meta.id, docIds, title, createdAt: Date.now() };
  await writeJsonAtomic(SHARES_FILE, shares);
  return c.json({ token, ...shares[token], status: await sharedForProduction(meta) });
});

workshopApp.delete("/sessions/:id/shares/:token", async (c) => {
  const meta = await ownedSession(c.req.param("id"), c.get("user"));
  if (!meta) return c.json({ error: "Not found" }, 404);
  const shares = await readShares();
  if (shares[c.req.param("token")]?.sessionId !== meta.id) return c.json({ error: "Not found" }, 404);
  delete shares[c.req.param("token")];
  await writeJsonAtomic(SHARES_FILE, shares);
  return c.json({ ok: true });
});

/** Public, no login (boot.ts PUBLIC_WORKSHOP): the shared pieces as they stand now, text and the picked slide layouts. */
export const workshopShareApp = new Hono<{ Variables: AuthVars }>();

workshopShareApp.get("/:token", async (c) => {
  const share = (await readShares())[c.req.param("token")];
  const meta = share ? await readSession(share.sessionId) : null;
  if (!share || !meta) return c.json({ error: "Not found" }, 404);
  const pieces = [];
  const ids = share.all ? (await listDocs(meta.id)).filter((d) => d.kind !== "notes" && d.blocks.some((b) => b.text.trim())).map((d) => d.id) : share.docIds;
  for (const id of ids) {
    const d = await readDoc(meta.id, id);
    if (!d) continue; // deleted since
    pieces.push({
      id: d.id,
      kind: d.kind,
      title: d.title,
      carouselType: d.carouselType,
      carouselLayouts: d.carouselLayouts,
      blocks: d.blocks.map((b) => ({ id: b.id, text: b.text })),
      hooks: (d.hooks ?? []).map((h) => ({ id: h.id, text: h.text })),
      caption: d.caption?.text ?? "",
      pinned: d.pinned?.text ?? "",
      updatedAt: d.updatedAt,
    });
  }
  return c.json(
    {
      title: share.all ? meta.title || share.title : share.title,
      status: meta.status ?? "draft",
      createdAt: meta.createdAt,
      updatedAt: Math.max(meta.updatedAt, ...pieces.map((p) => p.updatedAt)),
      progress: share.progress,
      deliveries: inSlideOrder(share.deliveries ?? []),
      pieces,
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

/* ---- answering the post's comments on the share link, signed in with access to the session (lib/workshop/answers.ts) ---- */

const answersPath = (id: string) => path.join(sessionDir(id), "answers.json");
const readAnswers = async (id: string): Promise<AnswersFile> => (await readJson<AnswersFile>(answersPath(id))) ?? { comments: [], thread: [] };

/** The share's session when the signed-in visitor can open it (not on the public allowlist in boot.ts, so there is a user). */
async function answerSession(c: Context<{ Variables: AuthVars }>): Promise<{ meta: SessionMeta; user: SessionUser } | null> {
  const share = (await readShares())[c.req.param("token") ?? ""];
  const user = c.get("user");
  const meta = share && user ? await ownedSession(share.sessionId, user) : null;
  return meta && user ? { meta, user } : null;
}

/**
 * The comments on every post the session became, as last read (one session can be several posts). Nothing is fetched or scraped until the author asks: `fresh` (Refresh) reads them, keeps judgments already made and judges the new ones; before that the
 * list is empty. Without `fresh`, ownPostComments only reads files (the author's handle, the author's earlier replies). The posts are read one after another and their comments listed together.
 */
async function loadPostComments(meta: SessionMeta, user: SessionUser, fresh: boolean) {
  const project = meta.projectId ? await readProject(meta.projectId, user) : null;
  const shortcodes = postingsOf(meta).map((p) => p.shortcode);
  const reads: Awaited<ReturnType<typeof ownPostComments>>[] = [];
  for (const shortcode of shortcodes) reads.push(await ownPostComments(user, shortcode, fresh, projectAccount(project)));
  const got = {
    handle: reads.find((r) => r.handle)?.handle,
    comments: reads.flatMap((r) => r.comments),
    replies: reads.flatMap((r) => r.replies),
  };
  return chained(`answers:${meta.id}`, async () => {
    const file = await readAnswers(meta.id);
    if (fresh) {
      const judged = new Map<string, Comment["judged"]>();
      const walk = (list: Comment[]) => list.forEach((x) => (x.judged && judged.set(x.id, x.judged), walk(x.replies ?? [])));
      walk(file.comments);
      const carry = (list: Comment[]) => list.forEach((x) => (judged.has(x.id) && !x.judged && (x.judged = judged.get(x.id)), carry(x.replies ?? [])));
      carry(got.comments);
      // each post's comments are judged with that post's own caption
      for (const r of reads) if (r.comments.length) await annotateComments(keyFor(user, "TYPESAFE_API_KEY").key, r.comments, { caption: r.caption, handle: r.handle }).catch(() => null);
      file.comments = got.comments;
      file.fetchedAt = Date.now();
      file.shortcodes = shortcodes;
      delete file.shortcode; // the one-post field of files saved before several posts
      await mkdir(sessionDir(meta.id), { recursive: true });
      await writeJsonAtomic(answersPath(meta.id), file);
    } else if (readFrom(file).join() !== shortcodes.join()) {
      // never read, or read from posts this session isn't linked to any more
      file.comments = [];
      delete file.fetchedAt;
    }
    return { ...got, file };
  });
}

/** The posts the saved comments were read from: `shortcodes`, or the one `shortcode` of a file saved before several posts. */
const readFrom = (file: AnswersFile): string[] => file.shortcodes ?? (file.shortcode ? [file.shortcode] : []);

const answersBody = (meta: SessionMeta, file: AnswersFile, handle?: string) => ({
  sessionId: meta.id,
  // the first post (the share page's Open post link); `posts` is every post whose comments are listed
  post: postingsOf(meta)[0] ?? null,
  posts: postingsOf(meta),
  fetchedAt: file.fetchedAt ?? null,
  comments: listComments(file.comments, handle),
  thread: file.thread,
});

workshopShareApp.get("/:token/answers", async (c) => {
  const got = await answerSession(c);
  if (!got) return c.json({ error: "Not found" }, 404);
  const { handle, file } = await loadPostComments(got.meta, got.user, false);
  return c.json(answersBody(got.meta, file, handle), 200, { "Cache-Control": "no-store" });
});

workshopShareApp.post("/:token/answers/refresh", async (c) => {
  const got = await answerSession(c);
  if (!got) return c.json({ error: "Not found" }, 404);
  const { handle, file } = await loadPostComments(got.meta, got.user, true);
  return c.json(answersBody(got.meta, file, handle));
});

/** Ask, or Reply on one comment: answers from the post, the session's chat and the comments; edits nothing. */
workshopShareApp.post("/:token/answers/ask", async (c) => {
  const got = await answerSession(c);
  if (!got) return c.json({ error: "Not found" }, 404);
  const { meta, user } = got;
  const body = (await c.req.json().catch(() => null)) as { question?: unknown; commentId?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim().slice(0, LIMITS.turnText) : "";
  const commentId = typeof body?.commentId === "string" ? body.commentId : undefined;
  if (!question && !commentId) return c.json({ error: "Ask something" }, 400);
  if (!aiOn(user)) return c.json({ error: "AI is not configured on the server" }, 503);
  const { handle, replies, file } = await loadPostComments(meta, user, false);
  const all = file.comments.flatMap((x) => [x, ...(x.replies ?? [])]);
  const comment = commentId ? all.find((x) => x.id === commentId) : undefined;
  if (commentId && !comment) return c.json({ error: "That comment is gone; refresh the comments" }, 404);
  const docs = await listDocs(meta.id);
  const notesDoc = docs.find((d) => d.kind === "notes");
  const chat = [];
  for (const m of (await readChat(meta.id)).messages) {
    if (m.status === "error" || m.status === "thinking") continue;
    const pasted = m.role === "user" ? await readPasted(meta.id, m.pasted) : [];
    const text = [m.text, ...pasted.map((p) => `[pasted: ${p.name}]\n${p.text}`)].filter((t) => t.trim()).join("\n\n");
    if (text) chat.push({ role: m.role, text });
  }
  const { system, user: prompt } = buildAnswerPrompt({
    pieces: docs.filter((d) => d.kind !== "notes" && d.blocks.some((b) => b.text.trim())).map((d) => `## ${d.title} (${d.kind})\n\n${docToMarkdown(d)}`),
    notes: notesDoc ? docToMarkdown(notesDoc) : await readNotes(meta.id),
    chat,
    comments: file.comments,
    handle,
    replies,
    thread: file.thread.slice(-30),
    question,
    comment,
  });
  try {
    let usage: MacUsage | undefined;
    const answer = await completeWithFallback(system, prompt, undefined, (t) => {
      if (!t.trim()) throw new Error("Empty answer");
      return t.trim();
    }, { ...workshopAi(user, meta.ai), onUsage: (u) => (usage = sumUsage(usage, u)) });
    bumpUsage(user.username, { aiRuns: 1 });
    const now = Date.now();
    const ask: AnswerMessage = { id: randomUUID(), role: "user", text: question, at: now, ...(commentId ? { commentId } : {}) };
    const reply: AnswerMessage = { id: randomUUID(), role: "assistant", text: answer, at: now + 1, ...(commentId ? { commentId } : {}), ...(usage ? { usage: { tokens: usage.tokens, costUsd: usage.costUsd } } : {}) };
    await chained(`answers:${meta.id}`, async () => {
      const f = await readAnswers(meta.id);
      f.thread.push(ask, reply);
      await writeJsonAtomic(answersPath(meta.id), f);
    });
    return c.json({ ask, reply });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 502);
  }
});

const deliveryDir = (sessionId: string, did: string) => path.join(sessionDir(sessionId), "deliveries", did);
const DELIVERY_MAX = 2 * 1024 ** 3;
const cleanName = (s: string) => s.replace(/[/\\\u0000-\u001f]/g, "").trim().slice(0, 120) || "file";

/** The freelancer marks the work: "producing" (the session goes In Production) or "done". */
workshopShareApp.post("/:token/progress", async (c) => {
  const token = c.req.param("token");
  const shares = await readShares();
  const share = shares[token];
  const meta = share ? await readSession(share.sessionId) : null;
  if (!share || !meta) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { state?: unknown; by?: unknown } | null;
  const state = body?.state === "producing" || body?.state === "done" ? body.state : null;
  if (!state) return c.json({ error: "producing or done?" }, 400);
  const by = typeof body?.by === "string" ? body.by.trim().slice(0, 60) : "";
  share.progress = { state, ...(by ? { by } : {}), at: Date.now() };
  await writeJsonAtomic(SHARES_FILE, shares);
  // the editor making it = Editing; "It's done" = Ready to post; published or shelved stay
  await updateSession(meta.id, (m) => {
    if (!["published", "shelved"].includes(m.status ?? "draft")) setSessionStatus(m, state === "done" ? "toPost" : "editing", "freelancer progress");
  });
  await notifyWorkshopOwner(share.owner, { kind: state === "done" ? "delivered" : "producing", by: by || "A freelancer", name: meta.title || share.title, href: `/workshop/sessions/${meta.id}`, ref: meta.id });
  return c.json({ progress: share.progress });
});

/** A final the freelancer uploads, streamed to disk (2 GB each; the raw file as the body, ?name=&by=&note=). */
workshopShareApp.post("/:token/deliveries", async (c) => {
  const token = c.req.param("token");
  const share = (await readShares())[token];
  const meta = share ? await readSession(share.sessionId) : null;
  if (!share || !meta || !c.req.raw.body) return c.json({ error: "Not found" }, 404);
  const length = Number(c.req.header("content-length") ?? "0");
  if (!length) return c.json({ error: "Send the file as the request body" }, 411);
  if (length > DELIVERY_MAX) return c.json({ error: "A file can be up to 2 GB" }, 413);
  const id = randomUUID();
  const name = cleanName(c.req.query("name") ?? "file");
  const dir = deliveryDir(meta.id, id);
  await mkdir(dir, { recursive: true });
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      done(size > DELIVERY_MAX ? new Error("A file can be up to 2 GB") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(c.req.raw.body as never), count, createWriteStream(path.join(dir, name)));
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    return c.json({ error: errorMessage(e) }, 400);
  }
  const by = (c.req.query("by") ?? "").trim().slice(0, 60);
  const note = (c.req.query("note") ?? "").trim().slice(0, 500);
  const item = { id, name, size, type: c.req.header("content-type") ?? "application/octet-stream", ...(by ? { by } : {}), ...(note ? { note } : {}), at: Date.now() };
  const shares = await readShares(); // re-read: another upload may have landed meanwhile
  const live = shares[token];
  if (!live) {
    await rm(dir, { recursive: true, force: true });
    return c.json({ error: "Not found" }, 404);
  }
  live.deliveries = [...(live.deliveries ?? []), item];
  await writeJsonAtomic(SHARES_FILE, shares);
  await notifyWorkshopOwner(share.owner, { kind: "delivered", by: by || "A freelancer", name: meta.title || share.title, text: name, href: `/workshop/sessions/${meta.id}`, ref: meta.id });
  return c.json(item);
});

/** Every delivered file as one ZIP, in slide order: "Save all to phone" (the iPhone app puts each in Photos). */
workshopShareApp.get("/:token/deliveries.zip", async (c) => {
  const share = (await readShares())[c.req.param("token")];
  const meta = share ? await readSession(share.sessionId) : null;
  if (!share || !meta || !share.deliveries?.length) return c.json({ error: "Not found" }, 404);
  try {
    const zip = await storedZip(inSlideOrder(share.deliveries).map((d) => ({ path: path.join(deliveryDir(meta.id, d.id), d.name), name: d.name })));
    const name = `${(meta.title || share.title).replace(/[^\w.-]+/g, "_").slice(0, 80) || "finals"}.zip`;
    return new Response(Readable.toWeb(zip.body) as never, {
      headers: { "Content-Type": "application/zip", "Content-Length": String(zip.size), "Content-Disposition": `attachment; filename="${name}"` },
    });
  } catch (e) {
    return c.json({ error: errorMessage(e) }, 500);
  }
});

/** A delivered file, for the freelancer and the owner (both have the link): played in the page, `?download=1` saves it. */
workshopShareApp.get("/:token/deliveries/:did", async (c) => {
  const share = (await readShares())[c.req.param("token")];
  const item = share?.deliveries?.find((d) => d.id === c.req.param("did"));
  if (!share || !item) return c.json({ error: "Not found" }, 404);
  const file = path.join(deliveryDir(share.sessionId, item.id), item.name);
  const info = await stat(file).catch(() => null);
  if (!info) return c.json({ error: "Not found" }, 404);
  if (!c.req.query("download")) return sendFile(c, file, item.type);
  return new Response(Readable.toWeb(createReadStream(file)) as never, {
    headers: { "Content-Type": item.type, "Content-Length": String(info.size), "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}` },
  });
});

