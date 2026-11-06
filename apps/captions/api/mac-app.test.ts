import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mac-app-"));
const { macAppPublic, macAppRelease } = await import("./mac-app");
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";

let who: SessionUser = { username: "alex", role: "admin", cloud: true, off: [] };
const app = new Hono<{ Variables: AuthVars }>();
app.route("/api/mac-app", macAppPublic);
app.use("*", async (c, next) => {
  c.set("user", who);
  await next();
});
app.route("/api/mac-app", macAppRelease);

const zip = (n: number) => new Uint8Array([0x50, 0x4b, ...new Array(2000).fill(n)]);
const sig = "A".repeat(86) + "==";
const put = (build: number, body = zip(build)) =>
  app.request(`/api/mac-app/release?version=1.0.${build}&build=${build}&signature=${encodeURIComponent(sig)}`, { method: "PUT", body });

describe("the Mac app's download and appcast", () => {
  it("serves nothing before the first release", async () => {
    expect((await app.request("/api/mac-app/download")).status).toBe(404);
    expect(await (await app.request("/api/mac-app/appcast.xml")).text()).not.toContain("<item>");
  });

  it("an admin's release becomes the download and the appcast's item; older builds and non-admins are refused", async () => {
    expect((await put(5)).status).toBe(200);
    expect((await put(5)).status).toBe(409);
    expect((await put(6, new Uint8Array(5000))).status).toBe(400);
    who = { username: "jordan", role: "team", cloud: true, off: [] };
    expect((await put(9)).status).toBe(403);
    who = { username: "alex", role: "admin", cloud: true, off: [] };

    const cast = await (await app.request("/api/mac-app/appcast.xml", { headers: { host: "creatortoolset.com" } })).text();
    expect(cast).toContain("<sparkle:version>5</sparkle:version>");
    expect(cast).toContain('url="https://creatortoolset.com/api/mac-app/download/5.zip" length="2002"');
    expect(cast).toContain(`sparkle:edSignature="${sig}"`);
    const dl = await app.request("/api/mac-app/download");
    expect(dl.headers.get("location")).toBe("/api/mac-app/download/5.zip");
    expect((await (await app.request("/api/mac-app/download/5.zip")).arrayBuffer()).byteLength).toBe(2002);
    expect(await (await app.request("/api/mac-app")).json()).toMatchObject({ version: "1.0.5", build: 5 });
  });
});
