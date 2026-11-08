/**
 * How a person wants to work: two separate questions, neither locks anyone in, and both answers can be "both".
 *   talk:  where they talk to the AI: in this app, in their own AI chat (Claude Code, Codex through the MCP), or both.
 *   check: where they look at and touch the work: in this app (Review, the edit page), in their own editor, or both.
 *   editor: the editor they use when check includes it (e.g. "resolve-studio", "premiere", "final-cut").
 *   makes: what they make (reels, newsletters, X threads…), asked in first-run setup after "how"; it pre-ticks the tools.
 *
 *   GET /api/work-prefs → WorkPrefs   PUT /api/work-prefs { talk?, check?, editor?, makes? } → WorkPrefs
 * First-run setup's "How do you want to use Creator Toolset?" and the MCP tools get_work_prefs / set_work_prefs
 * change the same record.
 */

export const TALK = ["app", "chat", "both"] as const;
export const CHECK = ["app", "editor", "both"] as const;
export const EDITORS = ["resolve-studio", "resolve", "premiere", "final-cut", "avid", "other"] as const;
export const MAKES = ["reel", "youtube", "carousel", "ad", "podcast", "course", "recording", "newsletter", "thread", "article", "other"] as const;
export type Make = (typeof MAKES)[number];

export interface WorkPrefs {
  talk: (typeof TALK)[number];
  check: (typeof CHECK)[number];
  editor: (typeof EDITORS)[number] | null;
  makes: Make[];
}

export const DEFAULT_WORK_PREFS: WorkPrefs = { talk: "app", check: "app", editor: null, makes: [] };
