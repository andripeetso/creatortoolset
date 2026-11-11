import { clock, str, ToolError, type ToolModule, when } from "./types";

// Caption Studio's tools: its projects, and a project's captions read back. Captions are the lines on the video;
// the text under a post is its post description, and is not here.

type Clip = { name: string; cues?: Array<{ start: number; words: Array<{ text: string }> }> };
type Project = { id: string; name: string; clips: Clip[]; captioning?: "preparing" | "transcribing" };

/** What the server is doing to a project it captions by itself (api/captions-job.ts), in words for the AI. */
const STATE = {
  preparing: "Still being prepared: its captions are made next. Ask again in a minute.",
  transcribing: "Still being transcribed. Ask again in a minute.",
};
/** A long video's captions are cut here, and say so (the page has the rest). */
const TEXT_MAX = 12_000;

export const captionsTools: ToolModule = {
  defs: [
    {
      name: "captions_list",
      description: "Caption Studio projects, newest first: id, name, each clip and whether it has captions yet, and the link that opens it. limit = how many (default 20).",
      inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    },
    {
      name: "captions_get",
      description: "A Caption Studio project's captions (the lines on the video, not the post description): each line with its start time, per clip, or that they are still being made. project = its id (captions_list, or use_file to: captions).",
      inputSchema: { type: "object", properties: { project: str }, required: ["project"] },
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
            link: `${ctx.origin}/captions?project=${m.id}`,
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
      return { id: p.id, name: p.name, ...(p.captioning ? { state: STATE[p.captioning] } : {}), clips, link: `${ctx.origin}/captions?project=${p.id}` };
    },
  },
  steps: { captions_list: "Looking through your Caption Studio projects", captions_get: "Reading the captions" },
};
