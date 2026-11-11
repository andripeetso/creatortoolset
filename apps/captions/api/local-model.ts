import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { env, hostedMode } from "./lib/env";
import { findUser, LOCAL_USER, USERNAME_RE } from "./users";
import type { LocalModel } from "../contracts/service-keys";

/**
 * Settings → API keys → Local model (contracts/service-keys.ts): a model the person runs themselves, by the address
 * its server answers at and the model's name there. Each account's: $DATA_DIR/local-model/<username>.json. The app
 * downloads nothing, looks at no hardware and names no model: both values are what the person typed.
 *
 * The server itself sends requests to that address, so only an install's own admin has one. On a hosted server the
 * address would point into the server's network, not at the person's computer: there the routes refuse and a saved
 * file is not read. ai-complete.ts (aiFor) asks localModelOf at every call.
 */

const fileOf = (username: string) => {
  const u = username.toLowerCase();
  return USERNAME_RE.test(u) ? path.join(env.dataDir, "local-model", `${u}.json`) : null;
};

/** An install's own admin, or the one account of an install with no sign-in. Never on a hosted server. */
const mayHave = (username: string) =>
  !hostedMode() && (findUser(username)?.role === "admin" || (!env.appSecret && username === LOCAL_USER.username));

/**
 * A typed address as the requests use it: http or https, with no sign-in part and no query. "localhost:11434" gets
 * http:// in front; a trailing slash or /v1 is dropped (the requests add /v1/messages and /v1/models themselves).
 */
export function addressOf(typed: unknown): string | null {
  if (typeof typed !== "string" || !typed.trim() || typed.length > 300) return null;
  const t = typed.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`); // another scheme stays what it is, and is refused below
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, "").replace(/\/v1$/, "");
}

const cache = new Map<string, LocalModel | null>();

function saved(username: string): LocalModel | null {
  const hit = cache.get(username);
  if (hit !== undefined) return hit;
  const file = fileOf(username);
  let model: LocalModel | null = null;
  try {
    const j = file ? (JSON.parse(readFileSync(file, "utf-8")) as Partial<LocalModel>) : null;
    const url = addressOf(j?.url);
    if (url && typeof j?.model === "string" && j.model) model = { url, model: j.model };
  } catch {
    /* none saved */
  }
  cache.set(username, model);
  return model;
}

/**
 * The local model this account's text jobs go to, or null. Who may have one is asked again here, at every use: a file
 * saved before the server became a hosted one, or before its owner stopped being an admin, is not read.
 */
export const localModelOf = (username: string): LocalModel | null => (mayHave(username) ? saved(username) : null);

/** The names a model server lists at GET /v1/models, 200 at most; none when it does not answer within 3 seconds. */
async function modelsAt(url: string): Promise<string[]> {
  try {
    const r = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> | null };
    return (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && !!id).slice(0, 200);
  } catch {
    return [];
  }
}

export const localModelApp = new Hono<{ Variables: AuthVars }>();

localModelApp.use("*", async (c, next) =>
  hostedMode()
    ? c.json({ error: "A local model is for an install on your own computer: this server has none" }, 403)
    : mayHave(c.get("user").username)
      ? next()
      : c.json({ error: "Only an admin sets a local model" }, 403),
);

localModelApp.get("/", (c) => c.json(saved(c.get("user").username) ?? {}));

localModelApp.get("/models", async (c) => {
  const url = addressOf(c.req.query("url"));
  return c.json({ models: url ? await modelsAt(url) : [] });
});

localModelApp.put("/", async (c) => {
  const username = c.get("user").username;
  const file = fileOf(username);
  if (!file) return c.json({ error: "No local model for this account" }, 400);
  const b = (await c.req.json().catch(() => null)) as { url?: unknown; model?: unknown } | null;
  if (b?.url === null) {
    rmSync(file, { force: true });
    cache.set(username, null);
    return c.json({});
  }
  const url = addressOf(b?.url);
  if (!url) return c.json({ error: "Type the address the model answers at, like http://localhost:11434" }, 400);
  const model = typeof b?.model === "string" ? b.model.trim() : "";
  if (!/^\S{1,200}$/.test(model)) return c.json({ error: "Type the model's name the way its server lists it" }, 400);
  const next: LocalModel = { url, model };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
  cache.set(username, next);
  return c.json(next);
});
