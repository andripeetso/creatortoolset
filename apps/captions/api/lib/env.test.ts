import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasTeam, hostedPlatform, isCloud, serverKind } from "./env";
import { watchAllowed } from "../library/watch";

const KEYS = ["CT_SERVER", "CT_MODE", "CT_LOCAL", "APP_SECRET", "LIBRARY_WATCH_FOLDERS"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// env.test reads only env vars; it writes no files (watch.ts loads without touching the data dir)
describe("serverKind", () => {
  const kindWith = (vars: Partial<Record<"CT_SERVER" | "CT_MODE" | "CT_LOCAL", string>>) => {
    Object.assign(process.env, vars);
    return serverKind();
  };

  it("CT_SERVER names the kind, and wins over the older settings", () => {
    expect(kindWith({ CT_SERVER: "mac" })).toBe("mac");
    expect(kindWith({ CT_SERVER: "cloud", CT_LOCAL: "1" })).toBe("cloud");
    expect(kindWith({ CT_SERVER: "server", CT_MODE: "hosted", CT_LOCAL: "1" })).toBe("server");
  });

  it("unset, CT_MODE=hosted is a Server, CT_LOCAL=1 This Mac, anything else a Server", () => {
    expect(serverKind()).toBe("server");
    expect(kindWith({ CT_LOCAL: "1" })).toBe("mac");
    expect(kindWith({ CT_MODE: "hosted" })).toBe("server"); // with CT_LOCAL=1 still set: hosted wins, as before
  });

  it("an unknown CT_SERVER falls back to the older settings", () => {
    expect(kindWith({ CT_SERVER: "studio", CT_LOCAL: "1" })).toBe("mac");
  });

  it("hasTeam on a Server and Cloud, isCloud only on Cloud", () => {
    expect([hasTeam(), isCloud()]).toEqual([true, false]);
    process.env.CT_SERVER = "cloud";
    expect([hasTeam(), isCloud()]).toEqual([true, true]);
    process.env.CT_SERVER = "mac";
    expect([hasTeam(), isCloud()]).toEqual([false, false]);
  });

  it("the descriptor's hosted platform keeps its old meaning: CT_MODE=hosted or Cloud", () => {
    expect(hostedPlatform()).toBe(false);
    process.env.CT_MODE = "hosted";
    expect(hostedPlatform()).toBe(true);
    delete process.env.CT_MODE;
    process.env.CT_SERVER = "cloud";
    expect(hostedPlatform()).toBe(true);
  });
});

describe("watchAllowed", () => {
  it("is on for a local server with no APP_SECRET", () => {
    expect(watchAllowed()).toBe(true);
  });

  it("is off on Cloud, even with no APP_SECRET", () => {
    process.env.CT_SERVER = "cloud";
    expect(watchAllowed()).toBe(false);
  });

  it("is on for a Server's admin, never for another account", () => {
    process.env.APP_SECRET = "x";
    process.env.CT_MODE = "hosted";
    expect(watchAllowed()).toBe(true);
    expect(watchAllowed("someone-else")).toBe(false);
  });

  it("is on for the Mac app's server (CT_LOCAL=1 with an APP_SECRET), never for an account that is not its admin", () => {
    process.env.APP_SECRET = "x";
    process.env.CT_LOCAL = "1";
    expect(watchAllowed()).toBe(true);
    expect(watchAllowed("someone-else")).toBe(false);
    process.env.CT_SERVER = "cloud";
    expect(watchAllowed()).toBe(false);
  });

  it("LIBRARY_WATCH_FOLDERS still overrides the kind", () => {
    process.env.CT_SERVER = "cloud";
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(watchAllowed()).toBe(true);
    process.env.CT_SERVER = "";
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    expect(watchAllowed()).toBe(false);
  });
});
