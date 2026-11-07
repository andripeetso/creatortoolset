/**
 * The outside services' API keys, asked for in Settings → API keys. One set per install, pasted by its admin. A key saved there wins over the same name in the
 * server's .env, which keeps working as before when nothing is saved.
 *
 *   GET /api/service-keys            → ServiceKeyView[]   (never a key, only its last 4)
 *   PUT /api/service-keys/:env       { value: string | null }  (null = forget it, the .env's own applies again)
 *
 * Services that sign in through a browser on a Mac rather than with a key are not here.
 */

export const SERVICE_KEYS = [
  { env: "NVIDIA_API_KEY", name: "NVIDIA", what: "Studio Voice, the Audio Enhancer's second voice engine.", where: "https://build.nvidia.com" },
  { env: "ELEVENLABS_API_KEY", name: "ElevenLabs", what: "Voice isolator in the Audio Enhancer.", where: "https://elevenlabs.io/app/settings/api-keys" },
  { env: "DEEPGRAM_API_KEY", name: "Deepgram", what: "Cloud transcription (nova-3). Without it, transcription runs on the device.", where: "https://console.deepgram.com" },
  { env: "OPENAI_API_KEY", name: "OpenAI", what: "Transcribes Media Library clips when there is no Deepgram key (any OpenAI-compatible service: OPENAI_BASE_URL in the .env).", where: "https://platform.openai.com/api-keys" },
  { env: "ANTHROPIC_API_KEY", name: "Anthropic API", what: "The workspace's API budget for members without their own AI, and Instagram frame reading.", where: "https://console.anthropic.com/settings/keys" },
  { env: "PERPLEXITY_API_KEY", name: "Perplexity", what: "The Content Workshop's accuracy check and deep research.", where: "https://www.perplexity.ai/account/api" },
  { env: "TYPESAFE_API_KEY", name: "TypeSafe", what: "Quick yes/no checks behind a few features; they work without it." },
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
