// Install for an AI provider on This Mac while the Mac app's window shows another server, so its own server is not
// running (built to dist/install.js; the Mac app runs it, AiInstall.swift). The same install as Settings → Providers on
// This Mac (installCli): one JSON line a second with Antigravity's download so far, then one with the answer.
import { installCli } from "./lib/local-ai";
import { agyProgress } from "./lib/antigravity";
import type { Driver } from "../contracts/providers";

const id = process.argv[2] ?? "";
if (!["claude", "codex", "gemini", "antigravity"].includes(id)) {
  console.log(JSON.stringify({ ok: false, message: "Not an AI this Mac installs." }));
  process.exit(2);
}
const tick = setInterval(() => {
  const p = agyProgress();
  if (p) console.log(JSON.stringify(p));
}, 1000);
const r = await installCli(id as Driver).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
clearInterval(tick);
console.log(JSON.stringify({ ok: r.ok, message: r.message }));
process.exit(r.ok ? 0 : 1);
