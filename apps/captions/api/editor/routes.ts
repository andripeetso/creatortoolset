import { Hono, type Context } from "hono";
import { EDIT_SLOTS, EDIT_STEPS, type EditSlot, type EditStep, type VersionPlan } from "../../contracts/editor";
import { innerCall, type AuthVars } from "../auth";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { onUploadDone } from "../library/routes";
import { ZipFile } from "yazl";
import { toFcpxml } from "./fcpxml";
import { footageTargetFor } from "./ingest";
import { notTyped } from "./own-words";
import { LINK_TTL_S, mediaPaths } from "./media";
import { toOtio } from "./otio";
import { qaOf } from "./qa";
import { forgetFinished, finishedOf, removeFinished } from "./finished";
import { allEdits, byToolAfter, cleanBrief, createEdit, uploadFinished, draftNames, editorDefaults, editRole, gradeOf, NoCollection, NoStyle, readDraft, readEdit, POST_UNFINISHED, postFiles, postUnfinished, readStep, saveEdit, saveStep, setChosenDefault, sourcesWorkspace, styleFields, summaryOf, viewOf, type EditMeta, jobsOf, readFiled, saveDraft } from "./store";
import { cleanEdits } from "../../contracts/edit-timeline";
import { applyEdits, EditRefused } from "./edits";
import { animationApp } from "./animation-styles";
import { voiceApp } from "./voice";
import { cardsApp } from "./cards/routes";
import { markPasses, nextPass } from "./passes";
import { createStyle, deleteStyle, findStyle, markAsked, stylesView, updateStyle } from "./styles";
import { stopEdit } from "./worker";
import { inProjectOf, projectOf } from "../lib/project-of";
import { resolveProjectId } from "../lib/workshop/workspace";

/**
 * AI Editor routes (contracts/editor.ts), mounted at /api/editor behind the `editor` tool gate (boot.ts). An edit that
 * is not the caller's to see is 404, as one that does not exist. Run, Retry and changes are the creator's: every step
 * runs on their keys and AI, so nobody else starts one.
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

/** The caller's own edit, or null (answer 404). */
function load(c: C): { e: EditMeta } | null {
  const e = readEdit(c.req.param("id") ?? "");
  return e && editRole(c.get("user").username, e) ? { e } : null;
}

// an edit made from clips still uploading (a phone's New edit) starts once the last one is in
onUploadDone.push((id, version) => void uploadFinished(id, version));

editorApp.post("/", async (c) => {
  const user = c.get("user").username;
  try {
    const b = await body(c);
    // made in the project asked for, if it is the person's, else the one they are in
    const projectId = await resolveProjectId(c.get("user"), typeof b.projectId === "string" ? b.projectId : null);
    const e = await createEdit(user, b, viaTool(c), projectId);
    return e ? c.json({ id: e.id }) : notFound(c);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    if (e instanceof NoStyle) return c.json({ error: e.message, code: "not_found" }, 404);
    throw e;
  }
});

/**
 * The person's edits, newest first, each with the project it is in (lib/project-of.ts: an old one is the first
 * brand's); ?projectId= only those of that project of theirs.
 */
editorApp.get("/", async (c) => {
  const user = c.get("user").username;
  const [inProject, of] = await Promise.all([inProjectOf(c.get("user"), c.req.query("projectId")), projectOf(c.get("user"))]);
  const list = allEdits()
    .filter((e) => !e.trashedAt && e.createdBy === user && (!inProject || inProject(e.projectId)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(list.map((e) => ({ ...summaryOf(e), ...(of ? { projectId: of(e.projectId) } : {}) })));
});

// where footage picked from this computer is filed (api/editor/ingest.ts); registered before /:id
editorApp.get("/footage-target", async (c) => {
  const t = await footageTargetFor(c.get("user").username);
  return t ? c.json(t) : notFound(c);
});

// the defaults are registered before /:id, so "defaults" is never read as an edit id
editorApp.get("/defaults", async (c) => c.json(await editorDefaults(c.get("user").username)));

/** One slot's default: an item id the person can choose from, or null for back to the pack's or the built-in one. */
editorApp.put("/defaults/:slot", async (c) => {
  const user = c.get("user").username;
  const slot = c.req.param("slot") as EditSlot;
  if (!EDIT_SLOTS.includes(slot)) return c.json({ error: "Unknown slot", code: "invalid" }, 400);
  const id = (await body(c)).id ?? null;
  const defaults = await editorDefaults(user);
  if (id !== null && (typeof id !== "string" || !defaults.items[slot].some((i) => i.id === id))) return c.json({ error: "No such item for this slot", code: "invalid" }, 400);
  await setChosenDefault(user, slot, id);
  return c.json(await editorDefaults(user));
});

// the person's editing styles (contracts/editor-styles.ts); registered before /:id, as the defaults are
editorApp.get("/styles", (c) => c.json(stylesView(c.get("user").username)));

const NOT_TYPED = "Not saved: the notes are not the user's own words in this chat. Send a whole phrase they typed themselves, or a passage of a long text they pasted with this message, word for word, or leave notes out: they write them on the style's sheet (AI Editor, Editing styles).";

/** An editing style's notes are the person's own words, also when the assistant saves them (own-words.ts). True when the save is refused. */
const notesNotTyped = (c: C, b: Record<string, unknown>): boolean => notTyped(c, b, ["notes", "addNotes"]);

/** A new style from the fields sent, or with `fromEdit` from an edit of the caller's own (its choices, never its brief, script or footage). */
editorApp.post("/styles", async (c) => {
  const user = c.get("user").username;
  const b = await body(c);
  if (notesNotTyped(c, b)) return c.json({ error: NOT_TYPED, code: "not_typed" }, 409);
  const from = b.fromEdit === undefined ? undefined : readEdit(String(b.fromEdit));
  if (b.fromEdit !== undefined && !editRole(user, from ?? null)) return notFound(c);
  const made = createStyle(user, b, from ?? undefined, b.first === true);
  return typeof made === "string" ? c.json({ error: made, code: "invalid" }, 400) : c.json(made);
});

/** New edit's "How do you like to work?" put off (Not now): it is not shown again. */
editorApp.post("/styles/asked", (c) => {
  markAsked(c.get("user").username);
  return c.json({ ok: true });
});

/** Changes the fields sent. `addNotes` adds a line under the notes the style has (one it already holds is not added twice). */
editorApp.put("/styles/:id", async (c) => {
  const user = c.get("user").username;
  const b = await body(c);
  if (notesNotTyped(c, b)) return c.json({ error: NOT_TYPED, code: "not_typed" }, 409);
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

// the person's animation styles and their pictures (animation-styles.ts); before /:id, as the styles are
editorApp.route("/animation-styles", animationApp);
// a voice made from text, saved in the Media Library as a take (voice.ts); before /:id too
editorApp.route("/voice", voiceApp);
// a version's cards on the edit page: a still, the 👍, Make cards again (cards/routes.ts)
editorApp.route("/", cardsApp);

/** Carry on, for an edit in passes: every drafted version's next pass is queued (and recorded as done); 409 while it is being made, or when no pass is left. */
editorApp.post("/:id/pass", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  const db = libraryDb();
  if (db.prepare("SELECT 1 FROM edit_jobs WHERE edit_id = ? AND state IN ('queued', 'running')").get(r.e.id)) return c.json({ error: "This edit is still being made", code: "conflict" }, 409);
  const queued = Object.fromEntries(draftNames(r.e.id).flatMap((n) => { const p = nextPass(r.e, n); return p ? [[n, p]] : []; }));
  if (!Object.keys(queued).length) return c.json({ error: "Nothing left to do", code: "conflict" }, 409);
  await markPasses(r.e.id, queued);
  for (const [n, p] of Object.entries(queued)) enqueueJob(db, r.e.workspaceId, `${r.e.id}:${n}`, p, r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e));
});

editorApp.get("/:id", (c) => {
  const r = load(c);
  return r ? c.json(viewOf(r.e)) : notFound(c);
});

editorApp.patch("/:id", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  let patch;
  let styled: Partial<EditMeta> = {};
  const b = await body(c);
  try {
    patch = cleanBrief(b, r.e.createdBy, r.e.workspaceId);
    // `style` puts an editing style's choices on the edit, under what this patch sets itself; null takes the style off
    if (typeof b.style === "string") styled = await styleFields(r.e.createdBy, r.e.workspaceId, b.style, r.e);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    if (e instanceof NoStyle) return c.json({ error: e.message, code: "not_found" }, 404);
    throw e;
  }
  delete patch.framing; // set per source in a later step
  // a flag the patch leaves out keeps its state
  const e = { ...r.e, ...styled, ...patch, flags: { ...r.e.flags, ...patch.flags } };
  if (b.style === null) {
    delete e.style;
    delete e.size; // an edit with no style is cut at the footage's size, as before
  }
  // whose words the name and the brief are now: an AI's tool's, or the person's own (finished.ts keeps only theirs)
  const byTool = byToolAfter(r.e.byTool, patch, viaTool(c)).byTool;
  if (byTool) e.byTool = byTool;
  else delete e.byTool;
  await saveEdit(e);
  return c.json(viewOf(readEdit(e.id)!));
});

editorApp.post("/:id/run", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  const from = (await body(c)).from ?? "analyze";
  if (!EDIT_STEPS.includes(from as EditStep)) return c.json({ error: "Unknown step", code: "invalid" }, 400);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:`, from as string, r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e));
});

editorApp.post("/:id/jobs/:jobId/retry", (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  const job = libraryDb().prepare("SELECT version_id, kind FROM edit_jobs WHERE id = ? AND edit_id = ?").get(Number(c.req.param("jobId")), r.e.id) as
    | { version_id: string; kind: string }
    | undefined;
  if (!job) return notFound(c);
  // a failed or needs_key step starts again from zero; a queued, running or done one stays as it is
  enqueueJob(libraryDb(), r.e.workspaceId, job.version_id, job.kind, r.e.createdBy, false, "edit_jobs");
  return c.json(viewOf(r.e));
});

editorApp.post("/:id/stop", (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  stopEdit(r.e.id);
  return c.json(viewOf(r.e));
});

editorApp.put("/:id/eyeline/:versionId", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  const v = c.req.param("versionId");
  const y = (await body(c)).y;
  if (!r.e.sources.includes(v)) return notFound(c);
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 1) return c.json({ error: "y is a fraction of the picture's height, 0 to 1", code: "invalid" }, 400);
  await saveEdit({ ...r.e, eyeline: { ...r.e.eyeline, [v]: y } });
  return c.json(viewOf(readEdit(r.e.id)!));
});

/** What analyze found, so the page can play a take from its seconds. */
editorApp.get("/:id/sentences", (c) => {
  const r = load(c);
  return r ? c.json(readStep(r.e.id, "analysis")?.sentences ?? []) : notFound(c);
});

/**
 * The script table's changes (PlansPatch): each version named gets the line order and takes sent, every take one the
 * line has. Only those versions are drafted again, with no AI.
 */
editorApp.put("/:id/lines", async (c) => {
  const r = load(c);
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
  for (const n of names) enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${n}`, "draft", r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e));
});

/** Renders the draft's preview again and files it in Review as the next version (the chain does this after a draft). */
editorApp.post("/:id/drafts/:name/review", (c) => {
  const r = load(c);
  const name = c.req.param("name");
  if (!r || !readDraft(r.e.id, name)) return notFound(c);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "preview", r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e));
});

/** Notes this route writes start with this, so the next hand cut replaces them. */
const HAND_NOTE = "Cut by hand in Review";

/**
 * The timeline edits made in Review on a version of this draft (body: the Review video, its version n, the edits as
 * Review sends them), cut into the draft with no AI: the edits as made, or none of them (edits.ts). The draft it replaces
 * is kept as a revision. The new cut then goes through post-processing again (a longer shot shows frames the old copies
 * never covered), is rendered and is filed in Review as the next version.
 */
editorApp.post("/:id/drafts/:name/cut", async (c) => {
  const r = load(c);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const b = await body(c);
  const bad = (error: string, code: "invalid" | "conflict") => c.json({ error, code }, code === "invalid" ? 400 : 409);
  const at = readStep(r.e.id, "review")?.[name];
  if (!at || at.assetId !== b.asset || at.n !== b.n) return bad("A newer version of this cut is in Review: make your edits on that one", "conflict");
  const filed = readFiled(r.e.id, at.assetId, at.n);
  if (!filed || filed.variant !== name) return bad("This version was filed before its timeline could be edited: file the cut in Review again first", "conflict");
  if (jobsOf(r.e.id).some((j) => j.variant === name && (j.state === "queued" || j.state === "running"))) return bad("This version is still being made", "conflict");
  const edits = cleanEdits(b.edits);
  if (!edits.length) return bad("There are no timeline edits to make", "invalid");
  let timeline;
  try {
    timeline = applyEdits(filed.timeline, edits);
  } catch (e) {
    if (e instanceof EditRefused) return bad(e.message, "invalid");
    throw e;
  }
  const notes = [...d.notes.filter((n) => !n.startsWith(HAND_NOTE)), `${HAND_NOTE}: ${edits.length} timeline edit${edits.length === 1 ? "" : "s"} on version ${at.n}`];
  await saveDraft(r.e.id, name, { timeline, notes });
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "post", r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e));
});

/** A version's draft with its checks, run against the edit's other drafts as they are now. */
editorApp.get("/:id/drafts/:name", (c) => {
  const r = load(c);
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
  return c.json({ ...d, qa: qaOf(d.timeline, others) });
});

/** The draft for the user's own editor: OTIO, FCPXML, or both in a zip (with download links when the footage is in a bucket). */
editorApp.get("/:id/drafts/:name/export", async (c) => {
  const r = load(c);
  const name = c.req.param("name");
  const d = r && readDraft(r.e.id, name);
  if (!r || !d) return notFound(c);
  const format = c.req.query("format") ?? "zip";
  if (!["otio", "fcpxml", "zip"].includes(format)) return c.json({ error: "format is otio, fcpxml or zip", code: "invalid" }, 400);
  const tl = d.timeline;
  // read again, as the worker does: footage trashed or a library left since means no new links or download URLs
  // (a card is the edit's own file, not footage: TimelineSource.file)
  if (sourcesWorkspace(c.get("user").username, Object.keys(tl.sources).filter((k) => !tl.sources[k]!.file)) !== r.e.workspaceId) return notFound(c);
  if (postUnfinished(r.e.id, name)) return c.json({ error: POST_UNFINISHED, code: "post_unfinished" }, 409);
  const m = await mediaPaths(r.e, Object.keys(tl.sources), tl.sources, format === "zip");
  Object.assign(m.files, postFiles(r.e.id, name));   // the post-processing copies, as the preview plays them
  const base = `${r.e.name} ${name}`.replace(/[^\w .-]+/g, "_").trim() || name;
  const otio = async () => JSON.stringify(toOtio(tl, m.files, await gradeOf(r.e.createdBy, r.e.bundle)), null, 2);
  const send = (body: string | Buffer, file: string, type: string) =>
    new Response(body, { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" } });
  if (format === "otio") return send(await otio(), `${base}.otio`, "application/json");
  if (format === "fcpxml") return send(toFcpxml(tl, m.files), `${base}.fcpxml`, "application/xml");
  const zip = new ZipFile();
  const at = { mtime: new Date("2000-01-01T00:00:00Z") };
  zip.addBuffer(Buffer.from(await otio()), `${base}/${base}.otio`, at);
  zip.addBuffer(Buffer.from(toFcpxml(tl, m.files)), `${base}/${base}.fcpxml`, at);
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

editorApp.delete("/:id", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  stopEdit(r.e.id);
  await saveEdit({ ...r.e, trashedAt: Date.now() });
  return c.json({ ok: true });
});
