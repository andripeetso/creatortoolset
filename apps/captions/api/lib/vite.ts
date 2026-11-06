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

  app.use("*", serveStatic({ root: "./dist/public" }));

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
    return c.html(content);
  });
}
