import { describe, expect, it, vi } from "vitest";

vi.mock("../plugins.gen", () => ({ serverPlugins: [] }));
const { accountFolder, folderEnv } = await import("./local-ai");

describe("a sign-in's account folder", () => {
  it("signs in where the runs look: the folder set, or the variable removed for the default", () => {
    const env = { PATH: "/bin", CLAUDE_CONFIG_DIR: "/Users/tiny/.left-over" };
    expect(folderEnv("claude", "/Users/tiny/.claude-work", env)).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/Users/tiny/.claude-work" });
    expect(folderEnv("claude", undefined, env)).toEqual({ PATH: "/bin" });
    expect(folderEnv("codex", "/Users/tiny/.codex-2", { PATH: "/bin" })).toEqual({ PATH: "/bin", CODEX_HOME: "/Users/tiny/.codex-2" });
    expect(folderEnv("grok", "/Users/tiny/x", env)).toBe(env);
  });

  it("takes only a folder inside the home folder", () => {
    expect(accountFolder("/Users/tiny/.claude-work", "/Users/tiny")).toBe("/Users/tiny/.claude-work");
    for (const bad of ["/Users/tiny/../other/.claude", "/etc", "relative", "/Users/tiny", 5, "/Users/tinyx/.claude"]) expect(accountFolder(bad, "/Users/tiny")).toBeNull();
  });
});
