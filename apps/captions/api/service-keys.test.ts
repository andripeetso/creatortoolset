import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AuthVars } from "./auth";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "service-keys-"));
process.env.NVIDIA_API_KEY = "server-env-key-1234";
delete process.env.DEEPGRAM_API_KEY;
const { serviceKeysApp, teamUseOn } = await import("./service-keys");

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "u", role: c.req.header("x-role") === "admin" ? "admin" : "user", cloud: true, off: [] });
  await next();
});
app.route("/", serviceKeysApp);
const put = (env: string, value: unknown, role = "admin") =>
  app.request(`/${env}`, { method: "PUT", headers: { "x-role": role, "content-type": "application/json" }, body: JSON.stringify({ value }) });
const list = async () => (await (await app.request("/", { headers: { "x-role": "admin" } })).json()) as { env: string; source: string | null; last4?: string }[];

it("a key pasted in Settings wins over the .env, Forget puts the .env's back; admins only, never the key itself", async () => {
  expect((await app.request("/")).status).toBe(403);
  expect((await put("DEEPGRAM_API_KEY", "dg-abcd", "user")).status).toBe(403);

  expect((await list()).find((k) => k.env === "NVIDIA_API_KEY")).toMatchObject({ source: "server", last4: "1234" });
  expect((await list()).find((k) => k.env === "DEEPGRAM_API_KEY")?.source).toBeNull();

  expect((await put("DEEPGRAM_API_KEY", "dg-hidden-abcd")).status).toBe(200);
  expect((await put("NVIDIA_API_KEY", "nvapi-settings-9999")).status).toBe(200);
  expect(process.env.DEEPGRAM_API_KEY).toBe("dg-hidden-abcd");
  expect(process.env.NVIDIA_API_KEY).toBe("nvapi-settings-9999");
  expect(JSON.stringify(await list())).not.toContain("hidden");
  expect(statSync(path.join(process.env.DATA_DIR!, "service-keys.json")).mode & 0o777).toBe(0o600);

  await put("NVIDIA_API_KEY", null);
  await put("DEEPGRAM_API_KEY", null);
  expect(process.env.NVIDIA_API_KEY).toBe("server-env-key-1234");
  expect(process.env.DEEPGRAM_API_KEY).toBeUndefined();

  expect((await put("STRIPE_SECRET_KEY", "x")).status).toBe(404);
  expect((await put("NVIDIA_API_KEY", "two words")).status).toBe(400);
});

it("Team use is off until an admin turns it on; admins only, and it is not a key", async () => {
  const team = (on: unknown, role = "admin") =>
    app.request("/team-use", { method: "PUT", headers: { "x-role": role, "content-type": "application/json" }, body: JSON.stringify({ on }) });
  expect(teamUseOn()).toBe(false);
  expect((await team(true, "user")).status).toBe(403);
  expect((await app.request("/team-use", { headers: { "x-role": "user" } })).status).toBe(403);
  expect((await team("yes")).status).toBe(400);

  expect((await team(true)).status).toBe(200);
  expect(teamUseOn()).toBe(true);
  expect(await (await app.request("/team-use", { headers: { "x-role": "admin" } })).json()).toEqual({ on: true });

  await team(false);
  expect(teamUseOn()).toBe(false);
});

it("saving a server speech key or turning Team use on with one already set wakes parked transcripts", async () => {
  const [{ libraryDb }, { claimJob, enqueueJob, parkJob }] = await Promise.all([import("./library/db"), import("./library/jobs")]);
  const db = libraryDb();
  const park = (ver: string, kind = "transcribe") => {
    enqueueJob(db, "lib_s", ver, kind, "member");
    const id = (db.prepare("SELECT id FROM jobs WHERE version_id = ?").get(ver) as { id: number }).id;
    parkJob(db, id, "Add your Deepgram key in Settings → API keys", "jobs", claimJob(db, 300, 1000, "jobs", undefined, id)!.claim_id);
  };
  const state = (ver: string) => (db.prepare("SELECT state FROM jobs WHERE version_id = ?").get(ver) as { state: string }).state;
  const team = (on: boolean) =>
    app.request("/team-use", { method: "PUT", headers: { "x-role": "admin", "content-type": "application/json" }, body: JSON.stringify({ on }) });

  park("ver_s1");
  park("ver_s2", "describe");
  // a non-speech server key wakes nothing
  expect((await put("PERPLEXITY_API_KEY", "pplx-test-1234")).status).toBe(200);
  expect(state("ver_s1")).toBe("needs_key");
  // turning Team use on with no speech key wakes nothing
  expect((await team(true)).status).toBe(200);
  expect(state("ver_s1")).toBe("needs_key");
  await team(false);
  // saving a server speech key wakes parked transcripts, not descriptions
  expect((await put("DEEPGRAM_API_KEY", "dg-server-1234")).status).toBe(200);
  expect([state("ver_s1"), state("ver_s2")]).toEqual(["queued", "needs_key"]);

  // a transcript parked while Team use was off wakes when Team use is turned on with the key already set
  park("ver_s3");
  expect((await team(false)).status).toBe(200);
  expect(state("ver_s3")).toBe("needs_key");
  expect((await team(true)).status).toBe(200);
  expect([state("ver_s3"), state("ver_s2")]).toEqual(["queued", "needs_key"]);

  await team(false);
  await put("DEEPGRAM_API_KEY", null);
  await put("PERPLEXITY_API_KEY", null);
});
