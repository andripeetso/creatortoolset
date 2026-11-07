import { Hono, type Context } from "hono";
import { EDIT_STEPS, type EditStep, type VersionPlan } from "../../contracts/editor";
import type { AuthVars } from "../auth";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { workspaceById, memberIn } from "../lib/workspaces";
import { ZipFile } from "yazl";
import { toFcpxml } from "./fcpxml";
import { LINK_TTL_S, mediaPaths } from "./media";
import { toOtio } from "./otio";
import { qaOf } from "./qa";
import { allEdits, cleanBrief, createEdit, draftNames, editRole, NoCollection, readDraft, readEdit, readStep, saveEdit, saveStep, summaryOf, viewOf, type EditMeta } from "./store";
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
  if (r.role !== "creator") return c.json({ error: "Only the edit's creator can change it", code: "forbidden" }, 403);
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
  return c.json(viewOf(r.e, r.e.createdBy));
});

/** Renders the draft's preview again and files it in Review as the next version (the chain does this after a draft). */
editorApp.post("/:id/drafts/:name/review", (c) => {
  const r = load(c);
  const name = c.req.param("name");
  if (!r || !readDraft(r.e.id, name)) return notFound(c);
  if (r.role !== "creator") return c.json({ error: "Only the edit's creator can run it: it runs on their own AI and keys", code: "forbidden" }, 403);
  enqueueJob(libraryDb(), r.e.workspaceId, `${r.e.id}:${name}`, "preview", r.e.createdBy, true, "edit_jobs");
  return c.json(viewOf(r.e, r.e.createdBy));
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
  const m = await mediaPaths(r.e, Object.keys(tl.sources));
  const base = `${r.e.name} ${name}`.replace(/[^\w .-]+/g, "_").trim() || name;
  const otio = () => JSON.stringify(toOtio(tl, m.files), null, 2);
  const send = (body: string | Buffer, file: string, type: string) =>
    new Response(body, { headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" } });
  if (format === "otio") return send(otio(), `${base}.otio`, "application/json");
  if (format === "fcpxml") return send(toFcpxml(tl, m.files), `${base}.fcpxml`, "application/xml");
  const zip = new ZipFile();
  const at = { mtime: new Date("2000-01-01T00:00:00Z") };
  zip.addBuffer(Buffer.from(otio()), `${base}/${base}.otio`, at);
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
