import { describe, expect, it } from "vitest";
import { navBlocks, navListFor, resolveSection, type NavContext } from "./nav";

const at = (hosted: boolean, admin: boolean, mac = false): NavContext => ({ hosted, admin, mac });
const listed = (ctx: NavContext) => navListFor(ctx, []).map((s) => s.id);

describe("the sidebar per install and role", () => {
  it("a local browser: General, Appearance, Tools, the AI block, the devices, the connections; no servers, team or admin", () => {
    expect(listed(at(false, true))).toEqual([
      "general", "appearance", "tools",
      "providers", "voice", "automations", "memory", "usage",
      "devices", "folders",
      "connectors", "keys", "own-ai",
    ]);
  });

  it("the Mac app adds Servers to the devices", () => {
    expect(listed(at(false, true, true))).toContain("servers");
    expect(listed(at(true, false, true))).toContain("servers");
  });

  it("the AI Editor has no sidebar page: its steps are on its page under Tools, where the old address goes", () => {
    expect(listed(at(false, true, true))).not.toContain("editor");
    expect(resolveSection("editor", at(false, true, true), [])).toEqual({ kind: "redirect", to: "/settings/tools/editor" });
  });

  it("a hosted member sees Team but not Admin", () => {
    const ids = listed(at(true, false));
    expect(ids).toContain("team");
    expect(ids).not.toContain("admin");
  });

  it("a hosted admin sees Team and Admin, the admin block last", () => {
    const ids = listed(at(true, true));
    expect(ids).toEqual(expect.arrayContaining(["team", "admin"]));
    expect(ids.at(-1)).toBe("admin");
  });

  it("on a server whose plug-in keeps the storage, members still get Storage (what they keep on the server)", () => {
    const owns = [{ replaces: { storage: () => null } }];
    expect(navListFor(at(true, false), owns).map((s) => s.id)).toContain("folders");
    expect(navListFor(at(true, true), owns).map((s) => s.id)).toContain("folders");
    expect(listed(at(true, false))).toContain("folders");
  });

  it("never lists Account: its entry is the account button", () => {
    expect(listed(at(true, true, true))).not.toContain("account");
  });
});

describe("the sidebar blocks", () => {
  it("a hosted admin's blocks: a top block with no heading, then AI, Devices, Connections and People", () => {
    const blocks = navBlocks(navListFor(at(true, true, true), []));
    expect(blocks.map((b) => b.heading)).toEqual([undefined, "AI", "Hardware", "Connections", "People"]);
    expect(blocks[0].items.map((s) => s.id)).toEqual(["general", "appearance", "tools"]);
  });

  it("a plug-in's own section with no group heads a Plug-ins block after Connections, before People", () => {
    const blocks = navBlocks(navListFor(at(true, true, true), [{ settings: [{ id: "tiny", title: "Tiny", body: null } as never] }]));
    expect(blocks.map((b) => b.heading)).toEqual([undefined, "AI", "Hardware", "Connections", "Plug-ins", "People"]);
    expect(blocks[4].items.map((s) => s.id)).toEqual(["tiny"]);
  });

  it("a plug-in section that names a tool is on that tool's page: no sidebar block, and its address goes there", () => {
    const plugins = [{ settings: [{ id: "tiny-picks", title: "Tiny picks", body: null, tool: "workshop" } as never] }];
    expect(navBlocks(navListFor(at(true, true, true), plugins)).map((b) => b.heading)).not.toContain("Plug-ins");
    expect(resolveSection("tiny-picks", at(true, true, true), plugins)).toEqual({ kind: "redirect", to: "/settings/tools/workshop" });
  });
});
