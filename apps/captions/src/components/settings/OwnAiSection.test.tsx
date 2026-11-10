import { expect, it } from "vitest";
import type { LocalAiRow } from "@contracts/local-ai";
import { commandFor, nextStep } from "./OwnAiSection";

const url = "https://studio.example.com/api/mcp";
const key = "ctk_" + "a".repeat(48);
const row = (over: Partial<LocalAiRow>): LocalAiRow => ({ id: "claude", name: "Claude Code", kind: "cli", found: true, signedIn: true, connected: false, mcp: "off", ...over });

it("on this computer the button does the next thing: sign in, update, install", () => {
  expect(nextStep(row({ signedIn: false }))).toBe("signin");
  expect(nextStep(row({ id: "codex", mcp: "update" }))).toBe("update");
  expect(nextStep(row({}))).toBe("connect");
  expect(nextStep(row({ mcp: "added" }), {})).toBe("connected");
  // written into the CLI once, but its key was removed: Install again
  expect(nextStep(row({ mcp: "added" }))).toBe("connect");
  // a command shown but never run is not installed; run and used, it is
  expect(nextStep(row({}), {})).toBe("connect");
  expect(nextStep(row({}), { usedAt: 1 })).toBe("connected");
});

it("Claude Code: one paste replaces an earlier entry and adds this server with its key", () => {
  const cmd = commandFor("claude", url, key);
  expect(cmd).toContain("claude mcp remove --scope user creator-toolset");
  expect(cmd).toContain(`claude mcp add --transport http --scope user creator-toolset ${url} --header "Authorization: Bearer ${key}"`);
});

it("Codex: the entry goes into its config with the key as a header", () => {
  const cmd = commandFor("codex", url, key);
  expect(cmd).toContain("[mcp_servers.creator-toolset]");
  expect(cmd).toContain(`url = "${url}"`);
  expect(cmd).toContain(`http_headers = { Authorization = "Bearer ${key}" }`);
  expect(cmd.trim().endsWith("EOF")).toBe(true);
});

it("another app gets the address and the header", () => {
  expect(commandFor("other", url, key)).toBe(`Address: ${url}\nHeader:  Authorization: Bearer ${key}`);
});
