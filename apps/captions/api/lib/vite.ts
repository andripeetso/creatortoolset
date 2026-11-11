import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";
import { clipPageAgentResponse, injectClipPageHtml } from "../clip-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type App = Hono<{ Bindings: HttpBindings; Variables: any }>;

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  app.get("/favicon.ico", (c) => c.redirect("/icons/icon-192.png", 301));
  // Vite's /assets/ files carry a content hash in their name: keep them for a year, so a reopen never refetches the
  // app. index.html (served by notFound below) is never cached, so a new deploy still loads at once.
  // /fonts/ too: with no header the CDN kept them 4 hours, then a visitor waited on the origin for the headings' font.
  // A font that changes gets a new name or ?v= in its url().
  app.use(
    "*",
    serveStatic({
      root: "./dist/public",
      onFound: (p, c) => {
        if (p.includes("/assets/") || p.includes("/fonts/")) c.header("Cache-Control", "public, max-age=31536000, immutable");
        else if (p.endsWith(".html")) c.header("Cache-Control", "no-cache");
      },
    }),
  );

  app.notFound(async (c) => {
    const agent = await clipPageAgentResponse(c);
    if (agent) return agent;
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    const raw = fs.readFileSync(indexPath, "utf-8");
    const content = injectClipPageHtml(
      raw,
      c.req.url,
      { get: (name) => c.req.header(name) },
      c.req.path,
    );
    c.header("Cache-Control", "no-cache");
    return c.html(content);
  });
}
