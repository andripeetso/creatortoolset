import { Hono } from "hono";
import { type AuthVars } from "./auth";
import { findUser, setLogin, verifyPassword } from "./users";

/**
 * Settings → Account: the sign-in name. Changing it moves no files (they stay filed under the username), and the
 * next sign-in uses the new name. Mounted at /api/account-profile behind the account gate (boot.ts). The current
 * password is checked first, as POST /api/auth/password does: a wrong one changes nothing.
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
  const b = (await c.req.json().catch(() => ({}))) as { login?: unknown; password?: unknown };
  if (typeof b.password !== "string" || !verifyPassword(me, b.password)) return c.json({ error: "The current password is wrong" }, 403);
  if (typeof b.login !== "string") return c.json({ error: "A sign-in name is needed" }, 400);
  try {
    setLogin(me, b.login);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ username: me.username, login: me.login ?? me.username });
});
