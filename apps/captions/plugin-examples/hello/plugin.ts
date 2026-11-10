import { Hono } from "hono";
import { definePlugin, requireGate } from "../../api/lib/plugin";

// Example plug-in: copy this folder to plugins/hello (or run with CT_PLUGINS=hello) to see the slot work.
// Its route answers at /api/x/hello/ping, behind the same login as the rest of /api, and behind its "hello" gate.
const app = new Hono();
app.get("/ping", requireGate("hello"), (c) => c.json({ ok: true, plugin: "hello", greeting: process.env.HELLO_GREETING ?? "hello" }));

export default definePlugin({ id: "hello", name: "Hello", about: "The example plug-in: a route behind a gate.", env: ["HELLO_GREETING"], gates: { ids: ["hello"] }, routes: app });
