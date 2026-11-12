import { editorStyleTools } from "./editor-styles";
import { ToolError, pick, str, type Args, type ToolContext, type ToolModule } from "./types";

// The AI Editor's page buttons for the assistant: Stop, Retry, a change to what the edit was asked for, the trash.
// Listing, reading, making and running an edit are api/mcp.ts's own tools.

/** The edit's API path. */
const pathOf = (edit: unknown): string => {
  if (!edit) throw new ToolError("Give the edit's id: editor_list lists them.");
  return `/api/editor/${encodeURIComponent(String(edit))}`;
};
const jobsOf = (e: Args) => (e.jobs as Args[] | undefined) ?? [];
const going = (j: Args) => j.state === "queued" || j.state === "running";
const failed = (j: Args) => j.state === "failed" || j.state === "needs_key";
const linkOf = (ctx: ToolContext, e: Args) => `${ctx.origin}/editor/${String(e.id)}`;
const edit = { type: "string", description: "the edit's id" };

/** What the tool calls a field → the route's name for it. */
const FIELDS = { name: "name", brief: "brief", script: "script", versions: "versions", target_s: "targetS", broll_folder: "brollCollectionId", flags: "flags" } as const;

export const editorTools: ToolModule = {
  defs: [
    { name: "editor_stop", description: "Stop an AI Editor edit: its running and waiting steps end as Stopped. editor_retry carries on from there.", inputSchema: { type: "object", properties: { edit }, required: ["edit"] } },
    {
      name: "editor_retry",
      description: "Run an edit's failed step again, also one that was stopped or needs setup (job: its id, as editor_get lists them; leave out for every such step). The steps after it follow.",
      inputSchema: { type: "object", properties: { edit, job: { type: "integer" } }, required: ["edit"] },
    },
    {
      name: "editor_update",
      description:
        'Change an AI Editor edit: name, brief, script, versions (1-5), target_s (seconds, 0 = as long as it needs), broll_folder (a Media Library folder id, or "none") and flags ({id: true or false}; a wrong id is answered with the ones this edit has). Drafts already cut stay as they are until the edit runs again.',
      inputSchema: {
        type: "object",
        properties: { edit, name: str, brief: str, script: str, versions: { type: "integer" }, target_s: { type: "integer" }, broll_folder: str, flags: { type: "object", additionalProperties: { type: "boolean" } } },
        required: ["edit"],
      },
    },
    { name: "editor_delete", description: "Move an AI Editor edit to the trash; what still runs is stopped.", inputSchema: { type: "object", properties: { edit }, required: ["edit"] } },
    // editing styles: make or change one, put one on an edit (editor-styles.ts)
    ...editorStyleTools.defs,
  ],
  handlers: {
    editor_stop: async (a, ctx) => {
      const path = pathOf(a.edit);
      const stopped = jobsOf(await ctx.json(path)).filter(going).length;
      const e = await ctx.json(`${path}/stop`, "POST");
      return { ...pick(e, ["id", "name"]), stopped, note: stopped ? "editor_retry runs the stopped steps again." : "Nothing was running.", link: linkOf(ctx, e) };
    },
    editor_retry: async (a, ctx) => {
      const path = pathOf(a.edit);
      const jobs = jobsOf(await ctx.json(path));
      // the route leaves a step that did not fail as it is and says nothing: refused here, in words
      const one = a.job == null ? undefined : jobs.find((j) => j.id === Number(a.job));
      if (a.job != null && !one) throw new ToolError("This edit has no step with that id: editor_get lists them.");
      if (one && !failed(one)) throw new ToolError(`That step is ${String(one.state)}: only one that failed, was stopped or needs setup runs again.`);
      const ids = (one ? [one] : jobs.filter(failed)).map((j) => j.id);
      if (!ids.length) throw new ToolError("No step of this edit failed: editor_run runs it again from a step.");
      let e: Args = {};
      for (const id of ids) e = await ctx.json(`${path}/jobs/${String(id)}/retry`, "POST");
      return { ...pick(e, ["id", "name"]), retried: jobsOf(e).filter((j) => ids.includes(j.id)).map((j) => pick(j, ["id", "kind", "variant", "state"])), link: linkOf(ctx, e) };
    },
    editor_update: async (a, ctx) => {
      const path = pathOf(a.edit);
      const sent = (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).filter((k) => a[k] != null);
      if (!sent.length) throw new ToolError(`Nothing to change: give ${Object.keys(FIELDS).join(", ").replace(/, flags$/, " or flags")}.`);
      const before = await ctx.json(path);
      const body: Args = Object.fromEntries(sent.map((k) => [FIELDS[k], a[k]]));
      if (a.broll_folder != null && /^(none)?$/i.test(String(a.broll_folder).trim())) body.brollCollectionId = null;
      if (a.flags != null) {
        // the route drops a flag it does not know and says nothing: refused here, with the ones there are
        const defs = (before.flagDefs as Args[] | undefined) ?? [];
        const given = a.flags && typeof a.flags === "object" && !Array.isArray(a.flags) ? (a.flags as Args) : {};
        const wrong = Object.keys(given).filter((id) => !defs.some((d) => d.id === id) || typeof given[id] !== "boolean");
        if (!defs.length) throw new ToolError("This edit has no flags.");
        if (wrong.length || !Object.keys(given).length) throw new ToolError(`flags is {id: true or false}. This edit's flags: ${defs.map((d) => `${String(d.id)} (${String(d.label)})`).join(", ")}.`);
      }
      const e = await ctx.json(path, "PATCH", body);
      // what the route kept, not what was sent: it clamps versions and leaves out an empty name or a wrong type
      const changed = sent.filter((k) => JSON.stringify(before[FIELDS[k]]) !== JSON.stringify(e[FIELDS[k]]));
      const cut = ((e.drafts as unknown[] | undefined) ?? []).length > 0;
      const from = changed.some((k) => ["brief", "script", "versions", "target_s"].includes(k)) ? "script" : changed.includes("broll_folder") ? "draft" : "";
      return {
        ...pick(e, ["id", "name"]),
        changed,
        ...(sent.includes("versions") ? { versions: e.versions } : {}),
        ...(sent.includes("target_s") ? { target_s: e.targetS } : {}),
        ...(sent.includes("broll_folder") ? { broll_folder: e.brollCollectionId ?? "none" } : {}),
        ...(sent.includes("flags") ? { flags: e.flags } : {}),
        ...(!changed.length
          ? { note: "Nothing changed: it was so already, or the value could not be used (a name can't be empty)." }
          : cut && from
            ? { note: `The drafts are as they were: editor_run from ${from} cuts them again with this.` }
            : {}),
        link: linkOf(ctx, e),
      };
    },
    editor_delete: async (a, ctx) => {
      const path = pathOf(a.edit);
      const e = await ctx.json(path);
      await ctx.sure(`Move the edit "${String(e.name)}" to the trash?${jobsOf(e).some(going) ? " It is still running and will stop." : ""}`);
      await ctx.json(path, "DELETE");
      return { ...pick(e, ["id", "name"]), trashed: true };
    },
    ...editorStyleTools.handlers,
  },
  steps: {
    editor_stop: "Stopping the edit",
    editor_retry: "Running the failed step again",
    editor_update: "Updating the edit",
    // in the dock this call only asks: the edit goes on Yes
    editor_delete: "Asking before the edit goes to the trash",
    ...editorStyleTools.steps,
  },
  // a retry starts work again: its card opens the edit, and ends when the run does (api/editor/ended.ts)
  work: (name, _a, r) =>
    name === "editor_retry" && r.id
      ? { card: { id: `edit:${String(r.id)}:retry`, kind: "edit", title: String(r.name ?? "Edit"), href: `/editor/${encodeURIComponent(String(r.id))}`, status: "running", detail: "The AI Editor is working on it" } }
      : null,
};

export { hasStyle } from "./editor-styles";
