import { Hono } from "hono";
import type { AuthVars } from "../auth";
import { keepFetched, removeFile, useFile } from "../assistant-files";
import { InstagramRefused, loginState, mayUseInstagram, readPost, signOut, startSignIn } from "../lib/instagram/session";

/**
 * Media Library → Add from Instagram: a post or reel by its link, read with the person's own Instagram sign-in
 * (lib/instagram/session.ts), each of its videos and photos added like a file dropped in the chat (useFile).
 */
export const instagramAddApp = new Hono<{ Variables: AuthVars }>();

const NOT_MINE = "Only this Mac's owner can add from Instagram";

instagramAddApp.get("/instagram/login", (c) => {
  const u = c.get("user");
  return c.json({ ...loginState(u.username), allowed: mayUseInstagram(u) });
});

instagramAddApp.post("/instagram/login", (c) => {
  const u = c.get("user");
  if (!mayUseInstagram(u)) return c.json({ error: NOT_MINE }, 403);
  startSignIn(u.username);
  return c.json(loginState(u.username));
});

instagramAddApp.delete("/instagram/login", (c) => {
  const u = c.get("user");
  if (!mayUseInstagram(u)) return c.json({ error: NOT_MINE }, 403);
  signOut(u.username);
  return c.json(loginState(u.username));
});

instagramAddApp.post("/instagram/add", async (c) => {
  const u = c.get("user");
  if (!mayUseInstagram(u)) return c.json({ error: NOT_MINE }, 403);
  const b = (await c.req.json().catch(() => null)) as { link?: unknown } | null;
  try {
    const post = await readPost(u.username, typeof b?.link === "string" ? b.link : "");
    const added: { name: string; href: string; note?: string }[] = [];
    for (const [i, f] of post.files.entries()) {
      const r = await fetch(f.url);
      if (!r.ok || !r.body) throw new InstagramRefused("Could not download the post. Try again later");
      const name = `${post.username} ${post.code}${post.files.length > 1 ? ` ${i + 1}` : ""}${f.kind === "video" ? ".mp4" : ".jpg"}`;
      const file = await keepFetched(u.username, name, f.kind === "video" ? "video/mp4" : "image/jpeg", r.body);
      let waiting = false;
      try {
        const used = await useFile(u, file.id, "library");
        waiting = !!used.waiting;
        added.push({ name: used.name, href: used.href, ...(used.note ? { note: used.note } : {}) });
      } finally {
        // the library keeps its own copy; a save waiting for a computer still reads this one (kept 7 days, as a drop)
        if (!waiting) await removeFile(u.username, file.id).catch(() => {});
      }
    }
    return c.json({ added });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, e instanceof InstagramRefused ? 409 : 500);
  }
});
