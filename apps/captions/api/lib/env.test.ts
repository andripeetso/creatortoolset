import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostedMode } from "./env";
import { watchAllowed } from "../library/watch";

const KEYS = ["CT_MODE", "CT_LOCAL", "APP_SECRET", "LIBRARY_WATCH_FOLDERS"] as const;
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
describe("hostedMode", () => {
  it("is local by default", () => {
    expect(hostedMode()).toBe(false);
  });

  it("is local when only CT_LOCAL=1 is set", () => {
    process.env.CT_LOCAL = "1";
    expect(hostedMode()).toBe(false);
  });

  it("is hosted when CT_MODE=hosted", () => {
    process.env.CT_MODE = "hosted";
    expect(hostedMode()).toBe(true);
  });

  it("is hosted when CT_MODE=hosted and CT_LOCAL=1 are both set", () => {
    process.env.CT_MODE = "hosted";
    process.env.CT_LOCAL = "1";
    expect(hostedMode()).toBe(true);
  });
});

describe("watchAllowed", () => {
  it("is on for a local server with no APP_SECRET", () => {
    expect(watchAllowed()).toBe(true);
  });

  it("is off for a hosted server, even with no APP_SECRET", () => {
    process.env.CT_MODE = "hosted";
    expect(watchAllowed()).toBe(false);
  });

  it("is off for a local server that has an APP_SECRET and is not the Mac app's", () => {
    process.env.APP_SECRET = "x";
    expect(watchAllowed()).toBe(false);
  });

  it("is on for the Mac app's server (CT_LOCAL=1 with an APP_SECRET), never for an account that is not its admin", () => {
    process.env.APP_SECRET = "x";
    process.env.CT_LOCAL = "1";
    expect(watchAllowed()).toBe(true);
    expect(watchAllowed("someone-else")).toBe(false);
    process.env.CT_MODE = "hosted";
    expect(watchAllowed()).toBe(false);
  });

  it("LIBRARY_WATCH_FOLDERS still overrides the mode", () => {
    process.env.CT_MODE = "hosted";
    process.env.LIBRARY_WATCH_FOLDERS = "1";
    expect(watchAllowed()).toBe(true);
    process.env.CT_MODE = "";
    process.env.LIBRARY_WATCH_FOLDERS = "0";
    expect(watchAllowed()).toBe(false);
  });
});
