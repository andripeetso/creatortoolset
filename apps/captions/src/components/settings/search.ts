import { MY_KEYS, SERVICE_KEYS, type MyKeyEnv, type ServiceKeyEnv } from "@contracts/service-keys";
import { HOME_TILES, HOME_TILE_LINES, HOME_TILE_NAMES, type HomeTile } from "@contracts/tools";
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
  needs?: "sign-in" | "mac";
}

/** The API key rows are one per service in contracts/service-keys.ts (MY_KEYS), so their ids come from it. */
export type ApiKeyRowId = `api-key-${MyKeyEnv}`;
/** The admin's fallback keys: one per service in contracts/service-keys.ts (SERVICE_KEYS). */
export type ServerKeyRowId = `server-key-${ServiceKeyEnv}`;

const STATIC_ROWS = [
  // General: how the app behaves here, setup, this computer's saved data
  { section: "general", id: "confirm-deletes", title: "Ask before moving to trash or deleting a comment", keywords: ["trash", "delete", "confirm", "comment"] },
  { section: "general", id: "status-colours", title: "Colour bar beside each session in the Workshop", keywords: ["status", "colour", "color", "sidebar", "workshop"] },
  { section: "general", id: "ask-fit", title: "Ask when dropped footage doesn't fit the open project", keywords: ["assistant", "drop", "footage", "project", "ask"] },
  { section: "general", id: "read-aloud", title: "Read the assistant's replies aloud", keywords: ["voice", "speech", "speak", "audio"] },
  { section: "general", id: "recording-shortcut", title: "Recording shortcut", description: "Starts and stops a screen recording from any app (Mac app)", keywords: ["record", "screen", "shortcut", "hotkey", "keyboard", "key", "mac app"], needs: "mac" },
  { section: "general", id: "app-version", title: "Version", description: "Which Creator Toolset Mac app this is", keywords: ["version", "update", "release", "about", "mac app"], needs: "mac" },
  { section: "general", id: "saved-lists", title: "Cache", description: "Lists kept on this computer so screens open at once. Clearing it loses no work.", keywords: ["cache", "clear", "storage", "saved", "lists", "screens", "reload"] },
  // Appearance
  { section: "appearance", id: "theme", title: "Theme", keywords: ["dark", "light", "system", "colour", "color", "look"] },
  { section: "appearance", id: "colour", title: "Colour", keywords: ["tint", "accent", "project", "own", "color", "violet", "sky", "emerald", "amber", "rose", "orange", "teal", "pink"] },
  { section: "appearance", id: "background-glow", title: "Glow behind Home", keywords: ["glow", "background", "dark", "home"] },
  { section: "appearance", id: "clip-view", title: "Clips open in", keywords: ["media library", "clip", "window", "side panel", "open", "player"] },
  { section: "appearance", id: "default-view", title: "Default view", keywords: ["list", "cards", "rows", "grid", "folders", "view", "layout"] },
  // Storage: where footage, music and finished videos live
  { section: "folders", id: "finished-videos", title: "Finished videos", keywords: ["folder", "export", "save", "output", "library"] },
  { section: "folders", id: "footage-folder", title: "Footage", keywords: ["folder", "media", "library", "clips", "raw"] },
  { section: "folders", id: "music-folder", title: "Music", keywords: ["folder", "audio", "tracks", "sound"] },
  // Providers: the AI tools that do the work, per computer
  { section: "providers", id: "default-ai", title: "Default AI", description: "Which AI does the work unless a tool picks another", keywords: ["provider", "default", "which ai", "model", "thinking"] },
  { section: "providers", id: "tool-ai", title: "A different AI for one tool", keywords: ["provider", "tool", "override", "use default", "model", "thinking"] },
  { section: "providers", id: "add-provider", title: "Add provider", keywords: ["install", "sign in", "claude", "codex", "cursor", "grok", "gemini"] },
  // Devices: the computers that run your AI, and the phones
  { section: "devices", id: "computers", title: "Computers", keywords: ["mac", "computer", "machine", "rename", "remove", "online"] },
  { section: "devices", id: "add-computer", title: "Add computer", keywords: ["mac", "pair", "link", "command line"] },
  { section: "devices", id: "phones", title: "Phones", description: "Use the app on your phone: scan a code with its camera", keywords: ["phone", "iphone", "qr", "qr code", "pair", "camera", "scan", "wifi", "wi-fi"] },
  { section: "devices", id: "add-phone", title: "Add phone", keywords: ["phone", "iphone", "qr", "pair", "camera", "scan", "code", "wifi", "same wi-fi"] },
  { section: "devices", id: "use-this-mac", title: "Use this Mac for my AI", keywords: ["mac app", "this mac", "switch", "ai on this mac"], needs: "mac" },
  // Scheduled tasks
  { section: "automations", id: "scheduled-tasks", title: "Scheduled tasks", keywords: ["automation", "schedule", "repeat", "daily", "weekly", "prompt"] },
  // Usage
  { section: "usage", id: "plan-limits", title: "Plan limits", keywords: ["session", "weekly", "reset", "left", "quota", "limit", "plan"] },
  { section: "usage", id: "your-plan", title: "Your AI plan", description: "On Pro or Plus, big jobs ask before they start", keywords: ["plan", "pro", "plus", "max", "chatgpt", "claude", "subscription", "limit"] },
  { section: "usage", id: "activity", title: "Activity", keywords: ["cost", "tokens", "calls", "tool", "api price", "usage"] },
  // Social accounts: the accounts the person signs in to, one row each
  { section: "connectors", id: "social-platforms", title: "Platforms", description: "Instagram, Facebook, YouTube and TikTok: sign in to your own accounts", keywords: ["platform", "instagram", "facebook", "youtube", "tiktok", "sign in", "login", "add account"] },
  { section: "connectors", id: "platform-instagram", title: "Instagram", description: "Your own Instagram account", keywords: ["instagram", "sign in", "login", "reach", "saves"] },
  { section: "connectors", id: "platform-facebook", title: "Facebook", description: "Your Pages, by sign-in", keywords: ["facebook", "pages", "meta", "sign in", "login"] },
  { section: "connectors", id: "platform-youtube", title: "YouTube", description: "Your channel, by sign-in", keywords: ["youtube", "channel", "sign in", "login", "google", "subscribers"] },
  { section: "connectors", id: "platform-tiktok", title: "TikTok", description: "Your account, by sign-in", keywords: ["tiktok", "sign in", "login", "followers", "likes"] },
  // API keys: the Apify key reads other creators' posts (its routes are the account's own, not api/my-keys.ts)
  { section: "keys", id: "apify-key", title: "Apify", description: "Public accounts on TikTok, YouTube, X, Facebook and Instagram", keywords: ["apify", "token", "instagram", "tiktok", "youtube", "facebook", "x", "follow", "handle", "api key"] },
  // Headless access: your own AI (Claude Code, Codex) or a script uses Creator Toolset as you
  { section: "own-ai", id: "connect-ai", title: "Use Creator Toolset from Claude Code or Codex", keywords: ["headless", "install", "claude code", "chatgpt", "codex", "mcp", "script", "connector", "ai access", "use from your ai", "terminal", "command"] },
  { section: "own-ai", id: "access-keys", title: "Access keys", keywords: ["key", "api key", "mcp", "script", "review", "full access", "claude"] },
  // Servers (Mac app)
  { section: "servers", id: "servers-list", title: "Servers", keywords: ["server", "open", "rename", "remove", "address", "cloud", "own server", "self-host", "vps"] },
  { section: "servers", id: "sign-in-another", title: "Sign-in link for another computer", description: "Signs another computer into this server as you", keywords: ["server", "link", "sign in", "pair", "computer", "another computer"] },
  // Team (hosted)
  { section: "team", id: "team-name", title: "Team name", keywords: ["team", "rename", "name"] },
  { section: "team", id: "team-members", title: "Members", keywords: ["member", "people", "role", "tools", "remove", "team"] },
  { section: "team", id: "team-invite", title: "Invite link", keywords: ["invite", "link", "join", "team", "revoke"] },
  { section: "team", id: "team-sign-in", title: "Sign-in", keywords: ["google", "apple", "password", "members", "team"] },
  // Admin (hosted)
  { section: "admin", id: "admin-accounts", title: "Accounts", keywords: ["account", "users", "password", "create", "apps"] },
  { section: "admin", id: "admin-access", title: "Access", keywords: ["access", "tick", "apps", "tools", "grant", "allow"] },
  { section: "admin", id: "admin-projects", title: "Projects", keywords: ["projects", "server", "newest"] },
  { section: "admin", id: "admin-sign-in-code", title: "Ask everyone for a sign-in code", keywords: ["two-factor", "2fa", "authenticator", "code", "security", "lock", "unlock"] },
  { section: "admin", id: "server-keys", title: "Server keys", keywords: ["env", "server", "api key", "secret", "fallback"] },
  // Account: the person's own profile and sign-in
  { section: "account", id: "name", title: "Name", keywords: ["display name", "profile", "your name"] },
  { section: "account", id: "sign-in-name", title: "Sign-in name", keywords: ["username", "login", "sign in"], needs: "sign-in" },
  { section: "account", id: "password", title: "Password", keywords: ["change password", "sign in", "security", "reset"], needs: "sign-in" },
  { section: "account", id: "sign-in-code", title: "Sign-in code", description: "Ask for a code from an authenticator app when you sign in with your password", keywords: ["two-factor", "2fa", "authenticator", "code", "security", "recovery codes", "otp"], needs: "sign-in" },
  { section: "account", id: "photo", title: "Photo", description: "From your Google or GitHub sign-in", keywords: ["picture", "avatar", "image", "profile photo"] },
  { section: "account", id: "sign-in-with", title: "Connected accounts", keywords: ["google", "apple", "github", "link", "unlink", "sign in", "connect"], needs: "sign-in" },
  { section: "account", id: "sign-out", title: "Sign out", keywords: ["log out", "logout", "session", "sign off"], needs: "sign-in" },
] as const satisfies readonly SearchRow[];

/** The Home tools a person can switch: one row each in Appearance → Tools on Home. */
export type HomeToolRowId = `home-tool-${HomeTile}`;

/** Every id a row may carry: the static ones, plus one per API key, per server key and per switchable Home tool. */
export type SearchRowId = (typeof STATIC_ROWS)[number]["id"] | ApiKeyRowId | ServerKeyRowId | HomeToolRowId;

export const SETTINGS_SEARCH_INDEX: readonly SearchRow[] = [
  ...STATIC_ROWS,
  ...HOME_TILES.map((t) => ({
    section: "tools" as const,
    id: `home-tool-${t}` as HomeToolRowId,
    title: HOME_TILE_NAMES[t],
    description: HOME_TILE_LINES[t],
    keywords: ["home", "tools", "tile", "switch"],
  })),
  ...MY_KEYS.map((k) => ({
    section: "keys" as const,
    id: `api-key-${k.env}` as ApiKeyRowId,
    title: k.name,
    description: k.what,
    keywords: [k.env.toLowerCase().replace(/_/g, " "), "api key", "key", "paste"],
  })),
  ...SERVICE_KEYS.map((k) => ({
    section: "admin" as const,
    id: `server-key-${k.env}` as ServerKeyRowId,
    title: k.name,
    description: k.what,
    keywords: [k.env.toLowerCase().replace(/_/g, " "), "server key", "fallback", "env", "api key"],
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
 * `signInRequired` and `macApp` say whether the sign-in rows and the Mac app's own rows exist here (a row with `needs`
 * is left out otherwise, so a hit never lands on a page that does not draw the row).
 */
export function searchSettings(
  query: string,
  sections: ReadonlyMap<string, string>,
  index: readonly SearchRow[] = SETTINGS_SEARCH_INDEX,
  signInRequired = false,
  macApp = false,
): SearchHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const tokens = q.split(" ");
  const rows: Array<SearchRow & { sectionTitle: string }> = [];
  for (const r of index) {
    const sectionTitle = sections.get(r.section);
    if (sectionTitle !== undefined && (!r.needs || (r.needs === "mac" ? macApp : signInRequired))) rows.push({ ...r, sectionTitle });
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
