/**
 * The server's own API keys for the outside services, asked for in Settings → API keys. One set per install, pasted by its
 * admin. A key saved there wins over the same name in the server's .env, which keeps working as before when nothing is saved.
 * They serve only the platform admin (api/my-keys.ts keyFor); every other account uses its own (MY_KEYS below).
 *
 *   GET /api/service-keys            → ServiceKeyView[]   (never a key, only its last 4)
 *   PUT /api/service-keys/:env       { value: string | null }  (null = forget it, the .env's own applies again)
 *
 * Services that sign in through a browser on a Mac rather than with a key are not here.
 */

export const SERVICE_KEYS = [
  { env: "NVIDIA_API_KEY", name: "NVIDIA", what: "Studio Voice, the Audio Enhancer's second voice engine.", where: "https://build.nvidia.com" },
  { env: "ELEVENLABS_API_KEY", name: "ElevenLabs", what: "Voice isolator in the Audio Enhancer.", where: "https://elevenlabs.io/app/settings/api-keys" },
  { env: "DEEPGRAM_API_KEY", name: "Deepgram", what: "Cloud transcription (nova-3) for you. Without it, transcription runs on the device.", where: "https://console.deepgram.com" },
  { env: "OPENAI_API_KEY", name: "OpenAI", what: "Media Library transcripts without a Deepgram key and its search by meaning (any OpenAI-compatible service: OPENAI_BASE_URL in the .env).", where: "https://platform.openai.com/api-keys" },
  { env: "PERPLEXITY_API_KEY", name: "Perplexity", what: "The Content Workshop's accuracy check and deep research.", where: "https://www.perplexity.ai/account/api" },
  { env: "LIBRARY_S3_ACCESS_KEY", name: "Media Library bucket: Access key", what: "The server's S3-compatible bucket that libraries can keep their files in (bucket and endpoint: LIBRARY_S3_* in the .env)." },
  { env: "LIBRARY_S3_SECRET_KEY", name: "Media Library bucket: Secret key", what: "Goes with the access key above." },
  { env: "TYPESAFE_API_KEY", name: "TypeSafe", what: "Optional. Judges Analyzer comments, labels what works, checks Workshop rules." },
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

/**
 * Settings → My API keys: each account's own keys, billed by the provider to that person, never to the server.
 * A tool that needs one and finds none says which key to add here. The server's keys above serve the platform admin
 * only. Apify (other creators' posts) is in Settings → Connectors.
 *
 *   GET /api/my-keys          → MyKeyView[]   (never a key, only its last 4)
 *   PUT /api/my-keys/:env     { value: string | null }  (null = forget it)
 */
export const MY_KEYS = [
  { env: "DEEPGRAM_API_KEY", name: "Deepgram", what: "Cloud transcripts in Caption Studio, Clips, the Analyzer and the Media Library. Without it, Caption Studio transcribes on your device.", where: "https://console.deepgram.com" },
  { env: "ELEVENLABS_API_KEY", name: "ElevenLabs", what: "Voice isolation in the Audio Enhancer.", where: "https://elevenlabs.io/app/settings/api-keys" },
  { env: "NVIDIA_API_KEY", name: "NVIDIA", what: "Studio Voice in the Audio Enhancer.", where: "https://build.nvidia.com" },
  { env: "ANTHROPIC_API_KEY", name: "Anthropic API", what: "AI on an API key when you have no AI provider of your own (not the Content Workshop, which needs your own Claude or ChatGPT login).", where: "https://console.anthropic.com/settings/keys" },
  { env: "OPENAI_API_KEY", name: "OpenAI", what: "Media Library transcripts when you have no Deepgram key, and its search by meaning.", where: "https://platform.openai.com/api-keys" },
  { env: "PERPLEXITY_API_KEY", name: "Perplexity", what: "The Content Workshop's accuracy check and deep research.", where: "https://www.perplexity.ai/account/api" },
  { env: "TYPESAFE_API_KEY", name: "TypeSafe", what: "Optional. Judges Analyzer comments, labels what works, checks Workshop rules." },
] as const;

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
