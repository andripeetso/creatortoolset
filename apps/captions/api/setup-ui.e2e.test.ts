import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The browser smoke run for first-run setup. It starts the app's own Vite server in this process and runs one
// headless Chrome, as the Mac app's window would be. It walks all three paths (In the app, In my own AI, Both)
// through the same five steps, then checks that Done leaves no setup dialog behind after a reload. Alone:
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

// One path through the five steps. The answer on step 1 is the only thing that differs between paths.
async function walkSetup(how: "In the app" | "In my own AI" | "Both") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(new URL("/?setup=start", base).toString());

  const dialog = page.getByRole("dialog");
  await dialog.getByText("How do you work best?").waitFor({ timeout: 60_000 });
  // the welcome has no bar or counter at all (brief point 16)
  expect(await dialog.getByText(/^\d of \d$/).count()).toBe(0);
  await dialog.getByRole("radio", { name: new RegExp(how) }).check();
  await dialog.getByRole("button", { name: "Continue" }).click();

  await dialog.getByText("What will you make?").waitFor();
  expect(await dialog.getByText("1 of 4", { exact: true }).count()).toBe(1);
  await dialog.getByRole("checkbox", { name: /Short videos/ }).check();
  await dialog.getByRole("button", { name: "Continue" }).click();

  await dialog.getByRole("heading", { name: "Your first project" }).waitFor();
  expect(await dialog.getByText("2 of 4", { exact: true }).count()).toBe(1);
  // a project may already exist from an earlier path in this run: then the step only offers Continue
  if (await dialog.getByPlaceholder("My brand").count()) {
    await dialog.getByPlaceholder("My brand").fill("Tiny Acrobatics");
    await dialog.getByRole("button", { name: "Create project" }).click();
  } else {
    await dialog.getByRole("button", { name: "Continue" }).click();
  }

  await dialog.getByRole("heading", { name: "Connect your AI" }).waitFor();
  expect(await dialog.getByText("3 of 4", { exact: true }).count()).toBe(1);
  // nothing is connected before a press: no Connect was clicked, so the footer offers to go on without one
  expect(await dialog.getByText("Connected ✓").count()).toBe(0);
  await dialog.getByRole("button", { name: "Continue without connecting" }).click();

  await dialog.getByRole("heading", { name: "You're ready to start" }).waitFor();
  expect(await dialog.getByText("4 of 4", { exact: true }).count()).toBe(1);
  await dialog.getByRole("button", { name: "Open Review" }).click();
  await dialog.waitFor({ state: "hidden" });

  const saved = JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "setup", "local.json"), "utf-8"));
  expect(saved.done).toBe(true);
  expect(Array.isArray(saved.tools)).toBe(true);
  expect(saved.tools).toContain("editor");
  // the assistant's popup never appears during setup
  expect(await page.getByText("Ask assistant").count()).toBe(0);
  expect(errors).toEqual([]);
  await page.close();
}

describe.skipIf(!enabled)("first-run setup in the browser", () => {
  it("in the app: how → make → project → AI (nothing connected) → ready, five steps every time", async () => {
    await walkSetup("In the app");
  }, 180_000);

  it("in my own AI: the same five steps", async () => {
    await walkSetup("In my own AI");
  }, 180_000);

  it("both: the same five steps", async () => {
    await walkSetup("Both");
  }, 180_000);

  it("Done → reload → Home, with no setup dialog again", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(new URL("/", base).toString());
    await page.waitForTimeout(1500);
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.close();
  }, 60_000);
});
