/**
 * How a person wants to work: two separate questions, neither locks anyone in, and both answers can be "both".
 *   talk:  where they talk to the AI: in this app, in their own AI chat (Claude Code, Codex through the MCP), or both.
 *   check: where they look at and touch the work: in this app (Review, the edit page), in their own editor, or both.
 *   editor: the editor they use when check includes it (e.g. "resolve-studio", "premiere", "final-cut").
 *   makes: what they make (reels, newsletters, X threads…), asked in first-run setup; it pre-ticks the tools.
 *   job: what they want to do first (setup's "What do you want to do first?"), or null when not answered.
 *   askFit: false = the assistant no longer asks whether dropped footage belongs in the open project.
 *   autoResume / snoozeLimited: a chat a usage limit stopped carries on by itself when the limit resets (absent = on) /
 *     is put away till then (absent = off). Each chat's banner changes its own (api/assistant.ts).
 *
 *   GET /api/work-prefs → WorkPrefs   PUT /api/work-prefs { talk?, check?, editor?, makes?, job?, askFit?, autoResume?, snoozeLimited? } → WorkPrefs
 * First-run setup's "How do you want to use Creator Toolset?" and the MCP tools get_work_prefs / set_work_prefs
 * change the same record.
 */

export const TALK = ["app", "chat", "both"] as const;
export const CHECK = ["app", "editor", "both"] as const;
export const EDITORS = ["resolve-studio", "resolve", "premiere", "final-cut", "avid", "other"] as const;
export const MAKES = ["reel", "youtube", "carousel", "ad", "podcast", "course", "recording", "newsletter", "thread", "article", "other"] as const;
export type Make = (typeof MAKES)[number];
/** Find ideas in posts I like, Write scripts and posts, Edit my videos, Add captions to a video, Just look around. */
export const JOBS = ["ideas", "write", "edit", "captions", "look"] as const;
export type Job = (typeof JOBS)[number];

export interface WorkPrefs {
  talk: (typeof TALK)[number];
  check: (typeof CHECK)[number];
  editor: (typeof EDITORS)[number] | null;
  makes: Make[];
  /** a record saved before this field has none: read as null */
  job?: Job | null;
  /** The assistant says when dropped footage doesn't seem to fit the project that is open (absent = on). */
  askFit?: boolean;
  /** A chat a usage limit stopped carries on by itself when the limit resets (absent = on). */
  autoResume?: boolean;
  /** A chat a usage limit stopped is put away until the limit resets (absent = off). */
  snoozeLimited?: boolean;
}

export const DEFAULT_WORK_PREFS: WorkPrefs = { talk: "app", check: "app", editor: null, makes: [], job: null };
