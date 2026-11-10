import { MY_KEYS, type MyKeyEnv } from "@contracts/service-keys";
import type { SettingsPageId } from "./nav";

/**
 * The search index: one entry per row a person can search for, written out as static data so rows of pages that are not
 * mounted (or not shown on this install) are still found. A row that renders with `id="..."` (Row, ListRow, Section,
 * data-settings-row) must have its id here: the id type is `SearchRowId`, so tsc fails on a row with no entry. Adding a
 * row: add an entry to STATIC_ROWS below (its section, a short title, one description line if it adds something, and
 * the words people would type).
 */

export interface SearchRow {
  section: SettingsPageId;
  id: string;
  title: string;
  description?: string;
  keywords?: readonly string[];
  /** Only shown where sign-in is required (this install has accounts). Not offered by search elsewhere. */
  needs?: "sign-in";
}

/** The API key rows are one per service in contracts/service-keys.ts (MY_KEYS), so their ids come from it. */
export type ApiKeyRowId = `api-key-${MyKeyEnv}`;

const STATIC_ROWS = [
  // General: how the app behaves here, setup, this computer's saved data
  { section: "general", id: "confirm-deletes", title: "Ask before moving to trash or deleting a comment", keywords: ["trash", "delete", "confirm", "comment"] },
  { section: "general", id: "status-colours", title: "Colour bar beside each session in the Workshop", keywords: ["status", "colour", "color", "sidebar", "workshop"] },
  { section: "general", id: "read-aloud", title: "Read the assistant's replies aloud", keywords: ["voice", "speech", "speak", "audio"] },
  { section: "general", id: "how-you-work", title: "How you work", keywords: ["assistant", "own ai", "setup", "chat"] },
  { section: "general", id: "run-setup", title: "First-run setup", keywords: ["setup", "walk-through", "onboarding", "wizard"] },
  { section: "general", id: "saved-lists", title: "Saved lists", keywords: ["cache", "clear", "storage", "saved", "lists"] },
  { section: "general", id: "screens", title: "Refresh saved screens", keywords: ["cache", "warm", "refresh", "reload"] },
  // Appearance
  { section: "appearance", id: "theme", title: "Theme", keywords: ["dark", "light", "system", "colour", "color", "look"] },
  { section: "appearance", id: "home-tools", title: "Tools on Home", keywords: ["home", "tools", "page", "tiles"] },
  { section: "appearance", id: "project-colour", title: "Project colour", keywords: ["tint", "violet", "colour", "color"] },
  { section: "appearance", id: "background-glow", title: "Background glow", keywords: ["glow", "dark", "home"] },
  // Storage: where footage, music and finished videos live
  { section: "folders", id: "finished-videos", title: "Finished videos", keywords: ["folder", "export", "save", "output", "library"] },
  { section: "folders", id: "footage-folder", title: "Footage", keywords: ["folder", "media", "library", "clips", "raw"] },
  { section: "folders", id: "music-folder", title: "Music", keywords: ["folder", "audio", "tracks", "sound"] },
  // Providers: the AI tools that do the work, per computer
  { section: "providers", id: "default-ai", title: "Default AI", description: "Provider, model and thinking level", keywords: ["provider", "model", "effort", "thinking", "default"] },
  { section: "providers", id: "tool-ai", title: "A different AI for one tool", keywords: ["provider", "tool", "override", "use default"] },
  { section: "providers", id: "add-provider", title: "Add provider", keywords: ["install", "sign in", "claude", "codex", "cursor", "grok", "gemini"] },
  // Computers: the computers that run your AI
  { section: "devices", id: "computers", title: "Computers", keywords: ["mac", "computer", "machine", "rename", "remove", "online"] },
  { section: "devices", id: "add-computer", title: "Add computer", keywords: ["mac", "pair", "link", "command line"] },
  { section: "devices", id: "use-this-mac", title: "Use this Mac for my AI", keywords: ["mac app", "this mac", "switch", "ai on this mac"] },
  // Scheduled tasks
  { section: "automations", id: "scheduled-tasks", title: "Scheduled tasks", keywords: ["automation", "schedule", "repeat", "daily", "weekly", "prompt"] },
  { section: "automations", id: "task-time", title: "Repeat and time", keywords: ["time zone", "daily", "weekly", "monday", "every"] },
  // Usage
  { section: "usage", id: "plan-limits", title: "Plan limits", keywords: ["session", "weekly", "reset", "left", "quota", "limit", "plan"] },
  { section: "usage", id: "activity", title: "Activity", keywords: ["cost", "tokens", "calls", "tool", "api price", "usage"] },
  // Social accounts (the Apify key moves to API keys later; the row id stays with it)
  { section: "connectors", id: "apify-key", title: "Apify key", description: "Reads public profiles and posts", keywords: ["apify", "token", "instagram", "public", "posts"] },
  { section: "connectors", id: "add-by-handle", title: "Follow by @handle", keywords: ["apify", "follow", "handle", "instagram", "tiktok", "youtube"] },
  { section: "connectors", id: "your-accounts", title: "Your accounts", keywords: ["instagram", "youtube", "tiktok", "followers", "project"] },
  { section: "connectors", id: "log-in-accounts", title: "Sign in with Instagram, YouTube or TikTok", keywords: ["login", "log in", "instagram", "youtube", "tiktok", "connect"] },
  // Own AI: the app gives your own AI a key
  { section: "own-ai", id: "connect-ai", title: "Connect your AI", keywords: ["claude", "chatgpt", "codex", "mcp", "script", "connector"] },
  { section: "own-ai", id: "access-keys", title: "Access keys", keywords: ["key", "api key", "mcp", "script", "review", "full access", "claude"] },
  // Servers (Mac app)
  { section: "servers", id: "servers-list", title: "Servers", keywords: ["server", "open", "rename", "remove", "address"] },
  { section: "servers", id: "sign-in-another", title: "Sign in another computer", keywords: ["server", "link", "pair", "computer"] },
  // Team (hosted)
  { section: "team", id: "team-name", title: "Team name", keywords: ["team", "rename", "name"] },
  { section: "team", id: "team-members", title: "Members", keywords: ["member", "people", "role", "tools", "remove", "team"] },
  { section: "team", id: "team-invite", title: "Invite link", keywords: ["invite", "link", "join", "team", "revoke"] },
  { section: "team", id: "team-sign-in", title: "Sign-in", keywords: ["google", "apple", "password", "members", "team"] },
  // Admin (hosted)
  { section: "admin", id: "admin-accounts", title: "Accounts", keywords: ["account", "users", "password", "create", "apps"] },
  { section: "admin", id: "admin-access", title: "Access", keywords: ["access", "tick", "apps", "tools", "grant", "allow"] },
  { section: "admin", id: "admin-projects", title: "Projects", keywords: ["projects", "server", "newest"] },
  { section: "admin", id: "server-keys", title: "Server keys", keywords: ["env", "server", "api key", "secret", "fallback"] },
  // Account: the person's own profile and sign-in
  { section: "account", id: "name", title: "Name", keywords: ["display name", "profile", "your name"] },
  { section: "account", id: "sign-in-name", title: "Sign-in name", keywords: ["username", "login", "sign in"], needs: "sign-in" },
  { section: "account", id: "password", title: "Password", keywords: ["change password", "sign in", "security", "reset"], needs: "sign-in" },
  { section: "account", id: "sign-in-with", title: "Sign in with Google or Apple", keywords: ["google", "apple", "github", "link", "unlink", "sign in"], needs: "sign-in" },
  { section: "account", id: "sign-out", title: "Sign out", keywords: ["log out", "logout", "session", "sign off"], needs: "sign-in" },
  { section: "account", id: "ai-access-key", title: "AI access key", keywords: ["key", "mcp", "script", "claude", "own ai", "access"] },
] as const satisfies readonly SearchRow[];

/** Every id a row may carry: the static ones, plus one per API key service. */
export type SearchRowId = (typeof STATIC_ROWS)[number]["id"] | ApiKeyRowId;

export const SETTINGS_SEARCH_INDEX: readonly SearchRow[] = [
  ...STATIC_ROWS,
  ...MY_KEYS.map((k) => ({
    section: "keys" as const,
    id: `api-key-${k.env}` as ApiKeyRowId,
    title: k.name,
    description: k.what,
    keywords: [k.env.toLowerCase().replace(/_/g, " "), "api key", "key", "paste"],
  })),
];

export interface SearchHit {
  /** The row's id, or undefined for a whole section (a plug-in section, or a built-in one by its title). */
  id?: string;
  section: SettingsPageId | string;
  title: string;
  sectionTitle: string;
}

/**
 * Finds rows (and section titles) for a query. Every word must match something (title, description, keywords, section
 * name). Ranked: title equals the query, title starts with it, title contains it, every word in the title, the whole
 * phrase elsewhere. Ties keep the index order. `sections` maps the sections this person may open to their titles;
 * `signInRequired` says whether the sign-in rows exist on this install (a row with `needs` is left out otherwise).
 */
export function searchSettings(
  query: string,
  sections: ReadonlyMap<string, string>,
  index: readonly SearchRow[] = SETTINGS_SEARCH_INDEX,
  signInRequired = false,
): SearchHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const tokens = q.split(" ");
  const rows: Array<SearchRow & { sectionTitle: string }> = [];
  for (const r of index) {
    const sectionTitle = sections.get(r.section);
    if (sectionTitle !== undefined && (!r.needs || signInRequired)) rows.push({ ...r, sectionTitle });
  }
  // a section by its own title (plug-in sections have no rows in the index)
  for (const [section, title] of sections) rows.push({ section: section as SettingsPageId, id: "", title, sectionTitle: title });

  const scored: Array<{ hit: SearchHit; rank: number; at: number }> = [];
  rows.forEach((r, at) => {
    const title = r.title.toLowerCase();
    const rest = [r.description, ...(r.keywords ?? []), r.sectionTitle].filter(Boolean).join(" ").toLowerCase();
    const all = `${title} ${rest}`;
    if (!tokens.every((t) => all.includes(t))) return;
    const rank =
      title === q ? 5 : title.startsWith(q) ? 4 : title.includes(q) ? 3 : tokens.every((t) => title.includes(t)) ? 2 : all.includes(q) ? 1 : 0;
    scored.push({
      hit: { id: r.id || undefined, section: r.section, title: r.title, sectionTitle: r.sectionTitle },
      rank,
      at,
    });
  });
  return scored.sort((a, b) => b.rank - a.rank || a.at - b.at).map((s) => s.hit);
}
