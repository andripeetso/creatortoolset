// After a build: the built page (dist/public) opens in a headless Chrome and the app draws into #root. A page whose
// script stops as it loads leaves the CT mark up for good (0.18.18–0.20.0 shipped one: the Mac app's build,
// CT_PLUGIN_HOST=1, read a value before it was set). The /api calls answer 404 here; the app still draws.
//   node scripts/check-page-opens.mjs [dist/public]      CHROME_PATH=… for a Chrome that isn't Google Chrome
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright-chromium";

const dir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "../dist/public"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".wasm": "application/wasm" };

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/api/")) return void res.writeHead(404).end();
  let file = path.join(dir, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dir, "index.html");
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, headless: true } : { channel: "chrome", headless: true });
const errors = [];
let ok = false;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  ok = await page.waitForFunction(() => document.getElementById("root")?.childElementCount > 0, null, { timeout: 15_000 }).then(() => true, () => false);
} finally {
  await browser.close();
  server.close();
}
if (!ok) {
  console.error(`The built page did not open: #root stayed empty after 15 s.${errors.length ? `\n  ${errors.join("\n  ")}` : ""}`);
  process.exit(1);
}
console.log("check-page-opens: ok");
