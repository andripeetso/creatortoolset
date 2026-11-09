import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The core events fire from the real routes: a session's status change (one publish, one event).
const dataDir = mkdtempSync(path.join(tmpdir(), "ev-"));
process.env.DATA_DIR = dataDir;

const { Hono } = await import("hono");
const { workshopApp } = await import("../workshop");
const { onEvent, emitEvent } = await import("./events");
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "admin", cloud: true, off: [] });
  await next();
});
app.route("/api/workshop", workshopApp as never);
const patch = (id: string, body: unknown) =>
  app.request(`/api/workshop/sessions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let n = 0;
function seed(status: string) {
  const id = `dddddddd-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const sdir = path.join(dataDir, "workshop", "sessions", id);
  mkdirSync(path.join(sdir, "docs"), { recursive: true });
  writeFileSync(path.join(sdir, "meta.json"), JSON.stringify({ id, owner: "alex", title: "Tiny", query: "", status, sources: [], drafts: [], createdAt: 1, updatedAt: 1 }));
  return id;
}

describe("core events", () => {
  it("session.published fires once for a publish, and a throwing listener does not fail the route", async () => {
    const seen: string[] = [];
    const stopSpy = onEvent("session.published", (e) => void seen.push(e.id));
    const stopThrow = onEvent("session.published", () => {
      throw new Error("plug-in bug");
    });
    const stopReject = onEvent("session.published", () => Promise.reject(new Error("async plug-in bug")));
    try {
      const id = seed("toPost");
      const res = await patch(id, { status: "published" });
      expect(res.status).toBe(200);
      expect(seen).toEqual([id]);
      // the same status again is not a change, so nothing new is announced
      expect((await patch(id, { status: "published" })).status).toBe(200);
      expect(seen).toEqual([id]);
    } finally {
      stopSpy();
      stopThrow();
      stopReject();
    }
  });

  it("emitEvent with no listeners is a no-op", () => {
    expect(() => emitEvent("session.status", { id: "x", owner: "alex", from: "draft", to: "writing" })).not.toThrow();
  });
});
