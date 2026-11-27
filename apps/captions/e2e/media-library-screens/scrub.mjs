// Hover-scrub check, headless, for a Linux helper machine (never the Mac):
//   node e2e/media-library-screens/scrub.mjs <outDir>
// Seeds seed.ts + scrub-seed.ts, starts the dev server, and in light and dark shoots the Gallery mid-scrub on an upright
// and a landscape clip, then an old 16:9 strip on an upright clip before and after the computer hands in its new strip
// (PUT /api/library/:id/versions/:v/sprite, as onMac.ts repairStrips does). Stops its own server by pid.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_WINDOW } from "./app-window.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? "./shots");
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SCREENS_PORT ?? 43931);
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(process.env.SCREENS_TMP ?? tmpdir(), "ml-scrub-"));
const APP_SECRET = "screens-secret-123";
const OWNER = { username: "owner", password: "owner-pass-1" };
const { chromium } = createRequire(path.join(app, "package.json"))("playwright-chromium");

for (const seed of ["seed.ts", "scrub-seed.ts"])
  execFileSync("npx", ["vite-node", `e2e/media-library-screens/${seed}`], { cwd: app, env: { ...process.env, SEED_DATA_DIR: data, APP_SECRET }, stdio: ["ignore", "ignore", "inherit"] });

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: app, env: { ...process.env, DATA_DIR: data, APP_SECRET }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
};
process.on("exit", stop);

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + "/api/auth/check")).status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const browser = await chromium.launch();
  const newStrip = readFileSync(path.join(data, "new-strip.jpg")).toString("base64");
  const pass = async (theme, shots) => {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 }, userAgent: APP_WINDOW });
    const login = await ctx.request.post(BASE + "/api/auth/login", { data: OWNER, timeout: 180_000 });
    if (login.status() !== 200) throw new Error(`login failed: ${login.status()}`);
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      try { localStorage.setItem("ct-setup-dismissed", "1"); localStorage.setItem("ct-intro-seen", "1"); localStorage.setItem("library:view", "gallery"); } catch { /* still draws */ }
    });
    await page.goto(BASE + "/library", { waitUntil: "load", timeout: 300_000 });
    const pick = page.locator("select").first();
    await pick.waitFor({ timeout: 300_000 });
    await pick.selectOption({ label: "Tiny Acrobatics library" });
    await page.locator("button[data-state]", { hasText: "Scrub upright" }).first().waitFor({ timeout: 120_000 });
    await page.waitForTimeout(1500); // the strips load as their cards come near the screen
    if (process.env.SCRUB_DEBUG) await page.screenshot({ path: path.join(out, `debug-${theme}.png`) });
    for (const [title, name] of shots) {
      const card = page.locator("button[data-state]", { hasText: title }).first();
      const box = await card.boundingBox();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width * 0.42, box.y + box.height / 2, { steps: 4 });
      await page.waitForTimeout(400);
      const style = await card.locator("[data-scrub]").getAttribute("style").catch(() => null);
      console.log(`${name}-${theme}: ${style ? "scrubbing" : "NO SCRUB"} ${style ?? ""}`);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(200);
    }
    await ctx.close();
  };
  for (const theme of ["light", "dark"]) await pass(theme, [["Scrub upright", "scrub-upright"], ["Scrub landscape", "scrub-landscape"], ["Old strip upright", "strip-old-before"]]);
  // the computer that has the old clip hands in its strip, as onMac.ts repairStrips does
  const owner = await (await browser.newContext({ userAgent: APP_WINDOW })).request;
  await owner.post(BASE + "/api/auth/login", { data: OWNER });
  console.log(`PUT sprite: ${(await owner.put(BASE + "/api/library/lib_ready/versions/ver_old/sprite", { data: { sprite: newStrip } })).status()}`);
  for (const theme of ["light", "dark"]) await pass(theme, [["Old strip upright", "strip-old-after"]]);
  await browser.close();
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
