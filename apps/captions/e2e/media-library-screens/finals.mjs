// Finals, headless, for a Linux helper machine (never the Mac):
//   node e2e/media-library-screens/finals.mjs <outDir>
// Seeds seed.ts + finals-seed.ts, starts the dev server, makes a carousel and a reel in Finals through the app's routes,
// and writes, in dark: the list, a piece's right-click menu, the carousel window (first and third slide), a slide's
// menu, the window after Mark as posted and after Replace file, and a piece's Type set by hand. Stops its own server by pid.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_WINDOW } from "./app-window.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? "./shots");
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SCREENS_PORT ?? 43951);
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(process.env.SCREENS_TMP ?? tmpdir(), "ml-finals-"));
const APP_SECRET = "screens-secret-123";
const OWNER = { username: "owner", password: "owner-pass-1" };
const { chromium } = createRequire(path.join(app, "package.json"))("playwright-chromium");

for (const seed of ["seed.ts", "finals-seed.ts"])
  execFileSync("npx", ["vite-node", `e2e/media-library-screens/${seed}`], { cwd: app, env: { ...process.env, SEED_DATA_DIR: data, APP_SECRET }, stdio: ["ignore", "ignore", "inherit"] });

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: app, env: { ...process.env, DATA_DIR: data, APP_SECRET }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
};
process.on("exit", stop);
const shot = (page, name) => page.screenshot({ path: path.join(out, `finals-${name}.png`) });

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + "/api/auth/check")).status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, userAgent: APP_WINDOW });
  const login = await ctx.request.post(BASE + "/api/auth/login", { data: OWNER, timeout: 180_000 });
  if (login.status() !== 200) throw new Error(`login failed: ${login.status()}`);
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    try { localStorage.setItem("ct-setup-dismissed", "1"); localStorage.setItem("ct-intro-seen", "1"); } catch { /* still draws */ }
  });
  await page.goto(BASE + "/", { waitUntil: "load", timeout: 300_000 });
  // the pieces, through the app's own routes
  const ids = await page.evaluate(async () => {
    const call = async (method, url, body) => {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
      if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const lib = "/api/library/lib_ready";
    const finals = await call("POST", `${lib}/collections`, { name: "Finals" });
    const make = async (label, versions) => {
      const p = await call("POST", `${lib}/pieces`, { label, collectionId: finals.id });
      for (const versionId of versions) await call("POST", `${lib}/pieces/${p.id}/items`, { versionId });
      return p.id;
    };
    const reel = await make("TinyReel", ["ver_clip1", "ver_clip2"]);
    const carousel = await make("TinyCarousel", ["ver_slide1", "ver_slide2", "ver_slide3", "ver_slide4"]);
    return { reel, carousel };
  });

  await page.goto(BASE + "/finals", { waitUntil: "load" });
  const card = page.locator(`a[href="/finals/${ids.carousel}"]`).first();
  await card.waitFor({ timeout: 120_000 });
  await page.waitForTimeout(1500);
  await shot(page, "1-list");

  await card.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Merge piece" }).hover();
  await page.waitForTimeout(700);
  await shot(page, "2-menu");
  console.log("menu:", JSON.stringify(await page.locator('[role="menuitem"]').allTextContents()));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await card.click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('[aria-label="Slides"] img').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1200);
  await shot(page, "3-carousel");
  await dialog.getByRole("button", { name: "Next slide" }).click();
  await page.waitForTimeout(700);
  await dialog.getByRole("button", { name: "Next slide" }).click();
  await page.waitForTimeout(1200);
  await shot(page, "4-carousel-slide3");
  console.log("count:", await dialog.locator("text=/\\d \\/ 4/").first().textContent());

  await dialog.getByRole("button", { name: /menu$/ }).nth(1).click(); // the first slide row's menu (the piece's own is first)
  await page.waitForTimeout(600);
  await shot(page, "5-slide-menu");
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: "Replace file" }).click();
  await (await chooser).setFiles(path.join(data, "slide4.jpg"));
  await page.waitForTimeout(4000);
  console.log("after replace:", JSON.stringify(await page.evaluate(async (id) => (await (await fetch(`/api/library/lib_ready/pieces/${id}`)).json()).items.map((i) => i.versionId), ids.carousel)));
  await shot(page, "6-replaced");

  await dialog.getByRole("button", { name: "Mark as posted" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "7-posted");
  console.log("header:", await dialog.locator("header p").first().textContent());

  // the reel set to Other by hand, from its right-click menu's Type
  await page.goto(BASE + "/finals", { waitUntil: "load" });
  const reel = page.locator(`a[href="/finals/${ids.reel}"]`).first();
  await reel.waitFor({ timeout: 60_000 });
  await reel.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Type" }).hover();
  await page.waitForTimeout(700);
  await shot(page, "8-type-menu");
  await page.getByRole("menuitemradio", { name: "Other" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "9-typed");
  console.log("reel's badge:", await reel.locator("span").first().textContent());
  await browser.close();
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
