import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The one browser smoke test for /library. It starts the app's own Vite server in this process and runs one headless
// Chrome (the installed Google Chrome: Playwright's bundled Chromium has no H.264). It runs alone:
//   LIBRARY_E2E=1 CT_SCRATCH_DIR=/Volumes/WinningFriends/GitHub/ct-scratch/s4-browser-ui \
//     pnpm -s exec vitest run api/library/library-ui.e2e.test.ts
// Everything it writes (data, fixture) lives under CT_SCRATCH_DIR and is removed at the end.
// Not part of the server typecheck (tsconfig.server.json excludes it): the browser types are not in this workspace.

const enabled = process.env.LIBRARY_E2E === "1";
type Any = any;
let dir = "";
let fixture = "";
let base = "";
let server: Any = null;
let browser: Any = null;
let stopWorker: (() => void) | null = null;

/** Polls `check` until it returns true, or fails after `ms`. */
async function until(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 200));
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const scratch = process.env.CT_SCRATCH_DIR;
  if (!scratch) throw new Error("Set CT_SCRATCH_DIR to a folder on the external disk");
  mkdirSync(scratch, { recursive: true });
  dir = mkdtempSync(path.join(scratch, "library-ui-"));
  process.env.DATA_DIR = path.join(dir, "data");
  mkdirSync(process.env.DATA_DIR, { recursive: true });
  // one workspace whose owner is the local account (APP_SECRET unset: every request is `local`, an admin)
  writeFileSync(
    path.join(process.env.DATA_DIR, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { id: "ws_ui", name: "Tiny Acrobatics", plan: "team", comped: false, createdAt: 0, members: [{ username: "local", role: "owner", ai: "own", budgetUsd: 0, joinedAt: 0 }] },
      ],
      invites: [],
      spend: {},
    }),
  );
  const { libraryDb } = await import("./db");
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_ui', 'ws_ui', 'Tiny Acrobatics library', 'local', 0)")
    .run();

  // a three-second clip, 320x240 H.264 with AAC: a browser plays it as it is, so no proxy is made
  const { ffmpegCommand } = await import("../ffmpeg-runtime");
  mkdirSync(path.join(dir, "upload"));
  fixture = path.join(dir, "upload", "Tiny Acrobatics clip.mp4");
  execFileSync(ffmpegCommand(), [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", fixture,
  ]);

  const { createServer } = await import("vite");
  server = await createServer({
    configFile: path.resolve(import.meta.dirname, "../../vite.config.ts"),
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  base = server.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${server.config.server.port}/`;

  const { startLibraryWorker } = await import("./worker");
  stopWorker = startLibraryWorker();

  const { chromium } = await import("playwright-chromium");
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  stopWorker?.();
  await browser?.close();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)("Media Library in the browser", () => {
  it("uploads a clip, sees its card become ready, plays the preview, searches, and fits a phone", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message));
    await page.goto(new URL("/library", base).toString());

    await page.getByRole("heading", { name: "Media Library" }).waitFor({ timeout: 60_000 });
    await page.getByText("Nothing here yet").waitFor();

    await page.locator('input[type="file"]').setInputFiles(fixture);
    const card = page.getByRole("button", { name: /Tiny Acrobatics clip/ });
    await card.waitFor({ timeout: 30_000 });
    await until(async () => (await card.getAttribute("data-state")) === "ready", 60_000, "the card to be ready");
    await until(async () => (await card.locator("img").evaluate((i: Any) => i.naturalWidth)) > 0, 20_000, "the thumbnail");

    await card.click();
    const video = page.locator("video");
    await video.waitFor();
    const time: number = await video.evaluate(async (v: Any) => {
      v.muted = true;
      await v.play();
      await new Promise((done) => setTimeout(done, 700));
      return v.currentTime;
    });
    expect(time).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    const search = page.getByRole("searchbox", { name: "Search" });
    await search.fill("tiny");
    await card.waitFor();
    await search.fill("zzqx");
    await page.getByText("No matches.").waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await search.fill("");
    await card.waitFor();
    const overflow: number = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
    expect(overflow).toBeLessThanOrEqual(0);

    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});
