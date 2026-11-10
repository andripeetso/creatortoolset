import { Hono } from "hono";
import { expect, it } from "vitest";
import hello from "./plugin";

// The plug-in's route as the server mounts it, asked by an account whose `off` list is given.
const ping = (off: string[]) => {
  const app = new Hono<{ Variables: { user: unknown } }>();
  app.use(async (c, next) => {
    c.set("user", { username: "tiny", role: "user", off });
    await next();
  });
  app.route("/api/x/hello", hello.routes!);
  return app.request("/api/x/hello/ping");
};

it("answers behind its gate", async () => {
  expect((await ping([])).status).toBe(200);
  expect((await ping(["hello"])).status).toBe(403);
});
