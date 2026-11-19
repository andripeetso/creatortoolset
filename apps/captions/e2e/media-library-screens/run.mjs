// On-screen check for the Media Library (PRD §3.1–§3.3, §5.7 S0–S5). Headless, meant for a Linux helper machine, never the Mac:
//   node e2e/media-library-screens/run.mjs <outDir>
// Seeds a scratch DATA_DIR (seed.ts), starts the dev server on it with APP_SECRET set (accounts on: an own-server
// kind), drives the owner and the member through Playwright in light and dark, and writes <outDir>/<screen>-<theme>.png
// plus <outDir>/screens.json: the visible text, every ⓘ tooltip and the disabled controls of each screen.
// Removes the scratch data and stops its own server by pid when done.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? "./shots");
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SCREENS_PORT ?? 43921);
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(process.env.SCREENS_TMP ?? tmpdir(), "ml-screens-"));
const OWNER = { username: "owner", password: "owner-pass-1" };
const MEMBER = { username: "member", password: "member-pass-1" };
const APP_SECRET = "screens-secret-123";

const require = createRequire(path.join(app, "package.json"));
const { chromium } = require("playwright-chromium");

execFileSync("npx", ["vite-node", "e2e/media-library-screens/seed.ts"], { cwd: app, env: { ...process.env, SEED_DATA_DIR: data, APP_SECRET }, stdio: ["ignore", "inherit", "inherit"] });

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
  cwd: app,
  env: { ...process.env, DATA_DIR: data, APP_SECRET },
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
const stopServer = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* already gone */ }
};
process.on("exit", stopServer);

const up = async () => {
  for (let i = 0; i < 120; i++) {
    // the API, not the page: its first request loads the whole server, which takes a while on a cold dev server
    try { if ((await fetch(BASE + "/api/auth/check")).status === 200) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the scratch server did not come up");
};

const results = {};
// The app's own first-run setup and intro would cover the Media Library screens; the Library's setup is not this one.
const SKIP_APP_SETUP = () => {
  try {
    localStorage.setItem("ct-setup-dismissed", "1");
    localStorage.setItem("ct-intro-seen", "1");
  } catch { /* blocked: the screens still draw */ }
};
const shot = async (page, name, theme) => {
  await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), fullPage: true });
};

/** Visible text, every ⓘ tooltip (hover each trigger), and the disabled controls of the current page. */
async function capture(page, name, theme) {
  const text = await page.evaluate(() => document.body.innerText);
  const tips = {};
  const triggers = page.locator('button[aria-label^="About "]');
  const n = await triggers.count();
  for (let i = 0; i < n; i++) {
    const t = triggers.nth(i);
    const label = (await t.getAttribute("aria-label")) ?? "";
    // a label on two rows (Final exports: Folders and Hosted media) keeps both tooltips
    const base = label.replace(/^About /, "");
    const key = base in tips ? `${base} (${i + 1})` : base;
    try {
      await t.hover({ timeout: 3000 });
    } catch {
      tips[key] = "HOVER-FAILED";
      continue;
    }
    await page.waitForTimeout(500);
    const tip = page.locator('[role="tooltip"]').last();
    tips[key] = (await tip.count()) ? (await tip.innerText()).trim() : null;
    await page.keyboard.press("Escape").catch(() => {});
  }
  const disabled = await page.evaluate(() =>
    [...document.querySelectorAll("button[disabled], [role=switch][disabled], input[disabled], [aria-disabled=true]")]
      .map((e) => (e.textContent || e.getAttribute("aria-label") || e.getAttribute("name") || "").trim().slice(0, 80))
      .filter(Boolean),
  );
  if (theme === "light") results[name] = { text, tooltips: tips, disabled };
  else results[name] = { ...results[name], darkText: text, darkTooltips: tips, darkDisabled: disabled };
  await shot(page, name, theme);
}

async function login(ctx, who) {
  const r = await ctx.request.post(BASE + "/api/auth/login", { data: who, timeout: 180_000 });
  if (r.status() !== 200) throw new Error(`login ${who.username} failed: ${r.status()}`);
}

async function go(page, route) {
  await page.goto(BASE + route, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
}

/** Continue through the setup dialog, capturing each step. */
async function setupSteps(page, theme) {
  for (let step = 1; step <= 5; step++) {
    const dialog = page.getByRole("dialog").first();
    if (!(await dialog.count())) break;
    await capture(page, `S-setup-step${step}`, theme);
    const next = dialog.getByRole("button", { name: /^(Continue|Done)$/ });
    if (!(await next.count())) break;
    if (await next.first().isDisabled()) break;
    const label = (await next.first().innerText()).trim();
    await next.first().click();
    await page.waitForTimeout(600);
    if (label === "Done") break;
  }
}

try {
  await up();
  const browser = await chromium.launch();
  for (const theme of ["light", "dark"]) {
    // Owner: the setup dialog opens itself on the fresh library; then the owner page and the empty Library.
    const owner = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 } });
    await login(owner, OWNER);
    const op = await owner.newPage();
    await op.addInitScript(SKIP_APP_SETUP);
    await go(op, "/library");
    await setupSteps(op, theme);
    await go(op, "/settings/library");
    await capture(op, "S1-owner-media-library", theme);
    await go(op, "/library");
    await capture(op, "S3-library", theme);
    await owner.close();

    // Member: its own page (no setup, no owner sections).
    const member = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 } });
    await login(member, MEMBER);
    const mp = await member.newPage();
    await mp.addInitScript(SKIP_APP_SETUP);
    await go(mp, "/settings/library");
    await capture(mp, "S2-member-media-library", theme);
    await member.close();
  }
  await browser.close();
  writeFileSync(path.join(out, "screens.json"), JSON.stringify(results, null, 1));
  console.log(JSON.stringify({ out, screens: Object.keys(results) }));
} finally {
  stopServer();
  rmSync(data, { recursive: true, force: true });
}
