import type { ExportStatus } from "../../contracts/exports";
import { exportName, renderSpecOf, storedRenderData, type StoredClip } from "../../src/lib/export-request";
import { exportFailure } from "../exports";
import type { Captioning } from "../projects";
import { clock, str, ToolError, type ToolModule, when } from "./types";

// Caption Studio's tools: its projects, a project's captions read back, and its video exported with them burned in.
// Captions are the lines on the video; the text under a post is its post description, and is not here.

type Clip = StoredClip & { id: string; name: string; srcFps?: number; hasOriginal?: boolean };
type Project = { id: string; name: string; fps: number | null; clips: Clip[]; captioning?: Captioning };
/** A render as GET /api/exports lists it. */
type Export = { id: string; kind: string; filename: string; status: ExportStatus; progress: number; error?: string; projectId?: string; finals?: { status: string; error?: string } };

/** What the server is doing to a project it captions by itself (api/captions-job.ts), in words for the AI. */
const STATE: Record<Captioning, string> = {
  preparing: "Still being prepared: its captions are made next. Ask again in a minute.",
  transcribing: "Still being transcribed. Ask again in a minute.",
};
/** A long video's captions are cut here, and say so (the page has the rest). */
const TEXT_MAX = 12_000;
/** The last renders of a project that captions_get names. */
const EXPORTS_MAX = 3;

const linkOf = (origin: string, id: string) => `${origin}/captions?project=${id}`;
const sameName = (a: string, b: string) => a.toLowerCase().replace(/\.[^.]+$/, "") === b.toLowerCase().replace(/\.[^.]+$/, "");

/** A render in words: how far it is, and where the file is once it is there. */
const exportOut = (j: Export, origin: string) => ({
  export: j.id,
  file: j.filename,
  state: j.status === "done" ? "Ready" : j.status === "error" ? `Failed: ${exportFailure(j.error)}` : j.status === "queued" ? "Waiting for its turn" : `Exporting, ${Math.round(j.progress * 100)}% done`,
  ...(j.status === "done" ? { download: `${origin}/api/exports/${j.id}/file` } : {}),
  ...(j.finals?.status === "sent" ? { finals: "In Finals" } : j.finals?.error ? { finals: `Not in Finals: ${j.finals.error}` } : {}),
});

export const captionsTools: ToolModule = {
  defs: [
    {
      name: "captions_list",
      description: "Caption Studio projects, newest first: id, name, each clip and whether it has captions yet, and the link that opens it. limit = how many (default 20).",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    },
    {
      name: "captions_get",
      description: "A Caption Studio project's captions (the lines on the video, not the post description): each line with its start time, per clip, or that they are still being made; and its exports, with the download link of a finished one. project = its id (captions_list, or use_file to: captions).",
      inputSchema: { type: "object", properties: { project: str }, required: ["project"] },
    },
    {
      name: "captions_export",
      description: "Export a Caption Studio project's video with its captions burned in, as an MP4 that renders by itself (captions_get says when it is ready). project = its id; clip = its name, only when several clips have captions; format = h264 (default) or h265; finals: true also puts the file in Finals.",
      inputSchema: { type: "object", properties: { project: str, clip: str, format: { type: "string", enum: ["h264", "h265"] }, finals: { type: "boolean" } }, required: ["project"] },
    },
  ],
  handlers: {
    captions_list: async (a, ctx) => {
      const limit = Math.min(50, Math.max(1, Math.floor(Number(a.limit)) || 20));
      const all = await ctx.json<Array<{ id: string; name: string; updatedAt: number }>>("/api/projects");
      // ponytail: one read per listed project (the list route has no clips): put them in that route when people keep hundreds
      const projects = await Promise.all(
        all.slice(0, limit).map(async (m) => {
          const p = await ctx.json<Project>(`/api/projects/${m.id}`);
          return {
            id: m.id,
            name: m.name,
            changed: when(m.updatedAt),
            clips: p.clips.map((c) => ({ name: c.name, captions: !!c.cues?.length })),
            ...(p.captioning ? { state: STATE[p.captioning] } : {}),
            link: linkOf(ctx.origin, m.id),
          };
        }),
      );
      return { projects, ...(all.length > limit ? { more: all.length - limit } : {}) };
    },
    captions_get: async (a, ctx) => {
      if (!a.project) throw new ToolError("Give the project's id: captions_list lists them.");
      const p = await ctx.json<Project>(`/api/projects/${encodeURIComponent(String(a.project))}`);
      let room = TEXT_MAX;
      const clips = p.clips.map((c) => {
        const all = (c.cues ?? []).map((q) => `${clock(q.start)} ${q.words.map((w) => w.text).join(" ")}`);
        const lines = all.filter((l) => (room -= l.length) >= 0);
        if (!all.length) return { name: c.name, captions: "None yet" };
        return { name: c.name, lines, ...(lines.length < all.length ? { cut: `${all.length} lines in all: the page has the rest` } : {}) };
      });
      // its renders, newest first (the route lists this account's own, kept a day)
      const exports = (await ctx.json<Export[]>("/api/exports")).filter((j) => j.projectId === p.id && j.kind === "burn").slice(0, EXPORTS_MAX);
      return {
        id: p.id,
        name: p.name,
        ...(p.captioning ? { state: STATE[p.captioning] } : {}),
        clips,
        ...(exports.length ? { exports: exports.map((j) => exportOut(j, ctx.origin)) } : {}),
        link: linkOf(ctx.origin, p.id),
      };
    },
    captions_export: async (a, ctx) => {
      if (!a.project) throw new ToolError("Give the project's id: captions_list lists them.");
      const format = a.format === undefined ? "h264" : String(a.format);
      if (format !== "h264" && format !== "h265") throw new ToolError("format is h264 or h265.");
      const p = await ctx.json<Project>(`/api/projects/${encodeURIComponent(String(a.project))}`);
      if (p.captioning) throw new ToolError(`The captions for “${p.name}” are still being made. Export it once they are there: ask again in a minute.`);
      // the clip: the one named, else the only one with something to burn in (captions, or texts on screen)
      const drawn = p.clips.filter((c) => c.cues?.length || c.texts?.length);
      const wanted = a.clip ? String(a.clip) : "";
      const clip = wanted ? p.clips.find((c) => c.id === wanted || sameName(c.name, wanted)) : drawn.length === 1 ? drawn[0] : undefined;
      if (wanted && !clip) throw new ToolError(`“${p.name}” has no clip “${wanted}”. Its clips: ${p.clips.map((c) => c.name).join(", ")}.`);
      if (!clip && drawn.length > 1) throw new ToolError(`“${p.name}” has ${drawn.length} clips with captions: say which one (clip = its name): ${drawn.map((c) => c.name).join(", ")}.`);
      const d = clip ? storedRenderData(clip) : null;
      if (!clip || !d || (!d.cues.length && !d.texts.length)) throw new ToolError(`“${clip?.name ?? p.name}” has no captions yet, so there is nothing to burn in. They are made on the project's page (Transcribe).`);
      const gone = new ToolError(`The video “${clip.name}” is no longer on the server, so it cannot be exported. On the project's page the video can be added again.`);
      if (clip.hasOriginal === false) throw gone;
      // the request the page's Export dialog sends (src/components/ExportDialog.tsx exportOne), with the frames drawn
      // by the server: the page's default engine measures each line in the browser, which a tool cannot
      const job = await ctx.json<Export>("/api/exports", "POST", {
        kind: "burn",
        format,
        name: exportName(p.name, clip.name),
        duration: d.duration,
        projectId: p.id,
        clipId: clip.id,
        width: d.width,
        height: d.height,
        // the frame rate an opened project has (src/lib/persist.ts applyServerProject)
        fps: p.fps ?? p.clips[0]?.srcFps ?? 30,
        engine: "wysiwyg",
        renderSpec: renderSpecOf(d),
        ...(a.finals === true ? { finals: true } : {}),
        chat: true,
      }).catch((e: unknown) => {
        // a video kept in the Media Library that has left it since: the route's own check finds that
        throw e instanceof ToolError && /not on the server/.test(e.message) ? gone : e;
      });
      return { id: p.id, name: p.name, export: job.id, file: job.filename, state: "Exporting by itself: captions_get shows when the file is ready.", link: linkOf(ctx.origin, p.id) };
    },
  },
  steps: { captions_list: "Looking through your Caption Studio projects", captions_get: "Reading the captions", captions_export: "Starting the export" },
  work: (name, _a, r) => {
    const href = `/captions?project=${String(r.id)}`;
    // the card runs until the render ends: api/exports.ts ends it, and says so in the chat
    if (name === "captions_export") return r.export ? { card: { id: `export:${String(r.export)}`, kind: "captions", title: String(r.name), href, status: "running", detail: "Exporting" } } : null;
    // a render read back by the reply that started it: its card follows, and the chat does not say it a second time
    const last = name === "captions_get" ? (r.exports as Array<ReturnType<typeof exportOut>> | undefined)?.[0] : undefined;
    if (!last) return null;
    const status = last.state === "Ready" ? "done" : last.state.startsWith("Failed") ? "failed" : "running";
    return { card: { id: `export:${last.export}`, kind: "captions", title: String(r.name), href, status, detail: status === "running" ? "Exporting" : status === "done" ? (last.finals === "In Finals" ? "Ready, and in Finals" : "Ready to download") : last.state.replace(/^Failed: /, "") }, only: true };
  },
};
