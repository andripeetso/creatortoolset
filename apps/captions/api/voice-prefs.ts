import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { readBalance } from "./lib/balance";
import { speechComputers, strongest, wantModel } from "./lib/computer-transcribe";
import { isOnline } from "./lib/devices";
import { availableEngines, availableFor, readVoicePrefs, resolvedFor, resolvedOne, writeVoicePrefs } from "./lib/speech";
import type { SttComputer, VoiceView } from "../contracts/voice";

/**
 * Settings → AI → Voice (contracts/voice.ts). Accounts only: a share-link visitor has none.
 *   PUT /api/voice-prefs/models { computer, model, keep } → VoiceView   Download (keep: true) or Remove a model on a computer
 */
export const voicePrefsApp = new Hono<{ Variables: AuthVars }>();

voicePrefsApp.use("*", async (c, next) => (c.get("user").role === "visitor" ? c.json({ error: "Sign in with an account" }, 403) : next()));

/** The account's computers that run speech models, strongest first, with each model's state on it. */
async function computers(username: string): Promise<SttComputer[]> {
  const { weights } = await readBalance(username);
  return strongest(speechComputers(username), weights).map((d) => {
    const s = d.stt ?? { want: [], held: [], getting: [] };
    const ids = [...new Set([...s.held, ...s.getting, ...s.want])];
    return {
      id: d.id,
      name: d.name,
      online: isOnline(d.id),
      models: ids.map((id) => ({ id, state: s.held.includes(id) ? "ready" : s.getting.includes(id) ? "downloading" : "asked" }) as const),
    };
  });
}

const view = async (user: AuthVars["user"]): Promise<VoiceView> => ({
  ...readVoicePrefs(user.username),
  resolved: resolvedFor(user),
  resolvedDefault: resolvedOne(user, "default"),
  available: availableEngines(user),
  availableFor: availableFor(user),
  computers: await computers(user.username),
});

voicePrefsApp.get("/", async (c) => c.json(await view(c.get("user"))));

voicePrefsApp.put("/", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const out = writeVoicePrefs(c.get("user").username, b);
  return typeof out === "string" ? c.json({ error: out }, 400) : c.json(await view(c.get("user")));
});

voicePrefsApp.put("/models", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof b?.computer !== "string" || typeof b.model !== "string" || typeof b.keep !== "boolean") return c.json({ error: "computer, model, keep" }, 400);
  const wrong = wantModel(c.get("user").username, b.computer, b.model, b.keep);
  return wrong ? c.json({ error: wrong }, 400) : c.json(await view(c.get("user")));
});
