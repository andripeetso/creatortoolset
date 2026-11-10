import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DRIVERS, type DriverCatalog, type MacReport } from "@contracts/providers";
import { buildInstance, defaultName, instanceId, ToolGrid } from "./AddProviderDialog";

/** The catalog as the server sends it: only Claude and Gemini run today; the rest carry the server's reason. */
const catalog: DriverCatalog = {
  drivers: DRIVERS.map((d) => {
    const runs = d.id === "claude" || d.id === "gemini";
    return {
      id: d.id,
      label: d.label,
      featured: d.featured,
      runs,
      ...(runs ? {} : { reason: d.id === "musecode" ? "The Creator Toolset Mac app can't run this CLI yet." : `${d.label} can't run yet.` }),
      devices: [],
    };
  }),
};

const grid = (report: MacReport | null, showMore: boolean, added: string[] = []) =>
  renderToStaticMarkup(<ToolGrid catalog={catalog} report={report} driver={null} showMore={showMore} added={added} onPick={() => {}} onToggleMore={() => {}} />);

describe("Add provider tool grid", () => {
  it("lists the featured tools in order, and hides Gemini and the local command behind Show more", () => {
    const html = grid(null, false);
    const order = ["Codex", "Claude", "Cursor", "Grok", "OpenCode", "Antigravity", "Muse Code", "Pi"].map((s) => html.indexOf(`>${s}<`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain(">Gemini<");
    expect(html).toContain("Show more");
  });

  it("puts a tool the computer has first and marks it Installed, even when it sits behind Show more", () => {
    const report: MacReport = { at: 1, drivers: [{ driver: "gemini", installed: true, version: "1.0" }], homes: [] };
    const html = grid(report, false);
    expect(html).toContain(">Installed<");
    expect(html.indexOf(">Gemini<")).toBeLessThan(html.indexOf(">Codex<"));
  });

  it("disables every tool the Mac app can't run, with the server's reason", () => {
    const html = grid(null, false);
    expect(html).toContain("The Creator Toolset Mac app can&#x27;t run this CLI yet.");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(7);
  });

  it("marks a tool already added on this computer Added and does not offer it again (one account folder)", () => {
    const report: MacReport = { at: 1, drivers: [{ driver: "claude", installed: true }], homes: [{ driver: "claude", home: "/Users/me/.claude" }] };
    const html = grid(report, false, ["claude"]);
    expect(html).toContain(">Added<");
    expect(html).not.toContain(">Installed<");
    // Claude is disabled as added; the 7 unrunnable tools stay disabled too
    expect((html.match(/disabled=""/g) ?? []).length).toBe(8);
  });

  it("still offers an added tool when the computer has a second account folder for it", () => {
    const report: MacReport = { at: 1, drivers: [{ driver: "claude", installed: true }], homes: [{ driver: "claude", home: "/Users/me/.claude" }, { driver: "claude", home: "/Users/me/.claude-work" }] };
    const html = grid(report, false, ["claude"]);
    expect(html).not.toContain(">Added<");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(7);
  });
});

describe("the one way an AI is built", () => {
  it("names the AI from its folder and makes its id from the folder, unique among the taken ones", () => {
    expect(defaultName("claude", "/Users/me/.claude-work")).toBe("Claude (work)");
    expect(defaultName("codex", "")).toBe("Codex (default)");
    expect(instanceId("claude", "/Users/me/.claude-work", [])).toBe("claude_work");
    expect(instanceId("claude", "/Users/me/.claude-work", ["claude_work"])).toBe("claude_work_2");
    expect(instanceId("grok", "", [])).toBe("grok");
  });

  it("builds the instance with its computer, folder and, for a local command, its program", () => {
    expect(buildInstance({ driver: "claude", home: "/Users/me/.claude-work", name: " Work ", device: "d1", takenIds: [] })).toEqual({
      id: "claude_work",
      driver: "claude",
      name: "Work",
      enabled: true,
      device: "d1",
      home: "/Users/me/.claude-work",
    });
    expect(buildInstance({ driver: "acp", name: "Agent", device: "d1", takenIds: [], command: "npx some-agent acp" })).toMatchObject({
      acp: { command: "npx some-agent acp", args: [] },
    });
  });
});
