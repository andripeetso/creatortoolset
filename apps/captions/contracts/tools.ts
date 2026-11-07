import type { PlanId } from "./plans";
import type { MyKeyEnv } from "./service-keys";

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

/** The home page's sections. */
export const TOOL_GROUPS: Record<Tool, string> = {
  instagram: "Ideas",
  workshop: "Ideas",
  enhance: "Make",
  captions: "Make",
  review: "Make",
  media: "Make",
  editor: "Make",
  clean: "Distribute",
  stories: "Distribute",
  notes: "Other tools",
  guides: "Other tools",
};

/**
 * What a person has set up, as the server sees it (api/setup.ts): a Workshop project, AI (any route: their own
 * Claude/Codex, or an API key), their own AI (a provider: the Workshop has no API-key path), a Media Library,
 * an Instagram login, their Apify key, and each key keyFor (api/my-keys.ts) finds for them.
 */
export type Have = "project" | "ai" | "ownAi" | "library" | "instagram" | "apify" | MyKeyEnv;

/** The screen that sets a row up: My API keys (its keys only), Apify, the Media Library, AI providers, a project. */
export type NeedForm = "keys" | "apify" | "library" | "ai" | "project";

/** One row of a tool's checklist: met when any of `anyOf` is set up. `optional` rows unlock more; the tool works without. */
export interface Need {
  what: string;
  anyOf: readonly Have[];
  form: NeedForm;
  optional?: true;
}

/**
 * Each tool's needs, from the code: the keyFor callers (api/transcribe.ts, enhance.ts, workshop.ts, instagram.ts,
 * library/transcribe.ts, library/embed.ts, ai-complete.ts), the Media Library's storage and the AI Editor's steps.
 * Review, Video Cleaner and Story Splitter need nothing.
 */
export const TOOL_NEEDS: Record<Tool, readonly Need[]> = {
  instagram: [
    { what: "A project", anyOf: ["project"], form: "project" },
    { what: "Posts to read: your own Apify key (Apify bills you for each read)", anyOf: ["apify", "instagram"], form: "apify" },
    { what: "AI to read posts and slides", anyOf: ["ai"], form: "ai", optional: true },
    { what: "TypeSafe: sharper picks", anyOf: ["TYPESAFE_API_KEY"], form: "keys", optional: true },
  ],
  workshop: [
    { what: "A project", anyOf: ["project"], form: "project" },
    { what: "Your own AI: Claude Code or Codex on your Mac", anyOf: ["ownAi"], form: "ai" },
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
    { what: "Transcripts: a Deepgram or OpenAI key", anyOf: ["DEEPGRAM_API_KEY", "OPENAI_API_KEY"], form: "keys", optional: true },
    { what: "Search by meaning: an OpenAI key", anyOf: ["OPENAI_API_KEY"], form: "keys", optional: true },
    { what: "AI: descriptions", anyOf: ["ai"], form: "ai", optional: true },
  ],
  editor: [
    { what: "AI", anyOf: ["ai"], form: "ai" },
    { what: "Your footage in a Media Library", anyOf: ["library"], form: "library" },
    { what: "Transcripts: a Deepgram or OpenAI key", anyOf: ["DEEPGRAM_API_KEY", "OPENAI_API_KEY"], form: "keys" },
  ],
  clean: [],
  stories: [],
  notes: [
    { what: "Transcripts: a Deepgram key", anyOf: ["DEEPGRAM_API_KEY"], form: "keys" },
    { what: "AI: summaries and chapters", anyOf: ["ai"], form: "ai" },
  ],
  guides: [
    { what: "Transcripts: a Deepgram key", anyOf: ["DEEPGRAM_API_KEY"], form: "keys" },
    { what: "AI: writes the guide", anyOf: ["ai"], form: "ai" },
  ],
};

/** A tool's rows split by what is still missing: `ready` when no required row is. */
export function readiness(tool: Tool, have: Iterable<Have>): { ready: boolean; missing: Need[]; extra: Need[] } {
  const got = new Set(have);
  const open = TOOL_NEEDS[tool].filter((n) => !n.anyOf.some((h) => got.has(h)));
  const missing = open.filter((n) => !n.optional);
  return { ready: missing.length === 0, missing, extra: open.filter((n) => n.optional) };
}

/** The other direction: the tools a key or login turns on (or adds to), in TOOLS order. */
export const toolsUsing = (h: Have): Tool[] => TOOLS.filter((t) => TOOL_NEEDS[t].some((n) => n.anyOf.includes(h)));

/** The tools that call AI at all (required or optional): setup asks about AI only when one of these is ticked. */
export const usesAi = (t: Tool) => TOOL_NEEDS[t].some((n) => n.form === "ai");

/** GET /api/setup (api/setup.ts): the tools a person ticked, their plan, whether setup is done, what they have. */
export interface SetupView {
  /** null = never asked */
  tools: Tool[] | null;
  plan: PlanId | null;
  /** what a CLI on one of their Macs says it is signed in to (`claude auth status`), for the plan question's default */
  detected: PlanId | null;
  done: boolean;
  have: Have[];
}
