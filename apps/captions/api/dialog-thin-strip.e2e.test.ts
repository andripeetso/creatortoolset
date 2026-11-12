import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The dialog body check for the thin-strip bug (a flex-1 body in a max-height dialog renders as a thin strip in
// WebKit). It runs the PRODUCTION build (vite build, then dist/boot.js) in Playwright WebKit, the engine the Mac app's
// window uses. Needs the build first:
//   DIALOG_E2E=1 CT_SCRATCH_DIR=<a folder on the external disk> SHOT_DIR=<screenshots> pnpm -s build && \
//   DIALOG_E2E=1 ... pnpm -s exec vitest run api/dialog-thin-strip.e2e.test.ts
// Everything it writes lives under CT_SCRATCH_DIR and is removed at the end.

const enabled = process.env.DIALOG_E2E === "1";
const captionsDir = path.resolve(import.meta.dirname, "..");
const shots = process.env.SHOT_DIR;

type Any = any;
let server: ChildProcess | null = null;
let browser: Any = null;
let base = "";
let secret = "";
let dir = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > until) throw new Error(`no answer from ${url}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  if (!enabled) return;
  if (!existsSync(path.join(captionsDir, "dist/boot.js"))) throw new Error("Run pnpm build first (dist/boot.js is missing)");
  const scratch = process.env.CT_SCRATCH_DIR;
  if (!scratch) throw new Error("Set CT_SCRATCH_DIR to a folder on the external disk");
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(path.join(scratch, "dialog-thin-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // Production refuses to start without APP_SECRET. The bootstrap admin "admin" gets it as its password, and a sign-in
  // from this machine's loopback takes it (api/auth.ts), so the browser signs in as the owner would.
  secret = randomBytes(16).toString("hex");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", APP_SECRET: secret, PORT: String(port), DATA_DIR: path.join(dir, "data"), CT_LOCAL: "1" };
  mkdirSync(env.DATA_DIR, { recursive: true });
  server = spawn(process.execPath, ["dist/boot.js"], { cwd: captionsDir, env, stdio: "ignore" });
  await waitFor(`${base}/`, 60_000);
  const { webkit } = await import("playwright-chromium");
  browser = await webkit.launch({ headless: true });
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const SIZES = { "1480x900": { width: 1480, height: 900 }, "960x640": { width: 960, height: 640 } } as const;

// The body of each dialog: the element that scrolls inside the dialog.
const CASES = [
  { name: "projects", route: "/projects", body: '[data-slot="dialog-content"] > .overflow-y-auto' },
] as const;

describe.skipIf(!enabled)("dialog bodies in WebKit (production build)", () => {
  for (const c of CASES) {
    for (const [sizeName, size] of Object.entries(SIZES)) {
      it(`${c.name} body shows full height at ${sizeName}`, async () => {
        const context = await browser.newContext({ viewport: size });
        // the login sets the session cookie in this context's jar, so the page below is signed in
        const login = await context.request.post(`${base}/api/auth/login`, { data: { username: "admin", password: secret } });
        expect(login.ok()).toBe(true);
        const page = await context.newPage();
        try {
          await page.goto(`${base}${c.route}`, { waitUntil: "networkidle" });
          await page.waitForSelector(c.body, { timeout: 30_000 });
          await page.waitForTimeout(400); // the dialog's fade-in
          // a long body (a list of projects, a guide): the case where a flex-1 body went to a thin strip in WebKit
          await page.evaluate((sel: string) => {
            const spacer = document.createElement("div");
            spacer.style.height = "1500px";
            (document.querySelector(sel) as HTMLElement).appendChild(spacer);
          }, c.body);
          await page.waitForTimeout(100);
          const m = await page.evaluate((sel: string) => {
            const body = document.querySelector(sel) as HTMLElement;
            const dialog = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
            return { body: body.getBoundingClientRect().height, scroll: body.scrollHeight, dialog: dialog.getBoundingClientRect().height };
          }, c.body);
          if (shots) {
            mkdirSync(shots, { recursive: true });
            await page.screenshot({ path: path.join(shots, `dialog-${c.name}-${sizeName}.png`) });
          }
          // The body is never a strip: it is at least what its content needs, or at least 200 px when the content is taller
          expect(m.body).toBeGreaterThanOrEqual(Math.min(m.scroll, 200) - 2); // 2 px: subpixel rounding
        } finally {
          await context.close();
        }
      }, 90_000);
    }
  }
});
