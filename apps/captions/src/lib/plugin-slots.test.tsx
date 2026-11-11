import { describe, expect, it } from "vitest";
import { Hand, Sparkles } from "lucide-react";
import type { Me } from "./auth";
import { accountItemsFor, adminTabsFor, defineWebPlugin, devicesSectionsFor, itemActionsFor, replacementFor, reviewSlotsFor, settingsWithPlugins, visibleSettings, webPluginAdds, type WebPlugin } from "./plugin";
import { shownTools, withPluginTiles } from "./tools";
import hello from "../../plugin-examples/hello/web";

const member = (off: string[] = []): Me => ({ username: "member", role: "user", cloud: false, off });
const admin = (off: string[] = []): Me => ({ username: "owner", role: "admin", cloud: false, off });

const tiny = defineWebPlugin({
  id: "tiny",
  tiles: [
    { stage: "Make", to: "/tiny-make", icon: Sparkles, name: "Tiny Make", desc: "a make tile", gate: "tiny-gate" },
    { stage: "Tools", to: "/tiny-tools", icon: Sparkles, name: "Tiny Tools", desc: "a quiet tile", gate: "tiny-gate" },
  ],
  settings: [{ id: "tiny", title: "Tiny", icon: Sparkles, adminOnly: true, body: null }],
  accountMenu: [
    { label: "Tiny account", to: "/tiny", icon: Sparkles, gate: "tiny-gate" },
    { label: "Everyone", to: "/everyone", icon: Sparkles },
  ],
});

describe("Home tiles", () => {
  it("leaves the built-in stages and Tools row as they were with no plug-ins", () => {
    const { workflow, other } = withPluginTiles([]);
    expect(workflow.map((s) => [s.stage, s.tools.map((t) => t.name)])).toEqual([
      ["Plan", ["Content Analyzer", "Content Workshop"]],
      ["Make", ["AI Editor", "Review"]],
      ["Distribute", ["Video Cleaner", "Story Splitter", "Finals"]],
    ]);
    expect(other.map((t) => t.name)).toEqual([
      "Media Library", "Audio Enhancer", "Caption Studio", "Video Notes", "Screen Recorder", "Guide Builder",
    ]);
  });

  it("puts a plug-in tile at the end of the stage it names, or in the Tools row", () => {
    const { workflow, other } = withPluginTiles([tiny]);
    expect(workflow[1].tools.map((t) => t.name)).toEqual(["AI Editor", "Review", "Tiny Make"]);
    expect(other.map((t) => t.name).at(-1)).toBe("Tiny Tools");
  });

  it("hides a plug-in tile whose gate is off for the account, and keeps built-in tiles", () => {
    const { workflow } = withPluginTiles([tiny]);
    const make = workflow[1].tools;
    expect(shownTools(make, member()).map((t) => t.name)).toEqual(["AI Editor", "Review", "Tiny Make"]);
    expect(shownTools(make, member(["tiny-gate"])).map((t) => t.name)).toEqual(["AI Editor", "Review"]);
    expect(shownTools(make, admin(["tiny-gate"])).map((t) => t.name)).toContain("Tiny Make");
    expect(shownTools(make, null).map((t) => t.name)).toEqual(["AI Editor", "Review"]);
  });

  it("hides the example plug-in's Hello tile when its gate is switched off", () => {
    const { other } = withPluginTiles([hello]);
    const hidden = (me: Me) => !shownTools(other, me).some((t) => t.to === "/hello");
    expect(hidden(member())).toBe(false);
    expect(hidden(member(["hello"]))).toBe(true);
    expect(hidden(admin(["hello"]))).toBe(false);
  });

  it("refuses a tile that names no stage", () => {
    const bad = defineWebPlugin({ id: "bad", tiles: [{ stage: "Nope" as "Make", to: "/x", icon: Hand, name: "Bad", desc: "", gate: "bad" }] });
    expect(() => withPluginTiles([bad])).toThrow('names no stage "Nope"');
  });
});

describe("Settings sections", () => {
  const builtin = [
    { id: "general", title: "General", icon: Hand },
    { id: "providers", title: "AI providers", icon: Hand, group: "AI" },
    { id: "keys", title: "API keys", icon: Hand, adminOnly: true, group: "Server" },
  ];

  it("puts a plug-in section with no group at the end of the top block, before the first headed block", () => {
    const sections = settingsWithPlugins(builtin, [tiny]);
    expect(sections.map((s) => s.id)).toEqual(["general", "tiny", "providers", "keys"]);
  });

  it("places a plug-in section inside its group, and an adminTab stays out of the sidebar", () => {
    const grouped = defineWebPlugin({
      id: "grouped",
      settings: [
        { id: "ai-extra", title: "AI extra", icon: Hand, group: "AI", body: null },
        { id: "footage", title: "Footage", icon: Hand, adminOnly: true, adminTab: true, body: null },
      ],
    });
    expect(settingsWithPlugins(builtin, [grouped]).map((s) => s.id)).toEqual(["general", "providers", "ai-extra", "keys"]);
    expect(adminTabsFor(admin(), [grouped]).map((s) => s.id)).toEqual(["footage"]);
    expect(adminTabsFor(member(), [grouped])).toEqual([]);
  });

  it("keeps the built-in order when no plug-in adds one", () => {
    expect(settingsWithPlugins(builtin, []).map((s) => s.id)).toEqual(["general", "providers", "keys"]);
  });

  it("shows an adminOnly plug-in section to admins only", () => {
    const sections = settingsWithPlugins(builtin, [tiny]);
    expect(visibleSettings(sections, member()).map((s) => s.id)).toEqual(["general", "providers"]);
    expect(visibleSettings(sections, admin()).map((s) => s.id)).toEqual(["general", "tiny", "providers", "keys"]);
  });

  it("refuses a plug-in section that reuses a built-in id", () => {
    const clash = defineWebPlugin({ id: "clash", settings: [{ id: "general", title: "x", icon: Hand, body: null }] });
    expect(() => settingsWithPlugins(builtin, [clash])).toThrow('"general" is already a built-in section');
  });

  it("shows the example plug-in's Hello section to admins only", () => {
    const sections = settingsWithPlugins(builtin, [hello]);
    expect(visibleSettings(sections, member()).some((s) => s.id === "hello")).toBe(false);
    expect(visibleSettings(sections, admin()).some((s) => s.id === "hello")).toBe(true);
  });
});

describe("account menu items", () => {
  it("shows a gated plug-in item only where its gate is on, and an ungated one to everyone", () => {
    const plugins: WebPlugin[] = [tiny];
    expect(accountItemsFor(member(), plugins).map((i) => i.label)).toEqual(["Tiny account", "Everyone"]);
    expect(accountItemsFor(member(["tiny-gate"]), plugins).map((i) => i.label)).toEqual(["Everyone"]);
    expect(accountItemsFor(admin(["tiny-gate"]), plugins).map((i) => i.label)).toEqual(["Tiny account", "Everyone"]);
    expect(accountItemsFor(null, plugins).map((i) => i.label)).toEqual(["Everyone"]);
  });
});

describe("Review slots", () => {
  const Panel = () => null;
  const review = defineWebPlugin({
    id: "review-test",
    review: {
      panels: [
        { id: "gated", gate: "tiny-gate", panel: Panel },
        { id: "open", panel: Panel },
      ],
      actions: [
        { label: "Gated action", icon: Sparkles, gate: "tiny-gate", onRun: () => {} },
        { label: "Open action", onRun: () => {} },
      ],
    },
  });

  it("adds nothing when no plug-in fills the Review slots", () => {
    expect(reviewSlotsFor(member(), [tiny])).toEqual({ panels: [], actions: [] });
  });

  it("shows a gated panel or button only where its gate is on, and an open one to everyone", () => {
    const slots = reviewSlotsFor(member(), [review]);
    expect(slots.panels.map((p) => p.id)).toEqual(["gated", "open"]);
    expect(slots.actions.map((a) => a.label)).toEqual(["Gated action", "Open action"]);
    const off = reviewSlotsFor(member(["tiny-gate"]), [review]);
    expect(off.panels.map((p) => p.id)).toEqual(["open"]);
    expect(off.actions.map((a) => a.label)).toEqual(["Open action"]);
    expect(reviewSlotsFor(admin(["tiny-gate"]), [review]).actions).toHaveLength(2);
  });
});

describe("replaced pages", () => {
  const Mine = () => null;
  const Other = () => null;

  it("uses the built-in page when no plug-in replaces it", () => {
    expect(replacementFor([tiny, hello], "editor")).toBeUndefined();
  });

  it("uses a plug-in's replacement for the page it names, and only that page", () => {
    const swap = defineWebPlugin({ id: "swap", replaces: { editor: Mine } });
    expect(replacementFor([tiny, swap], "editor")).toBe(Mine);
    expect(replacementFor([tiny, swap], "editorEdit")).toBeUndefined();
  });

  it("lets a plug-in's storage replacement stand in for the Storage folders, and only that", () => {
    const folders = defineWebPlugin({ id: "folders", replaces: { storage: Mine } });
    expect(replacementFor([tiny, folders], "storage")).toBe(Mine);
    expect(replacementFor([tiny, folders], "media")).toBeUndefined();
    expect(replacementFor([tiny], "storage")).toBeUndefined();
  });

  it("refuses two plug-ins replacing the same page", () => {
    const a = defineWebPlugin({ id: "a", replaces: { editor: Mine } });
    const b = defineWebPlugin({ id: "b", replaces: { editor: Other } });
    expect(() => replacementFor([a, b], "editor")).toThrow("more than one plug-in replaces the editor page: a, b");
  });
});

describe("item actions", () => {
  const open = defineWebPlugin({
    id: "open",
    itemActions: {
      session: [
        { label: "Open in tool", icon: Sparkles, gate: "tiny-gate", onRun: () => {} },
        { label: "Always", onRun: () => {} },
      ],
    },
  });

  it("shows no buttons for a kind no plug-in names", () => {
    expect(itemActionsFor(member(), [open], "export")).toEqual([]);
    expect(itemActionsFor(member(), [], "session")).toEqual([]);
  });

  it("shows a session button to everyone, and a gated one only where its gate is on", () => {
    expect(itemActionsFor(member(), [open], "session").map((a) => a.label)).toEqual(["Open in tool", "Always"]);
    expect(itemActionsFor(member(["tiny-gate"]), [open], "session").map((a) => a.label)).toEqual(["Always"]);
    expect(itemActionsFor(admin(["tiny-gate"]), [open], "session").map((a) => a.label)).toEqual(["Open in tool", "Always"]);
    expect(itemActionsFor(null, [open], "session").map((a) => a.label)).toEqual(["Always"]);
  });

  it("a button on the project open in Caption Studio gets that project's id, and Community names where it is", () => {
    const got: string[] = [];
    const clips = defineWebPlugin({ id: "clips", itemActions: { captions: [{ label: "Tiny edit", gate: "tiny-gate", onRun: (id) => void got.push(id) }] } });
    expect(itemActionsFor(member(), [open], "captions")).toEqual([]);
    void itemActionsFor(member(), [clips], "captions")[0]!.onRun("p1");
    expect(got).toEqual(["p1"]);
    expect(itemActionsFor(member(["tiny-gate"]), [clips], "captions")).toEqual([]);
    expect(webPluginAdds(clips, { me: member(), hosted: false })).toEqual([{ text: "Button on Caption Studio projects: Tiny edit", to: "/captions" }]);
  });
});

describe("Devices sections", () => {
  it("adds a plug-in's sections, admin-only ones only for an admin", () => {
    const drives = defineWebPlugin({
      id: "drives",
      devices: [
        { id: "nas", title: "Network storage", adminOnly: true, body: null },
        { id: "open", title: "Open", body: null },
      ],
    });
    expect(devicesSectionsFor(member(), [drives]).map((s) => s.id)).toEqual(["open"]);
    expect(devicesSectionsFor(admin(), [drives]).map((s) => s.id)).toEqual(["nas", "open"]);
    expect(devicesSectionsFor(admin(), [])).toEqual([]);
  });

  it("puts a section on Devices only when it says page: computers", () => {
    const plugin = defineWebPlugin({
      id: "editor-boxes",
      devices: [
        { id: "boxes", title: "AI Editor computers", page: "computers", adminOnly: true, body: null },
        { id: "nas", title: "Network storage", adminOnly: true, body: null },
      ],
    });
    expect(devicesSectionsFor(admin(), [plugin], "computers").map((s) => s.id)).toEqual(["boxes"]);
    expect(devicesSectionsFor(admin(), [plugin]).map((s) => s.id)).toEqual(["nas"]);
    expect(devicesSectionsFor(member(), [plugin], "computers")).toEqual([]);
  });
});
