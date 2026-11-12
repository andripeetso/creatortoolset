import { Hono } from "hono";
import { definePlugin } from "../../api/lib/plugin";
import { viaTunnel, type AuthVars } from "../../api/auth";
import { mine, NOT_MINE, setUp, signOut, startSignIn, stateOf } from "./engine";

// Adobe Enhance Speech as an engine of the Audio Enhancer (engine.ts registers it), and its Settings section's routes at
// /api/x/adobe-enhance: the state, Sign in (a Chrome window on this Mac) and Sign out. All of it is for the person whose
// Mac this server runs on (the account an admin, not a hosted server).
const routes = new Hono<{ Variables: AuthVars }>();
routes.use("*", async (c, next) => {
  if (!mine(c.get("user"))) return c.json({ error: NOT_MINE }, 403);
  await next();
});
routes.get("/", (c) => c.json(stateOf(c.get("user").username)));
routes.post("/signin", (c) => {
  // the window opens on this Mac's screen: only from this Mac, never through its tunnel
  if (viaTunnel(c)) return c.json({ error: "Sign in to Adobe on the Mac itself." }, 403);
  const u = c.get("user").username;
  if (!stateOf(u).chrome) return c.json({ error: "Needs Google Chrome on this Mac." }, 409);
  startSignIn(u);
  return c.json(stateOf(u));
});
routes.post("/signout", (c) => {
  const u = c.get("user").username;
  const busy = signOut(u);
  return busy ? c.json({ error: busy }, 409) : c.json(stateOf(u));
});

export default definePlugin({
  id: "adobe-enhance",
  name: "Adobe Enhance Speech",
  about: "Adobe's Enhance Speech in the Audio Enhancer, with your own Adobe account.",
  kind: "enhance",
  routes,
  // signed in to Adobe, the Audio Enhancer counts as set up ("Needs an API key or an Adobe sign-in" until then); the
  // row's Set up shows this plug-in's Settings section (web.tsx) under the key form
  needs: [{ tool: "enhance", what: "An Adobe sign-in", met: setUp, settings: "adobe-enhance" }],
});
