import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const data = mkdtempSync(path.join(tmpdir(), "exports-zip-"));
process.env.DATA_DIR = data;
const job = (id: string, owner: string, filename: string, body: string) => {
  const dir = path.join(data, "exports", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "out.mp4"), body);
  writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    id, kind: "burn", engine: "native", format: "h264", ext: "mp4", filename, status: "done",
    progress: 1, createdAt: Date.now(), finishedAt: Date.now(), owner, params: { duration: 1 },
  }));
};
job("job-aaaa1", "alex", "Launch_B-captioned.mp4", "bbbb");
job("job-aaaa2", "alex", "Launch_C-captioned.mp4", "cccc");
job("job-aaaa3", "someone", "theirs-captioned.mp4", "xxxx");
const { exportsApp } = await import("./exports");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "alex", role: "user", cloud: true, off: [] });
  await next();
});
app.route("/", exportsApp);

describe("several exports as one ZIP", () => {
  it("zips the finished files under their own names, only the asker's", async () => {
    const res = await app.request("/zip?ids=job-aaaa1,job-aaaa2,job-aaaa3&name=Launch");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="Launch.zip"');
    const file = path.join(data, "got.zip");
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const list = execFileSync("unzip", ["-Z1", file], { encoding: "utf8" }).trim().split("\n");
    expect(list.sort()).toEqual(["Launch_B-captioned.mp4", "Launch_C-captioned.mp4"]);
    expect(execFileSync("unzip", ["-p", file, "Launch_C-captioned.mp4"], { encoding: "utf8" })).toBe("cccc");
  });

  it("answers 404 when nothing asked for is the asker's", async () => {
    expect((await app.request("/zip?ids=job-aaaa3")).status).toBe(404);
  });
});
