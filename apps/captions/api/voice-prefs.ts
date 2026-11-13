import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { availableEngines, readVoicePrefs, resolvedFor, writeVoicePrefs } from "./lib/speech";
import type { VoiceView } from "../contracts/voice";

/** Settings → AI → Voice (contracts/voice.ts). Accounts only: a share-link visitor has none. */
export const voicePrefsApp = new Hono<{ Variables: AuthVars }>();

voicePrefsApp.use("*", async (c, next) => (c.get("user").role === "visitor" ? c.json({ error: "Sign in with an account" }, 403) : next()));

const view = (user: AuthVars["user"]): VoiceView => ({
  ...readVoicePrefs(user.username),
  resolved: resolvedFor(user),
  available: availableEngines(user),
});

voicePrefsApp.get("/", (c) => c.json(view(c.get("user"))));

voicePrefsApp.put("/", async (c) => {
  const b = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const out = writeVoicePrefs(c.get("user").username, b);
  return typeof out === "string" ? c.json({ error: out }, 400) : c.json(view(c.get("user")));
});
