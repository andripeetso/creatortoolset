import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "bug-report-"));

vi.mock("./plugins.gen", () => ({ serverPlugins: [] }));
const { libraryDb } = await import("./library/db");
const { diagnosticsOf, failedJobsOf, noteFailure, noteFailures, reportOf, unhome } = await import("./bug-report");
const { reportCrash } = await import("./lib/telemetry");
import type { ProvidersView } from "../contracts/providers";
import { Hono } from "hono";
import type { SessionUser } from "./users";

const NOW = 1_800_000_000_000;
const view = {
  using: "own",
  own: { instances: [{ id: "claude", driver: "claude", name: "Claude (Tiny)", enabled: true, home: "/Users/tiny/.claude-work", device: "d1" }] },
  workspace: null,
  checks: { "tiny:claude": { ok: false, at: NOW - 120_000, ms: 900, error: "spawn /Users/tiny/.local/bin/claude ENOENT" } },
  devices: [{ id: "d1", owner: "tiny", name: "Tiny's Mac", createdAt: 0, online: true, version: "0.40.0", report: { at: NOW, drivers: [{ driver: "claude", installed: true, version: "2.1.0", path: "/Users/tiny/x", signedIn: false }], homes: [] } }],
} as unknown as ProvidersView;

describe("bug report", () => {
  it("writes home folders as ~", () => {
    expect(unhome("at /Users/tiny/.claude and /home/pi/x")).toBe("at ~/.claude and ~/x");
  });

  it("carries each provider's last test and its computer, never a name or a path outside ~", () => {
    const d = diagnosticsOf(view, "tiny", true, NOW);
    expect(d.providers[0]).toMatchObject({ driver: "claude", computer: 1, accountFolder: "~/.claude-work", lastTest: { ok: false, minutesAgo: 2, error: "spawn ~/.local/bin/claude ENOENT" } });
    expect(d.computers[0]!.ai![0]).toEqual({ driver: "claude", installed: true, version: "2.1.0", signedIn: false, plan: undefined });
    expect(JSON.stringify(d)).not.toMatch(/Tiny|\/Users\//);
  });

  it("carries the server's errors to the server's owner only, never to a team member or a Cloud account", () => {
    reportCrash("server", new Error("someone else's request failed"));
    expect(diagnosticsOf(view, "tiny", true, NOW).errors.map((e) => e.message)).toContain("someone else's request failed");
    expect(diagnosticsOf(view, "tiny", false, NOW).errors).toEqual([]);
  });

  it("keeps an error's stack with its paths hidden", () => {
    const e = new Error("boom");
    e.stack = "Error: boom\n    at read (/srv/data/Tiny Shoot/a.mov:1:2)\n    at go (x.ts:3:4)";
    reportCrash("server", e);
    const stack = diagnosticsOf(view, "tiny", true, NOW).errors.at(-1)!.stack!;
    expect(stack).toContain("at go (x.ts:3:4)");
    expect(stack).not.toContain("Tiny Shoot");
  });

  it("carries each account's own failed requests, a repeat counted", () => {
    noteFailure("tiny", "POST", "/api/exports/1", 500, "spawn /Users/tiny/bin/ffmpeg ENOENT", NOW - 60_000);
    noteFailure("tiny", "POST", "/api/exports/1", 500, "spawn /Users/tiny/bin/ffmpeg ENOENT", NOW);
    noteFailure("alex", "GET", "/api/library", 404, "Not found", NOW);
    expect(diagnosticsOf(view, "tiny", false, NOW).failedRequests).toEqual([{ minutesAgo: 0, method: "POST", path: "/api/exports/1", status: 500, error: "spawn <path> ENOENT", count: 2 }]);
  });

  it("notes a failed answer with its error line, and nothing for a fine one or a visitor", async () => {
    const app = new Hono<{ Variables: { user: SessionUser } }>();
    app.use("*", async (c, next) => {
      const who = c.req.header("x-who");
      c.set("user", { username: who ?? "visitor", role: who ? "admin" : "visitor" } as SessionUser);
      await next();
    });
    app.use("*", noteFailures as never);
    app.get("/api/bad", (c) => c.json({ error: "Could not read the folder" }, 409));
    app.get("/api/ok", (c) => c.json({}));
    await app.request("/api/bad", { headers: { "x-who": "sam" } });
    await app.request("/api/ok", { headers: { "x-who": "sam" } });
    await app.request("/api/bad");
    await new Promise((r) => setTimeout(r, 10));
    expect(diagnosticsOf(view, "sam", false).failedRequests).toMatchObject([{ method: "GET", path: "/api/bad", status: 409, error: "Could not read the folder" }]);
    expect(diagnosticsOf(view, "visitor", false).failedRequests).toEqual([]);
  });

  it("counts alike failed jobs together, the person's own unless they own the server", () => {
    const add = libraryDb().prepare("INSERT INTO jobs (library_id, version_id, kind, state, actor, error, done_at) VALUES ('l', ?, 'transcribe', 'failed', ?, ?, ?)");
    add.run("v1", "tiny", "No speech key", NOW - 120_000);
    add.run("v2", "tiny", "No speech key", NOW - 60_000);
    add.run("v3", "alex", "ffmpeg exited 1 on /srv/Tiny Shoot/a.mov", NOW);
    expect(failedJobsOf("tiny", false, NOW)).toEqual([{ where: "library", kind: "transcribe", error: "No speech key", count: 2, minutesAgo: 1 }]);
    const all = failedJobsOf("tiny", true, NOW);
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("Tiny Shoot");
  });

  it("keeps the chat's words, at most 30 messages", () => {
    const chat = Array.from({ length: 40 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", text: `m${n}` }));
    const r = reportOf({ what: "x", chat: [...chat, { role: "user", text: "" }] }, diagnosticsOf(view, "tiny", true, NOW), "ab") as { chat: { text: string }[] };
    expect(r.chat).toHaveLength(29);
    expect(r.chat[0]!.text).toBe("m11");
  });

  it("needs the person's words and refuses a wrong kind", () => {
    const d = diagnosticsOf(view, "tiny", true, NOW);
    expect(reportOf({ kind: "bug" }, d, "ab")).toMatch(/what is required/);
    expect(reportOf({ kind: "rant", what: "x" }, d, "ab")).toMatch(/kind/);
    expect(reportOf({ what: "Sign in never finishes\nmore" }, d, "ab")).toMatchObject({ ref: "ab", kind: "bug", title: "Sign in never finishes" });
  });
});
