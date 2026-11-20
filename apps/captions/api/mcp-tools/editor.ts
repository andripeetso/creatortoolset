import { cleanEdits, type ItemEdit, type TimelineView } from "../../contracts/edit-timeline";
import type { Draft } from "../../contracts/editor";
import { editorStyleTools } from "./editor-styles";
import { ToolError, clock, pick, str, type Args, type ToolContext, type ToolModule } from "./types";

// The AI Editor's page buttons for the assistant: Stop, Retry, a change to what the edit was asked for, the trash.
// And Review's timeline of a draft with Make the next version: the same view and the same route as the page
// (api/editor/routes.ts POST drafts/:name/cut), so an edit the page would refuse is refused here in the same words.
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

/** What an edit on the timeline may hold, as the tool names it (copy_of is the route's copyOf). */
const CUT_FIELDS = ["key", "remove", "head", "tail", "move", "slip", "split", "track", "copy_of"];
/** How the edits are written. It rides in the timeline's answer, so a turn that cuts nothing carries none of it. */
const HOW_TO_CUT = [
  "Each clip has key (<track>:<the frame it starts at>), at (that start as a time), frames (its length), label (its first words, or its file's name) and more ([frames of its footage before its start, after its end]: how far head and tail can make it longer). V1 is the speaker, A1 the speaker's voice, V2 the B-roll.",
  "edits is a list with one edit per clip, each naming its clip by key. Every number in an edit counts frames of this version's timeline as listed here.",
  "Edit the speaker on V1 and leave A1 alone: the voice follows every V1 edit. remove: true takes a shot out with its voice. head and tail change its start and end: negative = shorter (those words go), positive = longer (more of the take with its voice, at most `more`).",
  'split: [frames] cuts a clip at those frames of the timeline. Each piece after the first is a clip of its own with the key <track>:<the frame it starts at>, and takes its own edit in the same list: {"key":"V1:0","split":[39]} with {"key":"V1:39","remove":true} cuts a shot at frame 39 and takes its second part out.',
  'B-roll and other sound (V2, A2, A3) take remove, head, tail and split too, and also move (frames later; negative = earlier) and slip (it plays that many frames later in its own clip, in the same place). A copy is one edit: its key is where the copy goes, copy_of the clip it copies, and it can carry head, tail and slip, so {"key":"V2:0","copy_of":"V2:195","tail":-30} puts a copy of V2:195 at the start, 30 frames shorter. A clip placed on another takes its place there.',
  "The order things happen in: every edit is made on this version first, and only then does what V1 lost or gained move everything after it, on every track, up or later. So B-roll that should stay on the same words needs no move when a shot before it goes: it moves up with them. Give move only to shift it against the words, in this version's frames. B-roll lying wholly over frames that go is taken out with them, and one lying partly over them gets shorter at its end.",
  "Use A1 only to silence a voice while its picture stays: remove: true, a negative head or tail, or split it around the words and remove that piece. A voice never moves or gets longer by itself.",
  "words lists [word, its first frame, the frame after its last]: cut on those.",
  "All the edits are made or none: one that can't be made is refused by its clip's label. The answer lists the cut as it now stands (now): check it against what was asked. editor_get says when the new version is in Review, and this tool then reads that version.",
].join(" ");

/** What the tool calls a field → the route's name for it. */
const FIELDS = { name: "name", brief: "brief", script: "script", versions: "versions", target_s: "targetS", broll_folder: "brollCollectionId", flags: "flags", add_sources: "addSources" } as const;

export const editorTools: ToolModule = {
  defs: [
    { name: "editor_stop", description: "Stop an Editor edit: its running and waiting steps end as Stopped. editor_retry carries on from there.", inputSchema: { type: "object", properties: { edit }, required: ["edit"] } },
    {
      name: "editor_retry",
      description: "Run an edit's failed step again, also one that was stopped or needs setup (job: its id, as editor_get lists them; leave out for every such step). The steps after it follow.",
      inputSchema: { type: "object", properties: { edit, job: { type: "integer" } }, required: ["edit"] },
    },
    {
      name: "editor_update",
      description:
        'Change an Editor edit: name, brief, script, versions (1-5), target_s (seconds, 0 = as long as it needs), broll_folder (a Media Library folder id, or "none"), flags ({id: true or false}; a wrong id is answered with the ones this edit has) and add_sources (more footage for it: version_id, as editor_create takes them, up to 50 in all). Footage the user sends after an edit was started ("and here\'s some B-roll") goes into that edit with add_sources, never into a new edit with the first one in the trash: only a different video is a new edit. Drafts already cut stay as they are until the edit runs again.',
      inputSchema: {
        type: "object",
        properties: { edit, name: str, brief: str, script: str, versions: { type: "integer" }, target_s: { type: "integer" }, broll_folder: str, flags: { type: "object", additionalProperties: { type: "boolean" } }, add_sources: { type: "array", items: str } },
        required: ["edit"],
      },
    },
    { name: "editor_delete", description: "Move an Editor edit to the trash; what still runs is stopped.", inputSchema: { type: "object", properties: { edit }, required: ["edit"] } },
    {
      name: "editor_feedback",
      description:
        "The user's notes on an edit's cut, in their own words (text: what they said, word for word, never summed up). Kept with the edit and read by every later version, and the next version is made from the last one, changing only what the notes speak to. Use it for their notes on a cut instead of rewriting the brief.",
      inputSchema: { type: "object", properties: { edit, text: str }, required: ["edit", "text"] },
    },
    {
      name: "editor_cut",
      description:
        "A draft's timeline as Review shows its newest preview: each clip with its key, place and words, and how to write edits. With edits, cuts them into the draft with no AI (take out, trim, lengthen, split, move B-roll) and makes its next version: all of them as given, or none.",
      inputSchema: { type: "object", properties: { edit, draft: str, edits: { type: "array", items: { type: "object" } } }, required: ["edit", "draft"] },
    },
    // editing styles: make or change one, put one on an edit (editor-styles.ts)
    ...editorStyleTools.defs,
    // a video with nothing filmed starts here: the script spoken, saved as a take (api/editor/voice.ts)
    {
      name: "voice_make",
      description:
        "Speak text in one of the user's ElevenLabs voices (their key, their credits) and save it in the Media Library: text (up to 5,000 characters), voice = a name or id (left out: the one used last). For a video with nothing filmed, give its version_id to editor_create as the only source: the picture is cut from B-roll.",
      inputSchema: { type: "object", properties: { text: str, voice: str, name: str }, required: ["text"] },
    },
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
      if (!sent.length) throw new ToolError(`Nothing to change: give ${Object.keys(FIELDS).join(", ").replace(/, add_sources$/, " or add_sources")}.`);
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
      const field = (k: keyof typeof FIELDS) => (k === "add_sources" ? "sources" : FIELDS[k]);
      const changed = sent.filter((k) => JSON.stringify(before[field(k)]) !== JSON.stringify(e[field(k)]));
      const cut = ((e.drafts as unknown[] | undefined) ?? []).length > 0;
      // new footage is read by analyze: in a run that already read the edit's footage it is not, so that run is followed by one from analyze
      const from = changed.includes("add_sources") ? "analyze" : changed.some((k) => ["brief", "script", "versions", "target_s"].includes(k)) ? "script" : changed.includes("broll_folder") ? "draft" : "";
      const readWithout = !cut && from === "analyze" && jobsOf(e).some((j) => j.kind === "analyze" && j.state !== "queued");
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
            : readWithout
              ? { note: "The run under way started without this footage: once editor_get shows it done, editor_run from analyze cuts it in." }
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
    editor_feedback: async (a, ctx) => {
      const path = pathOf(a.edit);
      const text = typeof a.text === "string" ? a.text : "";
      if (!text.trim()) throw new ToolError("Give text: what the user said about the cut, word for word.");
      const e = await ctx.json(`${path}/feedback`, "POST", { text });
      // a cut around what is said is written again with the notes (script.ts); a shot list is made from its last version
      const spoken = ((e.lines as unknown[] | undefined) ?? []).length > 0;
      return {
        ...pick(e, ["id", "name"]),
        kept: ((e.feedback as unknown[] | undefined) ?? []).length,
        queued: e.queued === true,
        note:
          e.queued === true
            ? `The next version is being ${spoken ? "cut with" : "made from the last one with"} these notes; the chat says when it is in Review, so end your reply rather than wait.`
            : "Kept. The edit is being made now: these notes go into this run when its plan isn't written yet, else into the next version, made when this run is done. The chat says when it is in Review, so end your reply rather than wait.",
        link: linkOf(ctx, e),
      };
    },
    editor_cut: async (a, ctx) => {
      const path = pathOf(a.edit);
      const e = await ctx.json(path);
      const draft = String(a.draft ?? "");
      const p = (e.previews as Record<string, { assetId: string; n: number }> | undefined)?.[draft];
      if (!p) throw new ToolError(`${draft ? `The draft ${draft}` : "That draft"} has no preview in Review yet: editor_get says where each draft's preview is.`);
      const view = await ctx.json<TimelineView>(`/api/review/assets/${p.assetId}/v/${p.n}/timeline`);
      const items = view.tracks.flatMap((t) => t.items);
      if (a.edits == null) {
        return {
          ...pick(e, ["id", "name"]),
          draft,
          version: p.n,
          fps: view.fps,
          clips: items.map((i) => ({ key: i.key, at: clock(i.rec / view.fps), frames: i.len, label: i.label, ...(i.detail ? { from: i.detail } : {}), more: [i.before ?? 0, i.after ?? 0] })),
          words: view.words.map((w) => [w.t, w.rs, w.re]),
          how: HOW_TO_CUT,
          link: `${ctx.origin}/review/${p.assetId}?v=${p.n}`,
        };
      }
      if (!Array.isArray(a.edits) || !a.edits.length) throw new ToolError("edits is a list with one edit per clip: leave it out to read the timeline and how to write them.");
      // the route keeps what it can read of an edit and drops the rest without a word: an edit it would not keep whole is refused here
      const seen = new Set<string>();
      const edits = (a.edits as unknown[]).map((raw): ItemEdit => {
        const x = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Args) : {};
        const key = String(x.key ?? "");
        // a clip is named by its words, as on the page (a piece made by a cut in this list, and a copy, by its key)
        const label = items.find((i) => i.key === key)?.label ?? key;
        const odd = Object.keys(x).filter((k) => !CUT_FIELDS.includes(k));
        if (odd.length) throw new ToolError(`${label || "An edit"}: an edit has no ${odd.join(", ")}. It takes ${CUT_FIELDS.join(", ")}.`);
        if (seen.has(key)) throw new ToolError(`${label}: two edits name this clip. Give one edit per clip.`);
        seen.add(key);
        // what the edit asks for (false and 0 ask for nothing), in the route's names
        const given: Args = {};
        if (x.remove != null && x.remove !== false) given.remove = x.remove;
        for (const k of ["head", "tail", "move", "slip"]) if (x[k] != null && x[k] !== 0) given[k] = x[k];
        if (x.track != null) given.track = x.track;
        if (Array.isArray(x.split) ? x.split.length : x.split != null) given.split = Array.isArray(x.split) ? [...new Set(x.split as number[])].sort((p, q) => p - q) : x.split;
        if (x.copy_of != null) given.copyOf = String(x.copy_of);
        const kept = cleanEdits([{ ...given, key, label }])[0] as (ItemEdit & Args) | undefined;
        const lost = Object.keys(given).filter((k) => JSON.stringify(given[k]) !== JSON.stringify(kept?.[k]));
        if (!kept || lost.length) throw new ToolError(`${label || "An edit"}: ${lost.length ? `${lost.map((k) => (k === "copyOf" ? "copy_of" : k)).join(", ")} can't be used on this clip as written` : "this edit changes nothing, or its key is not a clip's"}. Read the timeline (leave edits out) for the keys and how each kind of clip is edited.`);
        return kept;
      });
      const made = await ctx.json(`${path}/drafts/${encodeURIComponent(draft)}/cut`, "POST", { asset: p.assetId, n: p.n, edits });
      // the cut as it now stands, so the AI can check what its edits made (a clip that went with frames taken out is not in it)
      const tl = (await ctx.json<Draft>(`${path}/drafts/${encodeURIComponent(draft)}`)).timeline;
      const now = Object.entries(tl.tracks).flatMap(([track, t]) => t.items.map((i) => ({ track, at: clock(i.rec / tl.fps), frames: i.len, from: tl.sources[i.src]?.name ?? i.src })));
      return {
        ...pick(made, ["id", "name"]),
        draft,
        from_version: p.n,
        edits: edits.length,
        now,
        note: "Its next version is being made from these edits and will be filed in Review. editor_get says when: the draft's preview is being made, then in Review.",
        link: `${ctx.origin}/review/${p.assetId}`,
      };
    },
    voice_make: async (a, ctx) => {
      if (!a.text) throw new ToolError("Give text: what the voice says.");
      const v = await ctx.json("/api/editor/voice", "POST", pick(a, ["text", "voice", "name"]));
      // Upload none and their computer offline: it goes into the Media Library once that computer is back, as use_file's
      // save does; its card runs until then (library-save.ts ends it)
      if (v.waiting) return { said: v.waiting, save: v.save, note: "Not saved yet: say the line. There is no version_id to make a video from until it is in the library." };
      return {
        version_id: v.versionId,
        name: v.name,
        voice: (v.voice as Args).name,
        link: `${ctx.origin}/library?library=${String(v.libraryId)}&asset=${String(v.assetId)}`,
        next: "editor_create with sources [version_id] and the text as script makes the video: its whole picture comes from B-roll.",
      };
    },
    ...editorStyleTools.handlers,
  },
  steps: {
    editor_stop: "Stopping the edit",
    editor_retry: "Running the failed step again",
    editor_update: "Updating the edit",
    // in the dock this call only asks: the edit goes on Yes
    editor_delete: "Asking before the edit goes to the trash",
    editor_feedback: "Keeping the notes on the cut",
    editor_cut: "Working on the cut's timeline",
    voice_make: "Making the voice",
    ...editorStyleTools.steps,
  },
  // a retry starts work again: its card opens the edit, and ends when the run does (api/editor/ended.ts)
  work: (name, _a, r) =>
    name === "voice_make" && r.save
      ? { card: { id: `library-save:${String(r.save)}`, kind: "link", title: "Media Library", href: "/library", status: "running", detail: String(r.said) } }
      : (name === "editor_retry" || (name === "editor_feedback" && r.queued === true)) && r.id
      ? { card: { id: `edit:${String(r.id)}:retry`, kind: "edit", title: String(r.name ?? "Edit"), href: `/editor/${encodeURIComponent(String(r.id))}`, status: "running", detail: "The Editor is working on it" } }
      // a cut made from timeline edits: its card opens the cut in Review, and ends when the new version is filed
      : name === "editor_cut" && r.id && r.from_version
        ? { card: { id: `edit:${String(r.id)}:cut`, kind: "edit", title: String(r.name ?? "Edit"), href: String(r.link ?? "").replace(/^https?:\/\/[^/]+/, ""), status: "running", detail: "Making the next version from the timeline edits" } }
        : null,
};

export { hasStyle } from "./editor-styles";
