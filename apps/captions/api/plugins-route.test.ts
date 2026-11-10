import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { definePlugin, mountPlugins, mountPluginsList } from "./lib/plugin";

// A plug-in whose preset carries a home folder and an endpoint: neither may reach the response.
const tiny = definePlugin({
  id: "tiny-tools",
  name: "Tiny Tools",
  about: "A small example plug-in",
  providers: {
    presets: [{ id: "tiny-claude", name: "Tiny Claude", driver: "claude", badge: "Custom", home: "/Users/tiny/.claude", baseUrl: "https://secret.example/v1" }],
  },
  tools: { defs: [{ name: "tiny_a" }, { name: "tiny_b" }], handlers: {} },
});

type Body = { plugins: Array<{ id: string; name: string; about?: string; adds?: Array<{ text: string; to?: string }> }> };

function appAs(role: string | null) {
  const app = new Hono<any>();
  app.use(async (c, next) => {
    if (role) c.set("user", { role });
    await next();
  });
  mountPlugins(app, [tiny]);
  mountPluginsList(app);
  return app;
}

describe("GET /api/plugins", () => {
  it("tells an admin what each plug-in adds, by name and count only", async () => {
    const body = (await (await appAs("admin").request("/api/plugins")).json()) as Body;
    expect(body.plugins[0].adds?.map((a) => a.text)).toEqual(["AI provider preset: Tiny Claude", "2 tools for your own AI"]);
    expect(JSON.stringify(body)).not.toMatch(/\/Users\/|secret\.example/);
  });

  it("gives any other account only the id, name and about", async () => {
    const body = (await (await appAs("user").request("/api/plugins")).json()) as Body;
    expect(body.plugins).toEqual([{ id: "tiny-tools", name: "Tiny Tools", about: "A small example plug-in" }]);
  });
});
