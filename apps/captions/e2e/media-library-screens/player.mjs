// The library viewer's player, headless, for a Linux helper machine (never the Mac):
//   node e2e/media-library-screens/player.mjs <outDir>
// Seeds seed.ts + player-seed.ts, starts the dev server, and in light and dark opens a landscape and an upright clip:
// playing with its bar, a preview frame over the bar on hover, the gear menu and its speed list; logs a seek after play
// and whether the preview frame came from the clip's strip. Stops its own server by pid.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? "./shots");
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SCREENS_PORT ?? 43941);
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(process.env.SCREENS_TMP ?? tmpdir(), "ml-player-"));
const APP_SECRET = "screens-secret-123";
const OWNER = { username: "owner", password: "owner-pass-1" };
const { chromium } = createRequire(path.join(app, "package.json"))("playwright-chromium");

for (const seed of ["seed.ts", "player-seed.ts"])
  execFileSync("npx", ["vite-node", `e2e/media-library-screens/${seed}`], { cwd: app, env: { ...process.env, SEED_DATA_DIR: data, APP_SECRET }, stdio: ["ignore", "ignore", "inherit"] });

// SCREENS_BOOT=1: the built bundle (npm run build first), which a loaded machine serves far faster than the dev server
const server = process.env.SCREENS_BOOT
  ? spawn("node", ["dist/boot.js"], { cwd: app, env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), PACK_CATALOG_URL: "", DATA_DIR: data, APP_SECRET }, detached: true, stdio: ["ignore", "ignore", "ignore"] })
  : spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: app, env: { ...process.env, DATA_DIR: data, APP_SECRET }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
};
process.on("exit", stop);

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + "/api/auth/check")).status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 } });
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
    for (const [title, name] of [["Player landscape", "landscape"], ["Player upright", "upright"]]) {
      await page.locator("button[data-state]", { hasText: title }).first().click();
      const video = page.locator(".video-skin video").first();
      await video.waitFor({ timeout: 120_000 });
      await page.waitForFunction(() => { const v = document.querySelector(".video-skin video"); return v && v.readyState >= 3 && v.currentTime > 0.5; }, null, { timeout: 60_000 }).catch(() => {});
      const skin = page.locator(".video-skin").first();
      const box = await skin.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(out, `player-${name}-${theme}.png`) });
      if (name === "landscape") {
        // a seek after play: it should land and keep playing
        const seek = await page.evaluate(async () => {
          const v = document.querySelector(".video-skin video");
          v.currentTime = 12;
          await new Promise((r) => setTimeout(r, 1500));
          const a = v.currentTime;
          await new Promise((r) => setTimeout(r, 1000));
          return { readyState: v.readyState, at: a, later: v.currentTime, paused: v.paused };
        });
        console.log(`seek-${theme}: ${JSON.stringify(seek)} ${seek.later > seek.at && seek.readyState >= 3 ? "ok" : "STALLED"}`);
        const labels = await skin.locator("button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") || b.textContent?.trim()).filter(Boolean));
        console.log(`buttons-${theme}: ${JSON.stringify(labels)}`);
        // hover the time bar at 40%: the skin's preview frame
        const slider = skin.locator('[role="slider"]').first();
        const sb = await slider.boundingBox();
        await page.mouse.move(sb.x + sb.width * 0.2, sb.y + sb.height / 2);
        await page.mouse.move(sb.x + sb.width * 0.4, sb.y + sb.height / 2, { steps: 5 });
        await page.waitForTimeout(700);
        const thumb = await skin.evaluate((s) => [...s.querySelectorAll("img")].map((i) => ({ src: i.getAttribute("src"), w: i.getBoundingClientRect().width, style: i.getAttribute("style") })).filter((i) => i.src?.includes("sprite")));
        console.log(`preview-${theme}: ${thumb.length ? "ok " + JSON.stringify(thumb[0]) : "NO PREVIEW"}`);
        await page.screenshot({ path: path.join(out, `player-hover-${theme}.png`) });
        // the gear menu, then its speed list (DOM clicks: two pointer clicks on the skin read as a double tap, full screen)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3); // off the bar: its preview goes, the bar stays
        await page.waitForTimeout(300);
        await skin.getByRole("button", { name: "Settings" }).first().evaluate((b) => b.click());
        await page.waitForTimeout(1500); // the menu's own entry animation
        await page.screenshot({ path: path.join(out, `player-menu-${theme}.png`) });
        const items = await page.locator('[role="menuitem"], [role="menuitemradio"]').evaluateAll((xs) => xs.filter((x) => x.getBoundingClientRect().width).map((x) => x.textContent?.trim()));
        console.log(`menu-${theme}: ${JSON.stringify(items)}`);
        await page.locator('[role="menuitem"]', { hasText: /speed/i }).first().evaluate((x) => x.click());
        await page.waitForTimeout(1500);
        console.log(`speeds-${theme}: ${JSON.stringify(await page.locator('[role="menuitemradio"]').evaluateAll((xs) => xs.filter((x) => x.getBoundingClientRect().width).map((x) => x.textContent?.trim())))}`);
        await page.screenshot({ path: path.join(out, `player-speed-${theme}.png`) });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      }
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
