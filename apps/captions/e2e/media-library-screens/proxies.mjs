// The blurred copies and proxies screens, clicked through (docs/media-library-proxies-prd.md R12 and L10). Headless, for a
// Linux helper machine, never the Mac:
//   node e2e/media-library-screens/proxies.mjs <outDir>
// Seeds seed.ts + proxies-seed.ts, compiles the Face Blur plug-in in (CT_PLUGINS=blur-faces: it rewrites the generated
// plug-in registries, which the next `pnpm dev` writes again), starts the dev server and, in light and dark, in the
// Library's settings drawer and in Settings → Media Library, walks: the Proxy workflow card under each switch, the Hosted
// media rows, What's made → Blurred copies and Proxies, the question Blur faces asks, a clip's panel and menu, a held
// clip's card, the setup's two steps, and Make → Queueing at a narrow and a wide window. Writes <outDir>/<step>.png and
// <outDir>/proxies.json: each thing looked at, whether it was as expected, and what the screen said. Exits 1 when one
// was not. Stops its own server by pid and removes its scratch data.
//   SCREENS_CHROMIUM=/usr/bin/chromium  the browser to drive (none: Playwright's own)
//   SCREENS_BROWSER=webkit              WebKit in place of Chromium
//   SCREENS_ONLY=8                      one check only (1 to 8; 1, 2 and 4 are one walk)
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_WINDOW } from "./app-window.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? "./shots");
mkdirSync(out, { recursive: true });
const PORT = Number(process.env.SCREENS_PORT ?? 43961);
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(process.env.SCREENS_TMP ?? tmpdir(), "ml-proxies-"));
const APP_SECRET = "screens-secret-123";
const OWNER = { username: "owner", password: "owner-pass-1" };
const ONLY = process.env.SCREENS_ONLY ? Number(process.env.SCREENS_ONLY) : 0;
const runs = (...checks) => !ONLY || checks.includes(ONLY);
const pw = createRequire(path.join(app, "package.json"));
// WebKit, the engine of the Mac app's window, is in playwright-chromium's own playwright-core (its browser: `npx playwright install webkit`)
const engine = process.env.SCREENS_BROWSER === "webkit" ? createRequire(pw.resolve("playwright-chromium"))("playwright-core").webkit : pw("playwright-chromium").chromium;

const seed = (file, env = {}) =>
  execFileSync("npx", ["vite-node", `e2e/media-library-screens/${file}`], { cwd: app, env: { ...process.env, SEED_DATA_DIR: data, APP_SECRET, ...env }, stdio: ["ignore", "ignore", "inherit"] });
/** What changed the libraries, in order (a reset, each save a page sent): said when a library does not open as it was reset. */
const written = [];
/** Every library as it started, `first` the one the page and Settings → Media Library open on; `setup`: the Fresh library not set up. */
const reset = (first, setup = false) => {
  seed("proxies-seed.ts", { PROXIES_FIRST: first, ...(setup ? { PROXIES_SETUP: "1" } : {}) });
  written.push(`reset, ${first} first`);
};
seed("seed.ts");
reset("lib_ready");
execFileSync("node", ["scripts/plugins.mjs"], { cwd: app, env: { ...process.env, CT_PLUGINS: "blur-faces" }, stdio: "ignore" });

const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: app, env: { ...process.env, DATA_DIR: data, APP_SECRET, CT_PLUGINS: "blur-faces" }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
const stop = () => {
  try { process.kill(-server.pid, "SIGTERM"); } catch { /* gone */ }
};
process.on("exit", stop);

const LIB = {
  ready: { id: "lib_ready", name: "Tiny Acrobatics library" },
  answered: { id: "lib_answered", name: "Answered library" },
  blur: { id: "lib_blur", name: "Blurring library" },
  held: { id: "lib_held", name: "Phone library" },
};
const HOSTED = "Hosted media";
const BLUR = "Blur faces";
const GEN = "Generate proxies";
const UPLOAD = "Upload to server";
const ASK = "Blur the files already in the library?";

const seen = [];
const problems = [];
/** One thing looked at: the check (1 to 8, 0 a note), where, whether it was as expected, and what the screen said. */
const see = (check, where, ok, saw) => {
  seen.push({ check, where, ok, saw });
  console.log(`${ok ? "ok" : "NO"}  ${check} [${where}] ${saw}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lines = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).split("\n").map((s) => s.trim()).filter(Boolean) : []);
const section = (root, title) => root.locator(`section:has(h2:text-is("${title}"))`);
/** A section's rows, without its heading. */
const rows = async (root, title) => (await lines(section(root, title))).slice(1);
const sw = (root, name) => root.getByRole("switch", { name, exact: true });
const isOn = async (root, name) => (await sw(root, name).first().getAttribute("aria-checked")) === "true";
/** A What's made row, found by its New files switch. */
const made = (root, label) => sw(root, `${label} for new files`).locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " py-3 ")][1]');

async function go(page, route) {
  await page.goto(BASE + route, { waitUntil: "networkidle", timeout: 180_000 });
  await page.waitForTimeout(800);
}

try {
  for (let i = 0; i < 180; i++) {
    try { if ((await fetch(BASE + "/api/auth/check")).status === 200) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const browser = await engine.launch(process.env.SCREENS_CHROMIUM ? { executablePath: process.env.SCREENS_CHROMIUM } : {});
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 860 }, userAgent: APP_WINDOW });
    const login = await ctx.request.post(BASE + "/api/auth/login", { data: OWNER, timeout: 180_000 });
    if (login.status() !== 200) throw new Error(`login failed: ${login.status()}`);
    const page = await ctx.newPage();
    page.setDefaultTimeout(15_000);
    await page.addInitScript(() => {
      try { localStorage.setItem("ct-setup-dismissed", "1"); localStorage.setItem("ct-intro-seen", "1"); localStorage.setItem("library:view", "gallery"); } catch { /* still draws */ }
    });
    let at = "start";
    // not the dev server's own warning (its inspectAttr plug-in puts a code-path prop on fragments), and a refused
    // request is said once, by its address
    page.on("console", (m) => m.type() === "error" && !/code-path|Failed to load resource/.test(m.text()) && problems.push({ theme, at, error: m.text().slice(0, 300) }));
    page.on("response", (r) => r.status() >= 400 && problems.push({ theme, at, error: `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}` }));
    page.on("request", (r) => r.method() === "PATCH" && /\/api\/library\/[^/]+$/.test(new URL(r.url()).pathname) && written.push(`${theme} ${new URL(r.url()).pathname.split("/").pop()} ${(r.postData() ?? "").slice(0, 160)}`));
    page.on("pageerror", (e) => problems.push({ theme, at, error: `page error: ${e.message.slice(0, 300)}` }));

    /** A picture of the window as it is, `focus` scrolled to its middle. */
    const shot = async (name, focus) => {
      if (focus && (await focus.count())) await focus.first().evaluate((e) => e.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, `${name}-${theme}.png`) });
    };
    const flip = async (root, name) => {
      await sw(root, name).first().click();
      await page.waitForTimeout(1000);
    };
    const pickLibrary = async (lib) => {
      await go(page, "/library");
      await page.getByRole("combobox", { name: "Library" }).selectOption({ label: lib.name });
      await page.waitForTimeout(1500);
    };
    /**
     * A library's settings as it started, in `place`: the Library page's drawer, or Settings → Media Library (which shows
     * the library that sorts first). Answers what the sections are in.
     */
    const openSettings = async (place, lib) => {
      reset(lib.id);
      at = `${lib.name}, ${place}`;
      if (place === "settings") {
        await go(page, "/settings/library");
        return page.locator("body");
      }
      await pickLibrary(lib);
      await page.getByRole("button", { name: /^More/ }).first().click();
      await page.getByRole("menuitem", { name: "Library settings" }).click();
      const drawer = page.getByRole("dialog", { name: "Library settings" });
      await drawer.waitFor();
      await page.waitForTimeout(1200);
      return drawer;
    };
    const asking = () => page.getByRole("alertdialog");
    const turn = async (root, name, on) => {
      if ((await isOn(root, name)) !== on) await flip(root, name);
    };
    /** One walk: when it stops (a control that is not there), that is one failed look with its picture, and the next walk goes on. */
    const walk = async (check, where, steps) => {
      try {
        await steps();
      } catch (e) {
        await page.screenshot({ path: path.join(out, `stopped-${check}-${where.replace(/\W+/g, "-")}-${theme}.png`) }).catch(() => {});
        see(check, where, false, `stopped: ${String(e.message).split("\n").slice(0, 3).join(" ").slice(0, 400)}`);
      }
    };

    // 7: setup of a new library. The proxy step asks, unticked; Hosted media has no Proxies row until it is ticked
    if (runs(7)) await walk(7, `${theme} setup`, async () => {
      const where = `${theme} setup`;
      reset("lib_fresh", true);
      at = "setup";
      await go(page, "/library");
      const setup = page.locator(`[role="dialog"], section[aria-label="Let's set up the Media Library"]`).first();
      const to = async (found, button) => {
        for (let i = 0; i < 6 && !(await found()); i++) {
          const b = setup.getByRole("button", { name: button, exact: true }).first();
          if (!(await b.count()) || (await b.isDisabled())) return false;
          await b.click();
          await page.waitForTimeout(600);
        }
        return found();
      };
      const box = setup.getByRole("checkbox", { name: GEN, exact: true });
      const onProxy = async () => (await box.count()) > 0;
      const onHosted = async () => (await sw(setup, UPLOAD).count()) > 0;
      if (!(await to(onProxy, "Continue"))) see(7, where, false, `the Proxy workflow step was not reached: ${(await lines(setup)).join(" | ").slice(0, 300)}`);
      else {
        const text = await lines(setup);
        const ticked = (await box.getAttribute("aria-checked")) === "true";
        await shot(`7-setup-proxy-step`);
        see(7, where, text.includes("Make proxies?") && !ticked && !text.includes("Proxy quality"), `lead ${text.includes("Make proxies?") ? '"Make proxies?"' : "MISSING"}, ${GEN} ${ticked ? "TICKED" : "unticked"}, Proxy quality ${text.includes("Proxy quality") ? "SHOWN" : "not shown"}`);
        if (await to(onHosted, "Continue")) {
          if (!(await isOn(setup, UPLOAD))) await flip(setup, UPLOAD);
          const names = async () => (await lines(setup)).filter((l) => ["Final exports", "Proxies", "Originals", "Blurred"].includes(l));
          const before = await names();
          await shot(`7-setup-hosted-unticked`);
          see(7, where, same(before, ["Final exports", "Originals"]), `Hosted media with ${GEN} unticked: ${before.join(", ")}`);
          await to(onProxy, "Back");
          await box.click();
          await page.waitForTimeout(400);
          const quality = (await lines(setup)).includes("Proxy quality");
          await shot(`7-setup-proxy-ticked`);
          await to(onHosted, "Continue");
          const after = await names();
          await shot(`7-setup-hosted-ticked`);
          see(7, where, quality && same(after, ["Final exports", "Proxies", "Originals"]), `ticked: Proxy quality ${quality ? "shown" : "NOT shown"}; Hosted media: ${after.join(", ")}`);
          if (await sw(setup, BLUR).count()) {
            await flip(setup, BLUR);
            const blurred = await names();
            await shot(`7-setup-hosted-blur`);
            see(7, where, same(blurred, ["Final exports", "Blurred", "Proxies"]), `with ${BLUR} on in setup: ${blurred.join(", ")}`);
          } else see(0, where, true, `setup's Hosted media step has no ${BLUR} switch`);
        } else see(7, where, false, "the Hosted media step was not reached");
      }
    });

    for (const place of ["drawer", "settings"]) {
      const where = `${theme} ${place}`;
      const state = async (root) => ({ blur: await isOn(root, BLUR), gen: await isOn(root, GEN), quality: (await rows(root, "Proxy workflow")).includes("Proxy quality"), from: (await rows(root, "Proxy workflow")).includes("Made from the blurred copies") });
      const says = (s) => `${BLUR} ${s.blur ? "on" : "off"}, ${GEN} ${s.gen ? "on" : "off"}, Proxy quality ${s.quality ? "shown" : "hidden"}${s.from ? ', "Made from the blurred copies"' : ""}`;

      // 1, 2, 4: the library nobody answered for. The four mixes of the two switches, Upload's rows under each, the
      // question Blur faces asks, and Generate proxies off with Upload's Proxies on
      if (runs(1, 2, 4)) await walk(1, where, async () => {
        const root = await openSettings(place, LIB.ready);
        await sw(root, GEN).first().waitFor();
        const both = (await sw(root, BLUR).count()) === 1 && (await sw(root, GEN).count()) === 1;
        let s = await state(root);
        // not as it was reset: what the server says of its libraries now, and what was written before
        if (s.gen || s.blur || (await rows(root, HOSTED)).includes("Proxies")) {
          const now = (await (await ctx.request.get(BASE + "/api/library")).json()).libraries?.map((l) => `${l.id} proxy=${l.settings.proxy} upload=${l.settings.upload} blur=${!!l.settings.blurFaces}`);
          see(0, where, false, `the library did not open as it was reset. The page: ${(await rows(root, HOSTED)).join(", ")}. The server: ${JSON.stringify(now)}. Written before: ${JSON.stringify(written.slice(-8))}`);
        }
        await shot(`1-off-off-${place}`, section(root, "Proxy workflow"));
        see(1, where, both && !s.blur && !s.gen && !s.quality && !s.from, `both off: ${both ? "both switches there" : "A SWITCH IS MISSING"}; ${says(s)}`);
        await turn(root, UPLOAD, true);
        see(2, where, same(await rows(root, HOSTED), [UPLOAD, "Final exports", "Originals"]), `no ${BLUR}, ${GEN} off: ${(await rows(root, HOSTED)).join(", ")}`);
        await shot(`2-hosted-plain-${place}`, section(root, HOSTED));
        await flip(root, UPLOAD);
        see(2, where, same(await rows(root, HOSTED), [UPLOAD]), `${UPLOAD} off: ${(await rows(root, HOSTED)).join(", ")}`);
        await flip(root, UPLOAD);

        await flip(root, GEN);
        s = await state(root);
        await shot(`1-off-on-${place}`, section(root, "Proxy workflow"));
        see(1, where, !s.blur && s.gen && s.quality && !s.from, `${GEN} turned on: ${says(s)}`);
        see(2, where, same(await rows(root, HOSTED), [UPLOAD, "Final exports", "Proxies", "Originals"]), `no ${BLUR}, ${GEN} on: ${(await rows(root, HOSTED)).join(", ")}`);
        see(3, where, await isOn(root, "Proxies for new files"), `What's made → Proxies, New files: ${(await isOn(root, "Proxies for new files")) ? "on" : "OFF"} with ${GEN} on`);

        // Generate proxies off while Upload's Proxies is on: both off, Undo, and Undo puts both back
        await flip(root, "Proxies");
        const sent = await isOn(root, "Proxies");
        await flip(root, GEN);
        const undo = page.getByRole("button", { name: /^Undo/ }); // "Undo Ctrl+Z"
        const offered = (await undo.count()) > 0;
        const notice = offered ? (await undo.first().locator("xpath=..").innerText()).replace(/\s+/g, " ").trim() : "";
        s = await state(root);
        const gone = !(await rows(root, HOSTED)).includes("Proxies");
        await shot(`2-proxies-off-undo-${place}`, section(root, HOSTED));
        see(2, where, sent && !s.gen && gone && offered, `${GEN} off with Upload's Proxies on: ${GEN} ${s.gen ? "STILL ON" : "off"}, Proxies row ${gone ? "gone" : "STILL THERE"}, notice ${offered ? `"${notice}"` : "NONE"}`);
        if (offered) {
          // the button takes a click only when the pointer reaches it: a drawer turns off clicks outside itself. The key works either way
          const takes = await undo.first().evaluate((b) => {
            const r = b.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!top && b.contains(top);
          });
          see(2, where, takes, `the notice's Undo button ${takes ? "takes a click" : "TAKES NO CLICK: taken back with the key instead"}`);
          if (takes) await undo.first().click();
          else await page.keyboard.press("ControlOrMeta+z");
          await page.waitForTimeout(1200);
          s = await state(root);
          const back = (await rows(root, HOSTED)).includes("Proxies") && (await isOn(root, "Proxies"));
          await shot(`2-undo-back-${place}`, section(root, HOSTED));
          see(2, where, s.gen && back, `Undo: ${GEN} ${s.gen ? "on" : "STILL OFF"}, Upload's Proxies ${back ? "on" : "NOT BACK ON"}`);
        }
        if (!(await isOn(root, GEN))) await flip(root, GEN);

        // Blur faces on, with files nobody answered for: one question
        await flip(root, BLUR);
        const asked = await asking().count();
        const words = (await lines(asking())).join(" | ");
        await shot(`4-asks-${place}`);
        see(4, where, asked === 1 && words.includes(ASK), `${BLUR} on, 3 files with no answer: ${asked} dialog(s): ${words || "NOTHING ASKED"}`);
        if (asked) {
          await asking().getByRole("button", { name: "New files only", exact: true }).click();
          await page.waitForTimeout(1200);
          see(4, where, (await asking().count()) === 0, `after New files only: ${(await asking().count()) ? "ASKED AGAIN" : "no second question"}`);
        }
        s = await state(root);
        await shot(`1-on-on-${place}`, section(root, "Proxy workflow"));
        see(1, where, s.blur && s.gen && s.quality && s.from, `${BLUR} turned on: ${says(s)}`);
        see(2, where, same(await rows(root, HOSTED), [UPLOAD, "Final exports", "Blurred", "Proxies"]), `${BLUR}, ${GEN} on: ${(await rows(root, HOSTED)).join(", ")}`);
        await shot(`2-hosted-blur-${place}`, section(root, HOSTED));
        const left = await lines(made(root, "Blurred copies"));
        await shot(`3-left-as-they-were-${place}`, made(root, "Blurred copies"));
        see(3, where, left.some((l) => l.startsWith("3 missing · 0 of 3 made")) && left.includes("Make 3 missing"), `Blurred copies after New files only: ${left.join(" | ")}`);

        if (await isOn(root, "Proxies")) await flip(root, "Proxies");
        await flip(root, GEN);
        s = await state(root);
        await shot(`1-on-off-${place}`, section(root, "Proxy workflow"));
        see(1, where, s.blur && !s.gen && !s.quality && !s.from, `${GEN} turned off: ${says(s)}`);
        see(2, where, same(await rows(root, HOSTED), [UPLOAD, "Final exports", "Blurred"]), `${BLUR}, ${GEN} off: ${(await rows(root, HOSTED)).join(", ")}`);
        const off = await lines(made(root, "Proxies"));
        see(3, where, !(await isOn(root, "Proxies for new files")) && !off.some((l) => /^Make /.test(l)), `What's made → Proxies with ${GEN} off: ${off.join(" | ")}`);

        await flip(root, BLUR);
        s = await state(root);
        see(1, where, !s.blur && !s.gen && (await asking().count()) === 0, `${BLUR} turned off: ${says(s)}`);
        // a note, not a check: the files left as they were still count as missing, so the switch asks again
        await flip(root, BLUR);
        const again = await asking().count();
        see(0, where, true, `${BLUR} on a second time, the 3 files now left as they were: ${again ? "asks again" : "asks nothing"}`);
        if (again) {
          await asking().getByRole("button", { name: "Cancel", exact: true }).click();
          await page.waitForTimeout(600);
          see(4, where, !(await isOn(root, BLUR)), `Cancel on the question: ${BLUR} ${(await isOn(root, BLUR)) ? "TURNED ON" : "stays off"}`);
        }
      });

      // 4, 3: every file has its answer. Blur faces asks nothing, and Blurred copies is Done with nothing to press
      if (runs(3, 4)) await walk(4, where, async () => {
        const root = await openSettings(place, LIB.answered);
        await flip(root, BLUR);
        const asked = await asking().count();
        see(4, where, asked === 0 && (await isOn(root, BLUR)), `${BLUR} on, every file answered: ${asked ? `ASKED: ${(await lines(asking())).join(" | ")}` : "asks nothing"}, switch ${(await isOn(root, BLUR)) ? "on" : "OFF"}`);
        if (asked) await asking().getByRole("button", { name: "New files only", exact: true }).click();
        const done = await lines(made(root, "Blurred copies"));
        await shot(`3-done-${place}`, made(root, "Blurred copies"));
        see(3, where, done.includes("Done") && !done.some((l) => /^(Make|Retry|Cancel)/.test(l)), `Blurred copies, nothing missing: ${done.join(" | ")}`);
      });

      // 3: two files left as they were. The count, Make, and the New files switches being the Proxy workflow's own
      if (runs(3)) await walk(3, where, async () => {
        const root = await openSettings(place, LIB.blur);
        const row = await lines(made(root, "Blurred copies"));
        await shot(`3-missing-${place}`, made(root, "Blurred copies"));
        see(3, where, row.some((l) => l.startsWith("2 missing · 2 of 4 made")) && row.includes("Make 2 missing"), `Blurred copies, 2 left as they were: ${row.join(" | ")}`);
        const proxies = await lines(made(root, "Proxies"));
        see(3, where, (await isOn(root, "Proxies for new files")) && proxies.some((l) => /^Make \d+ missing$/.test(l)), `Proxies with ${GEN} on: ${proxies.join(" | ")}`);
        await flip(root, "Blurred copies for new files");
        see(3, where, !(await isOn(root, BLUR)) && (await isOn(root, GEN)), `Blurred copies' New files off: ${BLUR} ${(await isOn(root, BLUR)) ? "STILL ON" : "off"}, ${GEN} ${(await isOn(root, GEN)) ? "unchanged" : "CHANGED"}`);
        await shot(`3-new-files-off-${place}`, made(root, "Blurred copies"));
        await flip(root, "Proxies for new files");
        see(3, where, !(await isOn(root, GEN)) && !(await isOn(root, BLUR)), `Proxies' New files off: ${GEN} ${(await isOn(root, GEN)) ? "STILL ON" : "off"}, ${BLUR} ${(await isOn(root, BLUR)) ? "CHANGED" : "unchanged"}`);
        await flip(root, "Proxies for new files");
        see(3, where, await isOn(root, GEN), `Proxies' New files on: ${GEN} ${(await isOn(root, GEN)) ? "on" : "STILL OFF"}`);
      });

      // 2: Upload's Proxies stored on with Generate proxies off keeps its row, until it is turned off
      if (runs(2)) await walk(2, where, async () => {
        const root = await openSettings(place, LIB.held);
        const kept = await rows(root, HOSTED);
        await shot(`2-stored-proxies-${place}`, section(root, HOSTED));
        see(2, where, !(await isOn(root, GEN)) && same(kept, [UPLOAD, "Final exports", "Blurred", "Proxies"]) && (await isOn(root, "Proxies")), `Proxies stored on, ${GEN} off, ${BLUR} on: ${kept.join(", ")}`);
        if (kept.includes("Proxies")) {
          await flip(root, "Proxies");
          const after = await rows(root, HOSTED);
          see(2, where, !after.includes("Proxies"), `that Proxies turned off: ${after.join(", ") || "no rows"}`);
        }
      });

      // 8 (L10): Make → Queueing → "N files queued" on the two rows that cost nothing, nothing clipped
      if (runs(8)) {
        // at 1280 the drawer's button, at 760 and 1600 the Settings page's, lies across the confirm's edge
        for (const width of [760, 1280, 1600]) for (const [label, kind] of [["Blurred copies", "blur"], ["Proxies", "proxy"]]) {
          const spot = `${where} ${width}px ${label}`;
          await walk(8, spot, async () => {
            await page.setViewportSize({ width, height: 860 });
            const root = await openSettings(place, LIB.blur);
            const make = made(root, label).getByRole("button", { name: /^Make \d+ missing$/ });
            if (!(await make.count()) || (await make.isDisabled())) return see(8, spot, false, `no Make to press: ${(await lines(made(root, label))).join(" | ")}`);
            // the server's answer held 2.5 s, as a library of thousands of files takes: the row stays on Queueing to be looked at
            const held = `**/api/library/*/made/${kind}`;
            await page.route(held, async (route) => {
              await new Promise((r) => setTimeout(r, 2500));
              await route.continue();
            });
            await make.evaluate((e) => e.scrollIntoView({ block: "center" }));
            await make.click();
            await asking().waitFor();
            const name = `8-${kind}-${place}-${width}`;
            // as it opens (200 ms see-through, the row showing under it), then as it is read
            await page.screenshot({ path: path.join(out, `${name}-0-opening-${theme}.png`) });
            await page.waitForTimeout(400);
            await page.screenshot({ path: path.join(out, `${name}-0-confirm-${theme}.png`) });
            const body = (await lines(asking())).join(" | ");
            /** The Queueing button as it is drawn: cut by a box that hides what leaves it, or under something else. */
            const drawn = () =>
              page.evaluate(() => {
                const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Queueing");
                const dialog = !!document.querySelector('[role="alertdialog"]');
                if (!b) return { queueing: false, dialog };
                const r = b.getBoundingClientRect();
                let cut = null;
                for (let e = b.parentElement; e && !cut; e = e.parentElement) {
                  const s = getComputedStyle(e);
                  if (!/hidden|clip|auto|scroll/.test(s.overflowX + s.overflowY)) continue;
                  const q = e.getBoundingClientRect();
                  if (q.right < r.right - 0.5 || q.left > r.left + 0.5 || q.bottom < r.bottom - 0.5 || q.top > r.top + 0.5) cut = `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 50)}`;
                }
                const points = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
                // a button that is off takes no pointer, so the row under it answers: only something outside its own row covers it
                const over = points.map(([x, y]) => document.elementFromPoint(x, y)).filter((e) => e && !b.contains(e) && !e.contains(b));
                return { queueing: true, dialog, cut, over: [...new Set(over.map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute("data-slot") ?? e.getAttribute("role") ?? ""}]`))], fits: b.scrollWidth <= b.clientWidth, rect: [r.left, r.top, r.width, r.height].map(Math.round), inWindow: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
              });
            const t = Date.now();
            await asking().getByRole("button", { name: /^Make \d+$/ }).click();
            const first = await drawn();
            await page.screenshot({ path: path.join(out, `${name}-1-confirmed-${theme}.png`) });
            await page.waitForTimeout(Math.max(0, 1000 - (Date.now() - t)));
            const second = await drawn();
            await page.screenshot({ path: path.join(out, `${name}-2-one-second-${theme}.png`) });
            await page.getByRole("button", { name: "Queueing", exact: true }).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
            await page.waitForTimeout(500);
            const after = await lines(made(root, label));
            await made(root, label).evaluate((e) => e.scrollIntoView({ block: "center" }));
            await page.screenshot({ path: path.join(out, `${name}-3-queued-${theme}.png`) });
            const fine = (d) => d.queueing && !d.dialog && !d.cut && !d.over.length && d.fits && d.inWindow;
            see(8, spot, fine(first) && fine(second) && after.some((l) => /queued|waiting/.test(l)), `confirm "${body}"; right after ${JSON.stringify(first)}; one second later ${JSON.stringify(second)}; then: ${after.join(" | ")}`);
          }).finally(() => page.unrouteAll({ behavior: "ignoreErrors" }));
        }
        await page.setViewportSize({ width: 1280, height: 860 });
      }
    }

    // 5: a clip Face Blur found no face in, and one a person kept: what its panel says, no Blur faces button, Blur faces in ⋯
    if (runs(5)) await walk(5, theme, async () => {
      reset(LIB.blur.id);
      at = "Blurring library, the page";
      await pickLibrary(LIB.blur);
      await shot(`5-library`);
      for (const [title, words] of [["No faces clip", "No faces found"], ["Kept clip", "Kept as filmed"]]) {
        await page.locator("button[data-state]", { hasText: title }).first().click();
        await page.waitForTimeout(2500);
        const text = await lines(page.locator("body"));
        const button = await page.getByRole("button", { name: BLUR, exact: true }).count();
        await shot(`5-${words.toLowerCase().replace(/ /g, "-")}`);
        const more = page.getByRole("button", { name: "More", exact: true }).last();
        await more.click();
        await page.waitForTimeout(500);
        const items = await page.getByRole("menuitem").allInnerTexts();
        await shot(`5-${words.toLowerCase().replace(/ /g, "-")}-menu`);
        see(5, `${theme} ${title}`, text.includes(words) && !button && items.map((i) => i.trim()).includes(BLUR), `panel says ${text.includes(words) ? `"${words}"` : `NOT "${words}"`}; ${BLUR} button on the panel: ${button ? "THERE" : "none"}; ⋯ menu: ${items.map((i) => i.trim()).join(", ")}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(600);
        await go(page, "/library");
        await page.getByRole("combobox", { name: "Library" }).selectOption({ label: LIB.blur.name });
        await page.waitForTimeout(1500);
      }
    });

    // 6: a clip the server holds for its blur says so on its card
    if (runs(6)) await walk(6, theme, async () => {
      reset(LIB.held.id);
      at = "Phone library, the page";
      await pickLibrary(LIB.held);
      const card = page.locator("button[data-state]", { hasText: "From the phone" }).first();
      const text = (await lines(card)).join(" | ");
      await shot(`6-held-card`);
      see(6, theme, text.includes("Waiting for the main computer"), `the held clip's card: ${text || "NO CARD"}`);
    });
    await ctx.close();
  }
  await browser.close();
  // one line per error, with how often and where first
  const errors = Object.values(problems.reduce((all, p) => ((all[p.error] ??= { ...p, times: 0 }).times++, all), {}));
  writeFileSync(path.join(out, "proxies.json"), JSON.stringify({ seen, errors }, null, 1));
  const failed = seen.filter((s) => !s.ok);
  console.log(JSON.stringify({ out, looked: seen.length, failed: failed.length, consoleErrors: errors.length }));
  if (failed.length) process.exitCode = 1;
} finally {
  stop();
  rmSync(data, { recursive: true, force: true });
}
