import { Hono } from "hono";
import { type AuthVars } from "./auth";
import { findUser, setLogin } from "./users";

/**
 * Settings → Account: the sign-in name. Changing it moves no files (they stay filed under the username), and the
 * next sign-in uses the new name. Mounted at /api/account-profile behind the account gate (boot.ts).
 */
export const accountProfileApp = new Hono<{ Variables: AuthVars }>();

accountProfileApp.get("/", (c) => {
  const me = findUser(c.get("user").username);
  if (!me) return c.json({ error: "Sign in with an account first" }, 401);
  return c.json({ username: me.username, login: me.login ?? me.username });
});

accountProfileApp.patch("/", async (c) => {
  const me = findUser(c.get("user").username);
  if (!me) return c.json({ error: "Sign in with an account first" }, 401);
  const b = (await c.req.json().catch(() => ({}))) as { login?: unknown };
  if (typeof b.login !== "string") return c.json({ error: "A sign-in name is needed" }, 400);
  try {
    setLogin(me, b.login);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ username: me.username, login: me.login ?? me.username });
});
