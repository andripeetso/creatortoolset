import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGY_RELEASES, agyEnv, agyInstalled, agySignedIn, installAgy, removeAgy, type AgyRelease } from "./antigravity";
import { plainError } from "./local-ai";

const zip = Buffer.from("pretend zip");
const release: AgyRelease = {
  version: "9.9.9",
  url: "https://example.invalid/agy.zip",
  sha256: createHash("sha256").update(zip).digest("hex"),
  bytes: zip.length,
  files: [
    { name: "agy_acp_server.par", bytes: 3 },
    { name: "localharness_external", bytes: 2 },
  ],
};
const root = () => mkdtempSync(path.join(os.tmpdir(), "agy-"));
const answer = (body: Buffer, headers: Record<string, string> = {}) =>
  (async () => new Response(new Uint8Array(body), { headers: { "content-length": String(body.length), ...headers } })) as unknown as typeof fetch;
/** what Google's zip holds, or what `files` says */
const unpack = (files: Record<string, string> = { "agy_acp_server.par": "abc", localharness_external: "de" }) => async (_zip: string, into: string) => {
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(into, name), text);
};
const deps = { release, fetch: answer(zip), extract: unpack(), check: async () => null, freeBytes: () => 1e12 };

describe("Antigravity install", () => {
  it("pins Google's release for each platform it publishes", () => {
    expect(Object.keys(AGY_RELEASES).sort()).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
    for (const r of Object.values(AGY_RELEASES)) {
      expect(r.url).toMatch(/^https:\/\/dl\.google\.com\/agy-extensions\/releases\/.+\.zip$/);
      expect(r.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(r.files).toHaveLength(2);
    }
  });

  it("downloads, checks, unpacks and puts the release in place, replacing the one before", async () => {
    const dir = root();
    expect(agyInstalled(dir)).toBeNull();
    expect(await installAgy(dir, deps)).toBeNull();
    expect(agyInstalled(dir)).toEqual({ exe: path.join(dir, "runtime", "agy_acp_server.par"), harness: path.join(dir, "runtime", "localharness_external"), version: "9.9.9" });
    // an update is the same install; nothing is left beside it
    expect(await installAgy(dir, { ...deps, release: { ...release, version: "9.9.10" } })).toBeNull();
    expect(agyInstalled(dir)?.version).toBe("9.9.10");
    expect(readdirSync(dir)).toEqual(["runtime"]);
    removeAgy(dir);
    expect(agyInstalled(dir)).toBeNull();
  });

  it("installs nothing from a download that isn't Google's release", async () => {
    const dir = root();
    const other = Buffer.from("something else");
    expect((await installAgy(dir, { ...deps, fetch: answer(other) }))?.message).toBe("Could not download Antigravity. Check the internet connection, then try again.");
    expect((await installAgy(dir, { ...deps, fetch: answer(Buffer.from("pretend zap")) }))?.message).toBe("The Antigravity download didn't match Google's release, so nothing was installed. Try again.");
    expect((await installAgy(dir, { ...deps, extract: unpack({ "agy_acp_server.par": "abc", localharness_external: "de", "extra.sh": "x" }) }))?.message).toMatch(/other files than Google's release/);
    expect((await installAgy(dir, { ...deps, extract: unpack({ "agy_acp_server.par": "abcd", localharness_external: "de" }) }))?.message).toMatch(/other files than Google's release/);
    expect((await installAgy(dir, { ...deps, check: async () => "it named itself zed" }))?.message).toBe("Antigravity was downloaded but didn't start on this computer. Try again.");
    expect(agyInstalled(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("says how much space it needs before it downloads", async () => {
    let asked = false;
    const fetch = (async () => ((asked = true), new Response(""))) as unknown as typeof globalThis.fetch;
    expect((await installAgy(root(), { ...deps, fetch, freeBytes: () => 10 }))?.message).toMatch(/^Antigravity needs 25\d MB free/);
    expect(asked).toBe(false);
  });
});

describe("Antigravity sign-in and launch", () => {
  it("is signed in once the profile holds its token", () => {
    const dir = root();
    expect(agySignedIn(dir)).toBe(false);
    mkdirSync(path.join(dir, "profile", "antigravity-acp"), { recursive: true });
    writeFileSync(path.join(dir, "profile", "antigravity-acp", "acp_token.json"), "{}");
    expect(agySignedIn(dir)).toBe(true);
  });

  it("runs with its own profile and harness, no API keys, and a browser only when asked", () => {
    process.env.GEMINI_API_KEY = "x";
    const env = agyEnv({ harness: "/h/localharness_external" }, "/p", "true");
    delete process.env.GEMINI_API_KEY;
    expect(env).toMatchObject({ GEMINI_HOME: "/p", ANTIGRAVITY_HARNESS_PATH: "/h/localharness_external", AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: "true" });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(agyEnv({ harness: "/h" }, "/p").BROWSER).toBeUndefined();
  });

  it("says its errors plainly", () => {
    expect(plainError("session/new: Authentication required")).toEqual({ state: "signin", message: "Not signed in yet." });
    expect(plainError("Antigravity is not installed on this Mac. Install it in Settings → Providers")).toEqual({ state: "missing", message: "Antigravity isn't installed on this computer yet." });
    expect(plainError("Error 429, Message: Quota exhausted for test model., Status: RESOURCE_EXHAUSTED").message).toBe("Your Google account's Antigravity quota is used up for now. Try again later.");
  });
});

// release.json is what the Mac app reads (Antigravity.swift): its shape is kept
it("writes release.json as the Mac app reads it", async () => {
  const dir = root();
  await installAgy(dir, deps);
  expect(JSON.parse(readFileSync(path.join(dir, "runtime", "release.json"), "utf8"))).toEqual({ version: "9.9.9", files: release.files });
  expect(existsSync(path.join(dir, "runtime", "agy_acp_server.par"))).toBe(true);
});
