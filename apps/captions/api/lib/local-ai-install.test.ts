import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

// Scratch on the external SSD, not the Mac's disk. HOME is a fake home: every install and sign-in lands in it.
const scratch = process.env.CT_SCRATCH_DIR ?? "/Volumes/WinningFriends/ct-wt/scratch";
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(path.join(scratch, "local-install-"));
const home = path.join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.DATA_DIR = path.join(root, "data");
process.env.APP_SECRET = "test-secret";

const local = await import("./local-ai");

const localBin = (id: string) => path.join(home, ".local", "bin", id);
const nodeRoot = path.join(home, "Library", "Application Support", "Creator Toolset", "node");
const triple = os.arch() === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const nodeFile = `node-v${local.NODE_VERSION}-darwin-${os.arch() === "arm64" ? "arm64" : "x64"}.tar.gz`;

type Out = { stdout?: string; stderr?: string; code?: number | string | null };
type Fake = (file: string, args: string[]) => Out | undefined;
interface Call {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** A fake machine: the commands it answers are the fake binaries; every call is recorded. Unanswered calls succeed silently. */
function machine(fake: Fake): Call[] {
  const calls: Call[] = [];
  local.setRunnerForTests(async (file, args, opt) => {
    calls.push({ file, args, env: opt.env });
    const out = fake(file, args) ?? {};
    return { stdout: out.stdout ?? "", stderr: out.stderr ?? "", code: out.code !== undefined ? out.code : 0 };
  });
  return calls;
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const versionOf = (args: string[], text: string): Out | undefined => (args[0] === "--version" ? { stdout: text } : undefined);

afterAll(() => {
  local.setRunnerForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("install with the vendor's own route, no Terminal", () => {
  it("Claude Code: runs Anthropic's installer as a child process, then runs the binary by its path with --version", async () => {
    const calls = machine((file, args) => (file === localBin("claude") ? versionOf(args, "2.1.319 (Claude Code)\n") : undefined));
    expect(await local.installCli("claude")).toEqual({ ok: true, message: "Claude Code is installed." });
    expect(calls.some((c) => c.file === "/bin/bash" && c.args.join(" ").includes("https://claude.ai/install.sh"))).toBe(true);
    expect(calls.at(-1)).toMatchObject({ file: localBin("claude"), args: ["--version"] });
    expect(calls.some((c) => c.file.endsWith("osascript"))).toBe(false);
  });

  it("a failed install is one plain sentence, with the command's own output kept for Details", async () => {
    machine((file) => (file === "/bin/bash" ? { code: 6, stderr: "curl: (6) Could not resolve host: claude.ai" } : undefined));
    const r = await local.installCli("claude");
    expect(r).toEqual({
      ok: false,
      message: "Couldn't install Claude Code. Check the internet connection, then try again.",
      raw: "curl: (6) Could not resolve host: claude.ai",
    });
  });

  it("a binary that is installed but does not answer --version is not counted as installed", async () => {
    machine((file, args) => (file === localBin("claude") ? { code: 127, stderr: "not found" } : undefined));
    const r = await local.installCli("claude");
    expect(r).toMatchObject({ ok: false, message: "Claude Code installed, but it didn't start. Try again." });
  });

  it("Codex needs no Node: its release binary is downloaded, unpacked, copied to ~/.local/bin and run by its path", async () => {
    const calls = machine((file, args) => {
      if (file === "/usr/bin/curl") {
        writeFileSync(argAfter(args, "-o"), "tgz");
        return undefined;
      }
      if (file === "/usr/bin/tar") {
        writeFileSync(path.join(argAfter(args, "-C"), `codex-${triple}`), "codex");
        return undefined;
      }
      return file === localBin("codex") ? versionOf(args, "codex-cli 0.50.0\n") : undefined;
    });
    expect(await local.installCli("codex")).toEqual({ ok: true, message: "Codex is installed." });
    expect(existsSync(localBin("codex"))).toBe(true);
    expect(calls.some((c) => /npm|node/.test(`${c.file} ${c.args.join(" ")}`))).toBe(false);
    expect(calls.at(-1)).toMatchObject({ file: localBin("codex"), args: ["--version"] });
  });

  it("Gemini CLI on a Mac with no Node: the pinned Node.js is checked against its SHA-256, then npm installs Gemini CLI with it", async () => {
    rmSync(nodeRoot, { recursive: true, force: true });
    const tarball = Buffer.from("node tarball");
    const sha = createHash("sha256").update(tarball).digest("hex");
    const calls = machine((file, args) => {
      if (file === "/usr/bin/curl") {
        const out = argAfter(args, "-o");
        writeFileSync(out, out.endsWith("SHASUMS256.txt") ? `${sha}  ${nodeFile}\n` : tarball);
        return undefined;
      }
      if (file === "/usr/bin/tar" && args.includes("--strip-components")) {
        mkdirSync(path.join(nodeRoot, "bin"), { recursive: true });
        writeFileSync(path.join(nodeRoot, "bin", "node"), "node");
        writeFileSync(path.join(nodeRoot, "bin", "npm"), "npm");
        return undefined;
      }
      return file === localBin("gemini") ? versionOf(args, "0.5.0\n") : undefined;
    });
    expect(await local.installCli("gemini")).toEqual({ ok: true, message: "Gemini CLI is installed." });
    const npm = calls.find((c) => c.file === path.join(nodeRoot, "bin", "npm"));
    expect(npm?.args).toEqual(expect.arrayContaining(["install", "-g", "--prefix", "@google/gemini-cli"]));
    expect(npm?.env?.PATH?.startsWith(path.join(nodeRoot, "bin"))).toBe(true);
  });

  it("a Node.js download that does not match its checksum is not used, and npm never runs", async () => {
    rmSync(nodeRoot, { recursive: true, force: true });
    const calls = machine((file, args) => {
      if (file === "/usr/bin/curl") {
        const out = argAfter(args, "-o");
        writeFileSync(out, out.endsWith("SHASUMS256.txt") ? `${"0".repeat(64)}  ${nodeFile}\n` : "tampered");
      }
      return undefined;
    });
    const r = await local.installCli("gemini");
    expect(r.ok).toBe(false);
    expect(r.message).toBe("The Node.js download didn't check out, so it wasn't used. Try again.");
    expect(calls.some((c) => c.file.endsWith("/bin/npm"))).toBe(false);
  });
});

describe("a probe that times out is not a found CLI", () => {
  it("a --version that times out leaves the CLI not found, so setup offers Install", async () => {
    machine((file) => (file === "/bin/zsh" ? { stdout: "/fake/bin/claude\n" } : file === "/fake/bin/claude" ? { code: null, stderr: "timed out" } : undefined));
    expect((await local.probe("claude", true)).found).toBe(false);
  });
});

describe("sign in: the vendor's own sign-in runs as a child process, and the page's check sees it finish", () => {
  it("a fake Codex: sign-in starts without a Terminal, and the status read turns signed-in when the sign-in is done", async () => {
    const fakeCodex = localBin("codex");
    mkdirSync(path.dirname(fakeCodex), { recursive: true });
    // a fake binary: `login` finishes after a moment and leaves a mark; `login status` reads the mark
    writeFileSync(
      fakeCodex,
      [
        "#!/bin/sh",
        'FLAG="$HOME/codex-signed-in"',
        'case "$1" in',
        '  --version) echo "codex-cli 0.50.0" ;;',
        '  login) if [ "$2" = "status" ]; then if [ -f "$FLAG" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in"; fi; exit 0; fi',
        '    sleep 0.3; touch "$FLAG"; echo "Opened your browser"; exit 0 ;;',
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(fakeCodex, 0o755);
    rmSync(path.join(home, "codex-signed-in"), { force: true });

    // the path lookup answers with the fake; every other command is a real process, so the fake binary really runs
    const realExec = promisify(execFile);
    local.setRunnerForTests(async (file, args, opt) => {
      if (file === "/bin/zsh") return { stdout: `${fakeCodex}\n`, stderr: "", code: 0 };
      try {
        const r = await realExec(file, args, { env: opt.env, timeout: opt.timeout });
        return { stdout: String(r.stdout), stderr: String(r.stderr), code: 0 };
      } catch (e) {
        const x = e as { stdout?: unknown; stderr?: unknown; code?: number | string; message?: string };
        return { stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message ?? ""), code: x.code ?? null };
      }
    });

    expect((await local.probe("codex", true)).signedIn).toBe(false);
    expect(await local.signIn("codex")).toEqual({ ok: true, message: "Your browser opens. Sign in there, then come back here." });

    // the page polls this same read every few seconds until it reports the sign-in
    let signedIn: boolean | null = null;
    for (let i = 0; i < 50 && signedIn !== true; i++) {
      await new Promise((r) => setTimeout(r, 100));
      signedIn = (await local.probe("codex", true)).signedIn;
    }
    expect(signedIn).toBe(true);
    expect(await local.signIn("gemini")).toMatchObject({ ok: false });
  });
});
