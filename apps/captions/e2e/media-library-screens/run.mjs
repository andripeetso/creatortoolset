// On-screen check for the Media Library (PRD §3.1–§3.3, §5.7 S0–S5). Headless, meant for a Linux helper machine, never the Mac:
//   node e2e/media-library-screens/run.mjs <outDir>
// Seeds a scratch DATA_DIR (seed.ts), starts the dev server on it with APP_SECRET set (accounts on: an own-server
// kind), drives the owner and the member through Playwright in light and dark, and writes <outDir>/<screen>-<theme>.png
// plus <outDir>/screens.json: the visible text, every ⓘ tooltip and the disabled controls of each screen.
// Removes the scratch data and stops its own server by pid when done. The 11-19 sign-off screens (B2…D1 of the design
// page) are named by their letter: B2-folded, B2-unrolled, B3, B5, B6, B7, B8, C1, C2, C4-closed, C4-open, D1, D1-unrolled;
// the list's columns and the From/To days: L1-list, L1-list-sorted, S-dates-empty, S-dates-set.
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

const seeded = JSON.parse(
  execFileSync("npx", ["vite-node", "e2e/media-library-screens/seed.ts"], { cwd: app, env: { ...process.env, SEED_DATA_DIR: data, APP_SECRET }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop(),
);

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
/** The member's current workspace: the shared one, through the workspace switch the app's own picker uses. */
async function switchMember(ctx, id) {
  const r = await ctx.request.patch(BASE + "/api/workshop/workspace", { data: { currentProjectId: id }, timeout: 180_000 });
  if (r.status() !== 200) throw new Error(`switch the member's workspace failed: ${r.status()} ${await r.text()}`);
}

const shot = async (page, name, theme) => {
  await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), fullPage: true });
};

/** Visible text, every ⓘ tooltip (hover each trigger), and the disabled controls of the current page. */
async function capture(page, name, theme, focus) {
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
  // hovering the ⓘ scrolled the page's own scroll areas: back to the top (or to `focus`), the pointer off them
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.querySelectorAll("*").forEach((e) => e.scrollTop && (e.scrollTop = 0)));
  if (focus) await focus.evaluate((e) => e.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  if (theme === "light") results[name] = { text, tooltips: tips, disabled };
  else results[name] = { ...results[name], darkText: text, darkTooltips: tips, darkDisabled: disabled };
  await shot(page, name, theme);
}

async function login(ctx, who) {
  const r = await ctx.request.post(BASE + "/api/auth/login", { data: who, timeout: 180_000 });
  if (r.status() !== 200) throw new Error(`login ${who.username} failed: ${r.status()}`);
}

async function go(page, route) {
  await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForTimeout(800);
}

/** 11-19 ruling: folded and unrolled both fit the 608 px setup at an 860 px window, Copy fully shown, no inner scroll. */
const fits = {};
async function fitCheck(page, name) {
  const r = await setupOf(page).evaluate((d) => {
    const body = d.querySelector(".overflow-y-auto");
    const text = [...d.querySelectorAll("*")].find((e) => !e.children.length && e.textContent.trim() === "Copy into Source media");
    const option = text?.closest("label, button, [role=radio]") ?? text?.parentElement;
    const foot = body?.nextElementSibling?.getBoundingClientRect().top ?? Infinity;
    return { scrolls: !!body && body.scrollHeight > body.clientHeight + 1, over: body ? body.scrollHeight - body.clientHeight : 0, copyShown: !!option && option.getBoundingClientRect().bottom <= foot };
  });
  fits[name] = r;
  console.log(`fit ${name}: ${!r.scrolls && r.copyShown ? "ok" : `NO (scrolls ${r.scrolls} by ${r.over} px, Copy shown ${r.copyShown})`}`);
}

/** The setup: the Library page itself until it is set up, a sheet when opened again. */
const setupOf = (page) => page.locator(`[role="dialog"], section[aria-label="Let's set up the Media Library"]`).first();

/** Continue through the setup, capturing each step. */
async function setupSteps(page, theme) {
  for (let step = 1; step <= 5; step++) {
    const dialog = setupOf(page);
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
  // The setup as the Mac app shows it (its folder rows, picked in the app's folder window), in both themes before any Done:
  // a page that says it is in the Mac app, walked to the last step and left there.
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 } });
    await login(ctx, OWNER);
    const asMac = await ctx.newPage();
    await asMac.addInitScript(SKIP_APP_SETUP);
    // set on the parsed <html> (an init script runs before it exists), before the app's scripts run
    await asMac.addInitScript(() => new MutationObserver(() => document.documentElement?.setAttribute("data-mac-this-mac", "1")).observe(document, { childList: true, subtree: true }));
    await go(asMac, "/library");
    const sheet = setupOf(asMac);
    const press = async (name) => {
      await sheet.getByRole("button", { name, exact: true }).first().click();
      await asMac.waitForTimeout(500); // the unroll's 260 ms, and a step's change
    };
    await press("Continue");
    await capture(asMac, "B2-folded", theme);
    await fitCheck(asMac, `B2-folded-${theme}`);
    await press("Choose each folder");
    await capture(asMac, "B2-unrolled", theme);
    await fitCheck(asMac, `B2-unrolled-${theme}`);
    await press("Choose each folder");
    // the Mac app's folder window stubbed, only now (set from the start it takes the page down the Mac app's other paths):
    // it answers a Library folder with FOOTAGE and EXPORTS in it, Moo's layout
    await asMac.evaluate(() => {
      window.webkit = { messageHandlers: { thisMac: { postMessage: async (ask) => (ask === "folder" ? { path: "/Volumes/Tiny/MOO CLASSIC", children: ["EXPORTS", "FOOTAGE"], siblings: [] } : {}) } } };
    });
    await press("Change…");
    await capture(asMac, "B3", theme);
    await fitCheck(asMac, `B3-${theme}`);
    await press("Continue");
    await capture(asMac, "B6", theme);
    await press("Continue");
    await capture(asMac, "B7", theme);
    await press("Continue");
    await capture(asMac, "B8", theme);
    for (let i = 0; i < 4; i++) await press("Back");
    await sheet.getByRole("radio", { name: /Use my existing folders/ }).click();
    await press("Continue");
    await capture(asMac, "B5", theme);
    await ctx.close();
  }
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
    // Models rows (Rulings 11-19): each row's value button opens its options as a radio list
    for (const row of ["Descriptions", "Transcripts", "Video breakdown"]) {
      const btn = op.getByRole("button", { name: row, exact: true });
      if (!(await btn.count())) continue;
      await btn.first().scrollIntoViewIfNeeded();
      await btn.first().click();
      await op.waitForTimeout(400);
      await capture(op, `S1-models-${row.toLowerCase().replace(/ /g, "-")}-open`, theme);
      await btn.first().click();
    }
    // D1: the three in one Library folder on the owner's Mac (seed.ts), folded and unrolled
    await go(op, "/settings/library");
    // Effort on the owner page: the setup's six stops (11-19 ruling 3)
    await capture(op, "D-effort", theme, op.getByRole("radiogroup", { name: "Effort" }).first());
    const folders = op.getByRole("button", { name: "Choose each folder" }).first();
    await capture(op, "D1", theme, folders);
    await folders.click();
    await op.waitForTimeout(500);
    await capture(op, "D1-unrolled", theme, folders);
    await go(op, "/library");
    await capture(op, "S3-library", theme);
    if (await op.getByText("Drop media here").count()) await capture(op, "C1", theme);
    // the Library's ⋯ menu carries Redo (Rulings 11-19)
    const more = op.getByRole("button", { name: /^More/ });
    if (await more.count()) {
      await more.first().click();
      await op.waitForTimeout(400);
      await capture(op, "S3-library-more-menu", theme);
      await op.keyboard.press("Escape");
    }
    // C4 and C2 on the library with clips: Sort by closed and open; then a file on its way (its upload held, so it stays)
    await op.getByRole("combobox", { name: "Library" }).selectOption({ label: "Tiny Acrobatics library" }).catch(() => {});
    await op.waitForTimeout(1500);
    await capture(op, "C4-closed", theme);
    const sortBy = op.locator('button[aria-label^="Sort by"]').first();
    if (await sortBy.count()) {
      await sortBy.click();
      await op.waitForTimeout(400);
      await capture(op, "C4-open", theme);
      await op.keyboard.press("Escape");
    }
    // The list view's columns (11-19): as it opens, then sorted by a header (Name); the From/To days empty, then one set
    await op.locator('button[title^="View:"]').click();
    await op.getByRole("button", { name: "List", exact: true }).click();
    await op.keyboard.press("Escape");
    await op.waitForTimeout(800);
    await capture(op, "L1-list", theme);
    await op.getByRole("button", { name: "Sort by Name", exact: true }).last().click();
    await op.waitForTimeout(800);
    await capture(op, "L1-list-sorted", theme);
    const fromDay = op.locator('input[aria-label="From date"]').first();
    if (await fromDay.count()) {
      await capture(op, "S-dates-empty", theme, fromDay);
      await fromDay.fill("2026-01-01");
      await op.waitForTimeout(800);
      await capture(op, "S-dates-set", theme, fromDay);
      await op.getByRole("button", { name: "Clear From date" }).click();
      await op.waitForTimeout(500);
    }
    // C2 in the Gallery (tall clips, a cell each): seven files dropped beside the three portrait clips. Their sends are
    // held (never answered), so four are on their way and two wait for a turn; the first is refused, so it failed. The
    // cards' row holds both the drop's cards and the clips
    await op.locator('button[title^="View:"]').click();
    await op.getByRole("button", { name: "Gallery", exact: true }).click();
    await op.keyboard.press("Escape");
    await op.waitForTimeout(800);
    // the sends answered here, never by the server: the first file is refused (failed); the others start in 1 MB parts,
    // the first part of each taken, the rest held (never answered), so their bars stand part done
    await op.route("**/api/library/*/uploads", async (route) => {
      const name = String(route.request().postDataJSON?.()?.filename ?? "");
      if (name.includes("01")) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The share went away" }) });
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ id: `held-${name.replace(/\W/g, "")}`, offset: 0, chunkSize: 1 << 20 }) });
    });
    await op.route("**/api/library/uploads/held-*", (route) => {
      if (route.request().method() === "PATCH" && route.request().headers()["upload-offset"] === "0") return route.fulfill({ status: 204, headers: { "upload-offset": String(1 << 20) } });
    });
    const input = op.locator('input[type="file"]').first();
    if (await input.count()) {
      await input.setInputFiles(Array.from({ length: 7 }, (_, i) => ({ name: `Tiny Acrobatics drop 0${i + 1}.mp4`, mimeType: "video/mp4", buffer: Buffer.alloc(3 * 1024 * 1024, i) })));
      await op.waitForTimeout(2500);
      await capture(op, "C2", theme);
    }
    await owner.close();

    // Member: its own page (no setup, no owner sections).
    const member = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 } });
    await login(member, MEMBER);
    await switchMember(member, seeded.shared);
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
