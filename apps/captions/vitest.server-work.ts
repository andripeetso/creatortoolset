// A server's video work is off where server-work.json is missing (api/work/server-work.ts). Most tests check what the
// server does once it is on, so each test file's data folder starts with it on, unless the test wrote its own first.
// api/work/server-work.test.ts removes it to check the default itself.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll } from "vitest";

beforeAll(() => {
  const dir = process.env.DATA_DIR;
  if (!dir || !existsSync(dir)) return;
  const f = path.join(dir, "server-work.json");
  if (!existsSync(f)) writeFileSync(f, JSON.stringify({ on: true, v: 2 }));
});
