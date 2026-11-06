import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import type { AuthVars } from "./auth";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "service-keys-"));
process.env.NVIDIA_API_KEY = "server-env-key-1234";
delete process.env.DEEPGRAM_API_KEY;
const { serviceKeysApp } = await import("./service-keys");

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

  expect((await put("DEEPGRAM_API_KEY", "dg-secret-abcd")).status).toBe(200);
  expect((await put("NVIDIA_API_KEY", "nvapi-settings-9999")).status).toBe(200);
  expect(process.env.DEEPGRAM_API_KEY).toBe("dg-secret-abcd");
  expect(process.env.NVIDIA_API_KEY).toBe("nvapi-settings-9999");
  expect(JSON.stringify(await list())).not.toContain("secret");
  expect(statSync(path.join(process.env.DATA_DIR!, "service-keys.json")).mode & 0o777).toBe(0o600);

  await put("NVIDIA_API_KEY", null);
  await put("DEEPGRAM_API_KEY", null);
  expect(process.env.NVIDIA_API_KEY).toBe("server-env-key-1234");
  expect(process.env.DEEPGRAM_API_KEY).toBeUndefined();

  expect((await put("STRIPE_SECRET_KEY", "x")).status).toBe(404);
  expect((await put("NVIDIA_API_KEY", "two words")).status).toBe(400);
});
