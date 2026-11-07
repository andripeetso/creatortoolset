import { Hono, type Context } from "hono";
import { EDIT_STEPS, type EditStep } from "../../contracts/editor";
import type { AuthVars } from "../auth";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { workspaceById, memberIn } from "../lib/workspaces";
import { qaOf } from "./qa";
import { allEdits, cleanBrief, createEdit, draftNames, editRole, NoCollection, readDraft, readEdit, saveEdit, summaryOf, viewOf, type EditMeta } from "./store";
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

/** The edit and the caller's role on it, or null (answer 404). */
function load(c: C): { e: EditMeta; role: "creator" | "owner" } | null {
  const e = readEdit(c.req.param("id") ?? "");
  const role = editRole(c.get("user").username, e);
  return e && role ? { e, role } : null;
}

editorApp.post("/", async (c) => {
  const user = c.get("user").username;
  try {
    const e = await createEdit(user, await body(c));
    return e ? c.json({ id: e.id }) : notFound(c);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    throw e;
  }
});

editorApp.get("/", (c) => {
  const user = c.get("user").username;
  const owns = (ws: string) => {
    const w = workspaceById(ws);
    return !!w && memberIn(w, user)?.role === "owner";
  };
  const list = allEdits()
    .filter((e) => !e.trashedAt && (e.createdBy === user || owns(e.workspaceId)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return c.json(list.map(summaryOf));
});

editorApp.get("/:id", (c) => {
  const r = load(c);
  return r ? c.json(viewOf(r.e, c.get("user").username)) : notFound(c);
});

editorApp.patch("/:id", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  if (r.role !== "creator") return c.json({ error: "Only the edit's creator can change it", code: "forbidden" }, 403);
  let patch;
  try {
    patch = cleanBrief(await body(c), r.e.createdBy, r.e.workspaceId);
  } catch (e) {
    if (e instanceof NoCollection) return notFound(c);
    throw e;
  }
  delete patch.framing; // set per source in a later step
  const e = { ...r.e, ...patch };
  await saveEdit(e);
  return c.json(viewOf(readEdit(e.id)!, e.createdBy));
});

editorApp.post("/:id/run", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  if (r.role !== "creator") return c.json({ error: "Only the edit's creator can run it: it runs on their own AI and keys", code: "forbidden" }, 403);
  const from = (await body(c)).from ?? "analyze";
  if (!EDIT_STEPS.includes(from as EditStep)) return c.json({ error: "Unknown step", code: "invalid" }, 400);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:`, from as string, r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e, r.e.createdBy));
});

editorApp.post("/:id/jobs/:jobId/retry", (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  if (r.role !== "creator") return c.json({ error: "Only the edit's creator can run it: it runs on their own AI and keys", code: "forbidden" }, 403);
  const job = libraryDb().prepare("SELECT version_id, kind FROM edit_jobs WHERE id = ? AND edit_id = ?").get(Number(c.req.param("jobId")), r.e.id) as
    | { version_id: string; kind: string }
    | undefined;
  if (!job) return notFound(c);
  // a failed or needs_key step starts again from zero; a queued, running or done one stays as it is
  enqueueJob(libraryDb(), r.e.workspaceId, job.version_id, job.kind, r.e.createdBy, false, "edit_jobs");
  return c.json(viewOf(r.e, r.e.createdBy));
});

editorApp.post("/:id/stop", (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  stopEdit(r.e.id);
  return c.json(viewOf(r.e, c.get("user").username));
});

editorApp.put("/:id/eyeline/:versionId", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  if (r.role !== "creator") return c.json({ error: "Only the edit's creator can change it", code: "forbidden" }, 403);
  const v = c.req.param("versionId");
  const y = (await body(c)).y;
  if (!r.e.sources.includes(v)) return notFound(c);
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0 || y > 1) return c.json({ error: "y is a fraction of the picture's height, 0 to 1", code: "invalid" }, 400);
  await saveEdit({ ...r.e, eyeline: { ...r.e.eyeline, [v]: y } });
  return c.json(viewOf(readEdit(r.e.id)!, r.e.createdBy));
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

editorApp.delete("/:id", async (c) => {
  const r = load(c);
  if (!r) return notFound(c);
  stopEdit(r.e.id);
  await saveEdit({ ...r.e, trashedAt: Date.now() });
  return c.json({ ok: true });
});
