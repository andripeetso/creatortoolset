import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DRIVERS, type DriverCatalog } from "@contracts/providers";
import { DriverGrid, validateInstanceId } from "./AddProviderDialog";

/** The catalog as the server sends it: only Claude and Gemini run today; the rest carry the server's reason. */
const catalog: DriverCatalog = {
  drivers: DRIVERS.map((d) => {
    const runs = d.id === "claude" || d.id === "gemini";
    return {
      id: d.id,
      label: d.label,
      featured: d.featured,
      runs,
      ...(runs ? {} : { reason: d.id === "musecode" ? "Muse Code has no headless mode yet, so it can't answer a request." : `${d.label} can't run yet.` }),
      devices: [],
    };
  }),
};

const grid = (showMore: boolean) =>
  renderToStaticMarkup(<DriverGrid catalog={catalog} driver={null} showMore={showMore} onPick={() => {}} onToggleMore={() => {}} />);

describe("Add provider grid", () => {
  it("lists the owner's featured drivers in order, then Show more, and hides Gemini until it is opened", () => {
    const html = grid(false);
    const order = ["Codex", "Claude", "Cursor", "Grok", "OpenCode", "Antigravity", "Muse Code", "Pi", "Show more"].map((s) => html.indexOf(`>${s}<`) >= 0 ? html.indexOf(`>${s}<`) : html.indexOf(`>${s}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).not.toContain("Gemini");
    expect(html).not.toContain("Local ACP command");
  });

  it("shows Gemini and the local ACP command under Show less once Show more is opened", () => {
    const html = grid(true);
    expect(html).toContain("Gemini");
    expect(html).toContain("Local ACP command");
    expect(html).toContain("Show less");
  });

  it("disables every driver the Mac app can't run, with the server's reason, and leaves the runnable ones enabled", () => {
    const html = grid(false);
    expect(html).toContain("Muse Code has no headless mode yet");
    // Codex, Cursor, Grok, OpenCode, Antigravity, Muse Code, Pi: seven disabled tiles; Claude is not one of them
    expect((html.match(/disabled=""/g) ?? []).length).toBe(7);
  });
});

describe("validateInstanceId", () => {
  it("accepts a letter-first id of letters, digits, - and _ that no provider has", () => {
    expect(validateInstanceId("claude_work", ["claude"])).toBeNull();
    expect(validateInstanceId("Claude-2", [])).toBeNull();
  });

  it("refuses an empty id, a leading digit, other characters, a taken id and more than 60 characters", () => {
    expect(validateInstanceId("", [])).toMatch(/Give/);
    expect(validateInstanceId("1work", [])).toMatch(/starts with a letter/);
    expect(validateInstanceId("my id", [])).toMatch(/letters, digits/);
    expect(validateInstanceId("claude", ["claude"])).toMatch(/already has/);
    expect(validateInstanceId("a".repeat(60), [])).toBeNull();
    expect(validateInstanceId("a".repeat(61), [])).toMatch(/at most 60/);
  });
});

describe("plug-in providers in the grid", () => {
  it("shows a plug-in preset as a row, and a plug-in driver kind as a disabled tile with the server's reason", () => {
    const withPlugin: DriverCatalog = {
      ...catalog,
      drivers: [...catalog.drivers, { id: "tinycli", label: "Tiny CLI", featured: false, runs: false, reason: "The Creator Toolset Mac app can't run this CLI yet.", devices: [] }],
      presets: [{ id: "tiny-hub", name: "Tiny (hub)", driver: "claude", badge: "Custom API endpoint" }],
    };
    const html = renderToStaticMarkup(<DriverGrid catalog={withPlugin} driver={null} showMore={true} onPick={() => {}} onToggleMore={() => {}} />);
    expect(html).toContain("Tiny (hub)");
    expect(html).toContain("Tiny CLI");
    expect(html).toContain("The Creator Toolset Mac app can&#x27;t run this CLI yet.");
  });
});
