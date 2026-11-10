import { Hono } from "hono";
import { definePlugin, requireGate } from "../../api/lib/plugin";

// Example plug-in: copy this folder to plugins/hello (or run with CT_PLUGINS=hello) to see the slot work.
// Its route answers at /api/x/hello/ping, behind the same login as the rest of /api, and behind its "hello" gate.
const app = new Hono();
app.get("/ping", requireGate("hello"), (c) => c.json({ ok: true, plugin: "hello", greeting: process.env.HELLO_GREETING ?? "hello" }));

// A tool for the person's own AI, once it is connected (Settings → Headless access). The handler gets the tool's
// arguments and the account that asked; ctx.api(path) calls this server's own routes as that account.
const tools = {
  defs: [{ name: "hello_greet", description: "Greet someone by name, from the example plug-in.", inputSchema: { type: "object", properties: { name: { type: "string" } } } }],
  handlers: {
    hello_greet: async (args: { name?: string }, ctx: { user: { username: string } }) => ({
      greeting: `${process.env.HELLO_GREETING ?? "hello"}, ${args.name || ctx.user.username}`,
    }),
  },
};

export default definePlugin({
  id: "hello",
  name: "Hello",
  about: "The example plug-in: a route behind a gate, and a tool for your own AI.",
  env: ["HELLO_GREETING"],
  gates: { ids: ["hello"] },
  routes: app,
  tools,
});
