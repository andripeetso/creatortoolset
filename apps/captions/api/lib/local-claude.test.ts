import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeWithFallback } from "../ai-complete";
import { LOCAL_MODEL, completeLocal, localEnv } from "./local-claude";

// A stand-in `claude`: records its arguments, stdin, whether an API key and a base URL reached it, answers as `claude -p` does.
function fakeClaude(model = LOCAL_MODEL) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
cat > "${dir}/stdin"
printf '%s' "\${ANTHROPIC_API_KEY:-none}" > "${dir}/key"
printf '%s' "\${ANTHROPIC_BASE_URL:-none}" > "${dir}/base"
printf '{"result":"[1,0,1]","is_error":false,"total_cost_usd":0.01,"duration_ms":5,"modelUsage":{"${model}":{"inputTokens":10,"outputTokens":3}}}'
`);
  chmodSync(bin, 0o755);
  return { bin, read: (f: string) => readFileSync(path.join(dir, f), "utf8") };
}

describe("the local provider: Claude Code on this machine, for scripts", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("strips ANTHROPIC_BASE_URL by default; an instance's base URL is passed only when it is http(s)", () => {
    const env = { ANTHROPIC_BASE_URL: "https://ambient.example", ANTHROPIC_API_KEY: "k", HOME: "/h" };
    expect(localEnv(env)).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(localEnv(env, "https://hub.example/v1").ANTHROPIC_BASE_URL).toBe("https://hub.example/v1");
    expect(localEnv(env, "file:///etc/passwd")).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(localEnv(env, "https://hub.example").ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("sends the base URL to claude only when the calling instance has one", async () => {
    const fake = fakeClaude();
    process.env.CT_CLAUDE = fake.bin;
    process.env.ANTHROPIC_BASE_URL = "https://ambient.example";
    await completeLocal("S", "u", undefined, "https://hub.example/v1");
    expect(fake.read("base")).toBe("https://hub.example/v1");
    await completeLocal("S", "u");
    expect(fake.read("base")).toBe("none");
  });

  it("runs claude -p on Opus 5.5 at xhigh with no API key, the text on stdin, and parses the answer", async () => {
    const fake = fakeClaude();
    process.env.CT_CLAUDE = fake.bin;
    process.env.ANTHROPIC_API_KEY = "a-key-that-must-not-reach-claude";
    const out = await completeWithFallback("SYSTEM", "the words", undefined, (t) => JSON.parse(t) as number[],
      { only: ["local"], retries: 0, mac: { label: "captions" } });
    expect(out).toEqual([1, 0, 1]);
    const args = fake.read("args").split("\n");
    expect(args.slice(0, 5)).toEqual(["-p", "--model", LOCAL_MODEL, "--effort", "xhigh"]);
    expect(args).toContain("SYSTEM");
    expect(fake.read("stdin")).toBe("the words");
    expect(fake.read("key")).toBe("none"); // the subscription, never API billing
  });

  it("finds claude by EDITOR_CLAUDE when CT_CLAUDE is not set (an existing worker install)", async () => {
    const fake = fakeClaude();
    delete process.env.CT_CLAUDE;
    process.env.EDITOR_CLAUDE = fake.bin;
    expect(await completeLocal("S", "u")).toMatchObject({ text: "[1,0,1]" });
    expect(fake.read("stdin")).toBe("u");
  });

  it("refuses an answer from another model", async () => {
    process.env.CT_CLAUDE = fakeClaude("claude-haiku-5-5").bin;
    await expect(completeWithFallback("S", "u", undefined, (t) => t, { only: ["local"], retries: 0 }))
      .rejects.toThrow(/not claude-opus-5-5/);
  });
});
