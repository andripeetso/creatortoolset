import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { SERVICE_KEYS, type ServiceKeyEnv, type ServiceKeyView } from "../contracts/service-keys";

/**
 * Settings → Admin → Server keys (contracts/service-keys.ts): $DATA_DIR/service-keys.json (0600). A saved key is put into
 * process.env under its own name, so every place that already reads the env (read at each call, never cached) uses it.
 * Forgetting one puts the .env's own value back. Platform admins only (the middleware below checks it).
 */

const FILE = () => path.join(env.dataDir, "service-keys.json");
const NAMES = new Set<string>(SERVICE_KEYS.map((k) => k.env));
// the .env's own values, before any saved key replaced them
const fromServer = Object.fromEntries(SERVICE_KEYS.map((k) => [k.env, process.env[k.env] ?? ""])) as Record<ServiceKeyEnv, string>;

function readSaved(): Partial<Record<ServiceKeyEnv, string>> {
  try {
    return JSON.parse(readFileSync(FILE(), "utf-8"));
  } catch {
    return {};
  }
}

let saved = readSaved();
const apply = () => {
  for (const k of SERVICE_KEYS) {
    const v = saved[k.env] || fromServer[k.env];
    if (v) process.env[k.env] = v;
    else delete process.env[k.env];
  }
};
apply();

/** Where the server's key of this name was pasted: Admin → Server keys ("settings") or the server's .env ("env"). */
export const serverKeyFrom = (name: string): "settings" | "env" | null => (saved[name as ServiceKeyEnv] ? "settings" : fromServer[name as ServiceKeyEnv] ? "env" : null);

export const serviceKeysApp = new Hono<{ Variables: AuthVars }>();

serviceKeysApp.use("*", async (c, next) => (c.get("user").role === "admin" ? next() : c.json({ error: "Admins only" }, 403)));

serviceKeysApp.get("/", (c) =>
  c.json(
    SERVICE_KEYS.map((k): ServiceKeyView => {
      const value = saved[k.env] || fromServer[k.env];
      return {
        env: k.env, name: k.name, what: k.what, ...("where" in k ? { where: k.where } : {}),
        source: saved[k.env] ? "settings" : fromServer[k.env] ? "server" : null,
        ...(value ? { last4: value.slice(-4) } : {}),
      };
    }),
  ),
);

serviceKeysApp.put("/:env", async (c) => {
  const name = c.req.param("env");
  if (!NAMES.has(name)) return c.json({ error: "No such key" }, 404);
  const b = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
  const value = typeof b?.value === "string" ? b.value.trim() : b?.value === null ? null : undefined;
  if (value === undefined || value === "" || (value && (value.length > 500 || /\s/.test(value))))
    return c.json({ error: "Paste the key (one line, no spaces), or null to forget it" }, 400);
  const next = { ...saved };
  if (value) next[name as ServiceKeyEnv] = value;
  else delete next[name as ServiceKeyEnv];
  mkdirSync(env.dataDir, { recursive: true });
  const tmp = `${FILE()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, FILE());
  saved = next;
  apply();
  return c.json({ ok: true });
});
