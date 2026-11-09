import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "providers-routing-"));
const { aiFor } = await import("./ai-complete");
const { pairDevice } = await import("./lib/devices");
const { limitFallbacks, providerSettings, routeFor, saveSettings } = await import("./lib/providers");
const { saveMyKey } = await import("./my-keys");
const { createUser } = await import("./users");

// Who answers which job: an unnamed call never reaches a provider, a member never reaches the owner's logins, and an
// admin reaches only the workspace's providers on its own Macs.
const instance = (id: string, device: string) => ({ id, driver: "claude" as const, name: id, enabled: true, device });
const settings = (instances: ReturnType<typeof instance>[]) => ({
  instances,
  default: { instance: instances[0]!.id, model: "claude-opus-5-5", effort: "xhigh" as const },
  jobs: {},
});

let alexMac: string;
let samMac: string;
let jordanMac: string;

beforeAll(() => {
  createUser("alex", "password1", { role: "admin" });
  createUser("sam", "password1", { role: "admin" });
  createUser("jordan", "password1", { role: "team" });
  createUser("casey", "password1", { role: "team" });
  alexMac = pairDevice("alex", "Alex's Mac").device.id;
  samMac = pairDevice("sam", "Sam's Mac").device.id;
  jordanMac = pairDevice("jordan", "Jordan's Mac").device.id;
});

describe("an unnamed AI call is refused", () => {
  it("routeFor with no name is null, even when the workspace has a runnable Mac", async () => {
    await saveSettings(settings([instance("claude_alex", alexMac)]));
    expect(routeFor(undefined, true, "notes")).toBeNull();
    expect(routeFor("", true, "notes")).toBeNull();
  });

  it("aiFor with no name, or a visitor, runs nowhere", () => {
    expect(aiFor(undefined, "notes", "Video Notes")).toMatchObject({ only: [], off: "This AI call names no account" });
    expect(aiFor({ username: "alex", role: "visitor" }, "notes", "Video Notes")).toMatchObject({ only: [] });
  });
});

describe("a member", () => {
  it("never gets the workspace's providers, and runs on its own key or is refused", async () => {
    await saveSettings(settings([instance("claude_alex", alexMac)]));
    expect(routeFor("jordan", false, "captions")).toBeNull();
    expect(aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio").off).toMatch(/No AI for your account/);

    saveMyKey("jordan", "ANTHROPIC_API_KEY", "sk-ant-test-1234");
    expect(aiFor({ username: "jordan", role: "team" }, "captions", "Caption Studio")).toMatchObject({
      only: ["anthropic"],
      apiKey: "sk-ant-test-1234",
    });
  });

  it("a Workshop turn never runs on a plain API key (it needs its own AI)", () => {
    expect(aiFor({ username: "jordan", role: "team" }, "workshop", "Content Workshop").off).toMatch(/runs on your own AI/);
  });

  it("gets its own provider on its own Mac, not the workspace's", async () => {
    await saveSettings(
      { instances: [instance("claude_jordan", jordanMac)], default: { instance: "claude_jordan", model: "claude-opus-5-5", effort: "low" }, jobs: {} },
      "jordan",
    );
    expect(routeFor("jordan", false, "captions")).toMatchObject({ scope: "jordan", device: jordanMac });
    expect(routeFor("casey", false, "captions")).toBeNull();
  });
});

describe("an admin", () => {
  it("uses the workspace's providers on its own Mac", async () => {
    await saveSettings(settings([instance("claude_alex", alexMac)]));
    expect(routeFor("alex", true, "workshop")).toMatchObject({ scope: "workspace", device: alexMac });
  });

  it("never uses another admin's workspace provider", async () => {
    await saveSettings(settings([instance("claude_sam", samMac)]));
    expect(routeFor("alex", true, "workshop")).toBeNull();
    expect(aiFor({ username: "alex", role: "admin" }, "workshop", "Workshop").off).toMatch(/No AI for your account/);
    expect(routeFor("sam", true, "workshop")).toMatchObject({ scope: "workspace", device: samMac });
  });

  it("a usage limit falls back only to the same owner's Macs", async () => {
    await saveSettings(settings([instance("claude_alex", alexMac), instance("claude_alex_2", alexMac), instance("claude_sam", samMac)]));
    const after = providerSettings().instances.find((i) => i.id === "claude_alex")!;
    const fallbacks = limitFallbacks("workspace", after, "claude-opus-5-5").map((f) => f.instance.id);
    expect(fallbacks).toEqual(["claude_alex_2"]);
  });
});
