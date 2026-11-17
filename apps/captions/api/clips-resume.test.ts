import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "clips-resume-"));
delete process.env.APP_SECRET; // one local account: the notes run as it

/** A note on disk as a restart left it: still marked processing, no job running. */
const stopped = (resumes?: number) => {
  const id = randomUUID();
  const dir = path.join(process.env.DATA_DIR!, "clips", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "recording"), "not a video");
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id, name: "Walkthrough", owner: "local", duration: 0, bytes: 11, mime: "video/mp4", status: "processing", step: "transcribe", progress: 0.4, createdAt: 1, updatedAt: 1, resumes }));
  return id;
};
// there before the server starts, as a restart leaves them
const [once, often] = [stopped(), stopped(3)];

const app = (await import("./boot")).default;
const get = async (id: string) => (await (await app.request(`/api/clips/${id}`)).json()) as { status: string; error?: string; resumes?: number };

describe("a Video Note a server restart stopped", () => {
  it("starts processing again instead of failing", async () => {
    const note = await get(once);
    expect(note.status).toBe("processing");
    expect(note.resumes).toBe(1);
    expect(note.error).toBeUndefined();
  });

  it("fails after being started again too often, so a file that takes the server down doesn't loop", async () => {
    const note = await get(often);
    expect(note.status).toBe("error");
    expect(note.error).toMatch(/server restarted/);
  });

  it("is picked up at start, never by a read: reading a note changes nothing", async () => {
    const id = stopped(); // put there after the start: no restart stopped it, so nothing picks it up
    const file = path.join(process.env.DATA_DIR!, "clips", id, "meta.json");
    const before = readFileSync(file, "utf-8");
    expect(await get(id)).toMatchObject({ status: "processing" });
    expect((await get(id)).resumes).toBeUndefined();
    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});
