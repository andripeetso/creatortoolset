import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The browser smoke run for first-run setup. It starts the app's own Vite server in this process and runs one
// headless Chrome, as the Mac app's window would be. It walks the two screens (Connect your AI, What do you make?)
// the way a new person does, for every saved way of working, and checks what must hold: nothing on a phone,
// closing early keeps it unfinished, one project is made, no folder scan, no key to type. The tests share one data
// folder and run in order: the first ones need an account that has not finished. Alone:
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
  // a port nobody holds: the config's strictPort makes "0" mean the default one, which another run on this machine may have
  const { createServer: listener } = await import("node:net");
  const port = await new Promise<number>((done) => {
    const s = listener().listen(0, "127.0.0.1", () => {
      const free = (s.address() as { port: number }).port;
      s.close(() => done(free));
    });
  });
  server = await createServer({ configFile: path.resolve(import.meta.dirname, "../vite.config.ts"), server: { port, host: "127.0.0.1" }, logLevel: "error" });
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

const DESKTOP = { width: 1440, height: 900 };
// Small windows (a Mac window that is not full screen): the dialog must still show a whole step, never a thin strip
const SMALL = { w1024x640: { width: 1024, height: 640 }, w800x600: { width: 800, height: 600 } } as const;

const url = (p: string) => new URL(p, base).toString();
const saved = () => {
  try {
    return JSON.parse(readFileSync(path.join(process.env.DATA_DIR!, "setup", "local.json"), "utf-8"));
  } catch {
    return {}; // nothing saved yet
  }
};

/** A page in its own browser context. The folder scan walks every drive of the machine: it is answered here, and counted. */
async function open(context: Any = { viewport: DESKTOP }) {
  const ctx = await browser.newContext(context);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const scans: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.route("**/api/setup/folders/scan*", (route: Any) => {
    scans.push(route.request().url());
    return route.fulfill({ json: {} });
  });
  const get = async (p: string) => (await page.request.get(url(p))).json();
  return { page, dialog: page.getByRole("dialog"), errors, scans, get, close: () => ctx.close() };
}

/** Waits for a screen: its title and its place in the count. */
async function screen(dialog: Any, title: string, count: string | null) {
  await dialog.getByRole("heading", { name: title }).waitFor({ timeout: 60_000 });
  if (count) await dialog.getByText(count, { exact: true }).waitFor();
  else expect(await dialog.getByText(/^\d of 2$/).count()).toBe(0);
}

/** Nothing on a setup screen asks for a key or a password, and nothing reads like a line to paste into a terminal. */
async function plain(dialog: Any) {
  expect(await dialog.locator('input[type="password"]').count()).toBe(0);
  expect(await dialog.getByPlaceholder(/key|password|sk-/i).count()).toBe(0);
  // what is on screen, and what a folded Details holds too
  for (const text of [await dialog.innerText(), await dialog.evaluate((el: Any) => el.textContent)] as string[]) {
    expect(text).not.toMatch(/api key|password/i);
    expect(text).not.toMatch(/(^|\s|>)(\$|npx|npm|curl|brew|sudo|pip) \S/m);
  }
}

/** Leaves "Connect your AI": Continue when an AI is connected, else the one button is Skip for now. */
async function pastAi(dialog: Any) {
  await dialog.getByText(/Looking for your AI/).waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
  const go = dialog.getByRole("button", { name: "Continue", exact: true });
  const skip = dialog.getByRole("button", { name: "Skip for now" });
  expect((await go.count()) + (await skip.count())).toBe(1);
  await ((await skip.count()) ? skip : go).click();
}

describe.skipIf(!enabled)("first-run setup in the browser", () => {
  it("on a phone: no setup, only the way to the computer", async () => {
    const { page, dialog, close } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) => (q === "(pointer: coarse)" ? ({ ...real(q), matches: true } as MediaQueryList) : real(q));
    });
    await page.goto(url("/"));
    await page.getByText("Set up Creator Toolset on your computer first. Then add this phone from there.").waitFor({ timeout: 60_000 });
    expect(await page.getByRole("button", { name: "Share the download link" }).count()).toBe(1);
    expect(await page.getByText("Finish setting up").count()).toBe(0);
    expect(await dialog.count()).toBe(0);
    await shot(page, "phone-home");
    // a link to the last screen opens nothing either, and so does not mark the account as set up
    await page.goto(url("/m?setup=try"));
    await page.getByText("Set up Creator Toolset on your computer first.").waitFor();
    await page.waitForTimeout(1500);
    expect(await dialog.count()).toBe(0);
    expect(saved().done).not.toBe(true);
    await close();
  }, 180_000);

  it("first run: closing early keeps it unfinished, Home reopens where she left, one project is made, Done lands on Home", async () => {
    const { page, dialog, errors, scans, get, close } = await open();
    await page.goto(url("/"));
    // it opens by itself for a new account, on the first of three screens
    await screen(dialog, "Connect your AI", "1 of 2");
    await dialog.getByText(/Looking for your AI/).waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
    await plain(dialog);
    await shot(page, "1-ai");

    // the X: not done, and Home has the way back to the same screen
    await dialog.getByRole("button", { name: "Not now" }).first().click();
    await dialog.waitFor({ state: "hidden" });
    expect(saved().done).not.toBe(true);
    await page.getByRole("button", { name: /Finish setting up/ }).click();
    await screen(dialog, "Connect your AI", "1 of 2");

    // nothing under the AI rows: no box, no link
    expect(await dialog.getByRole("checkbox").count()).toBe(0);

    await pastAi(dialog);
    await screen(dialog, "What do you make?", "2 of 2");
    await dialog.getByRole("checkbox", { name: /Short videos/ }).check();
    await plain(dialog);
    await shot(page, "2-make");

    // Not now in the footer: still not done, and it reopens here
    await dialog.getByRole("button", { name: "Not now" }).last().click();
    await dialog.waitFor({ state: "hidden" });
    expect(saved().done).not.toBe(true);
    await page.getByRole("button", { name: /Finish setting up/ }).click();
    await screen(dialog, "What do you make?", "2 of 2");

    // Back keeps the answer, even after something else was saved on the screen before
    await dialog.getByRole("button", { name: "Back" }).click();
    await screen(dialog, "Connect your AI", "1 of 2");
    await pastAi(dialog);
    await screen(dialog, "What do you make?", "2 of 2");
    expect(await dialog.getByRole("checkbox", { name: /Short videos/ }).isChecked()).toBe(true);

    // Done makes the first project, with no form (named after the one thing picked), ends setup and lands on Home:
    // nothing to do is asked of her
    expect(await get("/api/workshop/projects")).toHaveLength(0);
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(new URL(page.url()).pathname).toBe("/");
    expect((await get("/api/workshop/projects")).map((p: Any) => p.name)).toEqual(["Short videos"]);
    await expect.poll(() => saved().done).toBe(true);
    expect(await page.getByText(/Try it|Drop a video/).count()).toBe(0);
    expect(errors).toEqual([]);
    expect(scans).toEqual([]);
    await close();
  }, 240_000);

  for (const talk of ["app", "chat", "both"] as const) {
    it(`saved way of working "${talk}": the same two screens, then Home`, async () => {
      const { page, dialog, errors, scans, get, close } = await open();
      await page.request.put(url("/api/work-prefs"), { data: { talk } });
      await page.goto(url("/?setup=start"));
      await screen(dialog, "Connect your AI", "1 of 2");
      await pastAi(dialog);
      await screen(dialog, "What do you make?", "2 of 2");
      await plain(dialog);
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(new URL(page.url()).pathname).toBe("/");
      expect(await get("/api/workshop/projects")).toHaveLength(1); // the account has one: none is made
      expect(errors).toEqual([]);
      expect(scans).toEqual([]);
      await close();
    }, 180_000);
  }

  it("old links land on the screen they now belong to", async () => {
    const { page, dialog, close } = await open();
    for (const [id, title, count] of [["done", "What do you make?", "2 of 2"], ["try", "What do you make?", "2 of 2"], ["project", "What do you make?", "2 of 2"], ["ai", "Connect your AI", "1 of 2"]] as const) {
      await page.goto(url(`/?setup=${id}`));
      await screen(dialog, title, count);
    }
    await close();
  }, 120_000);

  it("the screens off the path open alone and close with Done", async () => {
    const { page, dialog, scans, close } = await open();
    // from a link: the join form opens alone
    await page.goto(url("/?setup=connect"));
    await screen(dialog, "Connect your computers", null);
    expect(await dialog.getByRole("button", { name: /^(Back|Continue|Not now)$/ }).count()).toBe(0);
    // a pasted link that is not another server's link is refused on this server before anything is fetched
    await dialog.getByRole("button", { name: "Add another computer" }).click();
    await dialog.getByLabel(/paste the link it shows here/).fill("https://studio.example.com/api/devices");
    await dialog.getByRole("button", { name: "Join" }).click();
    await dialog.getByText("That isn't a sign-in link from another server").waitFor();
    await shot(page, "side-connect-refused");
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "hidden" });

    // the same for the way of working
    await page.goto(url("/?setup=how"));
    await screen(dialog, "How do you work best?", null);
    expect(await dialog.getByRole("radio").count()).toBe(3);
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(scans).toEqual([]);
    await close();
  }, 120_000);

  for (const size of Object.keys(SMALL) as Array<keyof typeof SMALL>) {
    it(`small window (${size}): each screen fits, with a body to use`, async () => {
      const { page, dialog, close } = await open({ viewport: SMALL[size] });
      await page.goto(url("/?setup=agents"));
      const fits = async (name: string) => {
        expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(SMALL[size].height);
        expect((await dialog.locator("header + div").boundingBox())!.height).toBeGreaterThan(200); // never a thin strip
        await shot(page, `small-${size}-${name}`);
      };
      await screen(dialog, "Connect your AI", "1 of 2");
      await fits("1-ai");
      await pastAi(dialog);
      await screen(dialog, "What do you make?", "2 of 2");
      await fits("2-make");
      await close();
    }, 120_000);
  }

  it("after setup: a reload shows Home, with no setup dialog and no card", async () => {
    const { page, dialog, close } = await open({ viewport: { width: 1280, height: 800 } });
    await page.goto(url("/"));
    await page.waitForTimeout(1500);
    expect(await dialog.count()).toBe(0);
    expect(await page.getByText("Finish setting up").count()).toBe(0);
    await close();
  }, 60_000);
});
