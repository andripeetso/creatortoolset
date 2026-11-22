import { Hono, type Context } from "hono";
import { EDIT_FEEDBACK_TEXT_MAX, EDIT_SLOTS, EDIT_STEPS, TRACKS, type EditSlot, type EditStep, type EditSummary, type Timeline, type VersionMark, type VersionPlan } from "../../contracts/editor";
import { deviceOf } from "../lib/devices";
import { innerCall, jobTurn, type AuthVars } from "../auth";
import { picturesInChat } from "../assistant";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { onUploadDone } from "../library/routes";
import { ZipFile } from "yazl";
import { exportGaps, handoverReadme } from "./carry";
import { toFcp7Xml, toFcpxml } from "./fcpxml";
import { footageTargetFor } from "./ingest";
import { notTyped } from "./own-words";
import { LINK_TTL_S, mediaPaths } from "./media";
import { otioText, toOtio } from "./otio";
import { qaOf } from "./qa";
import { forgetFinished, finishedOf, removeFinished } from "./finished";
import { addFeedback, cleanVoice, MAX_SOURCES, newestDraft, serial, queueVersion, allEdits, byToolAfter, cleanBrief, createEdit, uploadFinished, draftNames, editDir, editorDefaults, editRole, editSources, gradeOf, mayRename, NoCollection, NoStyle, ownerOf, readDraft, readEdit, POST_UNFINISHED, postFiles, postUnfinished, readStep, saveEdit, saveStep, setChosenDefault, styleFields, summaryOf, viewOf, type EditMeta, jobsOf, readFiled, saveDraft, seesEdit } from "./store";
import { forgetFailed, stemKey, voiceGroups } from "./voice-mix";
import { fileIntoProjects } from "./projects";
import { emptyTracks, NATURAL_CUT, sourceOf } from "./timeline";
import { lineTakes } from "./takes";
import type { ProbeSummary } from "../library/media/probe";
import { homeOf } from "../library/access";
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { PROPOSAL_STILLS } from "../../contracts/editor-styles";
import path from "node:path";
import { describeEdits } from "../../contracts/edit-summary";
import { cleanEdits } from "../../contracts/edit-timeline";
import { applyEdits, draftView, EditRefused } from "./edits";
import { openComments, wordsFor } from "./revise";
import { edlTracks, toEdl } from "./edl";
import { formatOf, fromSentBack, SentBackRefused, sentBackSummary } from "./sent-back";
import { importTimeline, MAX_TIMELINE_BYTES, TimelineError, timelineSources } from "../../contracts/timeline-import";
import { handCheck, refusal } from "../../src/lib/nle/check";
import { fromNle, toNle } from "../../src/lib/nle/draft";
import type { NleTimeline } from "../../src/lib/nle/model";
import { rendersOf } from "./preview";
import { animationApp } from "./animation-styles";
import { voiceApp } from "./voice";
import { editorChatApp } from "./chat";
import { cardsApp } from "./cards/routes";
import { clearCards, MAX_SHEET_NOTES, readCards, saveCards, sheetFile } from "./cards/state";
import { heldPasses, markRead, readKeys, sheetOf, todoFor, waitsGo, workerOf } from "./todo";
import { approvePass, markPasses, nextPass, PASS_WORD, type Pass } from "./passes";
import { createStyle, deleteStyle, findStyle, markAsked, removeLearned, setDefault, stylesView, updateStyle } from "./styles";
import { dismiss, finishedText, keep, propose, stillFile, videoStills } from "./style-proposals";
import { stopEdit } from "./worker";
import { onEvent } from "../lib/events";
import { readComments, readMeta } from "../review";
import { inProjectOf, projectOf } from "../lib/project-of";
import { sharedHere } from "../lib/workshop/workspace";
import { currentWorkspaceId, listWorkspaceId } from "../lib/workspace-scope";
import { findUser, mayChange, mayUse, type SessionUser } from "../users";
import { getWorkspace, resolveProjectId } from "../lib/workshop/workspace";

/**
 * AI Editor routes (contracts/editor.ts), mounted at /api/editor behind the `editor` tool gate (boot.ts). Edits are
 * shared in their workspace (store.ts editRole): one the caller doesn't see is 404, as one that does not exist. Anyone
 * with Read & write on the AI Editor there (boot.ts WRITE_GATES) runs, retries and makes the next version of any of
 * them; each step they ask for runs as them (the job's actor), on their own keys and AI. Renaming and the trash are the
 * maker's and the workspace owner's (store.ts mayRename).
 */

export const editorApp = new Hono<{ Variables: AuthVars }>();

type C = Context<{ Variables: AuthVars }>;
const notFound = (c: C) => c.json({ error: "Not found", code: "not_found" }, 404);
const body = async (c: C): Promise<Record<string, unknown>> => {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

/** A request an AI makes (one of its tools' own calls, or one with an AI key), not the person at their own screen. */
const viaTool = (c: C) => !!innerCall.getStore() || !!c.req.header("authorization");

/**
 * The edit, when the caller sees it, with who they are to it; null (answer 404) otherwise. `use`: they change it, run
 * it or take its footage, so a teammate must also see every clip it uses (store.ts seesEdit), as the library would.
 */
async function load(c: C, use = false) {
  const user = c.get("user").username;
  const e = readEdit(c.req.param("id") ?? "");
  const role = await editRole(user, e);
  return e && role && (!use || (await seesEdit(user, e))) ? { e, role, user } : null;
}
type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

/** The edit's view for the caller: `locked` when its name and the trash are not theirs. */
const viewFor = (r: Loaded, e: EditMeta = r.e) => ({ ...viewOf(e), ...(mayRename(r.user, e, r.role) ? {} : { locked: true as const }) });
const NOT_YOURS = { error: "Only the edit's maker or the workspace's owner renames it or moves it to the trash", code: "forbidden" } as const;

/** Whose editor settings and styles the caller works with: the team owner's in a workspace given to them, else their own. */
const settingsOf = async (c: C) => (await sharedHere(c.get("user")))?.owner ?? c.get("user").username;

// an edit made from clips still uploading (a phone's New edit) starts once the last one is in
onUploadDone.push((id, version) => void uploadFinished(id, version));

// ponytail: every edit on the server is read to find the one a Review video belongs to, as finished.ts does
/** A Review video an edit made is set to Changes: the open comments of its newest version become the edit's notes, each once. */
onEvent("review.changes", async ({ asset, owner }) => {
  for (const e of allEdits()) {
    if (ownerOf(e) !== owner || e.trashedAt) continue;
    const variant = Object.entries(readStep(e.id, "review") ?? {}).find(([, p]) => p.assetId === asset)?.[0];
    if (!variant) continue;
    const newest = Math.max(0, ...((await readMeta(asset))?.versions ?? []).map((v) => v.n));
    const open = (await readComments(asset)).filter((x) => x.version === newest && !x.parentId && !x.resolved && x.text.trim());
    await addFeedback(e.id, open.map((x) => ({ at: x.createdAt, from: "review" as const, variant, ...(x.t !== undefined ? { t: x.t } : {}), text: x.text, by: x.user ?? x.author })));
    return;
  }
});

/**
 * A cut an edit in passes filed was approved in Review: that is the go for its next pass (approvePass). Only the newest
 * cut of the version, and only from someone who may work on the edit (a guest on a share link approves, nothing starts).
 */
onEvent("review.approved", async ({ asset, owner, by, n }) => {
  for (const e of allEdits()) {
    if (ownerOf(e) !== owner || e.trashedAt) continue;
    const filed = Object.entries(readStep(e.id, "review") ?? {}).find(([, p]) => p.assetId === asset);
    if (!filed) continue;
    const [variant, p] = filed;
    // as Carry on: the AI Editor on and not read-only for them (boot.ts gates), and the edit theirs to work on (load)
    const u = by ? findUser(by) : null;
    if (p.n !== n || !u || !mayUse(u, "editor") || !mayChange(u, "editor") || !(await editRole(by, e)) || !(await seesEdit(by, e))) return;
    const next = (await readMeta(asset))?.versions.find((v) => v.n === n)?.next;
    await approvePass(e, variant, next, by);
    return;
  }
});

editorApp.post("/", async (c) => {
  const user = c.get("user").username;
  try {
    const b = await body(c);
    // made in the project asked for, if it is the person's, else the one they are in
    const projectId = await resolveProjectId(c.get("user"), typeof b.projectId === "string" ? b.projectId : null);
    const e = await createEdit(user, b, viaTool(c), projectId);
    if (e) await fileIntoProjects(user, () => listFor(c.get("user")));
    return e ? c.json({ id: e.id }) : notFound(c);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    if (e instanceof NoStyle) return c.json({ error: e.message, code: "not_found" }, 404);
    throw e;
  }
});

/**
 * The edits the person sees (their own, and every one in a workspace given to them), newest first, each with the
 * project it is in as its workspace's owner files it (lib/project-of.ts: an old one is the first brand's);
 * ?projectId= only those of that project of theirs; none asked: the workspace the request works in (the app's header,
 * a chat's tools), so a chat never lists another workspace's edits.
 */
editorApp.get("/", async (c) => {
  const user = c.get("user");
  const want = await listWorkspaceId(user, c.req.query("projectId"));
  const only = want && (await inProjectOf(user, want)) ? want : undefined;
  const all = await listFor(user);
  // the edits there before projects were filed go into their videos' folders once (projects.ts); the folders' change stream refreshes the list
  void fileIntoProjects(user.username, () => all, true);
  return c.json(only ? all.filter((e) => e.projectId === only) : all);
});

/** Every edit `user` sees, newest first, with the project it is in, how many versions it has and its newest one's Review still. */
async function listFor(user: SessionUser): Promise<EditSummary[]> {
  return (await seenBy(user)).map(({ e, projectId }) => {
    const names = draftNames(e.id).filter((n) => !e.marks?.[n]?.trashedAt);
    const still = newestStill(e.id, names);
    return { ...summaryOf(e), ...(projectId ? { projectId } : {}), versionCount: names.length, ...(still ? { still } : {}), ...(waitsGo(e) ? { waits: "go" as const } : {}) };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every edit `user` sees, not in the trash, with the project it is in (as its workspace's owner files it). */
async function seenBy(user: SessionUser): Promise<{ e: EditMeta; projectId?: string }[]> {
  const ofs = new Map<string, ((own?: string) => string) | null>();
  const out: { e: EditMeta; projectId?: string }[] = [];
  // ponytail: editRole reads the given workspaces once per edit; read them once per list if a team's list gets slow
  for (const e of allEdits()) {
    if (e.trashedAt || !(await editRole(user.username, e))) continue;
    const owner = ownerOf(e);
    if (!ofs.has(owner)) ofs.set(owner, await projectOf({ username: owner } as SessionUser));
    out.push({ e, projectId: ofs.get(owner)?.(e.projectId) });
  }
  return out;
}

/** The Review version filed last among `names`: its asset and number (the filed cut's file time says which is newest). */
function newestStill(id: string, names: string[]): { asset: string; n: number } | undefined {
  const filed = readStep(id, "review") ?? {};
  let best: { asset: string; n: number; at: number } | undefined;
  for (const n of names) {
    const p = filed[n];
    if (!p) continue;
    let at = 0;
    try {
      at = statSync(path.join(editDir(id), "filed", `${p.assetId}.${p.n}.json`)).mtimeMs;
    } catch {
      /* filed before cuts were kept: oldest */
    }
    if (!best || at > best.at) best = { asset: p.assetId, n: p.n, at };
  }
  return best && { asset: best.asset, n: best.n };
}

/**
 * An edit with no footage and one empty timeline (v1) in the workspace the person works in, for clips put on it by hand
 * (POST /:id/drafts/:name/clips). Its working size: its default style's, else 1080 × 1920; 25 fps.
 */
editorApp.post("/empty", async (c) => {
  const user = c.get("user");
  const b = await body(c);
  const projectId = await resolveProjectId(user, typeof b.projectId === "string" ? b.projectId : null);
  const owner = (projectId && (await getWorkspace(user)).projects.find((p) => p.id === projectId)?.owner) || user.username;
  const e = await createEdit(user.username, typeof b.name === "string" && b.name.trim() ? { name: b.name } : {}, viaTool(c), projectId, homeOf(owner));
  if (!e) return notFound(c);
  const timeline: Timeline = { name: `${e.name} v1`, fps: 25, width: e.size?.w ?? 1080, height: e.size?.h ?? 1920, sources: {}, tracks: emptyTracks(), markers: [] };
  await saveDraft(e.id, "v1", { timeline, notes: [] });
  await fileIntoProjects(user.username, () => listFor(user));
  return c.json({ id: e.id, draft: "v1" }, 201);
});

// where footage picked from this computer is filed (api/editor/ingest.ts); registered before /:id
editorApp.get("/footage-target", async (c) => {
  const t = await footageTargetFor(c.get("user").username);
  return t ? c.json(t) : notFound(c);
});

// the to-do (todo.ts) and whether a computer of the person's is on; registered before /:id
/** What waits on the person across the edits they see (?projectId= only that project's, as the list). */
editorApp.get("/todo", async (c) => {
  const user = c.get("user");
  const want = await listWorkspaceId(user, c.req.query("projectId"));
  const only = want && (await inProjectOf(user, want)) ? want : undefined;
  const edits = (await seenBy(user)).filter((x) => !only || x.projectId === only).map((x) => x.e);
  return c.json(await todoFor(user.username, edits, await readKeys(user.username)));
});

/** ✓ on a to-do row, or Mark all read: `keys`, the rows' own. */
editorApp.post("/todo/read", async (c) => {
  const keys = (await body(c)).keys;
  if (!Array.isArray(keys)) return c.json({ error: "keys: the to-do rows' keys", code: "invalid" }, 400);
  await markRead(c.get("user").username, keys.filter((k): k is string => typeof k === "string" && k.length < 200).slice(0, 500));
  return c.json({ ok: true });
});

editorApp.get("/worker", (c) => c.json(workerOf(c.get("user").username)));

// the defaults are registered before /:id, so "defaults" is never read as an edit id
// the defaults of the workspace the request works in (the window's, or the one picked in Settings: X-CT-Workspace);
// in a workspace given to the person, the workspace's own (its owner's): what a new edit there is made with
editorApp.get("/defaults", async (c) => c.json(await editorDefaults(await settingsOf(c), await currentWorkspaceId(c.get("user")))));

/** One slot's default in that workspace: an item id the person can choose from, or null for back to the pack's or the built-in one. */
editorApp.put("/defaults/:slot", async (c) => {
  const user = c.get("user").username;
  const slot = c.req.param("slot") as EditSlot;
  if (!EDIT_SLOTS.includes(slot)) return c.json({ error: "Unknown slot", code: "invalid" }, 400);
  const id = (await body(c)).id ?? null;
  const ws = await currentWorkspaceId(c.get("user"));
  const defaults = await editorDefaults(user, ws);
  if (id !== null && (typeof id !== "string" || !defaults.items[slot].some((i) => i.id === id))) return c.json({ error: "No such item for this slot", code: "invalid" }, 400);
  await setChosenDefault(user, slot, id, ws);
  return c.json(await editorDefaults(user, ws));
});

// the person's editing styles (contracts/editor-styles.ts), the workspace's in one given to them; registered before /:id, as the defaults are
// listed for the workspace a request works in (a phone or an API key with none: every style); the default is the app's current workspace's
editorApp.get("/styles", async (c) => c.json(stylesView(await settingsOf(c), await listWorkspaceId(c.get("user")), c.get("user").username, (await currentWorkspaceId(c.get("user"))) ?? "")));

const NOT_TYPED = "Not saved: the notes are not the user's own words in this chat. Send a whole phrase they typed themselves, or a passage of a long text they pasted with this message, word for word, or leave notes out: they write them on the style's sheet (Editor, Editing styles).";

/** An editing style's notes are the person's own words, also when the assistant saves them (own-words.ts). True when the save is refused. */
const notesNotTyped = (c: C, b: Record<string, unknown>): boolean => notTyped(c, b, ["notes", "addNotes"]);

const THEIR_PLAYBOOK = "Not saved: the user changed this style's playbook themselves, so it is theirs. Leave it as it is; they change it on the style's sheet.";

/**
 * A playbook sent is marked with who sent it: an AI's tool or key writes the researched one (`ai`), the person's own
 * screen makes it theirs (`person`), and one of theirs is never replaced or taken off by an AI. A string: refused.
 */
function playbookBy(c: C, b: Record<string, unknown>, had: ReturnType<typeof findStyle>): string | null {
  if (b.playbook === undefined) return null;
  const ai = viaTool(c);
  if (ai && had?.playbook?.by === "person") return THEIR_PLAYBOOK;
  if (b.playbook && typeof b.playbook === "object") b.playbook = { ...(b.playbook as object), by: ai ? "ai" : "person" };
  return null;
}

/** A new style from the fields sent, or with `fromEdit` from an edit of the caller's own (its choices, never its brief, script or footage). */
editorApp.post("/styles", async (c) => {
  const user = c.get("user").username;
  const b = await body(c);
  if (notesNotTyped(c, b)) return c.json({ error: NOT_TYPED, code: "not_typed" }, 409);
  playbookBy(c, b, null);
  const from = b.fromEdit === undefined ? undefined : readEdit(String(b.fromEdit));
  if (b.fromEdit !== undefined && !(await editRole(user, from ?? null))) return notFound(c);
  const made = createStyle(user, b, from ?? undefined, b.first === true, await currentWorkspaceId(c.get("user")));
  return typeof made === "string" ? c.json({ error: made, code: "invalid" }, 400) : c.json(made);
});

/** New edit's "How do you like to work?" put off (Not now): it is not shown again. */
editorApp.post("/styles/asked", (c) => {
  markAsked(c.get("user").username);
  return c.json({ ok: true });
});

/** The style New edit opens on in this workspace (one listed here), or `id: null` for none set: the last one used then. */
editorApp.put("/styles/default", async (c) => {
  const b = await body(c);
  const ws = await currentWorkspaceId(c.get("user"));
  if (b.id !== null && !(typeof b.id === "string" && stylesView(await settingsOf(c), ws).styles.some((s) => s.id === b.id))) return notFound(c);
  setDefault(c.get("user").username, ws ?? "", b.id);
  return c.json({ ok: true });
});

/**
 * The AI reads a reference and proposes a style (style-proposals.ts): `clip`, a library video's version id (its stills;
 * 202 with `waiting` while a computer makes them), stills sent as `file`, `finished: true` (the caller's finished
 * edits), or `chat: n`, the newest n pictures sent in the assistant's chat a reply is written in (found by that reply's
 * token, never by a path). Only a proposal: nothing uses it until the person keeps it.
 */
/** Styles of a workspace shared with the caller are its owner's: a suggestion kept there would be a style nobody lists. */
const SHARED_STYLES = { error: "This workspace's styles are its owner's to add", code: "forbidden" } as const;

editorApp.post("/styles/propose", async (c) => {
  const user = c.get("user").username;
  if ((await settingsOf(c)) !== user) return c.json(SHARED_STYLES, 403);
  const ws = await currentWorkspaceId(c.get("user"));
  const multipart = (c.req.header("content-type") ?? "").startsWith("multipart/");
  let made: Awaited<ReturnType<typeof propose>>;
  if (multipart) {
    const form = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
    const files = [form.file].flat().filter((f): f is File => f instanceof File);
    if (!files.length) return c.json({ error: "Send the pictures as file", code: "invalid" }, 400);
    if (files.some((f) => f.size > 20 * 1024 * 1024)) return c.json({ error: "A picture is at most 20 MB", code: "invalid" }, 400);
    const stills = await Promise.all(files.slice(0, PROPOSAL_STILLS).map(async (f) => Buffer.from(await f.arrayBuffer())));
    made = await propose(user, { from: "pictures", label: `${stills.length} ${stills.length === 1 ? "picture" : "pictures"}`, stills }, ws);
  } else {
    const b = await body(c);
    if (typeof b.clip === "string" && b.clip) {
      const v = await videoStills(user, b.clip);
      if ("waiting" in v) return c.json({ waiting: v.waiting }, 202);
      if ("error" in v) return c.json({ error: v.error, code: v.status === 404 ? "not_found" : v.status === 409 ? "conflict" : "invalid" }, v.status);
      made = await propose(user, { from: "video", label: v.title || "A video", stills: v.frames }, ws);
    } else if (b.finished === true) {
      const t = finishedText(user, ws);
      if (typeof t === "string") return c.json({ error: t, code: "conflict" }, 409);
      made = await propose(user, { from: "finished", label: `${t.count} finished ${t.count === 1 ? "edit" : "edits"}`, stills: [], text: t.text }, ws);
    } else if (b.chat !== undefined) {
      const auth = c.req.header("authorization");
      const sent = /^Bearer ctj_/.test(auth ?? "") ? picturesInChat(user, jobTurn(auth) ?? "") : null;
      if (!sent) return c.json({ error: "Pictures come from the app's own chat. Outside it the user adds them on the Editing styles tab (Propose a style).", code: "invalid" }, 400);
      const n = Number(b.chat);
      if (!Number.isInteger(n) || n < 1) return c.json({ error: "Give chat: how many of the newest pictures the user sent in this chat to read", code: "invalid" }, 400);
      const pics = (await Promise.all(sent.slice(-Math.min(n, PROPOSAL_STILLS)).map((p) => readFile(p.file).catch(() => null)))).filter((x) => x !== null);
      if (!pics.length) return c.json({ error: "The user sent no picture in this chat that could be read", code: "invalid" }, 400);
      made = await propose(user, { from: "pictures", label: `${pics.length} ${pics.length === 1 ? "picture" : "pictures"} from the chat`, stills: pics }, ws);
    } else return c.json({ error: "Give clip (a library video's version id), pictures as file, finished: true, or chat: n", code: "invalid" }, 400);
  }
  return typeof made === "string" ? c.json({ error: made, code: "failed" }, 422) : c.json(made);
});

editorApp.get("/styles/proposals/:id/stills/:n", async (c) => {
  const file = stillFile(c.get("user").username, c.req.param("id"), Number(c.req.param("n")));
  const bytes = file && (await readFile(file).catch(() => null));
  return bytes ? new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" } }) : notFound(c);
});

/** Keep: the person's own press on the proposal's sheet, never an AI's tool, so what the AI proposed is never applied by itself. */
editorApp.post("/styles/proposals/:id/keep", async (c) => {
  if (viaTool(c)) return c.json({ error: "Only the user keeps a proposal, on its sheet (Editor, Editing styles).", code: "forbidden" }, 403);
  if ((await settingsOf(c)) !== c.get("user").username) return c.json(SHARED_STYLES, 403);
  const kept = await keep(c.get("user").username, c.req.param("id"), await body(c));
  if (!kept) return notFound(c);
  return typeof kept === "string" ? c.json({ error: kept, code: "invalid" }, 400) : c.json(kept);
});

editorApp.delete("/styles/proposals/:id", async (c) => ((await dismiss(c.get("user").username, c.req.param("id"))) ? c.json({ ok: true }) : notFound(c)));

/** Changes the fields sent. `addNotes` adds a line under the notes the style has (one it already holds is not added twice). */
editorApp.put("/styles/:id", async (c) => {
  const user = c.get("user").username;
  const b = await body(c);
  if (notesNotTyped(c, b)) return c.json({ error: NOT_TYPED, code: "not_typed" }, 409);
  const theirs = playbookBy(c, b, findStyle(user, c.req.param("id")));
  if (theirs) return c.json({ error: theirs, code: "theirs" }, 409);
  if (typeof b.addNotes === "string" && b.addNotes.trim()) {
    const had = findStyle(user, c.req.param("id"))?.notes ?? "";
    const add = b.addNotes.trim();
    b.notes = had.toLowerCase().includes(add.toLowerCase()) ? had : [had, add].filter(Boolean).join("\n");
  }
  const changed = updateStyle(user, c.req.param("id"), b);
  if (!changed) return notFound(c);
  return typeof changed === "string" ? c.json({ error: changed, code: "invalid" }, 400) : c.json(changed);
});

// a deleted style takes the edits finished with it along (finished.ts)
editorApp.delete("/styles/:id", (c) => {
  const user = c.get("user").username;
  if (!deleteStyle(user, c.req.param("id"))) return notFound(c);
  forgetFinished(user, c.req.param("id"));
  return c.json({ ok: true });
});

// the edits the person finished in a style, newest first, and × on one: it never counts for a style again
editorApp.get("/styles/:id/finished", (c) => {
  const user = c.get("user").username;
  return findStyle(user, c.req.param("id")) ? c.json(finishedOf(user, c.req.param("id"))) : notFound(c);
});

editorApp.delete("/styles/:id/finished/:editId", async (c) =>
  (await removeFinished(c.get("user").username, c.req.param("id"), c.req.param("editId"))) ? c.json({ ok: true }) : notFound(c));

// × on what an approved edit taught the style (styles.ts removeLearned)
editorApp.delete("/styles/:id/learned/:editId", (c) => (removeLearned(c.get("user").username, c.req.param("id"), c.req.param("editId")) ? c.json({ ok: true }) : notFound(c)));

// the person's animation styles and their pictures (animation-styles.ts); before /:id, as the styles are
editorApp.route("/animation-styles", animationApp);
// a voice made from text, saved in the Media Library as a take (voice.ts); before /:id too
editorApp.route("/voice", voiceApp);
// the AI Editor's chat (the assistant's chat about one edit), before /:id would read "chat" as an edit
editorApp.route("/chat", editorChatApp);
// a version's cards on the edit page: a still, the 👍, Make cards again (cards/routes.ts)
editorApp.route("/", cardsApp);

/** Carry on, for an edit in passes: every drafted version's next pass is queued (and recorded as done); 409 while it is being made, or when no pass is left. */
editorApp.post("/:id/pass", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const db = libraryDb();
  if (db.prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").get(r.e.id)) return c.json({ error: "This edit is still being made", code: "conflict" }, 409);
  const queued = Object.fromEntries(draftNames(r.e.id).flatMap((n) => { const p = nextPass(r.e, n); return p ? [[n, p]] : []; }));
  if (!Object.keys(queued).length) return c.json({ error: "Nothing left to do", code: "conflict" }, 409);
  await markPasses(r.e.id, queued);
  for (const [n, p] of Object.entries(queued)) enqueueJob(db, r.e.workspaceId, `${r.e.id}:${n}`, p, r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

editorApp.get("/:id", async (c) => {
  const r = await load(c);
  return r ? c.json(viewFor(r)) : notFound(c);
});

editorApp.patch("/:id", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  let patch;
  let styled: Partial<EditMeta> = {};
  const b = await body(c);
  try {
    patch = await cleanBrief(b, r.user, r.e.workspaceId);
    // `style` puts an editing style's choices on the edit, under what this patch sets itself; null takes the style off
    if (typeof b.style === "string") styled = await styleFields(ownerOf(r.e), r.e.workspaceId, b.style, r.e);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    if (e instanceof NoStyle) return c.json({ error: e.message, code: "not_found" }, 404);
    throw e;
  }
  if (patch.name !== undefined && !mayRename(r.user, r.e, r.role)) return c.json(NOT_YOURS, 403);
  // addSources: more footage for this edit (version ids), checked as a new edit's sources are (createEdit)
  const add = Array.isArray(b.addSources) ? [...new Set(b.addSources.filter((s): s is string => typeof s === "string"))].filter((s) => !r.e.sources.includes(s)) : [];
  if (add.length && r.e.sources.length + (r.e.uploads?.length ?? 0) + add.length > MAX_SOURCES) return c.json({ error: `An edit takes up to ${MAX_SOURCES} clips`, code: "invalid" }, 400);
  if (add.length && (await editSources(r.user, add)) !== r.e.workspaceId) return c.json({ error: "A clip isn't in this edit's workspace's Media Library", code: "invalid" }, 400);
  delete patch.framing; // set per source in a later step
  // written on the uploads' chain from the edit as it is then: an upload finishing meanwhile keeps its clip (uploadFinished)
  const e = await serial(async () => {
    const now = readEdit(r.e.id);
    if (!now) return null;
    // a flag the patch leaves out keeps its state
    const e = { ...now, ...styled, ...patch, flags: { ...now.flags, ...patch.flags }, sources: [...new Set([...now.sources, ...add])] };
    if (b.style === null) {
      delete e.style;
      delete e.size; // an edit with no style is cut at the footage's size, as before
    }
    // whose words the name and the brief are now: an AI's tool's, or the person's own (finished.ts keeps only theirs)
    const byTool = byToolAfter(now.byTool, patch, viaTool(c)).byTool;
    if (byTool) e.byTool = byTool;
    else delete e.byTool;
    await saveEdit(e);
    // another voice: every version's sound is made again with it, the same cut (voice-mix.ts), as the next Review version
    if (patch.voice && JSON.stringify(patch.voice) !== JSON.stringify(now.voice ?? null)) await recutSound(e, draftNames(e.id).filter((n) => !e.marks?.[n]?.trashedAt), r.user);
    return e;
  });
  return e ? c.json(viewFor(r, readEdit(e.id)!)) : notFound(c);
});

/** Each named version's sound made again (the sound step, then its preview and Review), its cut as it is; a voice that failed is tried anew. */
async function recutSound(e: EditMeta, names: string[], user: string) {
  await forgetFailed(e.id);
  for (const n of names) enqueueJob(libraryDb(), e.workspaceId, `${e.id}:${n}`, "sound", user, true, "edit_jobs");
}

/**
 * Review's voice controls kept for the edit: the enhancer every recording plays ("off" = as recorded) and each voice
 * group's share of it (`mix`, by the stem group's key), then this version cut again with them, only its sound.
 */
editorApp.post("/:id/drafts/:name/voice", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const b = await body(c);
  const keys = Object.fromEntries(voiceGroups(d.timeline).map((src) => [stemKey(src), src]));
  const given = Object.entries((b.mix ?? {}) as Record<string, unknown>).filter(([k]) => keys[k]);
  if (b.voice !== undefined && !cleanVoice({ fx: b.voice })) return c.json({ error: "voice is off or an enhancer's id", code: "invalid" }, 400);
  if (b.voice === undefined && !given.length) return c.json({ error: "No voice of this cut in that mix", code: "invalid" }, 400);
  const e = await serial(async () => {
    const now = readEdit(r.e.id);
    if (!now) return null;
    const voice = cleanVoice({
      ...now.voice,
      fx: typeof b.voice === "string" ? b.voice : (now.voice?.fx ?? "off"),
      mix: { ...now.voice?.mix, ...Object.fromEntries(given.map(([k, v]) => [keys[k], v])) },
    })!;
    await saveEdit({ ...now, voice });
    return { ...now, voice };
  });
  if (!e) return notFound(c);
  await recutSound(e, [name], r.user);
  return c.json({ voice: e.voice }, 201);
});

editorApp.post("/:id/run", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const b = await body(c);
  const from = b.from ?? "analyze";
  if (!EDIT_STEPS.includes(from as EditStep)) return c.json({ error: "Unknown step", code: "invalid" }, 400);
  // now: cut from the footage the Media Library has ready and name the rest (plan.ts), for this run and until a run without it
  if (!!b.now !== !!r.e.now) {
    const { now: _, ...rest } = r.e;
    await saveEdit(b.now === true ? { ...rest, now: true } : rest);
  }
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:`, from as string, r.user, true, "edit_jobs");
  return c.json(viewFor(r, readEdit(r.e.id)!));
});

/**
 * What the person said about the edit's cut, word for word ({text}), kept with the edit for every later version
 * (contracts/editor.ts EditFeedback), and the next version queued: it starts from the last one (plan.ts reviseOf).
 * `queued` is false while the edit is being made: that run reads it when its script is not written yet, else the next
 * version is queued with it when the run ends (worker.ts queueNext). A note past EDIT_FEEDBACK_TEXT_MAX characters is
 * refused with the reason, never cut.
 */
editorApp.post("/:id/feedback", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const text = (await body(c)).text;
  if (typeof text !== "string" || !text.trim()) return c.json({ error: "text is what the person said about the cut", code: "invalid" }, 400);
  if (text.length > EDIT_FEEDBACK_TEXT_MAX) return c.json({ error: `A note is ${EDIT_FEEDBACK_TEXT_MAX.toLocaleString("en-US")} characters at most`, code: "invalid" }, 400);
  const variant = newestDraft(r.e.id);
  await addFeedback(r.e.id, [{ at: Date.now(), from: "chat", by: c.get("user").username, ...(variant ? { variant } : {}), text }]);
  const db = libraryDb();
  const busy = !!db.prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").get(r.e.id);
  if (!busy) queueVersion(r.e, r.user);
  return c.json({ ...viewFor(r, readEdit(r.e.id)!), queued: !busy });
});

editorApp.post("/:id/jobs/:jobId/retry", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const job = libraryDb().prepare("SELECT version_id, kind FROM edit_jobs WHERE id = ? AND edit_id = ?").get(Number(c.req.param("jobId")), r.e.id) as
    | { version_id: string; kind: string }
    | undefined;
  if (!job) return notFound(c);
  // a failed or needs_key step starts again from zero; a queued, running or done one stays as it is
  enqueueJob(libraryDb(), r.e.workspaceId, job.version_id, job.kind, r.user, false, "edit_jobs");
  return c.json(viewFor(r));
});

/** Steps the person starts by hand (POST /:id/jobs): the whole edit's, or one version's. The others follow the step before them (engine.ts). */
const WHOLE_STEPS = ["analyze", "script"];
const VERSION_STEPS = ["draft", "broll", "cards", "post", "sound", "preview"];

/** One step queued ({kind, variant} or the phone's {kind, draft}): 201 with the job, 409 while any step of the edit is queued or running. */
editorApp.post("/:id/jobs", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const b = await body(c);
  const kind = typeof b.kind === "string" ? b.kind : "";
  const whole = WHOLE_STEPS.includes(kind);
  if (!whole && !VERSION_STEPS.includes(kind)) return c.json({ error: "Unknown step", code: "invalid" }, 400);
  const variant = whole ? "" : typeof b.variant === "string" ? b.variant : typeof b.draft === "string" ? b.draft : "";
  // a version's cut is made from its plan; every other step works on a cut it has
  const known = kind === "draft" ? !!readStep(r.e.id, "plan")?.plans.some((p) => p.name === variant) : draftNames(r.e.id).includes(variant);
  if (!whole && !known) return c.json({ error: "Unknown version", code: "invalid" }, 400);
  const db = libraryDb();
  const vid = `${r.e.id}:${variant}`;
  // one step of an edit at a time, as Carry on and feedback wait: a preview of a cut still being drafted would be half of it
  if (db.prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").get(r.e.id)) return c.json({ error: "This edit is still being made", code: "conflict" }, 409);
  // an edit in passes: a pass started here is recorded as the go would record it, so it is not offered again
  if (nextPass(r.e, variant) === kind) await markPasses(r.e.id, { [variant]: kind as Pass });
  enqueueJob(db, r.e.workspaceId, vid, kind, r.user, true, "edit_jobs");
  return c.json(jobsOf(r.e.id).find((j) => j.kind === kind && j.variant === variant), 201);
});

/**
 * The person's go on what waits for it (todo.ts): a look sheet's cards are laid on the cut, or with `note` made again
 * answering it (a new sheet); a held pass of an edit in passes is queued, as Approve in Review queues it (passes.ts).
 */
editorApp.post("/:id/jobs/:job/go", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const db = libraryDb();
  const row = db.prepare("SELECT id, version_id, kind, state FROM edit_jobs WHERE id = ? AND edit_id = ?").get(Number(c.req.param("job")), r.e.id) as
    | { id: number; version_id: string; kind: string; state: string }
    | undefined;
  if (!row) return notFound(c);
  const variant = row.version_id.slice(r.e.id.length + 1);
  const b = await body(c);
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length > EDIT_FEEDBACK_TEXT_MAX) return c.json({ error: `A note is ${EDIT_FEEDBACK_TEXT_MAX.toLocaleString("en-US")} characters at most`, code: "invalid" }, 400);
  // running too: the step re-reads its state as it goes back to waiting (cards/step.ts lookSheetWait)
  const st = row.kind === "cards" && (row.state === "queued" || row.state === "running") && sheetOf(r.e.id, variant) ? readCards(r.e.id, variant) : null;
  if (st) {
    if (note) {
      const notes = (st.sheetNotes ?? 0) + 1;
      if (notes > MAX_SHEET_NOTES) return c.json({ error: `That is ${MAX_SHEET_NOTES} notes on these cards: give the go, or Make cards again`, code: "conflict" }, 409);
      // made again from nothing with the note: a new plan, script and draw, then a new sheet
      await clearCards(r.e.id, variant);
      await saveCards(r.e.id, variant, { style: st.style, calls: 0, draws: 0, drawn: [], liked: [], sheetNote: note, sheetNotes: notes });
    } else await saveCards(r.e.id, variant, { ...st, go: true });
    db.prepare("UPDATE edit_jobs SET run_after = 0 WHERE id = ? AND state = 'queued'").run(row.id);
    return c.json(viewFor(r, readEdit(r.e.id)!));
  }
  if (heldPasses(r.e).some((h) => h.job === row.id)) {
    if (note) return c.json({ error: "A note on the cut goes in Review or the chat; the go starts the next pass", code: "invalid" }, 400);
    // as Approve in Review gives it (passes.ts), one press at a time: a second quick press finds the pass recorded
    const p = nextPass(r.e, variant);
    if (p && (await serial(() => approvePass(readEdit(r.e.id)!, variant, PASS_WORD[p], r.user)))) return c.json(viewFor(r, readEdit(r.e.id)!));
  }
  return c.json({ error: "Nothing here waits for a go", code: "conflict" }, 409);
});

/** A waiting look sheet's picture (EditJob.sheet). */
editorApp.get("/:id/jobs/:job/sheet.jpg", async (c) => {
  const r = await load(c, true);
  const row = r && (libraryDb().prepare("SELECT version_id FROM edit_jobs WHERE id = ? AND edit_id = ? AND kind = 'cards'").get(Number(c.req.param("job")), r.e.id) as { version_id: string } | undefined);
  const bytes = row && (await readFile(sheetFile(r.e.id, row.version_id.slice(r.e.id.length + 1))).catch(() => null));
  return bytes ? new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } }) : notFound(c);
});

editorApp.post("/:id/stop", async (c) => {
  const r = await load(c);
  if (!r) return notFound(c);
  stopEdit(r.e.id);
  return c.json(viewFor(r));
});

editorApp.put("/:id/eyeline/:versionId", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const v = c.req.param("versionId");
  const y = (await body(c)).y;
  if (!r.e.sources.includes(v)) return notFound(c);
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 1) return c.json({ error: "y is a fraction of the picture's height, 0 to 1", code: "invalid" }, 400);
  await saveEdit({ ...r.e, eyeline: { ...r.e.eyeline, [v]: y } });
  return c.json(viewFor(r, readEdit(r.e.id)!));
});

/** What analyze found, so the page can play a take from its seconds. */
editorApp.get("/:id/sentences", async (c) => {
  const r = await load(c);
  return r ? c.json(readStep(r.e.id, "analysis")?.sentences ?? []) : notFound(c);
});

/** The take picker's takes of one line (contracts LineTakes), cut as the draft step cuts them; nothing is decoded. */
editorApp.get("/:id/takes/:line", async (c) => {
  const r = await load(c, true);
  const line = r && readStep(r.e.id, "plan")?.lines.find((l) => l.id === c.req.param("line"));
  if (!r || !line) return notFound(c);
  return c.json(await lineTakes(line, readStep(r.e.id, "analysis")?.sentences ?? [], r.e.style?.pace === "natural" ? NATURAL_CUT : undefined));
});

/**
 * The script table's changes (PlansPatch): each version named gets the line order and takes sent, every take one the
 * line has. Only those versions are drafted again, with no AI.
 */
editorApp.put("/:id/lines", async (c) => {
  const r = await load(c, true);
  if (!r) return notFound(c);
  const plan = readStep(r.e.id, "plan");
  if (!plan) return c.json({ error: "There is no script yet", code: "conflict" }, 409);
  const sent = (await body(c)).plans;
  const bad = (why: string) => c.json({ error: why, code: "invalid" }, 400);
  if (!Array.isArray(sent) || !sent.length) return bad("plans is a list of versions");
  const next = new Map(plan.plans.map((p) => [p.name, p]));
  for (const p of sent as { name?: unknown; lines?: unknown }[]) {
    const old = next.get(String(p?.name));
    if (!old || !Array.isArray(p.lines) || !p.lines.length) return bad(`No version ${String(p?.name)} in the script`);
    const lines: VersionPlan["lines"] = [];
    for (const l of p.lines as { line?: unknown; take?: { first?: unknown; last?: unknown } }[]) {
      const take = plan.lines.find((x) => x.id === l?.line)?.takes.find((t) => t.first === l.take?.first && t.last === l.take?.last);
      if (!take) return bad(`Line ${String(l?.line)} has no such take`);
      lines.push({ line: String(l.line), take });
    }
    next.set(old.name, { ...old, lines });
  }
  await saveStep(r.e.id, "plan", { ...plan, plans: plan.plans.map((p) => next.get(p.name)!) });
  const names = new Set((sent as { name: string }[]).map((p) => p.name));
  for (const n of names) enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${n}`, "draft", r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

/** Renders the draft's preview again and files it in Review as the next version (the chain does this after a draft). */
editorApp.post("/:id/drafts/:name/review", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  if (!r || !readDraft(r.e.id, name)) return notFound(c);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "preview", r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

/**
 * Revise the draft from its Review comments (revise.ts): the open comments on its newest Review version, each answered,
 * the cut changed only where they ask, as the draft's next version. 409 while the version is being made; 400 with no
 * open comments or no version in Review.
 */
editorApp.post("/:id/drafts/:name/revise", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  if (jobsOf(r.e.id).some((j) => j.variant === name && (j.state === "queued" || j.state === "running"))) return c.json({ error: "This version is still being made", code: "conflict" }, 409);
  const got = await openComments(r.e.id, name, d.timeline);
  if (typeof got === "string") return c.json({ error: got, code: "invalid" }, 400);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "revise", r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

/** Notes this route writes start with this, so the next hand cut replaces them. */
const HAND_NOTE = "Cut by hand";
const AI_NOTE = "Cut by the AI";

/** The Review version whose cut is exactly the draft as it is now; null when the draft changed since, or was never filed. */
function filedAs(id: string, name: string, tl: Timeline) {
  const at = readStep(id, "review")?.[name];
  const filed = at && readFiled(id, at.assetId, at.n);
  return at && filed && filed.variant === name && JSON.stringify(filed.timeline) === JSON.stringify(tl) ? at : null;
}

/**
 * Timeline edits cut into the draft with no AI: the edits as made, or none of them (edits.ts). With `asset` and `n`: made
 * in Review on that version of the draft's video, which must be the newest. Without: made on the draft as it is now (its
 * `view`, the editor's timeline page); `edits` may be empty then when the draft is not what Review has (clips were put on
 * it): it is rendered as it is. The draft it replaces is kept as a revision. The cut then goes through post-processing
 * again (a longer shot shows frames the old copies never covered), is rendered and is filed in Review as the next version.
 */
editorApp.post("/:id/drafts/:name/cut", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const b = await body(c);
  const bad = (error: string, code: "invalid" | "conflict") => c.json({ error, code }, code === "invalid" ? 400 : 409);
  const inReview = b.asset !== undefined || b.n !== undefined;
  let base = d.timeline;
  let on = "";
  if (inReview) {
    const at = readStep(r.e.id, "review")?.[name];
    if (!at || at.assetId !== b.asset || at.n !== b.n) return bad("A newer version of this cut is in Review: make your edits on that one", "conflict");
    const filed = readFiled(r.e.id, at.assetId, at.n);
    if (!filed || filed.variant !== name) return bad("This version was filed before its timeline could be edited: file the cut in Review again first", "conflict");
    base = filed.timeline;
    on = ` on version ${at.n}`;
  }
  if (jobsOf(r.e.id).some((j) => j.variant === name && (j.state === "queued" || j.state === "running"))) return bad("This version is still being made", "conflict");
  const edits = cleanEdits(b.edits);
  if (!edits.length && (inReview || filedAs(r.e.id, name, d.timeline))) return bad("There are no timeline edits to make", "invalid");
  if (edits.length) {
    let timeline;
    try {
      timeline = applyEdits(base, edits);
    } catch (e) {
      if (e instanceof EditRefused) return bad(e.message, "invalid");
      throw e;
    }
    const count = `${edits.length} timeline edit${edits.length === 1 ? "" : "s"}`;
    await saveCutDraft(c, r, name, d, timeline, `${inReview ? "in Review" : "on the timeline"}: ${count}${on} (${describeEdits(edits, base.fps)})`);
  }
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "post", r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

/** A cut kept as the draft (the one it replaces kept as a revision), with a note of what changed, so a later chat turn knows. */
async function saveCutDraft(c: C, r: Loaded, name: string, d: NonNullable<ReturnType<typeof readDraft>>, timeline: Timeline, what: string) {
  // an AI key's cut (a chat's editor_cut) is not the person's own
  const by = c.req.header("authorization") && !c.req.header("cookie") ? AI_NOTE : HAND_NOTE;
  // the earlier cuts stay with it, the last five in all, so the chat knows every change, not only the newest
  const isCut = (n: string) => n.startsWith(HAND_NOTE) || n.startsWith(AI_NOTE);
  let older = d.notes.filter(isCut).length - 4;
  await saveDraft(r.e.id, name, { timeline, notes: [...d.notes.filter((n) => !isCut(n) || --older < 0), `${by} ${what}`] });
}

/**
 * The editor's whole timeline (src/lib/nle, as it saves it) kept as the draft and rendered, with no AI: judged first
 * (lib/nle/check.ts; a version this server doesn't render is refused, never saved down), every field it doesn't know
 * kept. A clip new to the draft must be a Media Library clip in the edit's workspace that the caller sees; its frame
 * rate, length and size come from the library. Then post-processing, its render, and Review, as /cut.
 */
editorApp.put("/:id/drafts/:name/timeline", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const b = await body(c);
  const bad = (error: string, code: "invalid" | "conflict" = "invalid") => c.json({ error, code }, code === "invalid" ? 400 : 409);
  const nle = b.timeline as NleTimeline | undefined;
  if (!nle || typeof nle !== "object" || typeof nle.tracks !== "object" || typeof nle.sources !== "object" || typeof nle.timeline !== "object") return bad("timeline is the editor's whole timeline");
  if (jobsOf(r.e.id).some((j) => j.variant === name && (j.state === "queued" || j.state === "running"))) return bad("This version is still being made", "conflict");
  const added = Object.keys(nle.sources).filter((k) => !d.timeline.sources[k]);
  if (added.length && (await editSources(r.user, added)) !== r.e.workspaceId) return bad("A clip on the timeline isn't in this edit's workspace's Media Library");
  const db = libraryDb();
  const sources = { ...nle.sources };
  for (const k of added) {
    const row = db.prepare("SELECT a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(k) as { title: string; probe: string | null } | undefined;
    const probe = row?.probe ? (JSON.parse(row.probe) as ProbeSummary) : null;
    if (!row || !probe?.duration) return bad(`${row?.title ?? "A clip"} is not ready yet`, "conflict");
    sources[k] = { ...sources[k], ...sourceOf(k, row.title, probe) };
  }
  // what the draft already had that the renders don't draw (a planned edit's speeds) stays; nothing new is added
  const problems = handCheck({ ...nle, sources }, rendersOf(d.timeline), toNle(d.timeline));
  if (problems.length) return bad(refusal(problems));
  const timeline = fromNle({ ...nle, sources });
  // a draft keeps its five tracks, whatever the editor sent
  for (const t of TRACKS) timeline.tracks[t] ??= { name: t, items: [] };
  await saveCutDraft(c, r, name, d, timeline, "on the timeline: the whole timeline saved");
  if (added.length) await saveEdit({ ...r.e, sources: [...new Set([...r.e.sources, ...added])] });
  enqueueJob(db, r.e.workspaceId, `${r.e.id}:${name}`, "post", r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

/**
 * The draft as a new version of the edit (the next free v1…v9), with no AI: its timeline and notes, named "<its name>
 * copy". Post-processing and its preview are made for it, which files it in Review as a video of its own.
 */
editorApp.post("/:id/drafts/:name/duplicate", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const taken = new Set(draftNames(r.e.id));
  const to = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `v${n}`).find((n) => !taken.has(n));
  if (!to) return c.json({ error: "An edit has nine versions at most: delete one for good first", code: "conflict" }, 409);
  const title = r.e.marks?.[name]?.label ?? readStep(r.e.id, "plan")?.plans.find((p) => p.name === name)?.title ?? name;
  const tl = d.timeline;
  await saveDraft(r.e.id, to, { timeline: { ...tl, name: tl.name?.endsWith(name) ? `${tl.name.slice(0, -name.length)}${to}` : tl.name }, notes: d.notes });
  await saveEdit({ ...r.e, marks: { ...r.e.marks, [to]: { label: `${title} copy`.slice(0, 120) } } });
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${to}`, "post", r.user, true, "edit_jobs");
  return c.json({ name: to }, 201);
});

/**
 * A Media Library clip as the editor lays it on this draft (the bin): its source as the draft would keep it (rate,
 * length, size from the library) and whether it has sound, so a picture with none brings no voice clip. The clip must be
 * in the edit's workspace and seen by the caller; 409 while it isn't probed yet.
 */
editorApp.get("/:id/clips/:clip", async (c) => {
  const r = await load(c, true);
  const clip = c.req.param("clip");
  if (!r || (await editSources(r.user, [clip])) !== r.e.workspaceId) return notFound(c);
  const row = libraryDb().prepare("SELECT a.title, v.probe FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(clip) as { title: string; probe: string | null } | undefined;
  const probe = row?.probe ? (JSON.parse(row.probe) as ProbeSummary) : null;
  if (!row || !probe?.duration) return c.json({ error: "This clip is not ready yet", code: "conflict" }, 409);
  return c.json({ source: sourceOf(clip, row.title, probe), sound: !!probe.acodec });
});

/** The editor's sources' sound for Normalize and Lower Under Voice (sound.ts): `sources` are library version ids. */
editorApp.post("/sound", async (c) => {
  const b = await body(c);
  const ids = Array.isArray(b.sources) ? b.sources.filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return c.json({ error: "sources is a list of clip ids", code: "invalid" }, 400);
  return c.json(await (await import("./sound")).soundOf(c.get("user").username, ids));
});

/** A version's newest preview: its Review version's video (the phone plays this). A deleted version has none. */
editorApp.get("/:id/drafts/:name/preview", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const p = r && !r.e.marks?.[name]?.trashedAt && readStep(r.e.id, "review")?.[name];
  return p ? c.redirect(`/api/review/assets/${encodeURIComponent(p.assetId)}/v/${p.n}/play`) : notFound(c);
});

/**
 * A version's draft with its checks, run against the edit's other drafts as they are now; `view`, the draft as an editable
 * timeline (what /cut's edits name without a Review version), and `filed`, the Review version that is exactly this draft.
 */
editorApp.get("/:id/drafts/:name", async (c) => {
  const r = await load(c);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const others = Object.fromEntries(
    draftNames(r.e.id)
      .filter((n) => n !== name)
      .flatMap((n) => {
        const o = readDraft(r.e.id, n);
        return o ? [[n, o.timeline]] : [];
      }),
  );
  return c.json({ ...d, qa: qaOf(d.timeline, others), exportGaps: exportGaps(d.timeline, !!(await gradeOf(ownerOf(r.e), r.e.bundle))), view: draftView(d.timeline, wordsFor(d.timeline)), filed: filedAs(r.e.id, name, d.timeline), renders: rendersOf(d.timeline) });
});

/**
 * The draft for the user's own editor: OTIO, FCPXML, FCP 7 XML (`xml`, Premiere), CMX3600 EDL (`edl`, the speaker's
 * track), or all of them in a zip with a README of what each carries (with download links when the footage is in a bucket).
 */
editorApp.get("/:id/drafts/:name/export", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const format = c.req.query("format") ?? "zip";
  if (!["otio", "fcpxml", "xml", "edl", "zip"].includes(format)) return c.json({ error: "format is otio, fcpxml, xml, edl or zip", code: "invalid" }, 400);
  const tl = d.timeline;
  // read again, as the worker does: footage trashed or a library left since means no new links or download URLs
  // (a card is the edit's own file, not footage: TimelineSource.file)
  const footage = Object.keys(tl.sources).filter((k) => !tl.sources[k]!.file);
  if (footage.length && (await editSources(r.user, footage)) !== r.e.workspaceId) return notFound(c);
  if (postUnfinished(r.e.id, name)) return c.json({ error: POST_UNFINISHED, code: "post_unfinished" }, 409);
  const asker = c.req.query("device");
  const m = await mediaPaths(r.e, Object.keys(tl.sources), tl.sources, format === "zip", asker && deviceOf(asker)?.owner === r.user ? asker : undefined);
  if (m.refused && !m.refused.ok) return c.json(m.refused.body, m.refused.status);
  Object.assign(m.files, postFiles(r.e.id, name));   // the post-processing copies, as the preview plays them
  const base = `${r.e.name} ${name}`.replace(/[^\w .-]+/g, "_").trim() || name;
  const otio = async () => otioText(toOtio(tl, m.files, await gradeOf(ownerOf(r.e), r.e.bundle)));
  const send = (body: string | Buffer, file: string, type: string) =>
    new Response(body, { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" } });
  if (format === "otio") return send(await otio(), `${base}.otio`, "application/json");
  if (format === "fcpxml") return send(toFcpxml(tl, m.files), `${base}.fcpxml`, "application/xml");
  if (format === "xml") return send(toFcp7Xml(tl, m.files), `${base}.xml`, "application/xml");
  if (format === "edl") return send(toEdl(tl, m.files), `${base}.edl`, "text/plain; charset=utf-8");
  const zip = new ZipFile();
  const at = { mtime: new Date("2000-01-01T00:00:00Z") };
  zip.addBuffer(Buffer.from(await otio()), `${base}/${base}.otio`, at);
  zip.addBuffer(Buffer.from(toFcpxml(tl, m.files)), `${base}/${base}.fcpxml`, at);
  zip.addBuffer(Buffer.from(toFcp7Xml(tl, m.files)), `${base}/${base}.xml`, at);
  for (const t of edlTracks(tl)) zip.addBuffer(Buffer.from(toEdl(tl, m.files, t)), `${base}/${base}${t === "V1" ? "" : `.${t}`}.edl`, at);
  zip.addBuffer(Buffer.from(handoverReadme(base, tl, exportGaps(tl, !!(await gradeOf(ownerOf(r.e), r.e.bundle))))), `${base}/README.txt`, at);
  for (const o of m.own) zip.addFile(o.file, `${base}/media/${o.name}`, at);
  if (m.downloads.length) {
    const hours = LINK_TTL_S / 3600;
    const list = [`Download these into the media folder next to the timeline, then open the timeline (links work for ${hours} hours):`, ""];
    for (const x of m.downloads) list.push(x.name, x.url, "");
    zip.addBuffer(Buffer.from(list.join("\n")), `${base}/media/Download media.txt`, at);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const ch of zip.outputStream) chunks.push(ch as Buffer);
  return send(Buffer.concat(chunks), `${base}.zip`, "application/zip");
});

/**
 * The next round from a timeline sent back ({ file, text }: an OTIO, FCPXML, FCP 7 XML or EDL exported from the person's
 * editing app after they changed the draft there): the file's cuts become the draft, with no AI (sent-back.ts), the one it
 * replaces kept as a revision. Then post-processing, its render, and Review, as /cut. `?device=` as the export's.
 */
editorApp.post("/:id/drafts/:name/sent-back", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const b = await body(c);
  const bad = (error: string, code: "invalid" | "conflict" = "invalid") => c.json({ error, code }, code === "invalid" ? 400 : 409);
  const file = typeof b.file === "string" && b.file.trim() ? b.file.trim().slice(0, 200) : "timeline";
  if (typeof b.text !== "string" || !b.text.trim()) return bad("text is the timeline file's contents");
  if (b.text.length > MAX_TIMELINE_BYTES) return bad("That timeline file is too big");
  if (jobsOf(r.e.id).some((j) => j.variant === name && (j.state === "queued" || j.state === "running"))) return bad("This version is still being made", "conflict");
  const asker = c.req.query("device");
  const m = await mediaPaths(r.e, Object.keys(d.timeline.sources), d.timeline.sources, false, asker && deviceOf(asker)?.owner === r.user ? asker : undefined);
  const files = { ...m.files, ...postFiles(r.e.id, name) };
  let timeline: Timeline;
  try {
    const fmt = formatOf(b.text);
    timeline = fromSentBack(d.timeline, files, importTimeline(file, b.text, d.timeline.fps), timelineSources(file, b.text, d.timeline.fps), fmt);
  } catch (e) {
    if (e instanceof SentBackRefused || e instanceof TimelineError) return bad(e.message);
    throw e;
  }
  await saveCutDraft(c, r, name, d, timeline, `in another editing app: ${file} sent back (${sentBackSummary(d.timeline, timeline)})`);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "post", r.user, true, "edit_jobs");
  return c.json(viewFor(r));
});

/** Out of the trash again: the Undo of DELETE, for the same people. */
editorApp.post("/:id/restore", async (c) => {
  const user = c.get("user").username;
  const e = readEdit(c.req.param("id"));
  const role = e?.trashedAt ? await editRole(user, { ...e, trashedAt: undefined }) : null;
  if (!e || !role) return notFound(c);
  if (!mayRename(user, e, role)) return c.json(NOT_YOURS, 403);
  const { trashedAt: _, ...rest } = e;
  await saveEdit(rest);
  return c.json({ ok: true });
});

/** A version renamed ({ label }, "" takes the name off) or deleted ({ trashed: true }; false is its Undo): the project page hides a deleted one, its draft and Review video stay. */
editorApp.patch("/:id/versions/:name", async (c) => {
  const r = await load(c, true);
  const name = c.req.param("name");
  if (!r || !draftNames(r.e.id).includes(name)) return notFound(c);
  const b = await body(c);
  const m: VersionMark = { ...r.e.marks?.[name] };
  if (b.label !== undefined) {
    if (typeof b.label !== "string") return c.json({ error: "label is the version's name", code: "invalid" }, 400);
    const label = b.label.trim().slice(0, 120);
    if (label) m.label = label;
    else delete m.label;
  }
  if (b.trashed !== undefined) {
    if (typeof b.trashed !== "boolean") return c.json({ error: "trashed is true or false", code: "invalid" }, 400);
    if (b.trashed) m.trashedAt = Date.now();
    else delete m.trashedAt;
  }
  const marks = { ...r.e.marks };
  if (Object.keys(m).length) marks[name] = m;
  else delete marks[name];
  await saveEdit({ ...r.e, marks });
  return c.json(marks);
});

editorApp.delete("/:id", async (c) => {
  const r = await load(c);
  if (!r) return notFound(c);
  if (!mayRename(r.user, r.e, r.role)) return c.json(NOT_YOURS, 403);
  stopEdit(r.e.id);
  await saveEdit({ ...r.e, trashedAt: Date.now() });
  return c.json({ ok: true });
});
