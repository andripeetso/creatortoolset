import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderCheck } from "../../contracts/providers";

// Scratch on the external SSD, not the Mac's disk.
const scratch = process.env.CT_SCRATCH_DIR ?? "/Volumes/WinningFriends/ct-wt/scratch";
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(path.join(scratch, "local-ai-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.APP_SECRET = "test-secret";
process.env.CODEX_HOME = path.join(root, "codex");

// The Mac relay is not run here: the check's result is set per test, and it still goes through recordCheck.
const mockCheck = vi.hoisted(() => ({ next: { ok: true, ms: 5, error: undefined as string | undefined, note: undefined as string | undefined } }));
vi.mock("../providers", async () => {
  const lib = await import("./providers");
  return {
    checkInstance: async (scope: string, inst: { id: string }) => {
      const c = { ok: mockCheck.next.ok, ms: mockCheck.next.ms, model: "m", at: Date.now(), error: mockCheck.next.error, ...(mockCheck.next.note ? { note: mockCheck.next.note } : {}) } as ProviderCheck;
      await lib.recordCheck(`${scope}:${inst.id}`, c);
      return c;
    },
  };
});

const { createUser, findUser } = await import("../users");
const { pairDevice, touchDevice } = await import("./devices");
const local = await import("./local-ai");
const { ownSettings, saveSettings, connectedOwn, routeFor, parseSettings } = await import("./providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");
const { plainError, parseClaudeAuth, parseCodexLogin, fallbackCandidates, firstExecutable, codexUpdateCommand, claudeFolders, codexWithKey, claudeMcpAdd, probeCli } = local;

const home = path.join(root, "home");
const codexHome = path.join(root, "codex");

beforeAll(() => {
  for (const u of ["ana", "ben", "dee", "eve", "fay", "gus", "hal", "ian", "cy", "zed", "joy", "old", "lim"]) createUser(u, "password1", { role: "user" });
});
afterAll(() => {
  local.setRunnerForTests();
});

type Out = { stdout?: string; stderr?: string; code?: number | string | null };
type Table = (file: string, args: string[], env: NodeJS.ProcessEnv | undefined) => Out | undefined;

/** A fake machine: the CLIs in `present` are installed; the rest are not found. `over` answers the rest. */
function world(present: string[], over: Table) {
  const calls: string[] = [];
  local.setRunnerForTests(async (file, args, opt) => {
    calls.push([file, ...args].join(" "));
    if (file === "/bin/zsh") {
      const name = String(args[1]).replace("command -v ", "");
      return { stdout: present.includes(name) ? `/fake/bin/${name}\n` : `/nonexistent/${name}\n`, stderr: "", code: 0 };
    }
    if (file.startsWith("/nonexistent")) return { stdout: "", stderr: "", code: "ENOENT" };
    return { stdout: "", stderr: "", code: 0, ...(over(file, args, opt.env) ?? {}) };
  });
  return calls;
}

const claudeAuth = (signedIn: boolean, plan?: string) => JSON.stringify({ loggedIn: signedIn, ...(plan ? { subscriptionType: plan } : {}) });
/** Claude's own --version (keyed by the binary's path, so Codex's answer is separate). */
const claudeVersion = (file: string, args: string[]) => (file.endsWith("/claude") && args[0] === "--version" ? { stdout: "2.1.319 (Claude Code)\n" } : undefined);

describe("reading what the CLIs say", () => {
  it("reads Claude's sign-in, and a plan only when the CLI names one", () => {
    expect(parseClaudeAuth(claudeAuth(true, "max"))).toEqual({ signedIn: true, plan: "claude_max5" });
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: true, subscriptionType: "pro" }))).toEqual({ signedIn: true, plan: "claude_pro" });
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: true, planTier: "default_claude_max_20x" }))).toEqual({ signedIn: true, plan: "claude_max20" });
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: true }))).toEqual({ signedIn: true });
    expect(parseClaudeAuth(claudeAuth(false))).toEqual({ signedIn: false });
    expect(parseClaudeAuth("not json")).toEqual({ signedIn: null });
  });

  it("reads Codex's sign-in whatever the case, and never trusts 'not logged in'", () => {
    expect(parseCodexLogin("Logged in using ChatGPT")).toBe(true);
    expect(parseCodexLogin("logged in using chatgpt")).toBe(true);
    expect(parseCodexLogin("Not logged in")).toBe(false);
  });

  it("turns raw CLI text into plain words, and keeps a model's 'not found' out of the missing state", () => {
    expect(plainError("Claude: Not logged in · Please run /login")).toEqual({ state: "signin", message: "Not signed in yet." });
    expect(plainError("request timed out after 60s")).toMatchObject({ state: "failed", message: "It took too long to answer. Try again." });
    expect(plainError("spawn claude ENOENT")).toMatchObject({ state: "missing" });
    expect(plainError("model not found for this plan")).toMatchObject({ state: "failed", message: "It didn't answer. Try again." });
  });

  it("finds a binary in the usual places, nvm's newest last-resort", () => {
    expect(fallbackCandidates("claude", "/Users/x", ["/Users/x/.nvm/versions/node/v22/bin/claude"]).slice(0, 3)).toEqual([
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      "/Users/x/.local/bin/claude",
    ]);
    expect(firstExecutable(["/a", "/b", "/c"], (p) => p === "/b")).toBe("/b");
    expect(firstExecutable(["/a"], () => false)).toBeNull();
  });

  it("says how to update Codex from how it was installed", () => {
    expect(codexUpdateCommand("/opt/homebrew/bin/codex")).toBe("brew upgrade codex");
    expect(codexUpdateCommand("/usr/local/bin/codex", "/usr/local/Cellar/codex/0.39/bin/codex")).toBe("brew upgrade codex");
    expect(codexUpdateCommand("/Users/x/.nvm/versions/node/v22/bin/codex")).toBe("npm install -g @openai/codex@latest");
  });

  it("lists the Claude folders that hold a sign-in, and no others", () => {
    const h = path.join(root, "folders");
    mkdirSync(path.join(h, ".claude-work"), { recursive: true });
    writeFileSync(path.join(h, ".claude-work", "settings.json"), "{}");
    mkdirSync(path.join(h, ".claude-empty"), { recursive: true });
    mkdirSync(path.join(h, ".claude-login"), { recursive: true });
    writeFileSync(path.join(h, ".claude-login", ".credentials.json"), "{}");
    expect(claudeFolders(h).map((d) => path.basename(d))).toEqual([".claude-login", ".claude-work"]);
  });
});

describe("probing a CLI", () => {
  it("finds the signed-in folder when the default one is signed out, and uses its plan", async () => {
    const h = path.join(root, "probe-home");
    const folder = path.join(h, ".claude-work");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "settings.json"), "{}");
    world(["claude"], (file, args, env) => {
      if (args.join(" ") === "auth status --json") return { stdout: claudeAuth(env?.CLAUDE_CONFIG_DIR === folder, "pro") };
      return claudeVersion(file, args);
    });
    const p = await probeCli("claude", h);
    expect(p).toMatchObject({ found: true, version: "2.1.319 (Claude Code)", signedIn: true, home: folder, plan: "claude_pro" });
  });

  it("reads Codex: version, sign-in, and no --url on an old Codex", async () => {
    world(["codex"], (file, args) => {
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT\n" };
      if (args.join(" ") === "mcp add --help") return { stdout: "Usage: codex mcp add [OPTIONS] <NAME> [COMMAND]...\n" };
      if (args[0] === "--version") return { stdout: "codex-cli 0.39.0\n" };
      return undefined;
    });
    expect(await probeCli("codex", home)).toMatchObject({ found: true, version: "codex-cli 0.39.0", signedIn: true, supportsUrl: false });
  });

  it("says a CLI is not found when it is not installed", async () => {
    world([], () => undefined);
    expect(await probeCli("gemini", home)).toMatchObject({ found: false, signedIn: null });
  });
});

describe("connect your AI", () => {
  it("is missing when the CLI is not on this Mac", async () => {
    world([], () => undefined);
    expect(await local.connectCli("cy", "claude", home)).toMatchObject({ state: "missing", answered: null });
    expect(await local.connectCli("cy", "codex", home)).toMatchObject({ state: "missing", answered: null });
  });

  it("asks to sign in when no folder is signed in, and saves nothing", async () => {
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(false) } : claudeVersion(f, args)));
    expect(await local.connectCli("cy", "claude", home)).toMatchObject({ state: "signin", signedIn: false });
    expect(ownSettings("cy")).toBeNull();
  });

  it("an old Codex that today's models refuse is 'outdated' (the page installs the current one), and nothing is saved", async () => {
    const { device } = pairDevice("old", "Old Mac");
    touchDevice(device.id);
    world(["codex"], (f, args) => {
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT\n" };
      if (f.endsWith("/codex") && args[0] === "--version") return { stdout: "codex-cli 0.39.0\n" };
      return undefined;
    });
    // Codex's own words, as codex-cli 0.39.0 got them on 2026-11-10
    mockCheck.next = { ok: false, ms: 3, note: undefined, error: `Codex: unexpected status 400 Bad Request: {"detail":"The 'gpt-5.6-terra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}` };
    expect(await local.connectCli("old", "codex", home, device.id)).toMatchObject({ state: "outdated", answered: false });
    expect(ownSettings("old")).toBeNull();
  });

  it("a Gemini CLI the Mac app won't run for being too old is 'outdated' too, and nothing is saved", async () => {
    const { device } = pairDevice("oldg", "Old Mac");
    touchDevice(device.id);
    world(["gemini"], (f, args) => (f.endsWith("/gemini") && args[0] === "--version" ? { stdout: "0.20.0\n" } : undefined));
    mkdirSync(path.join(home, ".gemini"), { recursive: true });
    writeFileSync(path.join(home, ".gemini", "oauth_creds.json"), "{}");
    // the Mac app's own words (ClaudeRequest.swift geminiTooOld)
    mockCheck.next = { ok: false, ms: 3, note: undefined, error: "The Gemini on this Mac is too old to run here. Update it." };
    expect(await local.connectCli("oldg", "gemini", home, device.id)).toMatchObject({ state: "outdated", answered: false, message: "Google needs a newer Gemini than the one on this Mac. Try again." });
    expect(ownSettings("oldg")).toBeNull();
  });

  it("a plan at its limit is connected: saved with its check, and the message says when it resets", async () => {
    const { device } = pairDevice("lim", "Lim Mac");
    touchDevice(device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true, "max") } : claudeVersion(f, args)));
    const note = "Your Claude plan's weekly limit is reached; it resets Nov 11 at 5pm.";
    mockCheck.next = { ok: true, ms: 4, error: undefined, note };
    expect(await local.connectCli("lim", "claude", home, device.id)).toEqual({ state: "ready", signedIn: true, answered: false, ms: 4, message: note });
    expect(ownSettings("lim")?.instances[0]).toMatchObject({ id: "local-claude", lastCheck: { ok: true } });
    mockCheck.next = { ok: true, ms: 5, error: undefined, note: undefined };
  });

  it("runs the newest copy when this Mac has two: an old Homebrew Codex beside the one Install put in ~/.local/bin", async () => {
    const mine = path.join(os.homedir(), ".local", "bin", "codex");
    local.setRunnerForTests(
      async (file, args) => {
        if (file === "/bin/zsh") return { stdout: "/opt/homebrew/bin/codex\n", stderr: "", code: 0 };
        if (args[0] === "--version") return { stdout: file === mine ? "codex-cli 0.167.0\n" : "codex-cli 0.39.0\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
      (p) => p === mine,
    );
    expect(await local.binFor("codex")).toBe(mine);
    expect(local.olderThan([0, 39, 0], [0, 167, 0])).toBe(true);
    expect(local.olderThan([2, 1, 321], [2, 1, 321])).toBe(false);
    expect(local.versionNumbers("2.1.321 (Claude Code)")).toEqual([2, 1, 321]);
  });

  it("counts the Codex the ChatGPT app carries, so that person needs no download; never a Claude inside another app", async () => {
    const inApp = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
    expect(fallbackCandidates("codex", "/Users/x", [])).toContain(inApp);
    expect(fallbackCandidates("claude", "/Users/x", []).filter((p) => p.includes(".app/"))).toEqual([]);
    // an old Homebrew Codex on the shell's PATH, the ChatGPT app's newer one beside it: the app's runs
    local.setRunnerForTests(
      async (file, args) => {
        if (file === "/bin/zsh") return { stdout: "/opt/homebrew/bin/codex\n", stderr: "", code: 0 };
        if (args[0] === "--version") return { stdout: file === inApp ? "codex-cli 0.163.0-alpha.11.2\n" : "codex-cli 0.39.0\n", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
      (p) => p === inApp,
    );
    expect(await local.binFor("codex")).toBe(inApp);
  });

  it("a screen that looks again every few seconds never stacks shells or program starts: looks share one, and answers are kept", async () => {
    // 2026-11-10: setup's poll started a login shell per program per look, each outliving its timeout; 198 piled up
    let shells = 0;
    let versionRuns = 0;
    let vendorRuns = 0;
    let release: () => void = () => {};
    const slow = new Promise<void>((done) => (release = done));
    local.setRunnerForTests(async (file, args) => {
      if (file === "/bin/zsh") {
        shells++;
        await slow; // a busy Mac: the shell takes its time
        const name = String(args[1]).replace("command -v ", "");
        return { stdout: name === "claude" ? "/fake/bin/claude\n" : name.startsWith("grok ") ? "/fake/bin/grok\n/fake/bin/cursor-agent\n" : "", stderr: "", code: 0 };
      }
      if (args[0] === "--version") versionRuns++;
      if (/grok|cursor-agent/.test(file)) vendorRuns++;
      if (args.join(" ") === "auth status --json") return { stdout: claudeAuth(true), stderr: "", code: 0 };
      return { stdout: args[0] === "--version" ? "2.1.319 (Claude Code)\n" : "", stderr: "", code: 0 };
    });
    // ten looks arrive while the first is still waiting for its shell
    const looks = Array.from({ length: 10 }, () => local.localAiView("ana", [], true, home));
    await new Promise((r) => setTimeout(r, 20));
    expect(shells).toBe(4); // claude, codex, gemini, and one line for the other AIs: once each, not ten times
    release();
    const views = await Promise.all(looks);
    expect(views.every((v) => v.rows.find((r) => r.id === "claude")?.found)).toBe(true);
    // and the looks after it, inside ten seconds, start no shell and do not start the program again for its version
    await local.localAiView("ana", [], true, home);
    await local.localAiView("ana", [], true, home);
    expect(shells).toBe(4);
    expect(versionRuns).toBe(1);
    // Grok and Cursor are found and their sign-in read on every look without starting either
    expect(views[0]?.others?.map((o) => [o.id, o.found])).toEqual([["grok", true], ["musecode", false], ["cursor", true]]);
    expect(vendorRuns).toBe(0);
  });

  it("says the Mac app must be open when no Mac of this account is online", async () => {
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    expect(await local.connectCli("cy", "claude", home)).toMatchObject({ state: "mac", signedIn: true });
  });

  it("connects after a real check: saves the instance on this Mac, makes it the default, and keeps the check", async () => {
    const { device } = pairDevice("fay", "Studio Mac");
    touchDevice(device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true, "max") } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 7, error: undefined, note: undefined };
    const r = await local.connectCli("fay", "claude", home, device.id);
    expect(r).toEqual({ state: "ready", signedIn: true, answered: true, ms: 7 });
    const s = ownSettings("fay");
    expect(s?.instances).toEqual([expect.objectContaining({ id: "local-claude", driver: "claude", name: "Claude Code", enabled: true, device: device.id })]);
    expect(s?.default).toEqual({ instance: "local-claude", model: "claude-opus-5-5", effort: "xhigh" });
    expect(s?.instances[0]?.lastCheck).toMatchObject({ ok: true, ms: 7 });
    expect(connectedOwn("fay")).toBe(true);
  });

  it("connects Codex as the app's AI the same way: a saved local-codex instance on the Mac, after a real check", async () => {
    const { device } = pairDevice("hal", "Studio Mac");
    touchDevice(device.id);
    world(["codex"], (f, args) => {
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT\n" };
      if (args.join(" ") === "mcp add --help") return { stdout: "Usage: codex mcp add [OPTIONS] <NAME> --url <URL>" };
      if (f.endsWith("/codex") && args[0] === "--version") return { stdout: "codex-cli 0.50.0\n" };
      return undefined;
    });
    mockCheck.next = { ok: true, ms: 11, error: undefined, note: undefined };
    const r = await local.connectCli("hal", "codex", home, device.id);
    expect(r).toEqual({ state: "ready", signedIn: true, answered: true, ms: 11 });
    expect(ownSettings("hal")?.instances).toEqual([expect.objectContaining({ id: "local-codex", driver: "codex", name: "Codex", enabled: true, device: device.id })]);
    expect(connectedOwn("hal")).toBe(true);
  });

  it("a Codex-only person's connect names a model the login lists, so the AI step's own save of the default is accepted", async () => {
    const { device } = pairDevice("kit", "Kit's Mac");
    touchDevice(device.id);
    world(["codex"], (f, args) => {
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT\n" };
      if (args.join(" ") === "mcp add --help") return { stdout: "Usage: codex mcp add [OPTIONS] <NAME> --url <URL>" };
      if (f.endsWith("/codex") && args[0] === "--version") return { stdout: "codex-cli 0.50.0\n" };
      return undefined;
    });
    mockCheck.next = { ok: true, ms: 9, error: undefined, note: undefined };
    expect(await local.connectCli("kit", "codex", home, device.id)).toMatchObject({ state: "ready" });
    const saved = ownSettings("kit");
    expect(saved?.default).toEqual({ instance: "local-codex", model: "gpt-6-luna", effort: "xhigh" });
    expect(() => parseSettings(JSON.parse(JSON.stringify(saved)), "kit")).not.toThrow();
  });

  it("binds the AI to the Mac the app paired here, never the first online Mac of the account", async () => {
    const other = pairDevice("joy", "Other Mac");
    touchDevice(other.device.id);
    const mine = pairDevice("joy", "Studio Mac");
    touchDevice(mine.device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 6, error: undefined, note: undefined };
    expect(await local.connectCli("joy", "claude", home, mine.device.id)).toMatchObject({ state: "ready" });
    expect(ownSettings("joy")?.instances[0]?.device).toBe(mine.device.id);
  });

  it("refuses a device that is not this account's or not answering, and saves nothing", async () => {
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    expect(await local.connectCli("zed", "claude", home, "dev_not_mine")).toMatchObject({ state: "mac" });
    expect(await local.connectCli("zed", "claude", home)).toMatchObject({ state: "mac" });
    expect(ownSettings("zed")).toBeNull();
  });

  it("a failed check saves nothing and leaves the default as it was; a later passing AI does not take the default", async () => {
    const mine = pairDevice("joy", "Studio Mac");
    touchDevice(mine.device.id);
    world(["codex"], (f, args) => {
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT\n" };
      if (args.join(" ") === "mcp add --help") return { stdout: "Usage: codex mcp add [OPTIONS] <NAME> --url <URL>" };
      if (f.endsWith("/codex") && args[0] === "--version") return { stdout: "codex-cli 0.50.0\n" };
      return undefined;
    });
    mockCheck.next = { ok: false, ms: 4, error: "Codex: boom", note: undefined };
    expect(await local.connectCli("joy", "codex", home, mine.device.id)).toMatchObject({ state: "failed" });
    expect(ownSettings("joy")?.instances.map((i) => i.id)).toEqual(["local-claude"]);
    expect(ownSettings("joy")?.default.instance).toBe("local-claude");

    mockCheck.next = { ok: true, ms: 4, error: undefined, note: undefined };
    expect(await local.connectCli("joy", "codex", home, mine.device.id)).toMatchObject({ state: "ready" });
    expect(ownSettings("joy")?.instances.map((i) => i.id)).toEqual(["local-claude", "local-codex"]);
    expect(ownSettings("joy")?.default.instance).toBe("local-claude");
  });

  it("Check again finds a CLI installed since the last look, and reads its sign-in again (no cached 'not found')", async () => {
    const present: string[] = [];
    world(present, (f, args) => {
      if (f.endsWith("/codex") && args[0] === "--version") return { stdout: "codex-cli 0.50.0\n" };
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT\n" };
      return undefined;
    });
    expect((await local.localAiView("ana", [])).rows.filter((r) => r.found).map((r) => r.id)).toEqual([]);
    // installed after that look: a plain look still shows the cached answer, Check again reads the machine
    present.push("codex");
    expect((await local.localAiView("ana", [])).rows.filter((r) => r.found).map((r) => r.id)).toEqual([]);
    // the login shell is asked again at most every ten seconds (looks that come faster share its last answer)
    const later = Date.now() + 11_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    const fresh = await local.localAiView("ana", [], true);
    clock.mockRestore();
    expect(fresh.rows.filter((r) => r.found)).toEqual([expect.objectContaining({ id: "codex", found: true, signedIn: true, version: "codex-cli 0.50.0" })]);
  });

  it("updates the same instance on a second connect, and keeps its check through a Settings save", async () => {
    const before = ownSettings("fay")!;
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 9, error: undefined, note: undefined };
    await local.connectCli("fay", "claude", home, before.instances[0]!.device);
    expect(ownSettings("fay")?.instances).toHaveLength(1);
    // the Settings page sends its instances back without the check: the saved check stays
    const again = ownSettings("fay")!;
    await saveSettings(parseSettings({ instances: again.instances.map(({ lastCheck: _x, ...i }) => i), default: before.default, jobs: {} }, "fay"), "fay");
    expect(ownSettings("fay")?.instances[0]?.lastCheck?.ok).toBe(true);
    expect(connectedOwn("fay")).toBe(true);
  });

  it("reports a failed check in plain words, with the raw text for Details", async () => {
    const { device } = pairDevice("gus", "Mac");
    touchDevice(device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: false, ms: 30_000, error: "Claude: request timed out", note: undefined };
    const r = await local.connectCli("gus", "claude", home, device.id);
    expect(r).toMatchObject({ state: "failed", answered: false, message: "It took too long to answer. Try again.", raw: "Claude: request timed out" });
    expect(connectedOwn("gus")).toBe(false);
  });

  it("treats a 'not logged in' answer from the check as signed out, not as a failure", async () => {
    const { device } = pairDevice("hal", "Mac");
    touchDevice(device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: false, ms: 3, error: "Claude: Not logged in · Please run /login", note: undefined };
    expect(await local.connectCli("hal", "claude", home, device.id)).toMatchObject({ state: "signin", signedIn: false, answered: false, message: "Not signed in yet." });
  });

  it("saves the signed-in folder as the instance's home when the default folder is signed out", async () => {
    const h = path.join(root, "ian-home");
    const folder = path.join(h, ".claude-work");
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "settings.json"), "{}");
    const { device } = pairDevice("ian", "Mac");
    touchDevice(device.id);
    world(["claude"], (f, args, env) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(env?.CLAUDE_CONFIG_DIR === folder) } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 4, error: undefined, note: undefined };
    await local.connectCli("ian", "claude", h, device.id);
    expect(ownSettings("ian")?.instances[0]).toMatchObject({ home: folder });
  });

  it("gives an account with no providers no route", () => {
    expect(routeFor("zed", false, "workshop")).toBeNull();
  });

  it("starts with no providers at all", () => {
    expect(DEFAULT_SETTINGS.instances).toEqual([]);
    expect(DEFAULT_SETTINGS.default.instance).toBe("");
  });
});

describe("sign in", () => {
  it("starts the tool's own sign-in as a child process, and says so in one sentence when it cannot start", async () => {
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(false) } : claudeVersion(f, args)));
    expect(await local.signIn("claude")).toEqual({ ok: false, message: "Couldn't start Claude Code sign-in. Try again." });
    expect(await local.signIn("gemini")).toMatchObject({ ok: false });
  });
});

describe("the list setup shows", () => {
  it("lists the CLIs found, with Creator Toolset off until chosen, and Codex's update where it is old", async () => {
    world(["claude", "codex"], (f, args) => {
      if (args.join(" ") === "auth status --json") return { stdout: claudeAuth(true, "pro") };
      if (args.join(" ") === "login status") return { stdout: "Logged in using ChatGPT" };
      if (args.join(" ") === "mcp add --help") return { stdout: "Usage: codex mcp add <NAME>" };
      if (f.endsWith("/codex") && args[0] === "--version") return { stdout: "codex-cli 0.39.0" };
      return claudeVersion(f, args);
    });
    const v = await local.localAiView("ana", ["claude"]);
    expect(v.local).toBe(true);
    const cli = v.rows.filter((r) => r.kind === "cli" && r.found);
    expect(cli.map((r) => [r.id, r.mcp, r.signedIn])).toEqual([
      ["claude", "added", true],
      ["codex", "update", true],
    ]);
    expect(cli[0]?.plan).toBe("claude_pro");
    expect(cli[1]?.updateCommand).toBe("npm install -g @openai/codex@latest");
  });
});

describe("Creator Toolset in each CLI", () => {
  const keyIn = (calls: string[]) => calls.find((c) => c.includes("mcp add --transport"))?.match(/ctk_[0-9a-f]+/)?.[0];

  it("makes the CLI a key of its own and writes it in", async () => {
    const calls = world(["claude"], () => undefined);
    const { result, mcpTo } = await local.addMcp("ana", "claude", [], 4123);
    expect(result).toEqual({ ok: true, added: ["claude"], failed: [] });
    expect(mcpTo).toEqual(["claude"]);
    const key = keyIn(calls);
    expect(key).toMatch(/^ctk_[0-9a-f]{48}$/);
    expect(findUser("ana")?.aiKeys?.map((k) => k.name)).toEqual(["Claude Code"]);
    expect(findUser("ana")?.aiKeys?.[0]?.last4).toBe(key?.slice(-4));
  });

  it("Connect on Codex writes only Codex; Claude keeps its own key, and Codex's earlier key goes", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "o3"\n\n[mcp_servers.creator-toolset]\nurl = "http://127.0.0.1:4123/api/mcp"\n');
    const calls = world(["claude", "codex"], (_f, args) => {
      if (args.join(" ") === "mcp add --help") return { stdout: "--url" };
      return undefined;
    });
    await local.addMcp("ben", "claude", [], 4123);
    await local.addMcp("ben", "codex", ["claude"], 4123);
    const { result, mcpTo } = await local.addMcp("ben", "codex", ["claude", "codex"], 4123);
    expect(result).toEqual({ ok: true, added: ["codex"], failed: [] });
    expect(mcpTo).toEqual(["claude", "codex"]);
    expect(findUser("ben")?.aiKeys?.map((k) => k.name)).toEqual(["Claude Code", "Codex"]);
    const codexKey = readFileSync(path.join(codexHome, "config.toml"), "utf8").match(/Bearer (ctk_[0-9a-f]+)/)?.[1];
    expect(codexKey?.slice(-4)).toBe(findUser("ben")?.aiKeys?.[1]?.last4);
    expect(calls.filter((c) => c.includes("mcp add --transport")).length).toBe(1);
    expect(readdirSync(codexHome).filter((f) => f.includes("tmp"))).toEqual([]);
  });

  it("when Claude refuses the add because the name exists: remove, then add again, in that order", async () => {
    let adds = 0;
    const calls = world(["claude"], (_f, args) => {
      if (args[0] === "mcp" && args[1] === "add") {
        adds++;
        return adds === 1 ? { code: 1, stderr: "MCP server creator-toolset already exists in user config" } : { code: 0 };
      }
      return undefined;
    });
    const r = await local.addMcp("dee", "claude", [], 4123);
    expect(r.result.ok).toBe(true);
    const mcp = calls.filter((c) => c.includes(" mcp ")).map((c) => c.replace("/fake/bin/claude ", "").split(" ").slice(0, 3).join(" "));
    expect(mcp).toEqual(["mcp add --transport", "mcp remove --scope", "mcp add --transport"]);
  });

  it("a failed CLI is not listed as added, so its row offers the action again", async () => {
    rmCodex();
    const calls = world(["claude", "codex"], (_f, args) => {
      if (args.join(" ") === "mcp add --help") return { stdout: "--url" };
      if (args[0] === "mcp" && args[1] === "add" && args.includes("--url")) return { code: 1, stderr: "error: boom" };
      return undefined;
    });
    const r = await local.addMcp("eve", "codex", ["claude"], 4123);
    expect(r.result.ok).toBe(false);
    expect(r.result.added).toEqual([]);
    expect(r.result.failed.map((f) => f.id)).toEqual(["codex"]);
    expect(r.result.failed[0]?.message).toMatch(/^Creator Toolset couldn't be added to Codex: /);
    expect(r.mcpTo).toEqual(["claude"]);
    expect(findUser("eve")?.aiKeys ?? []).toEqual([]);
    expect(calls.some((c) => c.includes("mcp add creator-toolset"))).toBe(true);
  });

  it("changes nothing for an old Codex: no key is made, nothing is written", async () => {
    world(["codex"], (_f, args) => (args.join(" ") === "mcp add --help" ? { stdout: "Usage: codex mcp add <NAME> [COMMAND]" } : undefined));
    const before = findUser("ana")?.aiKeys?.length;
    const r = await local.addMcp("ana", "codex", ["claude"], 4123);
    expect(r.result.ok).toBe(false);
    expect(r.result.failed[0]?.message).toBe("Codex needs an update before it can use Creator Toolset.");
    expect(r.mcpTo).toEqual(["claude"]);
    expect(findUser("ana")?.aiKeys?.length).toBe(before);
  });

  it("Update runs Codex's own update here, then Codex takes the address", async () => {
    let updated = false;
    const calls = world(["codex"], (_f, args) => {
      if (args.join(" ") === "mcp add --help") return { stdout: updated ? "--url" : "Usage: codex mcp add <NAME> [COMMAND]" };
      return undefined;
    });
    local.setRunnerForTests(async (file, args, opt) => {
      if (file === "/bin/zsh" && args[0] === "-lc") {
        calls.push(args[1] as string);
        updated = true;
        return { stdout: "", stderr: "", code: 0 };
      }
      if (file === "/bin/zsh") return { stdout: "/fake/bin/codex\n", stderr: "", code: 0 };
      return { stdout: args.join(" ") === "mcp add --help" ? (updated ? "--url" : "Usage") : "", stderr: "", code: 0 };
    });
    local.forgetCli("codex");
    expect(await local.updateCli("codex")).toEqual({ ok: true, message: "Codex is updated." });
    expect(calls).toContain("npm install -g @openai/codex@latest");
  });

  it("writes the entry's header with the key in it, and Codex's key header under the entry", () => {
    const key = `ctk_${"b".repeat(48)}`;
    expect(claudeMcpAdd(4123, key)).toContain(`Authorization: Bearer ${key}`);
    expect(codexWithKey('[mcp_servers.creator-toolset]\nurl = "x"\n', key)).toContain(`http_headers = { Authorization = "Bearer ${key}" }`);
  });
});

/** A Codex folder with no config: the next add runs `codex mcp add` itself. */
function rmCodex() {
  rmSync(codexHome, { recursive: true, force: true });
  mkdirSync(codexHome, { recursive: true });
}

describe("Google (Gemini CLI) and the other AIs on this Mac", () => {
  /** A machine whose login shell finds only what `onPath` maps a command line to; every other command answers nothing. */
  const shell = (onPath: (line: string) => string, onDisk?: (p: string) => boolean) =>
    local.setRunnerForTests(async (file, args) => (file === "/bin/zsh" ? { stdout: onPath(String(args[1])), stderr: "", code: 0 } : { stdout: "", stderr: "", code: "ENOENT" }), onDisk);

  it("looks for Gemini beside the app's own Node.js, and for Grok and OpenCode in their installers' folders", () => {
    expect(fallbackCandidates("gemini", "/Users/x", []).at(-1)).toMatch(/\/node\/bin\/gemini$/);
    expect(fallbackCandidates("grok", "/Users/x", [])).toContain("/Users/x/.grok/bin/grok");
    expect(fallbackCandidates("opencode", "/Users/x", [])).toContain("/Users/x/.opencode/bin/opencode");
  });

  it("reads Gemini's sign-in from the Google login it saves; no sign-in method chosen is signed out", async () => {
    const h = path.join(root, "gemini-home");
    mkdirSync(h, { recursive: true });
    world(["gemini"], (_f, args) => (args[0] === "--version" ? { stdout: "0.67.0\n" } : undefined));
    expect(await probeCli("gemini", h)).toMatchObject({ found: true, version: "0.67.0", signedIn: false });
    mkdirSync(path.join(h, ".gemini"));
    writeFileSync(path.join(h, ".gemini", "oauth_creds.json"), "{}");
    expect(await probeCli("gemini", h)).toMatchObject({ signedIn: true });
    expect(plainError("Please set an Auth method in your /Users/x/.gemini/settings.json or specify one of the following").state).toBe("signin");
  });

  it("signs Gemini in through its editor mode: initialize, then the Google-account sign-in; signed in only once it has answered", async () => {
    const dir = path.join(root, "fake-gemini");
    const h = path.join(dir, "home");
    mkdirSync(h, { recursive: true });
    const bin = path.join(dir, "gemini");
    const asked = path.join(dir, "asked.txt");
    const creds = path.join(h, ".gemini", "oauth_creds.json");
    // notes what it was started with and asked; on authenticate it saves the login first and answers a moment later,
    // as Gemini CLI does (the account is set up between the two)
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") { console.log("0.67.0"); process.exit(0); }
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(asked)}, [process.argv[2], m.method, JSON.stringify(m.params)].join(" ") + "\\n");
    const answer = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }) + "\\n");
    if (m.method !== "authenticate") answer();
    else { fs.mkdirSync(${JSON.stringify(path.dirname(creds))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(creds)}, "{}"); setTimeout(answer, 1500); }
  }
});
setTimeout(() => {}, 60000);
`,
      { mode: 0o755 },
    );
    const realExec = promisify(execFile);
    local.setRunnerForTests(async (file, args) => {
      if (file === "/bin/zsh") return { stdout: args[1] === "command -v gemini" ? `${bin}\n` : "", stderr: "", code: 0 };
      const r = await realExec(file, args);
      return { stdout: String(r.stdout), stderr: "", code: 0 };
    });
    expect(await local.signIn("gemini")).toEqual({ ok: true, message: "Your browser opens. Sign in there, then come back here." });
    await vi.waitFor(() => expect(existsSync(creds)).toBe(true), { timeout: 5000 });
    expect((await probeCli("gemini", h)).signedIn).toBe(false); // the login is saved, the sign-in has not answered yet
    await vi.waitFor(async () => expect((await probeCli("gemini", h)).signedIn).toBe(true), { timeout: 5000 });
    expect(readFileSync(asked, "utf8").split("\n").filter(Boolean)).toEqual([
      '--acp initialize {"protocolVersion":1,"clientCapabilities":{}}',
      '--acp authenticate {"methodId":"oauth-personal"}',
    ]);
  });

  it("finds the other AIs the Mac app runs on the login shell's PATH or in their installers' folders", async () => {
    shell((line) => (line.startsWith("command -v grok ") ? "/opt/homebrew/bin/grok\ncursor-agent not found\n" : ""), (p) => p === "/Users/x/.opencode/bin/opencode");
    expect(await local.otherAis("/Users/x")).toEqual([
      { id: "grok", bin: "/opt/homebrew/bin/grok" },
      { id: "opencode", bin: "/Users/x/.opencode/bin/opencode" },
    ]);
  });

  it("reads Grok's and Cursor's sign-in from the files their sign-ins save, and lists both found or not", async () => {
    const h = path.join(root, "vendor-home");
    mkdirSync(path.join(h, ".grok"), { recursive: true });
    mkdirSync(path.join(h, ".cursor"), { recursive: true });
    shell((line) => (line.startsWith("command -v grok ") ? `${h}/.grok/bin/grok\n` : ""), (p) => p === path.join(h, ".local", "bin", "cursor-agent"));
    // Cursor's config before any sign-in, as its first start writes it
    writeFileSync(path.join(h, ".cursor", "cli-config.json"), JSON.stringify({ version: 1, approvalMode: "allowlist" }));
    const others = async () => (await local.localAiView("ana", [], true, h)).others;
    expect(await others()).toEqual([
      { id: "grok", found: true, signedIn: false, connected: false },
      { id: "musecode", found: false, signedIn: null, connected: false },
      { id: "cursor", found: true, signedIn: false, connected: false },
    ]);
    writeFileSync(path.join(h, ".grok", "auth.json"), "{}");
    writeFileSync(path.join(h, ".cursor", "cli-config.json"), JSON.stringify({ version: 1, authInfo: { email: "studio@tinyacrobatics.example" } }));
    expect((await others())?.map((o) => [o.id, o.signedIn])).toEqual([["grok", true], ["musecode", null], ["cursor", true]]);
    // Meta: its launcher in ~/.local/bin, signed in once its sign-in file holds Meta's token (an empty file is not)
    shell((line) => (line.startsWith("command -v grok ") ? `${h}/.grok/bin/grok\n` : ""), (p) => p === path.join(h, ".local", "bin", "cursor-agent") || p === path.join(h, ".local", "bin", "muse"));
    mkdirSync(path.join(h, ".config", "muse"), { recursive: true });
    writeFileSync(path.join(h, ".config", "muse", "auth.json"), JSON.stringify({ providers: {} }));
    expect((await others())?.find((o) => o.id === "musecode")).toMatchObject({ found: true, signedIn: false });
    writeFileSync(path.join(h, ".config", "muse", "auth.json"), JSON.stringify({ providers: { meta: { access_token: "tok" } } }));
    expect((await others())?.find((o) => o.id === "musecode")).toMatchObject({ found: true, signedIn: true });
    // not on this Mac: still listed (setup installs them), sign-in unknown
    shell(() => "");
    expect(await local.localAiView("ana", [], true, path.join(root, "empty-home"))).toMatchObject({
      others: [{ id: "grok", found: false, signedIn: null }, { id: "musecode", found: false, signedIn: null }, { id: "cursor", found: false, signedIn: null }],
    });
  });

  it("Grok signed out says so in its own words, and that is the sign-in state", () => {
    const grok = "Grok: Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.";
    expect(plainError(grok)).toEqual({ state: "signin", message: "Not signed in yet." });
    expect(plainError("Not logged in. Run `agent login` first.").state).toBe("signin");
    expect(plainError("Authentication required. Please run 'agent login' first, then call authenticate() with methodId 'cursor_login'.").state).toBe("signin");
    expect(plainError("Muse Code: not logged in: run /login to add an API key").state).toBe("signin");
    expect(plainError("It took 3 s to sign the request").state).toBe("failed");
  });

  it("Gemini with its login gone says so in its own words, and that is the sign-in state", () => {
    // Gemini CLI 0.68 with the Mac app's sign-in variables and a made-up login (2026-11-10)
    const gone = "Gemini: Manual authorization is required but the current session is non-interactive. Please run the Gemini CLI in an interactive terminal to log in, provide a GEMINI_API_KEY, or ensure Application Default Credentials are configured.";
    expect(plainError(gone)).toEqual({ state: "signin", message: "Not signed in yet." });
  });

  it("Google turning a free account away is said as that, not as a sign-in or a silence", () => {
    // Gemini CLI 0.68 on a free personal Google account (2026-11-10)
    const refused = "Gemini: This client is no longer supported for Gemini Code Assist for individuals. Please migrate to the Antigravity suite to continue. Authentication tier: free-tier";
    expect(plainError(refused)).toEqual({ state: "failed", message: "Google turned this account away: it no longer takes free Google accounts here." });
  });

  it("signs Grok in with its browser sign-in and Cursor with its own, each started from the copy on this Mac", async () => {
    const dir = path.join(root, "fake-vendors");
    mkdirSync(dir, { recursive: true });
    const said = path.join(dir, "said.txt");
    for (const name of ["grok", "cursor-agent"])
      writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(said)}\n`, { mode: 0o755 });
    shell((line) => (line.startsWith("command -v grok ") ? `${dir}/grok\n${dir}/cursor-agent\n` : ""));
    expect(await local.signIn("grok")).toEqual({ ok: true, message: "Your browser opens. Sign in there, then come back here." });
    expect(await local.signIn("cursor")).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(readFileSync(said, "utf8").split("\n").filter(Boolean).sort()).toEqual(["cursor-agent login", "grok login --oauth"]), { timeout: 5000 });
    // a sign-in started here that ended well counts, wherever that version saves it: no file of Grok's is in this home
    const grokNow = async () => (await local.localAiView("ana", [], true, path.join(root, "no-files-home"))).others?.find((o) => o.id === "grok");
    await vi.waitFor(async () => expect(await grokNow()).toMatchObject({ found: true, signedIn: true }), { timeout: 5000 });
    // OpenCode signs in its own way, not from here
    expect(await local.signIn("opencode")).toMatchObject({ ok: false });
  });

  it("reads Meta's sign-in page and code from what its sign-in prints, and answers with the code", async () => {
    // recorded from muse login with no terminal (the code made up)
    const printed = "Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=TINY-2468\nconfirm this code matches:\n  TINY-2468\n\nWaiting for approval\u2026";
    expect(local.museLoginPage(printed)).toEqual({ page: "https://auth.meta.com/oauth/device/?code=TINY-2468", code: "TINY-2468" });
    expect(local.museLoginPage("Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=TINY-2468\n")).toBeNull();
    expect(local.museLoginPage(printed.replace("auth.meta.com", "auth.meta.com.example"))).toBeNull();
    expect(local.museLoginPage(printed.replace("https://", "http://"))).toBeNull();
    const dir = path.join(root, "fake-muse");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "muse"), `#!/bin/sh\nprintf '%s\\n' 'Open this page to sign in:' '  https://auth.meta.com/oauth/device/?code=TINY-2468' 'confirm this code matches:' '  TINY-2468'\nsleep 30\n`, { mode: 0o755 });
    shell((line) => (line.startsWith("command -v grok ") ? `${dir}/muse\n` : ""));
    expect(await local.signIn("musecode")).toEqual({ ok: true, message: "Confirm this code on Meta's page: TINY-2468", code: "TINY-2468" });
  });

  it("connects another AI on this Mac as it is set up there: a real check, then a saved local-grok; nothing installed or signed in", async () => {
    createUser("kai", "password1", { role: "user" });
    const { device } = pairDevice("kai", "Studio Mac");
    touchDevice(device.id);
    shell((line) => (line.startsWith("command -v grok ") ? "/opt/homebrew/bin/grok\n" : ""));
    const grokRow = async () => (await local.localAiView("kai", [], false, home)).others?.find((o) => o.id === "grok");
    // its sign-in file isn't there, so the row offers Sign in; the file only names the button
    expect(await grokRow()).toEqual({ id: "grok", found: true, signedIn: false, connected: false });
    // the check is what knows: it answers, so Grok is connected, file or no file
    mockCheck.next = { ok: true, ms: 9, error: undefined, note: undefined };
    expect(await local.connectCli("kai", "grok", home, device.id)).toMatchObject({ state: "ready", answered: true });
    expect(ownSettings("kai")?.instances).toEqual([expect.objectContaining({ id: "local-grok", driver: "grok", name: "Grok", device: device.id })]);
    // connected with no file found: unknown, never "signed out since last time"
    expect(await grokRow()).toEqual({ id: "grok", found: true, signedIn: null, connected: true });
    mkdirSync(path.join(home, ".grok"), { recursive: true });
    writeFileSync(path.join(home, ".grok", "auth.json"), "{}");
    expect(await grokRow()).toEqual({ id: "grok", found: true, signedIn: true, connected: true });
    // a check that comes back not signed in is the sign-in state too
    mockCheck.next = { ok: false, ms: 9, error: "Grok: Not signed in. To authenticate without a browser, run:\n  grok login --device-code", note: undefined };
    expect(await local.connectCli("kai", "grok", home, device.id)).toMatchObject({ state: "signin" });
    // not on this Mac: missing, and nothing changes
    expect(await local.connectCli("kai", "opencode", home, device.id)).toMatchObject({ state: "missing" });
    expect(ownSettings("kai")?.instances).toHaveLength(1);
  });
});

describe("the app's entry name in the AI tools", () => {
  it("is creator-toolset for the app, and its own name for a copy beside it", async () => {
    const { mcpName } = await import("./local-ai");
    expect(mcpName("")).toBe("creator-toolset");
    expect(mcpName("/Users/sam/Library/Application Support/Creator Toolset")).toBe("creator-toolset");
    expect(mcpName("/Users/sam/Library/Application Support/Creator Toolset (fresh)")).toBe("creator-toolset-fresh");
    expect(mcpName("/Users/sam/Library/Application Support/Creator Toolset (Fresh)/")).toBe("creator-toolset-fresh");
  });
});
