import { Hono, type Context } from "hono";
import { EDIT_SLOTS, EDIT_STEPS, type EditSlot, type EditStep, type VersionPlan } from "../../contracts/editor";
import type { AuthVars } from "../auth";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { ZipFile } from "yazl";
import { toFcpxml } from "./fcpxml";
import { footageTargetFor } from "./ingest";
import { LINK_TTL_S, mediaPaths } from "./media";
import { toOtio } from "./otio";
import { qaOf } from "./qa";
import { allEdits, cleanBrief, createEdit, draftNames, editorDefaults, editRole, gradeOf, NoCollection, NoStyle, readDraft, readEdit, postFiles, readStep, saveEdit, saveStep, setChosenDefault, sourcesWorkspace, styleFields, summaryOf, viewOf, type EditMeta } from "./store";
import { createStyle, deleteStyle, stylesView, updateStyle } from "./styles";
import { stopEdit } from "./worker";

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

/** The caller's own edit, or null (answer 404). */
function load(c: C): { e: EditMeta } | null {
  const e = readEdit(c.req.param("id") ?? "");
  return e && editRole(c.get("user").username, e) ? { e } : null;
}

editorApp.post("/", async (c) => {
  const user = c.get("user").username;
  try {
    const e = await createEdit(user, await body(c));
    return e ? c.json({ id: e.id }) : notFound(c);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    if (e instanceof NoStyle) return c.json({ error: e.message, code: "not_found" }, 404);
    throw e;
  }
});

editorApp.get("/", (c) => {
  const user = c.get("user").username;
  const list = allEdits()
    .filter((e) => !e.trashedAt && e.createdBy === user)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(list.map(summaryOf));
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

/** A new style from the fields sent, or with `fromEdit` from an edit of the caller's own (its choices, never its brief, script or footage). */
editorApp.post("/styles", async (c) => {
  const user = c.get("user").username;
  const b = await body(c);
  const from = b.fromEdit === undefined ? undefined : readEdit(String(b.fromEdit));
  if (b.fromEdit !== undefined && !editRole(user, from ?? null)) return notFound(c);
  const made = createStyle(user, b, from ?? undefined);
  return typeof made === "string" ? c.json({ error: made, code: "invalid" }, 400) : c.json(made);
});

editorApp.put("/styles/:id", async (c) => {
  const changed = updateStyle(c.get("user").username, c.req.param("id"), await body(c));
  if (!changed) return notFound(c);
  return typeof changed === "string" ? c.json({ error: changed, code: "invalid" }, 400) : c.json(changed);
});

editorApp.delete("/styles/:id", (c) => (deleteStyle(c.get("user").username, c.req.param("id")) ? c.json({ ok: true }) : notFound(c)));

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
    if (typeof b.style === "string") styled = await styleFields(r.e.createdBy, r.e.workspaceId, b.style, r.e.bundle);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    if (e instanceof NoStyle) return c.json({ error: e.message, code: "not_found" }, 404);
    throw e;
  }
  delete patch.framing; // set per source in a later step
  // a flag the patch leaves out keeps its state
  const e = { ...r.e, ...styled, ...patch, flags: { ...r.e.flags, ...patch.flags } };
  if (b.style === null) delete e.style;
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
  if (sourcesWorkspace(c.get("user").username, Object.keys(tl.sources)) !== r.e.workspaceId) return notFound(c);
  const m = await mediaPaths(r.e, Object.keys(tl.sources));
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
