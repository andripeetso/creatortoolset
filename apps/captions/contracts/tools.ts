import type { PlanId } from "./plans";
import type { MyKeyEnv } from "./service-keys";
import type { CliId } from "./local-ai";

/**
 * The apps, in the home page's order. Every app is on unless the account's
 * `off` list (users.json) switches it off; admins always have all of them.
 */
export const TOOLS = [
  "instagram", "workshop",
  "enhance", "captions", "review", "media", "editor",
  "clean", "stories",
  "notes", "guides",
] as const;
export type Tool = (typeof TOOLS)[number];
export const isTool = (t: unknown): t is Tool => TOOLS.includes(t as Tool);

/**
 * A plug-in's access gate, kept in the same `off` list as the apps (users.json). Plug-ins declare their ids
 * (api/lib/plugin.ts). Lowercase words and dashes; a built-in app id is never a gate.
 */
export type PluginGateId = string;
/**
 * App ids an earlier build of this app had (the studio's private build had `finals`) that a users.json `off` list may
 * still hold. No plug-in can declare one as a gate, and an account keeps its entry (users.ts load, setOff), so an app
 * switched off stays off until the app comes back under that id.
 */
export const RETIRED_APP_IDS = ["finals"] as const;
export const isRetiredAppId = (g: unknown): boolean => RETIRED_APP_IDS.includes(g as (typeof RETIRED_APP_IDS)[number]);
export const isPluginGateId = (g: unknown): g is PluginGateId =>
  typeof g === "string" && /^[a-z][a-z0-9-]*$/.test(g) && !isTool(g) && !isRetiredAppId(g);

export const TOOL_NAMES: Record<Tool, string> = {
  instagram: "Content Analyzer",
  workshop: "Content Workshop",
  enhance: "Audio Enhancer",
  captions: "Caption Studio",
  review: "Review",
  media: "Media Library",
  editor: "AI Editor",
  clean: "Video Cleaner",
  stories: "Story Splitter",
  notes: "Video Notes",
  guides: "Guide Builder",
};

/** One line per tool, for setup's "Which tools do you use?". */
export const TOOL_LINES: Record<Tool, string> = {
  instagram: "Collect posts you like, rank them, find what works.",
  workshop: "Research, notes and drafts for reels, carousels and ads.",
  enhance: "Studio sound for any recording.",
  captions: "Transcribe, caption and export.",
  review: "Share a cut with one link; comments on the frame.",
  media: "Your footage in one place, searchable.",
  editor: "Raw takes in, draft timelines out.",
  clean: "Clean metadata and compare fingerprints before posting.",
  stories: "One video in, stories of about 20 s out.",
  notes: "A recording in: transcript, summary, chapters.",
  guides: "Turn recordings into guides and SOPs.",
};

/** The home page's sections, in its order (the page renders from this, so the two cannot drift). */
export const TOOL_GROUPS: ReadonlyArray<{ id: "plan" | "make" | "distribute" | "tools"; label: string; tools: Tool[] }> = [
  { id: "plan", label: "Plan", tools: ["instagram", "workshop"] },
  { id: "make", label: "Make", tools: ["media", "editor", "review"] },
  // Finals is a view of the library, not a Tool: Home draws it in this box (ToolsetHome)
  { id: "distribute", label: "Distribute", tools: [] },
  { id: "tools", label: "Extras", tools: ["enhance", "captions", "clean", "stories", "notes", "guides"] },
];

/** Always on for every account and never part of the "What will you make?" pick: the Plan and Make tools above. */
export const DEFAULT_TOOLS: readonly Tool[] = TOOL_GROUPS.filter((g) => g.id !== "tools").flatMap((g) => g.tools);

/** A tile Home can show or hide: every tool, and the Screen Recorder (the Mac app's recorder: a tile, not a tool of its own). */
export type HomeTile = Tool | "record";
/** Home's tiles in its order: Plan, Make, the Extras, then the Screen Recorder (Settings → Tools lists them the same way). */
export const HOME_TILES: readonly HomeTile[] = [...TOOL_GROUPS.flatMap((g) => g.tools), "record"];
export const isHomeTile = (t: unknown): t is HomeTile => HOME_TILES.includes(t as HomeTile);
export const HOME_TILE_NAMES: Record<HomeTile, string> = { ...TOOL_NAMES, record: "Screen Recorder" };
export const HOME_TILE_LINES: Record<HomeTile, string> = { ...TOOL_LINES, record: "Record your screen, a window or an area, with your camera and voice." };

/** Whether Home shows a tile: every one except those the person switched off (SetupView.hidden). Nothing hidden = all shown. */
export const onHome = (hidden: readonly HomeTile[] | null | undefined, t: HomeTile): boolean => !hidden?.includes(t);

/** What each thing a tool needs is called in a row's heading (plain, no vendor-first wording). */
export const NEED_SHORT: Record<Have, string> = {
  project: "a project",
  ai: "an AI that answers",
  ownAi: "your own AI",
  library: "a Media Library",
  instagram: "an Instagram login",
  apify: "an Apify key",
  mcp: "Creator Toolset in your AI",
  deviceTranscripts: "transcripts",
  DEEPGRAM_API_KEY: "a Deepgram key",
  ELEVENLABS_API_KEY: "an ElevenLabs or NVIDIA key",
  NVIDIA_API_KEY: "an ElevenLabs or NVIDIA key",
  ANTHROPIC_API_KEY: "an Anthropic key",
  OPENAI_API_KEY: "an OpenAI key",
  PERPLEXITY_API_KEY: "a Perplexity key",
  YOUTUBE_API_KEY: "a YouTube Data API key",
  TYPESAFE_API_KEY: "a TypeSafe Jev key",
};

/** One plain sentence per need: what it is for and who bills (section 11.2 of the onboarding spec). */
export const NEED_SENTENCE: Record<Have, string> = {
  project: "A project keeps this tool's work together. Making one takes a moment.",
  ai: "Runs on the AI you connect (ChatGPT, Claude and others), on your own plan.",
  ownAi: "Runs on the AI you connect (ChatGPT, Claude and others), on your own plan.",
  library: "The Media Library is where your footage lives. Make one to start.",
  instagram: "Lets this tool read your own Instagram posts. You sign in yourself.",
  apify: "Apify reads public posts for you. Apify bills you for each read, to your own account.",
  mcp: "Lets your own Claude Code or Codex use Creator Toolset. Set it up in Settings → Headless access.",
  deviceTranscripts: "This computer turns speech into text by itself, for free. A Deepgram or OpenAI key makes it faster.",
  DEEPGRAM_API_KEY: "Deepgram turns speech into text, so captions and notes can be made. Deepgram bills you, to your own account.",
  ELEVENLABS_API_KEY: "Cleans up voice audio. ElevenLabs or NVIDIA bills you, to your own account.",
  NVIDIA_API_KEY: "Cleans up voice audio. ElevenLabs or NVIDIA bills you, to your own account.",
  ANTHROPIC_API_KEY: "Anthropic bills you for what you use, to your own account.",
  OPENAI_API_KEY: "Used for search and descriptions in the Media Library. OpenAI bills you, to your own account.",
  PERPLEXITY_API_KEY: "Lets research look things up on the web. Perplexity bills you, to your own account.",
  YOUTUBE_API_KEY: "Reads public YouTube channels through YouTube's own API. Free within Google's daily quota.",
  TYPESAFE_API_KEY: "Sharper picks for Content Analyzer. TypeSafe Jev bills you, to your own account.",
};

/**
 * What a person has set up, as the server sees it (api/setup.ts): a Workshop project, AI (any route: their own
 * Claude/Codex, or an API key), their own AI (a provider: the Workshop has no API-key path), a Media Library,
 * an Instagram login, their Apify key, their own AI connected through the MCP (their Full key used since it was made),
 * transcripts made on this computer without a key (the server is on its owner's computer: api/lib/device-transcribe.ts),
 * and each key keyFor (api/my-keys.ts) finds for them.
 */
export type Have = "project" | "ai" | "ownAi" | "library" | "instagram" | "apify" | "mcp" | "deviceTranscripts" | MyKeyEnv;

/** The screen that sets a row up: API keys (its keys only), Apify, the Media Library, Providers, a project. */
export type NeedForm = "keys" | "apify" | "library" | "ai" | "project";

/**
 * One row of a tool's checklist: met when any of `anyOf` is set up. `optional` rows unlock more; the tool works without.
 * `alsoMetBy`: what meets the row without being something to add (transcripts made on the person's own computer),
 * so `anyOf` stays the list of things a screen or the assistant can ask for.
 */
export interface Need {
  what: string;
  anyOf: readonly Have[];
  alsoMetBy?: readonly Have[];
  form: NeedForm;
  optional?: true;
}

/**
 * Each tool's needs, from the code: the keyFor callers (api/transcribe.ts, enhance.ts, workshop.ts, instagram.ts,
 * library/transcribe.ts, library/embed.ts, ai-complete.ts), the Media Library's storage and the AI Editor's steps.
 * Review, Video Cleaner and Story Splitter need nothing. A transcripts row is also met by "deviceTranscripts": on the
 * person's own computer no key is needed.
 */
const OWN_COMPUTER = "the Mac app transcribes without one; a key is faster";
export const TOOL_NEEDS: Record<Tool, readonly Need[]> = {
  instagram: [
    { what: "A project", anyOf: ["project"], form: "project" },
    { what: "Posts to read: your own Apify key (Apify bills you for each read)", anyOf: ["apify", "instagram"], form: "apify" },
    { what: "AI to read posts and slides", anyOf: ["ai"], form: "ai", optional: true },
    { what: "TypeSafe Jev: sharper picks", anyOf: ["TYPESAFE_API_KEY"], form: "keys", optional: true },
  ],
  workshop: [
    { what: "A project", anyOf: ["project"], form: "project" },
    { what: "Your AI, connected", anyOf: ["ownAi"], form: "ai" },
    { what: "Perplexity: accuracy checks and deep research without your AI", anyOf: ["PERPLEXITY_API_KEY"], form: "keys", optional: true },
  ],
  enhance: [{ what: "An ElevenLabs or NVIDIA key", anyOf: ["ELEVENLABS_API_KEY", "NVIDIA_API_KEY"], form: "keys" }],
  captions: [
    { what: "Deepgram: faster cloud transcripts (without it, your device transcribes)", anyOf: ["DEEPGRAM_API_KEY"], form: "keys", optional: true },
    { what: "AI: the cadence pass", anyOf: ["ai"], form: "ai", optional: true },
  ],
  review: [],
  media: [
    { what: "A library: where your files live", anyOf: ["library"], form: "library" },
    { what: `Transcripts: a Deepgram or OpenAI key (${OWN_COMPUTER})`, anyOf: ["DEEPGRAM_API_KEY", "OPENAI_API_KEY"], alsoMetBy: ["deviceTranscripts"], form: "keys", optional: true },
    { what: "Search by meaning: an OpenAI key", anyOf: ["OPENAI_API_KEY"], form: "keys", optional: true },
    { what: "AI: descriptions", anyOf: ["ai"], form: "ai", optional: true },
  ],
  editor: [
    { what: "AI", anyOf: ["ai"], form: "ai" },
    { what: "Your footage in a Media Library", anyOf: ["library"], form: "library" },
    { what: `Transcripts: a Deepgram or OpenAI key (${OWN_COMPUTER})`, anyOf: ["DEEPGRAM_API_KEY", "OPENAI_API_KEY"], alsoMetBy: ["deviceTranscripts"], form: "keys" },
  ],
  clean: [],
  stories: [],
  notes: [
    { what: `Transcripts: a Deepgram key (${OWN_COMPUTER})`, anyOf: ["DEEPGRAM_API_KEY"], alsoMetBy: ["deviceTranscripts"], form: "keys" },
    { what: "AI: summaries and chapters", anyOf: ["ai"], form: "ai" },
  ],
  guides: [
    { what: `Transcripts: a Deepgram key (${OWN_COMPUTER})`, anyOf: ["DEEPGRAM_API_KEY"], alsoMetBy: ["deviceTranscripts"], form: "keys" },
    { what: "AI: writes the guide", anyOf: ["ai"], form: "ai" },
  ],
};

/** A tool's rows split by what is still missing: `ready` when no required row is. */
export function readiness(tool: Tool, have: Iterable<Have>): { ready: boolean; missing: Need[]; extra: Need[] } {
  const got = new Set(have);
  const open = TOOL_NEEDS[tool].filter((n) => ![...n.anyOf, ...(n.alsoMetBy ?? [])].some((h) => got.has(h)));
  const missing = open.filter((n) => !n.optional);
  return { ready: missing.length === 0, missing, extra: open.filter((n) => n.optional) };
}

/** The other direction: the tools a key or login turns on (or adds to), in TOOLS order. */
export const toolsUsing = (h: Have): Tool[] => TOOLS.filter((t) => TOOL_NEEDS[t].some((n) => n.anyOf.includes(h)));

/** The tools that call AI at all (required or optional): setup asks about AI only when one of these is ticked. */
export const usesAi = (t: Tool) => TOOL_NEEDS[t].some((n) => n.form === "ai");

/** GET /api/setup (api/setup.ts): the tools a person ticked, their plan, whether setup is done, what they have. */
export interface SetupView {
  /** null = never asked. Only what the tools, the needs-setup text and the setup window read; Home reads `hidden`. */
  tools: Tool[] | null;
  /** Home tiles switched off under Settings → Tools. Empty = Home shows every one. */
  hidden: HomeTile[];
  plan: PlanId | null;
  /** what a CLI on one of their Macs says it is signed in to (`claude auth status`), for the plan question's default */
  detected: PlanId | null;
  done: boolean;
  have: Have[];
  /** the AI CLIs that hold this account's Creator Toolset entry (stored in its setup file; they get the new key on each add) */
  mcpTo: CliId[];
}
