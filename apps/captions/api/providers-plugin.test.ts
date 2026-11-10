import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "providers-plugin-")); // provider settings, devices
const { definePlugin, mountPlugins } = await import("./lib/plugin");
const { driverCatalog, ownSettings, parseSettings, saveSettings } = await import("./lib/providers");
const { pairDevice } = await import("./lib/devices");

// A test plug-in: one driver kind (no Mac runs it yet) and one preset of the built-in Claude driver, with an endpoint.
const TINY_URL = "https://tiny-proxy.example.test/v1";
const plugin = definePlugin({
  id: "tiny-hub",
  providers: {
    kinds: [{ id: "tinycli", label: "Tiny CLI", featured: false }],
    presets: [{ id: "tiny-hub", name: "Tiny (hub)", driver: "claude", badge: "Custom API endpoint", home: "/Users/tiny/.claude-hub", baseUrl: TINY_URL }],
  },
});

let alex: { device: { id: string } };

beforeAll(() => {
  mountPlugins(new Hono(), [plugin]);
  alex = pairDevice("alex", "Alex's Mac");
});

describe("provider kinds and presets from a plug-in", () => {
  it("the catalog lists the kind as not runnable and the preset with its badge, and never the endpoint", () => {
    const cat = driverCatalog([]);
    expect(cat.drivers.find((d) => d.id === "tinycli")).toMatchObject({ label: "Tiny CLI", runs: false });
    expect(cat.presets).toEqual([{ id: "tiny-hub", name: "Tiny (hub)", driver: "claude", badge: "Custom API endpoint", home: "/Users/tiny/.claude-hub" }]);
    expect(JSON.stringify(cat)).not.toContain(TINY_URL);
  });

  it("an instance added from the preset gets its endpoint on read, the page's value is dropped, and the saved file never holds the endpoint", async () => {
    const s = parseSettings(
      {
        instances: [{ id: "tiny_hub", driver: "claude", name: "Tiny (hub)", enabled: true, device: alex.device.id, preset: "tiny-hub", home: "/Users/tiny/.claude-hub", baseUrl: "https://evil.example.test" }],
        default: { instance: "tiny_hub", model: "claude-opus-5-5", effort: "xhigh" },
      },
      "alex",
    );
    expect(s.instances[0]).toMatchObject({ preset: "tiny-hub" });
    expect(s.instances[0]?.baseUrl).toBeUndefined();
    await saveSettings(s, "alex");
    expect(readFileSync(path.join(process.env.DATA_DIR!, "ai-providers", "alex.json"), "utf-8")).not.toContain(TINY_URL);
    expect(ownSettings("alex")?.instances[0]?.baseUrl).toBe(TINY_URL);
  });

  it("refuses a preset saved under another driver, drops an unknown preset, and does not count a kind that no Mac runs as a runnable provider", () => {
    const body = (inst: Record<string, unknown>) => ({ instances: [{ id: "x", enabled: true, device: alex.device.id, ...inst }], default: { instance: "x", model: "m", effort: "xhigh" } });
    expect(() => parseSettings(body({ driver: "codex", name: "X", preset: "tiny-hub" }), "alex")).toThrow("comes from a preset for claude");
    const gone = parseSettings(body({ driver: "claude", name: "X", preset: "removed-preset" }), "alex");
    expect(gone.instances[0]).not.toHaveProperty("preset");
    expect(() => parseSettings(body({ driver: "tinycli", name: "Tiny CLI" }), "alex")).toThrow("Turn on at least one AI");
  });
});
