import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
// the bundle's banner declares createRequire itself (package.json build), so not a named import
import nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-chromium";
import type { CaptionRenderSpec } from "../src/lib/types";

interface RendererWindow {
  captionRenderer: {
    setSpec(spec: CaptionRenderSpec): Promise<void>;
    renderAt(time: number): Promise<void>;
  };
}

/** The app's own render page (render.html): the captions' frames, and a design's pages (api/lib/design-picture.ts). */
export function rendererUrl(): string {
  // dev = the vite server's live render.html. PM2 sets PM2_USAGE for its
  // children, so a server started without NODE_ENV=production is still
  // treated as production (this used to send exports to a dead dev URL)
  const isDev =
    process.env.NODE_ENV !== "production" && !process.env.PM2_USAGE;
  if (isDev) {
    return (
      process.env.CAPTION_RENDERER_URL ||
      `http://127.0.0.1:${process.env.PORT || 3000}/render.html`
    );
  }
  const candidates = [
    path.resolve(import.meta.dirname, "public/render.html"),
    path.resolve(process.cwd(), "dist/public/render.html"),
    path.resolve(process.cwd(), "../dist/public/render.html"),
  ];
  const file = candidates.find(existsSync);
  if (!file) {
    throw new Error(
      "Caption renderer is missing. Run the production build before exporting."
    );
  }
  return pathToFileURL(file).href;
}

let installing: Promise<void> | null = null;

/**
 * Downloads Chromium's headless shell once, with Playwright's own installer run by this same node (the Mac app's
 * bundle has no npm or npx). It lands in PLAYWRIGHT_BROWSERS_PATH, which the Mac app points outside the data
 * folder. Exports that ask while it runs wait for the same download; a failed one is tried again next export.
 */
export function installExportBrowser(): Promise<void> {
  installing ??= new Promise<void>((resolve, reject) => {
    const pkg = nodeModule.createRequire(import.meta.url).resolve("playwright-chromium/package.json");
    const child = spawn(process.execPath, [path.join(path.dirname(pkg), "cli.js"), "install", "chromium-headless-shell"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr?.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Downloading the export browser failed: ${err.trim() || `exit ${code}`}`)));
  }).finally(() => {
    installing = null;
  });
  return installing;
}

export interface CaptionFrameRenderer {
  capacity: number;
  render(times: number[]): Promise<Buffer[]>;
  close(): Promise<void>;
}

/**
 * Opens a small pool of identical transparent render pages. A batch maps one
 * timestamp to each page, which keeps full-HD exports practical while frame
 * order remains deterministic when the PNGs are written to FFmpeg.
 */
export async function createCaptionFrameRenderer(
  spec: CaptionRenderSpec,
  /** called when Chromium is missing and the first export downloads it */
  onDownload?: () => void,
): Promise<CaptionFrameRenderer> {
  // lazy: a missing/broken playwright install must fail exports with a
  // clean error, never crash the whole server at module load
  const { chromium } = await import("playwright-chromium").catch(() => {
    throw new Error(
      "playwright-chromium is not installed on the server — caption video exports are unavailable"
    );
  });
  const launch = () =>
    chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--allow-file-access-from-files",
        "--disable-dev-shm-usage",
      ],
    });
  let browser: Browser | null = await launch().catch(async (e: unknown) => {
    // ponytail: Playwright's missing-browser message (1.62); recheck it when Playwright is upgraded
    if (!String((e as Error)?.message).includes("Executable doesn't exist")) throw e;
    onDownload?.();
    await installExportBrowser();
    return launch();
  });
  const pixels = spec.width * spec.height;
  const configured = Number(process.env.EXPORT_RENDER_PAGES || 4);
  const requested = Number.isFinite(configured)
    ? Math.max(1, Math.min(6, Math.floor(configured)))
    : 4;
  const count = Math.min(
    requested,
    pixels > 8_000_000 ? 2 : pixels > 4_000_000 ? 3 : 4
  );
  const pages: Page[] = [];

  try {
    for (let i = 0; i < count; i++) {
      const page = await browser.newPage({
        viewport: { width: spec.width, height: spec.height },
        deviceScaleFactor: 1,
      });
      await page.goto(rendererUrl(), { waitUntil: "load" });
      await page.waitForFunction(
        () => Boolean((globalThis as unknown as RendererWindow).captionRenderer)
      );
      await page.evaluate(
        (next) =>
          (globalThis as unknown as RendererWindow).captionRenderer.setSpec(next),
        spec
      );
      pages.push(page);
    }
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }

  return {
    capacity: pages.length,
    async render(times) {
      if (!browser) throw new Error("Caption renderer is already closed");
      if (times.length > pages.length) {
        throw new Error("Caption frame batch exceeds renderer capacity");
      }
      return Promise.all(
        times.map(async (time, i) => {
          const page = pages[i];
          await page.evaluate(
            (at) =>
              (globalThis as unknown as RendererWindow).captionRenderer.renderAt(at),
            time
          );
          return page.screenshot({
            type: "png",
            omitBackground: true,
          });
        })
      );
    },
    async close() {
      const active = browser;
      browser = null;
      if (active) await active.close().catch(() => {});
    },
  };
}
