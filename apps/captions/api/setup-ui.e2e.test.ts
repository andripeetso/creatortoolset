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
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// Screenshots go to SHOT_DIR when it is set (the Playwright run on the test machine copies them back).
const shots = process.env.SHOT_DIR;
async function shot(page: Any, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(400); // the step's fade-in
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } } as const;

// One path through the steps. The answer on step 1 is the only thing that differs between paths. The click path is
// how → make → project → agents (not in In the app) → done; Connect and Folders are reached from the done step.
async function walkSetup(how: "In the app" | "In my own AI" | "Both", size: keyof typeof SIZES) {
  const tag = `${how.replace(/\s+/g, "-").toLowerCase()}-${size}`;
  const page = await browser.newPage({ viewport: SIZES[size] });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(new URL("/?setup=start", base).toString());

  const dialog = page.getByRole("dialog");
  await dialog.getByText("How do you work best?").waitFor({ timeout: 60_000 });
  // the welcome has no stage bar at all
  expect(await dialog.getByRole("list", { name: "Stage 1 of 3" }).count()).toBe(0);
  await shot(page, `${tag}-1how`);
  await dialog.getByRole("radio", { name: new RegExp(how) }).check();
  await dialog.getByRole("button", { name: "Continue" }).click();

  await dialog.getByText("What will you make?").waitFor();
  await dialog.getByRole("checkbox", { name: /Short videos/ }).check();
  await shot(page, `${tag}-2make`);
  await dialog.getByRole("button", { name: "Continue" }).click();

  await dialog.getByRole("heading", { name: "Your first project" }).waitFor();
  // a project may already exist from an earlier path in this run: then the step only offers Continue
  if (await dialog.getByPlaceholder("My brand").count()) {
    await dialog.getByPlaceholder("My brand").fill("Tiny Acrobatics");
    await dialog.getByRole("button", { name: "Create project" }).click();
  } else {
    await dialog.getByRole("button", { name: "Continue" }).click();
  }

  if (how !== "In the app") {
    await dialog.getByRole("heading", { name: "Connect your agents" }).waitFor();
    expect(await dialog.getByRole("list", { name: "Stage 2 of 3" }).count()).toBe(1);
    // nothing is connected before a press: no Connect was clicked, so the footer offers to go on without one
    expect(await dialog.getByText("Connected ✓").count()).toBe(0);
    await shot(page, `${tag}-3agents`);
    await dialog.getByRole("button", { name: /^Continue/ }).click();
  }

  await dialog.getByRole("heading", { name: "You're ready to start" }).waitFor();
  await shot(page, `${tag}-4done`);

  // Connect and Folders are a side trip from the done step, and Back returns to done
  await dialog.getByRole("button", { name: /Add your phone or another computer/ }).click();
  await dialog.getByRole("heading", { name: "Connect your computers" }).waitFor();
  expect(await dialog.getByRole("list", { name: "Stage 1 of 3" }).count()).toBe(1);
  await shot(page, `${tag}-5connect`);
  await dialog.getByRole("button", { name: "Back" }).click();
  await dialog.getByRole("heading", { name: "You're ready to start" }).waitFor();

  await dialog.getByRole("button", { name: /Add your folders/ }).click();
  await dialog.getByRole("heading", { name: "Add your folders" }).waitFor();
  expect(await dialog.getByRole("list", { name: "Stage 3 of 3" }).count()).toBe(1);
  await shot(page, `${tag}-6folders`);
  await dialog.getByRole("button", { name: "Do not add folders" }).click();
  await dialog.getByRole("heading", { name: "You're ready to start" }).waitFor();

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

// "I already have a server", as far as one server can show it: the address opens, and a pasted link that is not
// another server's link is refused on this server before anything is fetched.
async function existingServer(size: keyof typeof SIZES) {
  const page = await browser.newPage({ viewport: SIZES[size] });
  await page.goto(new URL("/?setup=connect", base).toString());
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Connect your computers" }).waitFor({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Add another computer" }).click();
  await dialog.getByLabel(/paste the link it shows here/).fill("https://studio.example.com/api/devices");
  await dialog.getByRole("button", { name: "Join" }).click();
  await dialog.getByText("That isn't a sign-in link from another server").waitFor();
  await shot(page, `existing-${size}-refused`);
  await page.close();
}

describe.skipIf(!enabled)("first-run setup in the browser", () => {
  for (const size of Object.keys(SIZES) as Array<keyof typeof SIZES>) {
    it(`in the app (${size}): make → project → ready, Agents skipped`, async () => {
      await walkSetup("In the app", size);
    }, 180_000);

    it(`in my own AI (${size}): make → project → agents → ready`, async () => {
      await walkSetup("In my own AI", size);
    }, 180_000);

    it(`both (${size}): make → project → agents → ready`, async () => {
      await walkSetup("Both", size);
    }, 180_000);

    it(`existing server (${size}): a pasted link that isn't one is refused`, async () => {
      await existingServer(size);
    }, 120_000);
  }

  it("Done → reload → Home, with no setup dialog again", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(new URL("/", base).toString());
    await page.waitForTimeout(1500);
    expect(await page.getByRole("dialog").count()).toBe(0);
    await page.close();
  }, 60_000);
});
