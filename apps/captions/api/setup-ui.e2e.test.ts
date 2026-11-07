import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The browser smoke run for first-run setup. It starts the app's own Vite server in this process and runs one
// headless Chrome, as the Mac app's window would be, with the account step answered "sign-in isn't set up yet". Alone:
//   SETUP_E2E=1 CT_SCRATCH_DIR=<a scratch folder on a big disk> pnpm -s exec vitest run api/setup-ui.e2e.test.ts
// Everything it writes lives under CT_SCRATCH_DIR and is removed at the end.
// Not part of the server typecheck (tsconfig.server.json excludes it): the browser types are not in this workspace.

const enabled = process.env.SETUP_E2E === "1";
type Any = any;
let dir = "";
let base = "";
let server: Any = null;
let browser: Any = null;

beforeAll(async () => {
  if (!enabled) return;
  const scratch = process.env.CT_SCRATCH_DIR;
  if (!scratch) throw new Error("Set CT_SCRATCH_DIR to a folder on the external disk");
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(path.join(scratch, "setup-ui-"));
  process.env.DATA_DIR = path.join(dir, "data");
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  delete process.env.APP_SECRET; // every request is the local account, an admin

  const { createServer } = await import("vite");
  server = await createServer({ configFile: path.resolve(import.meta.dirname, "../vite.config.ts"), server: { port: 0, host: "127.0.0.1" }, logLevel: "error" });
  await server.listen();
  base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;
  const { chromium } = await import("playwright-chromium");
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("first-run setup in the browser", () => {
  it("account (not set up yet) → tools → AI with the plan → what's left → done", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    // the Mac app's account bridge, its server without sign-in
    await page.addInitScript(() => {
      (window as Any).webkit = { messageHandlers: { account: { postMessage: async () => ({ state: "notSetUp", server: "accounts.example" }) } } };
    });
    await page.goto(new URL("/?setup=start", base).toString());

    const dialog = page.getByRole("dialog");
    await dialog.getByText("Sign-in isn't set up on accounts.example yet", { exact: false }).waitFor({ timeout: 60_000 });
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();

    await dialog.getByText("Which tools do you use?", { exact: false }).waitFor();
    expect(await dialog.getByRole("button", { name: "Next" }).isDisabled()).toBe(true);
    await dialog.getByText("Caption Studio", { exact: true }).click();
    await dialog.getByRole("button", { name: "Next" }).click();

    // Caption Studio uses AI (the cadence pass) and isn't the Workshop: no project step, the AI step
    const plan = dialog.getByLabel("Which plan are you on?");
    await plan.waitFor();
    expect(await dialog.getByText("Your first project").count()).toBe(0);
    await plan.selectOption("claude_pro");
    await dialog.getByRole("button", { name: "Next" }).click();

    await dialog.getByText("Deepgram: faster cloud transcripts", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "hidden" });

    const saved = JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "setup", "local.json"), "utf-8"));
    expect(saved).toEqual({ tools: ["captions"], plan: "claude_pro", done: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);
});
