import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

// Stop on a source being read: the AI call is aborted, the source goes back to Not read, and the read's late answer
// writes nothing. Model mocked: it answers only when its signal is aborted (as a stopped call rejects).
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "ws-source-stop-"));
process.env.DATA_DIR = dataDir;
process.env.ANTHROPIC_API_KEY = "test-key";

const signals: AbortSignal[] = [];
vi.mock("./ai-complete", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-complete")>()),
  completeWithFallback: vi.fn(
    (_s: string, _u: string, signal: AbortSignal) =>
      new Promise((_, reject) => {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("Stopped")));
      }),
  ),
}));

const id = "eeeeeeee-0000-4000-8000-000000000001";
mkdirSync(path.join(dataDir, "workshop", "sources"), { recursive: true });
writeFileSync(path.join(dataDir, "workshop", "sources", `${id}.json`), JSON.stringify({ id, owner: "alex", name: "notes.txt", chars: 8, status: "new", createdAt: 1, updatedAt: 1 }));
writeFileSync(path.join(dataDir, "workshop", "sources", `${id}.txt`), "line one");

const { Hono } = await import("hono");
const { workshopApp } = await import("./workshop");
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
const status = async () => ((await (await app.request("/api/workshop/sources")).json()) as { id: string; status: string }[]).find((s) => s.id === id)?.status;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

it("Stop ends a source's read: the AI call is aborted and it is Not read again", async () => {
  await app.request(`/api/workshop/sources/${id}/read`, { method: "POST" });
  for (let i = 0; i < 200 && !signals.length; i++) await pause(5);
  expect(await status()).toBe("reading");
  const r = await app.request(`/api/workshop/sources/${id}/stop`, { method: "POST" });
  expect(r.status).toBe(200);
  expect(signals[0]!.aborted).toBe(true);
  await pause(30);
  expect(await status()).toBe("new");
  expect((await app.request("/api/workshop/sources/eeeeeeee-0000-4000-8000-000000000009/stop", { method: "POST" })).status).toBe(404);
});
