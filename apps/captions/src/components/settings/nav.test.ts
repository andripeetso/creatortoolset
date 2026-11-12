import { describe, expect, it } from "vitest";
import { navBlocks, navListFor, type NavContext } from "./nav";

const at = (hosted: boolean, admin: boolean, mac = false): NavContext => ({ hosted, admin, mac });
const listed = (ctx: NavContext) => navListFor(ctx, []).map((s) => s.id);

describe("the sidebar per install and role", () => {
  it("a local browser: General, Appearance, Tools, the AI block, the devices, the connections; no servers, team or admin", () => {
    expect(listed(at(false, true))).toEqual([
      "general", "appearance", "tools",
      "providers", "automations", "memory", "usage",
      "devices", "folders",
      "connectors", "keys", "own-ai",
    ]);
  });

  it("the Mac app adds Servers to the devices", () => {
    expect(listed(at(false, true, true))).toContain("servers");
    expect(listed(at(true, false, true))).toContain("servers");
  });

  it("AI Editor (its post-processing steps) is on the Mac app's own server only: they are switched on there", () => {
    expect(listed(at(false, true, true))).toEqual(expect.arrayContaining(["tools", "editor"]));
    expect(listed(at(false, true))).not.toContain("editor");
    expect(listed(at(true, true, true))).not.toContain("editor");
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

  it("the Mac app's own server: the AI Editor's steps head a Plug-ins block after Connections, not the top block", () => {
    const blocks = navBlocks(navListFor(at(false, true, true), []));
    expect(blocks.map((b) => b.heading)).toEqual([undefined, "AI", "Hardware", "Connections", "Plug-ins"]);
    expect(blocks[0].items.map((s) => s.id)).toEqual(["general", "appearance", "tools"]);
    expect(blocks.at(-1)?.items.map((s) => s.id)).toEqual(["editor"]);
  });
});
