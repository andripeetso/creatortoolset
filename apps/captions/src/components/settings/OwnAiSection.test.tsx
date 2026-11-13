import { describe, expect, it } from "vitest";
import type { LocalAiRow } from "@contracts/local-ai";
import { commandFor, nextStep, NEEDS_MAC_APP, UPDATE_MAC_APP, installOutcome, webRowsFor, webRowState, webAppsShown, WEB_APPS } from "./OwnAiSection";

it("ChatGPT and Claude rows: on a linked computer they use the broker's address; on the web this server's; else hidden", () => {
  const origin = "https://studio.example.com";
  // a linked computer (its own tunnel is https, so it is on the web too): the broker wins
  expect(webRowsFor({ onWeb: true, connectAi: "https://broker.example.com/mcp", origin })).toEqual({ show: true, url: "https://broker.example.com/mcp", via: "connect" });
  expect(webRowsFor({ onWeb: false, connectAi: "https://broker.example.com/mcp", origin: "http://localhost:43127" })).toEqual({ show: true, url: "https://broker.example.com/mcp", via: "connect" });
  // not linked, on the web: as today
  expect(webRowsFor({ onWeb: true, connectAi: null, origin })).toEqual({ show: true, url: `${origin}/api/mcp`, via: "web" });
  // neither linked nor on the web: hidden
  expect(webRowsFor({ onWeb: false, connectAi: null, origin: "http://localhost:43127" }).show).toBe(false);
});

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

describe("how Install ends on a server that is not this computer", () => {
  it("in the Mac app the click does the work, or says what to do: never a line to run", () => {
    expect(installOutcome(true, { macApp: true, commands: true })).toBe("installed");
    expect(installOutcome("Claude Code isn't on this Mac.", { macApp: true, commands: true })).toEqual({ failed: "Claude Code isn't on this Mac." });
    // a Mac app from before it could install (the owner: "why is it giving me Terminal commands, just run them")
    expect(installOutcome(undefined, { macApp: true, commands: true })).toEqual({ failed: UPDATE_MAC_APP });
    expect(installOutcome(undefined, { macApp: true, commands: false })).toEqual({ failed: UPDATE_MAC_APP });
  });

  it("a line to run shows only in a plain browser, and never on a screen that shows none (setup)", () => {
    expect(installOutcome(undefined, { macApp: false, commands: true })).toBe("command");
    expect(installOutcome(undefined, { macApp: false, commands: false })).toEqual({ failed: NEEDS_MAC_APP });
  });
});

it("a ChatGPT or Claude row through Connect is installed once the app has used it; on the web, once the key exists", () => {
  expect(webRowState("connect")).toBe("install");
  expect(webRowState("connect", {})).toBe("finish");
  expect(webRowState("connect", { usedAt: 1 })).toBe("installed");
  expect(webRowState("web")).toBe("install");
  expect(webRowState("web", {})).toBe("installed");
});

it("through Connect a ChatGPT or Claude row shows only once that store lists Creator Toolset; on the web always", () => {
  const apps = [{ name: "ChatGPT", listing: "" }, { name: "Claude", listing: "https://claude.ai/directory/creator-toolset" }];
  expect(webAppsShown("connect", apps).map((a) => a.name)).toEqual(["Claude"]);
  expect(webAppsShown("web", apps).map((a) => a.name)).toEqual(["ChatGPT", "Claude"]);
  // today neither store lists it: a linked computer shows neither row
  expect(webAppsShown("connect", WEB_APPS)).toEqual([]);
});
