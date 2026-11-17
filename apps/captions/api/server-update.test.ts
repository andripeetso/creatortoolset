import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { AuthVars } from "./auth";

const data = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "server-update-"));
process.env.DATA_DIR = data;
const { draining, serverUpdateApp } = await import("./server-update");
afterAll(() => rmSync(data, { recursive: true, force: true }));

const status = path.join(data, "server-update", "status.json");
const request = path.join(data, "server-update", "request");
const write = (s: unknown) => (mkdirSync(path.dirname(status), { recursive: true }), writeFileSync(status, JSON.stringify(s)));

const as = (role: "admin" | "user") => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => (c.set("user", { username: "ada", role } as AuthVars["user"]), next()));
  app.route("/", serverUpdateApp);
  return app;
};

describe("server update", () => {
  it("is off, and refuses a request, while the machine runs no updater", async () => {
    expect(await (await as("admin").request("/")).json()).toEqual({ available: false });
    expect((await as("admin").request("/request", { method: "POST" })).status).toBe(409);
  });

  it("shows an admin what is waiting and takes the request", async () => {
    write({ behind: 3, nightly: 1800000000, failed: false });
    expect(await (await as("admin").request("/")).json()).toEqual({ available: true, behind: 3, nightly: 1800000000, requested: false, waiting: false, failed: false });
    expect((await as("user").request("/")).status).toBe(403);
    expect((await as("user").request("/request", { method: "POST" })).status).toBe(403);
    expect(existsSync(request)).toBe(false);
    expect(await (await as("admin").request("/request", { method: "POST" })).json()).toMatchObject({ requested: true });
    expect(existsSync(request)).toBe(true);
    expect(await (await as("admin").request("/")).json()).toMatchObject({ requested: true });
    rmSync(request);
  });

  it("asks for nothing when the server is up to date, and reads odd values as none", async () => {
    write({ behind: "many", nightly: "04", failed: "yes" });
    expect(await (await as("admin").request("/")).json()).toEqual({ available: true, behind: 0, nightly: null, requested: false, waiting: false, failed: false });
    await as("admin").request("/request", { method: "POST" });
    expect(existsSync(request)).toBe(false);
  });

  it("is off again once the updater has stopped writing", async () => {
    write({ behind: 3 });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(status, old, old);
    expect(await (await as("admin").request("/")).json()).toEqual({ available: false });
  });

  it("takes no new job while the updater's drain is fresh, and forgets one an updater left behind", () => {
    const file = path.join(data, "server-update", "drain");
    expect(draining()).toBe(false);
    writeFileSync(file, "");
    expect(draining()).toBe(true);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(file, old, old);
    expect(draining()).toBe(false);
  });
});
