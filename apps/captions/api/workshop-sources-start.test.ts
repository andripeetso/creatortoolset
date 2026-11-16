import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

// Knowledge sources at the server's start: what an older version kept another way moves to where it is kept now, and
// what waited to be read is read. Listing the sources afterwards is a read and nothing else. Model mocked.
const dataDir = mkdtempSync(path.join(tmpdir(), "ws-sources-start-"));
process.env.DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "test-key";

vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  completeWithFallback: vi.fn(async (_s: string, _u: string, _c: unknown, parse: (t: string) => unknown) =>
    parse(JSON.stringify({ kind: "notes", title: "Notes", about: "Some notes.", uses: [], sections: [] })),
  ),
}));

const ws = (...p: string[]) => path.join(dataDir, "workshop", ...p);
const id = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = (n: number, name: string, status: string, text: string) => {
  mkdirSync(ws("sources"), { recursive: true });
  writeFileSync(ws("sources", `${id(n)}.json`), JSON.stringify({ id: id(n), owner: "alex", name, chars: text.length, status, createdAt: n, updatedAt: n }));
  writeFileSync(ws("sources", `${id(n)}.txt`), text);
};
const projectFile = ws("projects", `${id(1)}.json`);
const project = (knowledge: unknown[]) => {
  mkdirSync(ws("projects"), { recursive: true });
  writeFileSync(projectFile, JSON.stringify({ id: id(1), owner: "alex", name: "Tiny Acrobatics", audience: "", voice: "", cta: "", notes: "", knowledge, createdAt: 1, updatedAt: 1 }));
};
const bundle = (name: string) => `# ${name}/a.md\n\nalpha\n\n# ${name}/b.md\n\nbeta`;

// as an older version and a restart left them, there before the server starts
project([{ id: id(2), name: "offers-facts.md", text: "Offer facts", addedAt: 1 }]);
source(3, "brandkit", "failed", bundle("brandkit")); // a folder kept as one source
source(4, "notes.txt", "reading", "line one\nline two"); // the restart stopped its read

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
const { completeWithFallback } = await import("./ai-complete");
const { createUser } = await import("./users");
const { pairDevice } = await import("./lib/devices");
const { saveSettings } = await import("./lib/providers");
createUser("alex", "password1", { role: "admin" });
await saveSettings({
  instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: pairDevice("alex", "Alex's Mac").device.id }],
  default: { instance: "claude", model: "claude-opus-5-5", effort: "xhigh" },
  jobs: {},
});

const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
type Row = { id: string; name: string; status: string; projectId?: string };
const rows = async () => (await (await app.request("/api/workshop/sources")).json()) as Row[];
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

it("at the start: old context files and a kept folder become sources, and what waited to be read is read", async () => {
  let got = await rows();
  expect(got.map((x) => x.name).sort()).toEqual(["brandkit/a.md", "brandkit/b.md", "notes.txt", "offers-facts.md"]);
  expect(got.find((x) => x.name === "offers-facts.md")).toMatchObject({ projectId: id(1), status: "new" });
  expect(JSON.parse(readFileSync(projectFile, "utf-8")).knowledge).toEqual([]);
  expect(existsSync(ws("sources", `${id(3)}.txt`))).toBe(false);
  for (let i = 0; i < 200 && got.some((x) => x.name !== "offers-facts.md" && x.status !== "read"); i++) {
    await pause(10);
    got = await rows();
  }
  expect(got.filter((x) => x.name !== "offers-facts.md").map((x) => x.status)).toEqual(["read", "read", "read"]);
});

it("listing the sources afterwards changes nothing and starts nothing", async () => {
  // none of these is something the running server leaves: only a start puts them right
  project([{ id: id(5), name: "late-facts.md", text: "Late facts", addedAt: 1 }]);
  source(6, "latekit", "failed", bundle("latekit"));
  source(7, "late.txt", "queued", "later");
  const state = () => [readFileSync(projectFile, "utf-8"), ...readdirSync(ws("sources")).sort().map((f) => `${f}:${f.endsWith(".json") ? readFileSync(ws("sources", f), "utf-8") : ""}`)];
  const [before, asked] = [state(), vi.mocked(completeWithFallback).mock.calls.length];
  const got = await rows();
  await app.request("/api/workshop/context-files");
  await pause(50);
  expect(got.filter((x) => x.name.startsWith("late")).map((x) => [x.name, x.status])).toEqual([["latekit", "failed"], ["late.txt", "queued"]]);
  expect(state()).toEqual(before);
  expect(vi.mocked(completeWithFallback).mock.calls.length).toBe(asked);
});
