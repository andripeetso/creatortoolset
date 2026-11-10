import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
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
const mockCheck = vi.hoisted(() => ({ next: { ok: true, ms: 5, error: undefined as string | undefined } }));
vi.mock("../providers", async () => {
  const lib = await import("./providers");
  return {
    checkInstance: async (scope: string, inst: { id: string }) => {
      const c = { ok: mockCheck.next.ok, ms: mockCheck.next.ms, model: "m", at: Date.now(), error: mockCheck.next.error } as ProviderCheck;
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
  for (const u of ["ana", "ben", "dee", "eve", "fay", "gus", "hal", "ian", "cy", "zed", "joy"]) createUser(u, "password1", { role: "user" });
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
    expect(plainError("model not found for this plan")).toMatchObject({ state: "failed", message: "It didn't answer. Check that you're signed in, then try again." });
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

  it("says the Mac app must be open when no Mac of this account is online", async () => {
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    expect(await local.connectCli("cy", "claude", home)).toMatchObject({ state: "mac", signedIn: true });
  });

  it("connects after a real check: saves the instance on this Mac, makes it the default, and keeps the check", async () => {
    const { device } = pairDevice("fay", "Studio Mac");
    touchDevice(device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true, "max") } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 7, error: undefined };
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
    mockCheck.next = { ok: true, ms: 11, error: undefined };
    const r = await local.connectCli("hal", "codex", home, device.id);
    expect(r).toEqual({ state: "ready", signedIn: true, answered: true, ms: 11 });
    expect(ownSettings("hal")?.instances).toEqual([expect.objectContaining({ id: "local-codex", driver: "codex", name: "Codex", enabled: true, device: device.id })]);
    expect(connectedOwn("hal")).toBe(true);
  });

  it("binds the AI to the Mac the app paired here, never the first online Mac of the account", async () => {
    const other = pairDevice("joy", "Other Mac");
    touchDevice(other.device.id);
    const mine = pairDevice("joy", "Studio Mac");
    touchDevice(mine.device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 6, error: undefined };
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
    mockCheck.next = { ok: false, ms: 4, error: "Codex: boom" };
    expect(await local.connectCli("joy", "codex", home, mine.device.id)).toMatchObject({ state: "failed" });
    expect(ownSettings("joy")?.instances.map((i) => i.id)).toEqual(["local-claude"]);
    expect(ownSettings("joy")?.default.instance).toBe("local-claude");

    mockCheck.next = { ok: true, ms: 4, error: undefined };
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
    expect((await local.localAiView("ana", [])).rows.map((r) => r.id)).toEqual([]);
    // installed after that look: a plain look still shows the cached answer, Check again reads the machine
    present.push("codex");
    expect((await local.localAiView("ana", [])).rows.map((r) => r.id)).toEqual([]);
    const fresh = await local.localAiView("ana", [], true);
    expect(fresh.rows).toEqual([expect.objectContaining({ id: "codex", found: true, signedIn: true, version: "codex-cli 0.50.0" })]);
  });

  it("updates the same instance on a second connect, and keeps its check through a Settings save", async () => {
    const before = ownSettings("fay")!;
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: true, ms: 9, error: undefined };
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
    mockCheck.next = { ok: false, ms: 30_000, error: "Claude: request timed out" };
    const r = await local.connectCli("gus", "claude", home, device.id);
    expect(r).toMatchObject({ state: "failed", answered: false, message: "It took too long to answer. Try again.", raw: "Claude: request timed out" });
    expect(connectedOwn("gus")).toBe(false);
  });

  it("treats a 'not logged in' answer from the check as signed out, not as a failure", async () => {
    const { device } = pairDevice("hal", "Mac");
    touchDevice(device.id);
    world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(true) } : claudeVersion(f, args)));
    mockCheck.next = { ok: false, ms: 3, error: "Claude: Not logged in · Please run /login" };
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
    mockCheck.next = { ok: true, ms: 4, error: undefined };
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
  it("opens Terminal with the tool's own sign-in, using the path this server found", async () => {
    const calls = world(["claude"], (f, args) => (args.join(" ") === "auth status --json" ? { stdout: claudeAuth(false) } : claudeVersion(f, args)));
    expect(await local.signIn("claude")).toEqual({ ok: true });
    const open = calls.find((c) => c.startsWith("/usr/bin/osascript"));
    expect(open).toContain(`do script "export PATH='/fake/bin':\\"$PATH\\"; '/fake/bin/claude' auth login"`);
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
    const cli = v.rows.filter((r) => r.kind === "cli");
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

  it("mints one new Full key and writes it into the CLI", async () => {
    const calls = world(["claude"], () => undefined);
    const { result, mcpTo } = await local.addMcp("ana", "claude", [], 4123);
    expect(result).toEqual({ ok: true, added: ["claude"], failed: [] });
    expect(mcpTo).toEqual(["claude"]);
    const key = keyIn(calls);
    expect(key).toMatch(/^ctk_[0-9a-f]{48}$/);
    expect(findUser("ana")?.fullKeyHash).toBeTruthy();
  });

  it("rewrites every CLI that holds the entry with the same new key, and each Codex write replaces the file", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "o3"\n\n[mcp_servers.creator-toolset]\nurl = "http://127.0.0.1:4123/api/mcp"\n');
    const calls = world(["claude", "codex"], (_f, args) => {
      if (args.join(" ") === "mcp add --help") return { stdout: "--url" };
      return undefined;
    });
    const { result } = await local.addMcp("ben", "codex", ["claude"], 4123);
    expect(result.ok).toBe(true);
    expect(result.added).toEqual(["claude", "codex"]);
    const key = keyIn(calls);
    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(`Bearer ${key}`);
    expect(calls.some((c) => c.includes("codex mcp add creator-toolset"))).toBe(false);
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
    expect(r.result.added).toEqual(["claude"]);
    expect(r.result.failed.map((f) => f.id)).toEqual(["codex"]);
    expect(r.result.failed[0]?.message).toMatch(/^Creator Toolset couldn't be added to Codex: .* Your AI is still connected\.$/);
    expect(r.mcpTo).toEqual(["claude"]);
    expect(calls.some((c) => c.includes("mcp add creator-toolset"))).toBe(true);
  });

  it("changes nothing for an old Codex: no key is made, nothing is written", async () => {
    world(["codex"], (_f, args) => (args.join(" ") === "mcp add --help" ? { stdout: "Usage: codex mcp add <NAME> [COMMAND]" } : undefined));
    const before = findUser("ana")?.fullKeyHash;
    const r = await local.addMcp("ana", "codex", ["claude"], 4123);
    expect(r.result.ok).toBe(false);
    expect(r.result.failed[0]?.message).toBe("Codex needs an update before it can use Creator Toolset.");
    expect(r.mcpTo).toEqual(["claude"]);
    expect(findUser("ana")?.fullKeyHash).toBe(before);
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
