import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Claude Code on this machine, for scripts only (scripts/cadence-lines-for.ts): the provider "local" in
 * ai-complete.ts. The site's providers answer through a paired Mac's relay, which a script can't reach. So this runs
 * `claude -p` on the person's own subscription (no API key in its environment), Opus 5.5 at xhigh, no tools, no
 * settings, no CLAUDE.md, a fresh folder. An answer from any other model fails (never a downgrade).
 * The binary: CT_CLAUDE, else `claude` on PATH. Nothing the site serves names this provider.
 */

export const LOCAL_MODEL = "claude-opus-5-5";

export interface LocalUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

/** The environment for `claude`: the subscription, never API billing, and not inside another Claude Code session. */
export function localEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT)$/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

export function localArgs(system: string): string[] {
  return ["-p", "--model", LOCAL_MODEL, "--effort", "xhigh", "--output-format", "json", "--system-prompt", system,
    "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"];
}

export async function completeLocal(system: string, user: string, cancel?: AbortSignal): Promise<{ text: string; usage: LocalUsage }> {
  const bin = process.env.CT_CLAUDE || "claude";
  const cwd = mkdtempSync(path.join(tmpdir(), "ct-local-"));
  try {
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(bin, localArgs(system), { cwd, env: localEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c, stdout: out, stderr: err }));
      cancel?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      child.stdin.end(user);
    });
    let r: { result?: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number;
             modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number }> };
    try {
      r = JSON.parse(stdout);
    } catch {
      throw new Error(`Claude Code here gave no answer (exit ${code}): ${(stderr || stdout).trim().slice(0, 300)}`);
    }
    if (r.is_error || !r.result) throw new Error(`Claude Code here: ${(r.result || stderr).slice(0, 300)}`);
    const models = Object.keys(r.modelUsage ?? {});
    if (models.some((m) => !m.startsWith(LOCAL_MODEL))) throw new Error(`Claude Code answered with ${models.join(", ")}, not ${LOCAL_MODEL}`);
    const use = Object.values(r.modelUsage ?? {});
    return {
      text: r.result,
      usage: {
        costUsd: r.total_cost_usd ?? 0,
        inputTokens: use.reduce((n, u) => n + (u.inputTokens ?? 0), 0),
        outputTokens: use.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
        ms: r.duration_ms ?? 0,
      },
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
