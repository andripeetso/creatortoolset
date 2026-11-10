import { describe, expect, it } from "vitest";
import { Sparkles } from "lucide-react";
import type { Me } from "./auth";
import { defineWebPlugin, mergePluginInfo, webPluginAdds } from "./plugin";
import { resolveSection, type NavContext } from "../components/settings/nav";
import hello from "../../plugin-examples/hello/web";

const member = (off: string[] = []): Me => ({ username: "member", role: "user", cloud: false, off });
const admin: Me = { username: "owner", role: "admin", cloud: false, off: [] };

const tiny = defineWebPlugin({
  id: "tiny",
  name: "Tiny Tools",
  about: "A small example",
  tiles: [{ stage: "Tools", to: "/tiny", icon: Sparkles, name: "Tiny", desc: "tile", gate: "tiny-gate" }],
  settings: [
    { id: "tiny-admin", title: "Tiny admin", icon: Sparkles, adminTab: true, body: null },
    { id: "tiny-section", title: "Tiny section", icon: Sparkles, group: "AI", body: null },
  ],
  devices: [{ id: "tiny-drive", title: "Tiny drive", adminOnly: true, body: null }],
  replaces: { media: () => null },
  routes: [{ path: "/tiny/:id", element: null }],
});

describe("webPluginAdds", () => {
  it("names what a plug-in adds, each with the path it lives at", () => {
    const adds = webPluginAdds(hello, { me: admin, hosted: true });
    expect(adds).toContainEqual({ text: "Home: Hello", to: "/hello" });
    expect(adds).toContainEqual({ text: "Settings: Hello plug-in", to: "/settings/hello" });
    expect(adds).toContainEqual({ text: "Page at /hello", to: "/hello" });
  });

  it("leaves out admin tabs off a hosted server, gated tiles while the gate is off, and admin-only items for members", () => {
    const local = webPluginAdds(tiny, { me: admin, hosted: false }).map((a) => a.text);
    expect(local).not.toContain("Settings → Admin → Tiny admin");
    expect(webPluginAdds(tiny, { me: admin, hosted: true })).toContainEqual({ text: "Settings → Admin → Tiny admin", to: "/settings/admin/tiny-admin" });
    expect(webPluginAdds(tiny, { me: member(["tiny-gate"]), hosted: true }).map((a) => a.text)).not.toContain("Home: Tiny");
    const asMember = webPluginAdds(tiny, { me: member(), hosted: true }).map((a) => a.text);
    expect(asMember).toContain("Settings → AI: Tiny section");
    expect(asMember).not.toContain("Settings → Storage: Tiny drive");
    expect(asMember).not.toContain("Settings → Admin → Tiny admin");
  });

  it("gives every Settings link a page this install and person can open", () => {
    const plugins = [hello, tiny];
    const contexts: Array<[NavContext, Me]> = [
      [{ hosted: true, admin: true, mac: false }, admin],
      [{ hosted: true, admin: false, mac: false }, member()],
      [{ hosted: false, admin: true, mac: false }, admin],
      [{ hosted: false, admin: false, mac: false }, member()],
    ];
    for (const [ctx, me] of contexts) {
      for (const p of plugins) {
        for (const a of webPluginAdds(p, { me, hosted: ctx.hosted })) {
          if (!a.to?.startsWith("/settings/")) continue;
          const section = a.to.split("/")[2];
          expect(resolveSection(section, ctx, plugins).kind, `${a.text} (${section})`).toBe("page");
        }
      }
    }
  });
});

describe("mergePluginInfo", () => {
  it("merges web and server by id, keeps server-only plug-ins, and does not repeat an add", () => {
    const merged = mergePluginInfo(
      [tiny],
      [
        { id: "tiny", name: "tiny", about: "server line", adds: [{ text: "Connector: Tiny reader", to: "/settings/connectors" }] },
        { id: "server-only", name: "Server only", about: "no web part", adds: [{ text: "1 tool for your own AI", to: "/settings/own-ai" }] },
      ],
      { me: admin, hosted: false },
    );
    expect(merged.map((p) => [p.id, p.name])).toEqual([
      ["tiny", "Tiny Tools"],
      ["server-only", "Server only"],
    ]);
    expect(merged[0].about).toBe("A small example");
    expect(merged[0].adds.map((a) => a.text)).toContain("Connector: Tiny reader");
    expect(merged[1].adds).toEqual([{ text: "1 tool for your own AI", to: "/settings/own-ai" }]);
  });
});
