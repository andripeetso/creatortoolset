import { MY_KEYS, SERVICE_KEYS, type MyKeyEnv, type ServiceKeyEnv } from "@contracts/service-keys";
import { SPEECH_USES, SPEECH_USE_NAMES, type SpeechUse } from "@contracts/voice";
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
  /** The page under the section the row is on (a tool's page under Tools: "record"). */
  sub?: string;
  id: string;
  title: string;
  description?: string;
  keywords?: readonly string[];
  /** Only shown where sign-in is required (this install has accounts). Not offered by search elsewhere. */
  /** server-admin: an admin on a hosted server (the server's own accounts, projects and keys). */
  needs?: "sign-in" | "mac" | "mac-recorder" | "server-admin";
}

/** The API key rows are one per service in contracts/service-keys.ts (MY_KEYS), so their ids come from it. */
export type ApiKeyRowId = `api-key-${MyKeyEnv}`;
/** The admin's fallback keys: one per service in contracts/service-keys.ts (SERVICE_KEYS). */
export type ServerKeyRowId = `server-key-${ServiceKeyEnv}`;

const STATIC_ROWS = [
  // General: how the app behaves here, setup, this computer's saved data
  { section: "general", id: "confirm-deletes", title: "Confirm deletes", keywords: ["trash", "delete", "confirm", "comment"] },
  { section: "general", id: "status-colours", title: "Workshop status colours", keywords: ["status", "colour", "color", "sidebar", "workshop"] },
  { section: "general", id: "ask-fit", title: "Footage workspace prompt", keywords: ["assistant", "drop", "footage", "workspace", "ask"] },
  { section: "general", id: "auto-resume-limited", title: "Auto-resume", keywords: ["assistant", "chat", "limit", "rate", "continue", "auto"] },
  { section: "general", id: "snooze-limited", title: "Limit snooze", keywords: ["assistant", "chat", "limit", "rate", "snooze"] },
  { section: "general", id: "recording-shortcut", title: "Recording shortcut", description: "Starts and stops a screen recording from any app (Mac app)", keywords: ["record", "screen", "shortcut", "hotkey", "keyboard", "key", "mac app"], needs: "mac" },
  { section: "tools", sub: "record", id: "recorder-streams", title: "Separate streams", description: "Screen, camera, voice and Mac sound as their own files (Screen Recorder)", keywords: ["record", "screen recorder", "camera", "streams", "separate", "files", "ai", "mac app"], needs: "mac-recorder" },
  { section: "tools", sub: "record", id: "recorder-screen-quality", title: "Screen quality", description: "How sharp the Screen Recorder records the screen", keywords: ["record", "screen recorder", "quality", "resolution", "4k", "1080p", "size", "mac app"], needs: "mac-recorder" },
  { section: "tools", sub: "record", id: "recorder-camera-quality", title: "Camera quality", description: "How sharp the Screen Recorder records the camera", keywords: ["record", "screen recorder", "camera", "webcam", "quality", "resolution", "4k", "1080p", "720p", "mac app"], needs: "mac-recorder" },
  { section: "voice", id: "dictation", title: "Dictation", description: "Types what is said at the cursor (Mac app)", keywords: ["dictate", "dictation", "speech", "voice", "talk", "transcribe", "whisper", "set up", "setup", "guide", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-key-talk", title: "Talk key", description: "Starts dictation on a tap, or while it is held", keywords: ["dictation", "fn", "globe", "option", "hold", "key", "shortcut", "push to talk", "f13", "mac app"], needs: "mac" },
    { section: "voice", id: "dictation-key-cancel", title: "Cancel key", keywords: ["dictation", "cancel", "key", "shortcut", "f16", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-engine", title: "Engine", description: "This Mac, or your server's Deepgram or OpenAI", keywords: ["dictation", "engine", "transcribed by", "deepgram", "openai", "server", "cloud", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-server", title: "Speech server", description: "Tried before this Mac", keywords: ["dictation", "server", "address", "url", "parakeet", "whisper", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-model", title: "Dictation model", keywords: ["dictation", "whisper", "parakeet", "model", "download", "remove", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-history", title: "History", description: "Recent recordings, to copy or redo", keywords: ["dictation", "history", "recordings", "transcript", "key", "shortcut", "f14", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-file", title: "File transcription", description: "Audio or video, on this Mac", keywords: ["dictation", "transcribe", "file", "audio", "video", "key", "shortcut", "f15", "mac app"], needs: "mac" },
  { section: "voice", id: "dictation-sounds", title: "Sound cues", keywords: ["dictation", "sound", "beep", "mac app"], needs: "mac" },
  { section: "general", id: "app-version", title: "Version", description: "Which Creator Toolset Mac app this is", keywords: ["version", "update", "release", "about", "mac app"], needs: "mac" },
  { section: "general", id: "usage-reports", title: "Usage and crash reports", keywords: ["telemetry", "analytics", "crash", "privacy", "usage", "report", "mac app"], needs: "mac" },
  { section: "general", id: "saved-lists", title: "Cache", description: "Lists saved on this computer so screens open at once", keywords: ["cache", "clear", "storage", "saved", "lists", "screens", "reload"] },
  // Appearance
  { section: "appearance", id: "theme", title: "Theme", keywords: ["dark", "light", "system", "colour", "color", "look"] },
  { section: "appearance", id: "colour", title: "Colour", keywords: ["tint", "accent", "project", "own", "color", "violet", "sky", "emerald", "amber", "rose", "orange", "teal", "pink", "blue", "indigo", "fuchsia", "red", "lime", "cyan", "yellow", "slate"] },
  { section: "appearance", id: "background-glow", title: "Glow behind Home", keywords: ["glow", "background", "dark", "home"] },
  { section: "appearance", id: "chat-wave", title: "Transition effect", keywords: ["chat mode", "wave", "animation", "effect", "motion", "transition", "switch"] },
  { section: "appearance", id: "clip-view", title: "Clip view", keywords: ["media library", "clip", "window", "side panel", "open", "player"] },
  { section: "appearance", id: "default-view", title: "Default view", keywords: ["list", "cards", "rows", "grid", "folders", "view", "layout"] },
  // Folders: where each workspace's footage, music and finished videos live
  { section: "folders", id: "finished-videos", title: "Finished videos", keywords: ["folder", "export", "save", "output", "library"] },
  { section: "folders", id: "finals-folder", title: "Finals", keywords: ["folder", "final video", "finished", "project", "workshop"] },
  { section: "folders", id: "footage-folder", title: "Footage", keywords: ["folder", "media", "library", "clips", "raw"] },
  { section: "library", id: "library-adding", title: "Import", keywords: ["media library", "import", "copy", "in place", "keep in place", "places", "adding files"] },
  { section: "library", id: "library-look", title: "New files", keywords: ["media library", "look for new files", "rescan", "scan", "places", "network drive"] },
  { section: "library", id: "library-sorting", title: "Folders", keywords: ["media library", "organize", "sort", "sorting", "by type", "by content", "ai"] },
  { section: "library", id: "library-upload", title: "Footage", keywords: ["media library", "upload", "upload to the server", "proxies", "originals", "cloud", "server", "bucket", "storage"] },
  { section: "library", id: "finals-upload", title: "Finals", keywords: ["media library", "finals", "finals upload", "upload", "phone", "final video", "finished videos"] },
  { section: "library", id: "library-proxies", title: "Proxies", keywords: ["media library", "proxies", "generate", "playback", "4k", "storage"] },
  { section: "library", id: "library-ai", title: "Descriptions", keywords: ["media library", "descriptions", "clip descriptions", "describe", "shot", "shots", "timelines", "ai"] },
  { section: "library", id: "library-timeline-model", title: "Timeline model", keywords: ["media library", "timelines", "gemini", "flash", "antigravity", "model", "sound"] },
  { section: "library", id: "library-search", title: "Search", keywords: ["media library", "search", "meaning", "picture", "embeddings"] },
  { section: "library", id: "library-shot-detail", title: "Shot detail", keywords: ["media library", "shot descriptions", "light", "standard", "detailed", "frames", "density"] },
  { section: "library", id: "library-shot-budget", title: "Monthly budget", keywords: ["media library", "shot descriptions", "budget", "cost", "spending", "cap", "limit"] },
  { section: "sound-effects", id: "sfx-library", title: "Your library", keywords: ["sound effects", "sfx", "sounds", "folder", "library"] },
  { section: "sound-effects", id: "sfx-starter", title: "Starter set", keywords: ["sound effects", "sfx", "install", "remove", "starter", "kenney", "cc0", "sounds"] },
  { section: "sound-effects", id: "sfx-sources", title: "Sources", keywords: ["sound effects", "sfx", "licence", "license", "cc0", "kenney", "source", "credit"] },
  { section: "folders", id: "music-folder", title: "Music", keywords: ["folder", "audio", "tracks", "sound"] },
  // Providers: the AI tools that do the work, per computer
  { section: "providers", id: "default-ai", title: "Default", keywords: ["provider", "default ai", "which ai", "model", "thinking"] },
  { section: "providers", id: "tool-ai", title: "AI by job", keywords: ["provider", "tool", "job", "override", "different ai", "use default", "model", "thinking"] },
  { section: "providers", id: "add-provider", title: "Add provider", keywords: ["install", "sign in", "claude", "codex", "cursor", "grok", "gemini"] },
  // Voice: the languages the person speaks, speech to text (one row per use, below) and read-aloud
  { section: "voice", id: "voice-languages", title: "Spoken languages", keywords: ["language", "estonian", "english", "detect", "speech", "transcribe"] },
  { section: "voice", id: "stt-default", title: "Default engine", description: "Which engine turns speech into text, unless a use picks another", keywords: ["transcribe", "transcription", "stt", "whisper", "deepgram", "openai", "model", "engine", "default"] },
  { section: "voice", id: "read-aloud", title: "Read replies aloud", keywords: ["voice", "speech", "speak", "audio", "text to speech", "tts"] },
  // Devices: the computers that run your AI, and the phones
  { section: "devices", id: "computers", title: "Computers", keywords: ["mac", "computer", "machine", "rename", "remove", "online"] },
  { section: "devices", id: "add-computer", title: "Add computer", keywords: ["mac", "pair", "link", "command line"] },
  { section: "devices", id: "phones", title: "Phones", description: "Use the app on your phone: scan a code with its camera", keywords: ["phone", "iphone", "qr", "qr code", "pair", "camera", "scan", "wifi", "wi-fi"] },
  { section: "devices", id: "add-phone", title: "Add phone", keywords: ["phone", "iphone", "qr", "pair", "camera", "scan", "code", "wifi", "same wi-fi"] },
  { section: "devices", id: "use-this-mac", title: "Take work from this server", keywords: ["mac app", "this mac", "switch", "use this mac", "ai on this mac", "ai jobs", "take work"], needs: "mac" },
  { section: "devices", id: "shared-drives", title: "Shared drives", keywords: ["nas", "network drive", "share", "smb", "connect", "reconnect", "office"], needs: "mac" },
  // Scheduled tasks
  { section: "automations", id: "scheduled-tasks", title: "Scheduled tasks", keywords: ["automation", "schedule", "repeat", "daily", "weekly", "prompt"] },
  // Memory: the rules the assistant keeps from one chat to the next
  { section: "memory", id: "memory-workspaces", title: "Workspaces", keywords: ["memory", "remember", "workspace", "shared", "each", "separate", "apart", "client"] },
  { section: "memory", id: "memory-rules", title: "Rules", keywords: ["memory", "remember", "rule", "chat", "assistant", "forget", "workspace"] },
  // Usage
  { section: "usage", id: "plan-limits", title: "Plan limits", keywords: ["session", "weekly", "reset", "left", "quota", "limit", "plan"] },
  { section: "usage", id: "your-plan", title: "Plan", description: "On Pro or Plus, big jobs start after a confirmation", keywords: ["plan", "pro", "plus", "max", "chatgpt", "claude", "subscription", "limit"] },
  { section: "usage", id: "activity", title: "Activity", keywords: ["cost", "tokens", "calls", "tool", "api price", "usage", "workspace", "period"] },
  // Details: one workspace's own settings (the workspace form, components/workshop/ProjectForm.tsx)
  { section: "workspace", id: "workspace-name", title: "Name", keywords: ["workspace", "rename", "brand"] },
  { section: "workspace", id: "workspace-colour", title: "Colour", keywords: ["workspace", "color", "dot"] },
  { section: "workspace", id: "workspace-instructions", title: "Instructions", keywords: ["workspace", "prompt", "audience", "voice", "cta", "notes", "write it for me"] },
  { section: "workspace", id: "workspace-language", title: "Video language", keywords: ["workspace", "language", "spoken", "speech", "transcribe", "estonian", "english"] },
  { section: "workspace", id: "workspace-files", title: "Context files", keywords: ["workspace", "knowledge", "files", "documents", "pdf", "folder", "context"] },
  // Social accounts: the accounts the person signs in to, one row each (the section is the page: every workspace's, or one's)
  { section: "connectors", id: "social-platforms", title: "Social accounts", keywords: ["platform", "instagram", "facebook", "youtube", "tiktok", "sign in", "login", "add account", "workspace", "move", "disconnect"] },
  { section: "connectors", id: "platform-instagram", title: "Instagram", keywords: ["instagram", "sign in", "login", "reach", "saves"] },
  { section: "connectors", id: "platform-facebook", title: "Facebook", keywords: ["facebook", "pages", "meta", "sign in", "login"] },
  { section: "connectors", id: "platform-youtube", title: "YouTube", keywords: ["youtube", "channel", "sign in", "login", "google", "subscribers"] },
  { section: "connectors", id: "platform-tiktok", title: "TikTok", keywords: ["tiktok", "sign in", "login", "followers", "likes"] },
  // API keys: the Apify key reads other creators' posts (its routes are the account's own, not api/my-keys.ts)
  { section: "keys", id: "apify-key", title: "Apify", description: "Public accounts on TikTok, YouTube, X, Facebook and Instagram", keywords: ["apify", "token", "instagram", "tiktok", "youtube", "facebook", "x", "follow", "handle", "api key"] },
  // Headless access: your own AI (Claude Code, Codex) or a script uses Creator Toolset as you
  { section: "own-ai", id: "connect-ai", title: "AI apps", keywords: ["headless", "install", "claude code", "chatgpt", "claude.ai", "connect chatgpt", "codex", "mcp", "script", "connector", "ai access", "use from your ai", "terminal", "command"] },
  { section: "own-ai", id: "access-keys", title: "Access keys", keywords: ["key", "api key", "mcp", "script", "review", "full access", "claude"] },
  // Servers (Mac app)
  { section: "servers", id: "servers-list", title: "Servers", keywords: ["server", "open", "rename", "remove", "address", "cloud", "own server", "self-host", "vps"] },
  { section: "servers", id: "sign-in-another", title: "Sign-in link", description: "Signs another computer in to this server", keywords: ["server", "link", "sign in", "pair", "computer", "another computer"] },
  // Team (hosted)
  { section: "team", id: "team-name", title: "Name", keywords: ["team", "rename", "name"] },
  { section: "team", id: "team-members", title: "Members", keywords: ["member", "people", "ai", "budget", "workspaces", "remove", "team", "invite"] },
  { section: "team", id: "team-access", title: "Access", keywords: ["access", "tick", "apps", "tools", "grant", "allow", "scripts", "invite"] },
  { section: "team", id: "team-invite", title: "Pending invites", keywords: ["invite", "link", "join", "team", "revoke", "delete"] },
  { section: "team", id: "team-sign-in", title: "Sign-in methods", keywords: ["google", "apple", "github", "password", "members", "team"] },
  // Admin (hosted)
  { section: "team", id: "team-accounts", title: "Accounts", keywords: ["account", "users", "password", "reset", "create account", "new account", "admin", "role", "lock", "unlock", "delete"], needs: "server-admin" },
  { section: "team", id: "admin-sign-in-code", title: "Sign-in code", description: "Every password sign-in on this server needs a code from an authenticator app", keywords: ["two-factor", "2fa", "authenticator", "code", "security", "everyone"], needs: "server-admin" },
  { section: "storage", id: "admin-projects", title: "All projects", keywords: ["projects", "server", "newest", "delete", "size"], needs: "server-admin" },
  { section: "keys", id: "server-keys", title: "Server keys", keywords: ["env", "server", "api key", "secret", "fallback", "server keys"], needs: "server-admin" },
  // Account: the person's own profile and sign-in
  { section: "account", id: "name", title: "Name", keywords: ["display name", "profile", "your name"] },
  { section: "account", id: "sign-in-name", title: "Sign-in name", keywords: ["username", "login", "sign in"], needs: "sign-in" },
  { section: "account", id: "password", title: "Password", keywords: ["change password", "sign in", "security", "reset"], needs: "sign-in" },
  { section: "account", id: "sign-in-code", title: "Sign-in code", description: "A password sign-in also needs a code from an authenticator app", keywords: ["two-factor", "2fa", "authenticator", "code", "security", "recovery codes", "otp"], needs: "sign-in" },
  { section: "account", id: "sign-in-with", title: "Sign-ins", keywords: ["google", "apple", "github", "link", "unlink", "sign in", "connect", "connected accounts", "disconnect"], needs: "sign-in" },
  { section: "account", id: "sign-out", title: "This server", description: "Sign out", keywords: ["log out", "logout", "session", "sign off"], needs: "sign-in" },
] as const satisfies readonly SearchRow[];

/** The Home tools a person can switch: one row each in Appearance → Tools on Home. */
export type HomeToolRowId = `home-tool-${HomeTile}`;

/** One row per speech-to-text use in Voice. */
export type SttUseRowId = `stt-use-${SpeechUse}`;

/** Every id a row may carry: the static ones, plus one per API key, per server key, per switchable Home tool and per speech use. */
export type SearchRowId = (typeof STATIC_ROWS)[number]["id"] | ApiKeyRowId | ServerKeyRowId | HomeToolRowId | SttUseRowId;

export const SETTINGS_SEARCH_INDEX: readonly SearchRow[] = [
  ...STATIC_ROWS,
  ...HOME_TILES.map((t) => ({
    section: "tools" as const,
    id: `home-tool-${t}` as HomeToolRowId,
    title: HOME_TILE_NAMES[t],
    description: HOME_TILE_LINES[t],
    keywords: ["home", "tools", "tile", "switch"],
  })),
  ...SPEECH_USES.map((u) => ({
    section: "voice" as const,
    id: `stt-use-${u}` as SttUseRowId,
    title: SPEECH_USE_NAMES[u],
    description: "Speech to text",
    keywords: ["transcribe", "stt", "engine", "model", "whisper", "deepgram"],
  })),
  ...MY_KEYS.map((k) => ({
    section: "keys" as const,
    id: `api-key-${k.env}` as ApiKeyRowId,
    title: k.name,
    description: k.what,
    keywords: [k.env.toLowerCase().replace(/_/g, " "), "api key", "key", "paste"],
  })),
  ...SERVICE_KEYS.map((k) => ({
    section: "keys" as const,
    id: `server-key-${k.env}` as ServerKeyRowId,
    title: k.name,
    description: k.what,
    keywords: [k.env.toLowerCase().replace(/_/g, " "), "server key", "fallback", "env", "api key"],
    needs: "server-admin" as const,
  })),
];

export interface SearchHit {
  /** The row's id, or undefined for a whole section (a plug-in section, or a built-in one by its title). */
  id?: string;
  section: SettingsPageId | string;
  sub?: string;
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
  /** The Mac app has the Screen Recorder's settings (rows with needs "mac-recorder"). */
  macRecorder = false,
  /** An admin on a hosted server (rows with needs "server-admin"). */
  serverAdmin = false,
): SearchHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return [];
  const tokens = q.split(" ");
  const rows: Array<SearchRow & { sectionTitle: string }> = [];
  for (const r of index) {
    const sectionTitle = sections.get(r.section);
    const shown =
      !r.needs || (r.needs === "mac" ? macApp : r.needs === "mac-recorder" ? macApp && macRecorder : r.needs === "server-admin" ? serverAdmin : signInRequired);
    if (sectionTitle !== undefined && shown) rows.push({ ...r, sectionTitle });
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
      hit: { id: r.id || undefined, section: r.section, ...(r.sub ? { sub: r.sub } : {}), title: r.title, sectionTitle: r.sectionTitle },
      rank,
      at,
    });
  });
  return scored.sort((a, b) => b.rank - a.rank || a.at - b.at).map((s) => s.hit);
}
