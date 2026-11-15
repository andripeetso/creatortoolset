import { describe, expect, it } from "vitest";
import { navBlocks, navListFor, resolveSection, type NavContext } from "./nav";

const at = (hosted: boolean, admin: boolean, mac = false): NavContext => ({ hosted, admin, mac });
const listed = (ctx: NavContext) => navListFor(ctx, []).map((s) => s.id);

describe("the sidebar per install and role", () => {
  it("a local browser: You, AI, then Storage and API keys under Server; no servers or team", () => {
    expect(listed(at(false, true))).toEqual([
      "general", "appearance", "tools", "voice", "devices", "connectors", "own-ai",
      "providers", "memory", "automations", "usage",
      "folders", "keys",
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

  it("nobody has an Admin page: its old addresses still open (and send on to their new places)", () => {
    expect(listed(at(true, true))).not.toContain("admin");
    expect(listed(at(true, false))).not.toContain("admin");
    expect(resolveSection("admin", at(true, true), [])).toEqual({ kind: "page", id: "admin" });
    expect(resolveSection("admin", at(true, false), [])).toEqual({ kind: "page", id: "admin" });
  });

  it("a hosted member and admin both see Team under Server", () => {
    expect(listed(at(true, false))).toContain("team");
    expect(listed(at(true, true)).slice(-3)).toEqual(["team", "folders", "keys"]);
  });

  it("a plug-in's server-wide page (was an Admin tab) is in Plug-ins for an admin on a hosted server only", () => {
    const plugins = [{ settings: [{ id: "tiny-footage", title: "Footage", body: null, adminTab: true } as never] }];
    expect(navListFor(at(true, true), plugins).map((s) => s.id)).toContain("tiny-footage");
    expect(navListFor(at(true, false), plugins).map((s) => s.id)).not.toContain("tiny-footage");
    expect(navListFor(at(false, true), plugins).map((s) => s.id)).not.toContain("tiny-footage");
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
  it("a hosted admin's blocks, by whose setting it is: You, AI, Server", () => {
    const blocks = navBlocks(navListFor(at(true, true, true), []));
    expect(blocks.map((b) => b.heading)).toEqual(["You", "AI", "Server"]);
    expect(blocks[0].items.map((s) => s.id)).toEqual(["general", "appearance", "tools", "voice", "devices", "servers", "connectors", "own-ai"]);
    expect(blocks[2].items.map((s) => s.id)).toEqual(["team", "folders", "keys"]);
  });

  it("a plug-in's own section with no group heads a Plug-ins block, last", () => {
    const blocks = navBlocks(navListFor(at(true, true, true), [{ settings: [{ id: "tiny", title: "Tiny", body: null } as never] }]));
    expect(blocks.map((b) => b.heading)).toEqual(["You", "AI", "Server", "Plug-ins"]);
    expect(blocks[3].items.map((s) => s.id)).toEqual(["tiny"]);
  });

  it("a plug-in section that names a tool is on that tool's page: no sidebar block, and its address goes there", () => {
    const plugins = [{ settings: [{ id: "tiny-picks", title: "Tiny picks", body: null, tool: "workshop" } as never] }];
    expect(navBlocks(navListFor(at(true, true, true), plugins)).map((b) => b.heading)).not.toContain("Plug-ins");
    expect(resolveSection("tiny-picks", at(true, true, true), plugins)).toEqual({ kind: "redirect", to: "/settings/tools/workshop" });
  });
});
