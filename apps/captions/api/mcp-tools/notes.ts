import { pick, when, type Args, type ToolModule } from "./types";

/** Video Notes for the assistant: the list. Reading one (notes_get) and making one from a dropped file (use_file) are in api/mcp.ts. */
export const notesTools: ToolModule = {
  defs: [
    {
      name: "notes_list",
      description: "The user's Video Notes, newest first: id, name, status (processing, ready, error), length (minutes:seconds), when it was recorded (UTC) and its link. limit = how many (default 30). notes_get reads one.",
      inputSchema: { type: "object", properties: { limit: { type: "integer" } } },
    },
  ],
  handlers: {
    notes_list: async (a, ctx) => {
      // the route lists the caller's own notes, newest first
      const all = await ctx.json<Args[]>("/api/clips");
      const limit = Math.max(1, Math.min(Number(a.limit) || 30, 100));
      return {
        notes: all.slice(0, limit).map((c) => {
          const s = Math.round(Number(c.duration) || 0);
          return { ...pick(c, ["id", "name", "status"]), ...(s ? { length: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` } : {}), when: when(c.createdAt), link: `${ctx.origin}/video-notes/${String(c.id)}` };
        }),
        ...(all.length > limit ? { more: all.length - limit } : {}),
      };
    },
  },
  steps: { notes_list: "Looking through your Video Notes" },
};
