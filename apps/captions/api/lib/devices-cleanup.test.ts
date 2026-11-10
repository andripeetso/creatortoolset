import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "devices-cleanup-"));
const { devicesSaved, moveProviders, pairDevice, revokeDevice } = await import("./devices");
const { ownSettings, providerSettings, saveSettings } = await import("./providers");
import type { ProviderInstance, ProviderSettings } from "../../contracts/providers";

const ACCOUNT = "tinyacrobatics";
const inst = (id: string, device: string): ProviderInstance => ({ id, driver: "claude", name: id, enabled: true, device });
const pick = (instance: string) => ({ instance, model: "", effort: "xhigh" as const });

// A computer that is removed takes its providers with it, and the default and job picks move on; a re-pair moves them.
describe("removing or re-pairing a computer", () => {
  it("drops its providers, moves the default, and drops the account's set when nothing is left", async () => {
    const mac = pairDevice(ACCOUNT, "Tiny Mac").device;
    const studio = pairDevice(ACCOUNT, "Tiny Studio").device;
    const s: ProviderSettings = {
      instances: [inst("claude_mac", mac.id), inst("codex_studio", studio.id)],
      default: pick("claude_mac"),
      jobs: { workshop: pick("claude_mac") },
    };
    await saveSettings(s, ACCOUNT);

    await revokeDevice(mac.id);
    const left = ownSettings(ACCOUNT)!;
    expect(left.instances.map((i) => i.id)).toEqual(["codex_studio"]);
    expect(left.default.instance).toBe("codex_studio");
    expect(left.jobs.workshop).toBeUndefined();

    await revokeDevice(studio.id);
    expect(ownSettings(ACCOUNT)).toBeNull();
    expect(providerSettings().instances).toEqual([]);
    await devicesSaved();
  });

  it("repoints a re-paired Mac's providers to the new record", async () => {
    const old = pairDevice("otheruser", "Other Mac");
    await saveSettings({ instances: [inst("claude_other", old.device.id)], default: pick("claude_other"), jobs: {} }, "otheruser");

    const again = pairDevice("otheruser", "Other Mac");
    expect(again.replaced).toEqual([old.device.id]);
    await moveProviders("otheruser", again.replaced, again.device.id);
    expect(ownSettings("otheruser")!.instances[0]!.device).toBe(again.device.id);
    await devicesSaved();
  });
});
