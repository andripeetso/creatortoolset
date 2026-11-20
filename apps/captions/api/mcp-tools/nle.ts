import { commandLines } from "../../src/lib/nle/commands";
import { ToolError, type Args, type ToolContext, type ToolModule } from "./types";

// The editor commands: the timeline open on the page the chat's message was sent from, read and changed there as the
// person's own edits (src/lib/nle/commands.ts, run by the page through api/editor/nle-bridge.ts). api/mcp.ts lists them
// only on a turn sent from a timeline page, so no other chat carries them.

/** The draft the message was sent from, checked as this account's and in the chat's workspace, then the page asked. */
async function ask(ctx: ToolContext, body: Args): Promise<unknown> {
  const page = await ctx.json<{ edit: string; draft: string; workspace?: string }>("/api/editor/nle/page");
  // the edit route refuses an edit that is not this account's (404); its view says which workspace it is in and its drafts
  const e = await ctx.json<{ projectId?: string; drafts?: unknown }>(`/api/editor/${encodeURIComponent(page.edit)}`);
  if (page.workspace && e.projectId && e.projectId !== page.workspace) throw new ToolError("That draft is in another workspace than this chat's: switch the app to its workspace first.");
  // the app's editor lists its drafts by name, a plug-in's (the studio's) as { name, … }
  const drafts = Array.isArray(e.drafts) ? e.drafts.map((d) => (typeof d === "string" ? d : (d as { name?: unknown } | null)?.name)) : null;
  if (drafts && !drafts.includes(page.draft)) throw new ToolError("Not found, or not this account's.");
  return ctx.json("/api/editor/nle/wait", "POST", body);
}

const ref = { description: 'Clips by ref from nle_state ("V2:3" = the third clip on V2), picked before the command runs', anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };

export const NLE_TOOLS = new Set(["nle_state", "nle_run"]);

export const nleTools: ToolModule = {
  defs: [
    {
      name: "nle_state",
      description: "The timeline open in the user's editor, as they see it with their unsaved edits: each track's clips as refs (V2:3) with rec and len in seconds, name and source file, the playhead, the picked clips and In / Out. Never name a child in a clip, a track or your reply.",
      inputSchema: { type: "object", properties: {} },
      dockOnly: true,
    },
    {
      name: "nle_run",
      description: `Edits the timeline open in the user's editor, as one undo step they see at once; Save stays theirs. Commands run in order, all or none; refs are read on the timeline as it was before the first. Read nle_state first. Times are seconds. Commands:\n${commandLines()}`,
      inputSchema: {
        type: "object",
        properties: {
          commands: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, params: { type: "object" }, ref }, required: ["id"] },
          },
        },
        required: ["commands"],
      },
      dockOnly: true,
    },
  ],
  handlers: {
    nle_state: async (_a, ctx) => ask(ctx, { kind: "state" }),
    nle_run: async (a, ctx) => {
      if (!Array.isArray(a.commands) || !a.commands.length) throw new ToolError("Give the commands to run, in order.");
      return ask(ctx, { kind: "run", commands: a.commands });
    },
  },
  steps: { nle_state: "Reading the timeline", nle_run: "Editing the timeline" },
};
