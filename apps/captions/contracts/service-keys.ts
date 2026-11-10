/**
 * API keys for the paid services, in two lists:
 *
 *   MY_KEYS       the person's own keys (Settings → API keys). Each account's keys are saved on the server
 *                 ($DATA_DIR/my-keys/<user>.json, api/my-keys.ts); a tool that needs one and has none says which to add.
 *   SERVICE_KEYS  the server's fallback keys (Admin → Server keys, admins only, api/service-keys.ts). A key saved there
 *                 wins over the same name in the server's .env, which keeps working as before when nothing is saved.
 *
 * Apify (other creators' posts) is an API key too, saved by /api/instagram/apify and shown on the same page.
 * `what` is the one line a row shows: the tools that use the key.
 *
 *   GET /api/my-keys          → MyKeyView[]   (never a key, only its last 4)
 *   PUT /api/my-keys/:env     { value: string | null }  (null = forget it)
 *   GET /api/service-keys     → ServiceKeyView[]   (admins; never a key, only its last 4)
 *   PUT /api/service-keys/:env  { value: string | null }  (null = forget it, the .env's own applies again)
 */

export const SERVICE_KEYS = [
  { env: "NVIDIA_API_KEY", name: "NVIDIA", what: "Studio Voice in the Audio Enhancer", where: "https://build.nvidia.com" },
  { env: "ELEVENLABS_API_KEY", name: "ElevenLabs", what: "Voice isolation in the Audio Enhancer", where: "https://elevenlabs.io/app/settings/api-keys" },
  { env: "DEEPGRAM_API_KEY", name: "Deepgram", what: "Captions and transcripts in Caption Studio and the Media Library", where: "https://console.deepgram.com" },
  { env: "OPENAI_API_KEY", name: "OpenAI", what: "Media Library transcripts without Deepgram, and search by meaning", where: "https://platform.openai.com/api-keys" },
  { env: "PERPLEXITY_API_KEY", name: "Perplexity", what: "Accuracy check and research in the Content Workshop", where: "https://www.perplexity.ai/account/api" },
  { env: "LIBRARY_S3_ACCESS_KEY", name: "Media Library bucket: Access key", what: "The bucket libraries keep their files in (LIBRARY_S3_* in the .env)" },
  { env: "LIBRARY_S3_SECRET_KEY", name: "Media Library bucket: Secret key", what: "Goes with the access key above" },
  { env: "TYPESAFE_API_KEY", name: "TypeSafe", what: "Analyzer comments and ideas, and Workshop rules" },
] as const;

export type ServiceKeyEnv = (typeof SERVICE_KEYS)[number]["env"];

export interface ServiceKeyView {
  env: ServiceKeyEnv;
  name: string;
  what: string;
  where?: string;
  /** settings = pasted here; server = only in the .env; null = not set anywhere */
  source: "settings" | "server" | null;
  last4?: string;
}

/** The sections of the API keys page, in order. */
export type MyKeyGroup = "voice" | "research" | "ai";

export const MY_KEYS = [
  { env: "DEEPGRAM_API_KEY", name: "Deepgram", group: "voice", what: "Captions and transcripts in Caption Studio and the Media Library", where: "https://console.deepgram.com" },
  { env: "ELEVENLABS_API_KEY", name: "ElevenLabs", group: "voice", what: "Voice isolation in the Audio Enhancer", where: "https://elevenlabs.io/app/settings/api-keys" },
  { env: "NVIDIA_API_KEY", name: "NVIDIA", group: "voice", what: "Studio Voice in the Audio Enhancer", where: "https://build.nvidia.com" },
  { env: "PERPLEXITY_API_KEY", name: "Perplexity", group: "research", what: "Accuracy check and research in the Content Workshop", where: "https://www.perplexity.ai/account/api" },
  { env: "OPENAI_API_KEY", name: "OpenAI", group: "ai", what: "Media Library transcripts without Deepgram, and search by meaning", where: "https://platform.openai.com/api-keys" },
  { env: "TYPESAFE_API_KEY", name: "TypeSafe", group: "ai", what: "Analyzer comments and ideas, and Workshop rules" },
  // last: read only when the account has no AI of its own (api/ai-complete.ts onApiKey); the page hides it then, unless a key is saved
  { env: "ANTHROPIC_API_KEY", name: "Anthropic API", group: "ai", what: "Used by the tools, except Content Workshop, when you have no AI of your own here", where: "https://console.anthropic.com/settings/keys" },
] as const satisfies ReadonlyArray<{ env: string; name: string; group: MyKeyGroup; what: string; where?: string }>;

export type MyKeyEnv = (typeof MY_KEYS)[number]["env"];

export interface MyKeyView {
  env: MyKeyEnv;
  name: string;
  what: string;
  where?: string;
  set: boolean;
  last4?: string;
  /** Without a key of your own: "admin" when the server's key serves you instead, else absent. */
  server?: "admin";
}
