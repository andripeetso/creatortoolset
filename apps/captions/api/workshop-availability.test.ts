import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "workshop-availability-"));
const { aiFor } = await import("./ai-complete");
const { pairDevice } = await import("./lib/devices");
const { routeFor, saveSettings } = await import("./lib/providers");
const { createUser } = await import("./users");

// The Workshop's banner ("Connect Claude Code to write") is `ai` from /api/workshop/availability, which is
// !aiFor(user, "workshop").off (workshop.ts aiOn). Settings → Providers' "using" is routeFor(...) != null. They must agree:
// a provider counts for both when it is on an admin's workspace Mac or the account's own Mac, and for neither otherwise.
const instance = (id: string, device: string) => ({ id, driver: "claude" as const, name: id, enabled: true, device });
const settings = (instances: ReturnType<typeof instance>[]) => ({
  instances,
  default: { instance: instances[0]!.id, model: "claude-opus-5-5", effort: "xhigh" as const },
  jobs: {},
});

let alexMac: string;

beforeAll(() => {
  createUser("alex", "password1", { role: "admin" });
  createUser("jordan", "password1", { role: "team" });
  alexMac = pairDevice("alex", "Alex's Mac").device.id;
});

const banner = (name: string, role: "admin" | "team") => !aiFor({ username: name, role }, "workshop", "Workshop").off;
const providers = (name: string, role: "admin" | "team") => routeFor(name, role === "admin", "workshop") !== null;

describe("the Workshop banner agrees with Settings → Providers", () => {
  it("no provider anywhere: both say no AI", () => {
    expect(banner("alex", "admin")).toBe(false);
    expect(banner("jordan", "team")).toBe(false);
    expect(providers("alex", "admin")).toBe(false);
  });

  it("an admin's workspace provider on the admin's Mac: both say AI works, and a member still has none", async () => {
    await saveSettings(settings([instance("claude_alex", alexMac)]));
    expect(banner("alex", "admin")).toBe(true);
    expect(providers("alex", "admin")).toBe(true);
    expect(banner("jordan", "team")).toBe(false);
    expect(providers("jordan", "team")).toBe(false);
  });
});
