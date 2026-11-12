import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BrowserContext, Response as PageResponse } from "playwright-chromium";
import { registerEnhanceEngine, type EnhanceHost, type Meta } from "../../api/enhance";
import { env, hostedMode } from "../../api/lib/env";
import { announce } from "../../api/lib/sync";
import { announceSoon } from "../../api/lib/announce-soon";
import type { SessionUser } from "../../api/users";

// Adobe's Enhance Speech in the Audio Enhancer. Adobe has no API for it, so this drives its web page in the person's own
// Google Chrome, with a Chrome profile kept for this plug-in only: they sign in once in a Chrome window (they type, never
// this code), and each run opens the same profile hidden, uploads through the page's own file input and reads the result
// off the page's own calls. Seen in a real run (2026-11-11): the page puts the file in Adobe's storage first, then
// POST /api/v1/enhance_speech_tracks (small JSON; its answer has the id and the plan's `limits`: `is_limited?`,
// `time_remaining`, `retry_at_time`), polls of /enhance_speech_tracks/<id> (`error_type`), then
// /<id>/enhanced_audio = {"url": the WAV}.
// A hidden Chrome says "HeadlessChrome" in its user agent and Adobe's page stays blank, so a run uses a desktop one: the
// installed Chrome's own version (157 worked in that run).

export const ENGINE = "adobespeech";
const PLUGIN = "adobe-enhance";
const TRACKS = "/api/v1/enhance_speech_tracks";
/** The desktop user agent of the Chrome at `exe` (its major version, from the Info.plist beside it; 140 when unreadable). */
function desktopUA(exe: string): string {
  let major = "140";
  try {
    major = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\./.exec(readFileSync(path.join(exe, "../../Info.plist"), "utf8"))?.[1] ?? major;
  } catch {
    // not a Mac app bundle
  }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
const CHROME_ARGS = { viewport: { width: 1280, height: 860 }, ignoreDefaultArgs: ["--enable-automation"], args: ["--disable-blink-features=AutomationControlled"] };

/** What a test changes: Adobe's page (a stand-in), and how long a run waits for the page to say who is signed in. */
export const adobe = {
  url: () => process.env.ADOBE_ENHANCE_URL || "https://podcast.adobe.com/en/enhance",
  signInWaitMs: 30_000,
  loginMs: 15 * 60_000,
};

/** Google Chrome on this Mac, or null. ADOBE_ENHANCE_CHROME names another one ("" = none). */
export function chromePath(): string | null {
  const set = process.env.ADOBE_ENHANCE_CHROME;
  if (set !== undefined) return set && existsSync(set) ? set : null;
  const app = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return [path.join("/", app), path.join(os.homedir(), app)].find((p) => existsSync(p)) ?? null;
}

/** Its files, per account: Chrome's profile, a mark once the person signed in, and the time Adobe holds runs off until. */
const home = (u: string) => path.join(env.dataDir, "plugins", PLUGIN, u);
const profileOf = (u: string) => path.join(home(u), "chrome-profile");
const signedFile = (u: string) => path.join(home(u), "signed-in");
const offFile = (u: string) => path.join(home(u), "off.json");

/** The person whose Mac this server runs on: the sign-in opens a window on its screen, and runs use its Chrome. */
export const NOT_MINE = "Only this Mac's owner can use it";
export const mine = (u: SessionUser) => u.role === "admin" && !hostedMode();
const signedIn = (u: string) => existsSync(signedFile(u));
function heldOff(u: string): { reason: string; until: number } | null {
  try {
    const o = JSON.parse(readFileSync(offFile(u), "utf8")) as { reason: string; until: number };
    return Date.now() < o.until ? o : null;
  } catch {
    return null;
  }
}

/** Settings, Home and the Enhance page follow a change by themselves. */
function changed(u: string): void {
  announce(u, `x/${PLUGIN}`);
  announce(u, "setup");
}

function holdOff(u: string, reason: string, until: number): void {
  mkdirSync(home(u), { recursive: true });
  writeFileSync(offFile(u), JSON.stringify({ reason, until }));
  changed(u);
}

/** Adobe's page says nobody is signed in: the mark goes (the profile stays, so the next sign-in may remember the email). */
function signedOut(u: string): void {
  rmSync(signedFile(u), { force: true });
  changed(u);
}

/** Why this account can't run Adobe now, as the engine's card says it, or null. */
export function refusal(user: SessionUser): string | null {
  if (!mine(user)) return NOT_MINE;
  if (!chromePath()) return "Needs Google Chrome";
  if (!signedIn(user.username)) return "Needs an Adobe sign-in";
  return heldOff(user.username)?.reason ?? null;
}

/** Signed in to Adobe, here: the Audio Enhancer counts as set up (the needs slot). */
export const setUp = (user: SessionUser): boolean => mine(user) && !!chromePath() && signedIn(user.username);

/* ---- one Chrome at a time ---- */

// ponytail: one Chrome for the whole server (sign-ins and runs queue); per-profile locks if several accounts ever run it
let turn: Promise<unknown> = Promise.resolve();
let chromeFor: string | null = null;
function oneAtATime<T>(u: string, fn: () => Promise<T>): Promise<T> {
  const mineTurn = turn.then(async () => {
    chromeFor = u;
    try {
      return await fn();
    } finally {
      chromeFor = null;
    }
  });
  turn = mineTurn.catch(() => {});
  return mineTurn;
}

async function openChrome(u: string, hidden: boolean): Promise<BrowserContext> {
  const exe = chromePath();
  if (!exe) throw new Refused("Needs Google Chrome on this Mac.");
  const { chromium } = await import("playwright-chromium");
  mkdirSync(profileOf(u), { recursive: true });
  return chromium.launchPersistentContext(profileOf(u), { executablePath: exe, headless: hidden, ...(hidden ? { userAgent: desktopUA(exe) } : {}), ...CHROME_ARGS });
}

// run in Adobe's page: its own sign-in code says who is in
const isSignedIn = "!!(window.adobeIMS && window.adobeIMS.isSignedInUser())";
const hasIms = "!!window.adobeIMS";

/* ---- sign in and out (Settings) ---- */

const signingIn = new Set<string>();
const lastError = new Map<string, string>();

export interface AdobeState {
  chrome: boolean;
  signedIn: boolean;
  signingIn: boolean;
  /** Adobe holds runs off until a time: why, in one line */
  off: string | null;
  /** the last sign-in that could not start */
  error: string | null;
}

export const stateOf = (u: string): AdobeState => ({
  chrome: !!chromePath(),
  signedIn: signedIn(u),
  signingIn: signingIn.has(u),
  off: heldOff(u)?.reason ?? null,
  error: lastError.get(u) ?? null,
});

/** A Chrome window on Adobe's page; the person signs in there. It closes once Adobe's page says they are in. */
export function startSignIn(u: string): void {
  if (signingIn.has(u)) return;
  signingIn.add(u);
  lastError.delete(u);
  changed(u);
  void oneAtATime(u, async () => {
    const ctx = await openChrome(u, false);
    let open = true;
    ctx.on("close", () => (open = false));
    let done = false;
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto(adobe.url()).catch(() => {});
      const host = new URL(adobe.url()).host;
      for (const end = Date.now() + adobe.loginMs; open && Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 3000));
        // the person closed the window: on a Mac, Chrome itself may stay open with no window
        const pg = ctx.pages().at(-1);
        if (!pg) break;
        try {
          if (new URL(pg.url()).host === host && (await pg.evaluate<boolean>(isSignedIn))) {
            await new Promise((r) => setTimeout(r, 5000)); // Chrome writes the sign-in to the profile
            done = true;
            break;
          }
        } catch {
          // the window is between pages, or closed
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    if (done) {
      writeFileSync(signedFile(u), new Date().toISOString());
      rmSync(offFile(u), { force: true });
    }
  })
    .catch((e) => lastError.set(u, e instanceof Refused ? e.message : `Chrome didn't open: ${message(e)}`))
    .finally(() => {
      signingIn.delete(u);
      changed(u);
    });
}

/** Forgets the profile. Refused while Chrome has it open. */
export function signOut(u: string): string | null {
  if (chromeFor === u || signingIn.has(u)) return "Adobe is open in Chrome now. Try again when it is done.";
  for (const f of [profileOf(u), signedFile(u), offFile(u)]) rmSync(f, { recursive: true, force: true });
  lastError.delete(u);
  changed(u);
  return null;
}

/* ---- a run ---- */

/** Adobe refused, or can't be reached for a reason the person can act on: the message is the whole line they see. */
class Refused extends Error {}
class Cancelled extends Error {}
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clock = (t: number) => new Date(t).toLocaleTimeString([], { timeStyle: "short" });
const TOO_LONG = "Your Adobe plan doesn't take a file this long.";

/** The plan's limit in an answer of Adobe's: the runs are held off until the time it gives (an hour when it gives none). */
function limited(u: string, j: { limits?: Record<string, unknown> } | null): Refused | null {
  const l = j?.limits;
  if (!l?.["is_limited?"]) return null;
  const at = Date.parse(String(l.retry_at_time ?? ""));
  const until = Number.isFinite(at) ? at : Date.now() + 3600_000;
  holdOff(u, `Today's Adobe time is used up, back at ${clock(until)}`, until);
  return new Refused(`You used up today's Adobe time. It comes back at ${clock(until)}.`);
}

/** Adobe's enhanced WAV of `file`: its address. `progress` gets 0..1 of the way. */
async function enhanceOnPage(u: string, file: string, seconds: number, alive: () => boolean, progress: (f: number) => void): Promise<string> {
  const ctx = await openChrome(u, true);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // each answer's body is read as it arrives: Chrome soon drops a body nobody asked for (a call that carried a file, first)
    const seen: { r: PageResponse; body: Promise<string> }[] = [];
    page.on("response", (r) => void (r.url().includes(TRACKS) && seen.push({ r, body: r.text().catch(() => "") })));
    progress(0.05);
    await page.goto(adobe.url(), { waitUntil: "load", timeout: 60_000 }).catch(() => {});
    try {
      await page.waitForFunction(isSignedIn, null, { timeout: adobe.signInWaitMs });
    } catch {
      if (!alive()) throw new Cancelled();
      // Adobe's sign-in code loaded and says nobody is in: signed out. Anything else is the page not loading.
      if (await page.evaluate<boolean>(hasIms).catch(() => false)) {
        signedOut(u);
        throw new Refused("You are signed out of Adobe. Sign in again in Settings → Adobe Enhance Speech.");
      }
      throw new Refused("Adobe's page didn't load. Try again in a moment.");
    }
    await page.locator("input[type=file]").first().setInputFiles(file);
    progress(0.1);
    // the upload at 0.5 MB/s or better, then Adobe's own 10 minutes for the work
    let end = Date.now() + 60_000 + statSync(file).size / 500;
    let started = false;
    let tid: string | null = null;
    let since = Date.now();
    for (let k = 0; Date.now() < end; ) {
      await page.waitForTimeout(1000);
      if (!alive()) throw new Cancelled();
      for (; k < seen.length; k++) {
        const { r, body } = seen[k]!;
        const at = r.url().split("?")[0]!;
        const text = await body;
        if (r.status() >= 400) {
          console.warn(`[${PLUGIN}] Adobe ${r.status()} on ${at}: ${text.slice(0, 300)}`);
          if (r.status() === 401) {
            signedOut(u);
            throw new Refused("You are signed out of Adobe. Sign in again in Settings → Adobe Enhance Speech.");
          }
          throw new Refused(r.status() === 413 ? TOO_LONG : `Adobe refused the file (error ${r.status()}).`);
        }
        let j: { id?: string; url?: string; error_type?: string; limits?: Record<string, unknown> } | null = null;
        try {
          j = JSON.parse(text);
        } catch {
          // not JSON: nothing in it for us
        }
        const track = /\/enhance_speech_tracks\/([^/]+)(\/enhanced_audio)?$/.exec(at);
        if (r.request().method() === "POST" && at.endsWith(TRACKS)) {
          // the track is made: its id, or (when Chrome kept no body) the first one the page asks about next
          started = true;
          tid = j?.id ?? null;
          end = Date.now() + 600_000;
          since = Date.now();
        } else if (started && track && (tid ??= track[1]!) === track[1]) {
          if (track[2] && j?.url) return j.url;
          if (!track[2] && j?.error_type)
            throw new Refused(/long|duration|length/i.test(j.error_type) ? TOO_LONG : `Adobe couldn't enhance this file (${j.error_type}).`);
        }
        const off = limited(u, j);
        if (off) throw off;
      }
      if (started) progress(0.2 + 0.75 * (1 - Math.exp(-(Date.now() - since) / (Math.max(10, seconds / 3) * 1000))));
      else {
        // two refusals show only on the page: a file longer than the plan takes, and the last minutes of the day's time
        // ("There was a problem uploading your file", with no limit in any answer: a shorter file may still go through)
        const text = (await page.evaluate<string>("document.body.innerText").catch(() => "")).replace(/\s+/g, " ");
        if (/problem uploading/i.test(text)) throw new Refused("Adobe took no upload. Your time left today may be shorter than this file.");
        if (/too long|longer than|exceeds/i.test(text)) throw new Refused(TOO_LONG);
      }
    }
    throw new Refused(started ? "Adobe didn't finish within 10 minutes." : "Adobe's page took no upload. Try again in a moment.");
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** One pass on Adobe: its input from the host, its result handed back. Resolves when the pass is over; never rejects. */
async function run(h: EnhanceHost, meta: Meta): Promise<void> {
  const id = meta.id;
  const u = meta.owner ?? "";
  const step = meta.step ?? 0;
  const passes = meta.chain?.length ?? 1;
  const [lo, hi] = h.band(step, passes);
  const input = path.join(h.sesDir(id), "adobe-in.wav");
  const output = path.join(h.sesDir(id), "adobe-out.wav");
  h.active.set(id, meta); // cancel() reaches it, and readMeta serves this copy
  const alive = () => h.active.get(id) === meta;
  const save = async () => {
    if (!alive()) return;
    await h.persist(meta);
    announceSoon(meta.owner, "enhance");
  };
  let handedOn = false;
  try {
    await save(); // waiting for the run before it shows as waiting
    await oneAtATime(u, async () => {
      if (!alive()) throw new Cancelled();
      if (meta.status === "queued") h.setStatus(meta, "running");
      meta.progress = Math.max(meta.progress, lo);
      await save();
      await h.runStep(id, meta, "ffmpeg", ["-i", h.stepInput(meta), "-vn", "-ac", "1", "-ar", String(h.sampleRate), "-c:a", "pcm_s16le", "-f", "wav", input]);
      if (!alive()) throw new Cancelled();
      let saved = 0;
      const url = await enhanceOnPage(u, input, meta.duration, alive, (f) => {
        meta.progress = Math.max(meta.progress, lo + f * (hi - lo));
        if (Date.now() - saved < 1000) return;
        saved = Date.now();
        void save();
      });
      const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Refused(`Adobe's result didn't download (error ${res.status}).`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(output + ".part"));
      await rename(output + ".part", output);
    });
    if (!alive()) return;
    if (step + 1 < passes) {
      // the next pass starts from Adobe's result
      await h.runStep(id, meta, "ffmpeg", ["-i", output, "-ac", "1", "-ar", String(h.sampleRate), "-c:a", "pcm_s16le", "-f", "wav", h.passOut(id, step)]);
      if (!alive()) return;
      meta.step = step + 1;
      h.setStatus(meta, "queued");
      meta.progress = hi;
      await save();
      handedOn = true;
      h.startStep(meta);
      return;
    }
    meta.progress = Math.max(meta.progress, 0.84);
    await save();
    await h.finish(id, meta, output, meta.duration, alive);
  } catch (e) {
    if (e instanceof Cancelled || !alive()) return;
    if (!(e instanceof Refused)) console.warn(`[${PLUGIN}] ${id}: ${message(e)}`);
    h.setStatus(meta, "error");
    meta.error = e instanceof Refused ? e.message : `Adobe: ${message(e).split("\n")[0]!.slice(0, 200)}`;
    await save();
  } finally {
    if (!handedOn && alive()) h.active.delete(id);
    await Promise.all([input, output, output + ".part"].map((f) => rm(f, { force: true }))).catch(() => {});
  }
}

registerEnhanceEngine({
  id: ENGINE,
  refusal,
  // they installed it and signed in: a new file starts on Adobe
  preferred: (user) => !refusal(user),
  start: run,
});
