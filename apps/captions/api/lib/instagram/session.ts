import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { env, isCloud } from "../env";
import type { SessionUser } from "../../users";

// The person's own Instagram account, signed in once in a Chrome window on their Mac (they type, never this code), so
// the Media Library can add a post or reel by its link. Only its cookies are kept (0600); each read is one call to
// Instagram's own web API with them, one at a time, on demand. Instagram's terms apply to that account.

export const IG = {
  /** how long the sign-in window waits for the person */
  loginMs: 10 * 60_000,
  /** the web app's own id, which Instagram's web API asks for */
  appId: "936619743392459",
};

const home = (u: string) => path.join(env.dataDir, "instagram-login", u);
const profileOf = (u: string) => path.join(home(u), "chrome-profile");
const cookieFile = (u: string) => path.join(home(u), "cookies.json");

interface Cookies {
  sessionid: string;
  csrftoken: string;
  ds_user_id: string;
}

/** The person whose Mac this server runs on: the sign-in window opens on its screen. */
export const mayUseInstagram = (u: SessionUser) => u.role === "admin" && !isCloud();

/** Google Chrome on this Mac, or null. */
export function chromePath(): string | null {
  const app = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return [path.join("/", app), path.join(os.homedir(), app)].find((p) => existsSync(p)) ?? null;
}

function cookiesOf(u: string): Cookies | null {
  try {
    const c = JSON.parse(readFileSync(cookieFile(u), "utf8")) as Cookies;
    return c.sessionid ? c : null;
  } catch {
    return null;
  }
}

export function saveCookies(u: string, c: Cookies): void {
  mkdirSync(home(u), { recursive: true, mode: 0o700 });
  writeFileSync(cookieFile(u), JSON.stringify(c), { mode: 0o600 });
}

const signingIn = new Set<string>();
const lastError = new Map<string, string>();

export interface InstagramLoginState {
  chrome: boolean;
  signedIn: boolean;
  signingIn: boolean;
  error: string | null;
}

export const loginState = (u: string): InstagramLoginState => ({
  chrome: !!chromePath(),
  signedIn: !!cookiesOf(u),
  signingIn: signingIn.has(u),
  error: lastError.get(u) ?? null,
});

/** A Chrome window on Instagram's sign-in page; it closes once Instagram has set the session cookie. */
export function startSignIn(u: string): void {
  if (signingIn.has(u)) return;
  const exe = chromePath();
  if (!exe) return void lastError.set(u, "Needs Google Chrome on this Mac");
  signingIn.add(u);
  lastError.delete(u);
  void (async () => {
    const { chromium } = await import("playwright-chromium");
    mkdirSync(profileOf(u), { recursive: true, mode: 0o700 });
    const ctx = await chromium.launchPersistentContext(profileOf(u), {
      executablePath: exe,
      headless: false,
      viewport: { width: 1000, height: 800 },
      ignoreDefaultArgs: ["--enable-automation"],
      args: ["--disable-blink-features=AutomationControlled"],
    });
    let open = true;
    ctx.on("close", () => (open = false));
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto("https://www.instagram.com/accounts/login/").catch(() => {});
      for (const end = Date.now() + IG.loginMs; open && Date.now() < end; ) {
        await new Promise((r) => setTimeout(r, 2000));
        const all = await ctx.cookies("https://www.instagram.com").catch(() => null);
        if (!all) break;
        const get = (n: string) => all.find((c) => c.name === n)?.value ?? "";
        if (get("sessionid") && get("ds_user_id")) {
          saveCookies(u, { sessionid: get("sessionid"), csrftoken: get("csrftoken"), ds_user_id: get("ds_user_id") });
          break;
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
  })()
    .catch((e) => lastError.set(u, `Could not open Chrome: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => signingIn.delete(u));
}

/** Forgets the cookies and the Chrome profile. */
export function signOut(u: string): void {
  rmSync(home(u), { recursive: true, force: true });
  lastError.delete(u);
}

/* ---- a post by its link ---- */

export class InstagramRefused extends Error {}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The post's code in a link to a post, reel or video ("instagram.com/reel/C0dE…"), or null. */
export function shortcodeOf(link: string): string | null {
  return /instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]+)/i.exec(link)?.[1] ?? null;
}

/** The media id Instagram's API takes, from a post's code (a private post's code carries 28 more characters). */
export function mediaIdOf(code: string): string {
  const c = code.length > 28 ? code.slice(0, -28) : code;
  let n = 0n;
  for (const ch of c) n = n * 64n + BigInt(ALPHABET.indexOf(ch));
  return n.toString();
}

export interface PostFile {
  url: string;
  kind: "video" | "picture";
}

interface Version {
  url: string;
  width?: number;
}
interface Item {
  code?: string;
  user?: { username?: string };
  video_versions?: Version[];
  image_versions2?: { candidates?: Version[] };
  carousel_media?: Item[];
}

const widest = (v?: Version[]) => v?.reduce<Version | undefined>((a, b) => (!a || (b.width ?? 0) > (a.width ?? 0) ? b : a), undefined)?.url;

/** Each video or picture of a post (a carousel's in order), the largest Instagram gives. */
export function filesOf(item: Item): PostFile[] {
  const one = (i: Item): PostFile | null => {
    const video = widest(i.video_versions);
    if (video) return { url: video, kind: "video" };
    const pic = widest(i.image_versions2?.candidates);
    return pic ? { url: pic, kind: "picture" } : null;
  };
  return (item.carousel_media?.length ? item.carousel_media.map(one) : [one(item)]).filter((f): f is PostFile => !!f);
}

// one read at a time for the whole server, a few seconds apart: on demand, at a person's pace
let turn: Promise<unknown> = Promise.resolve();
let lastRead = 0;
export const PACE = { ms: 3000 };

/** A post's files and whose it is, read with the person's own sign-in. */
export function readPost(u: string, link: string): Promise<{ username: string; code: string; files: PostFile[] }> {
  const run = turn.then(async () => {
    const wait = lastRead + PACE.ms - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await readNow(u, link);
    } finally {
      lastRead = Date.now();
    }
  });
  turn = run.catch(() => {});
  return run;
}

async function readNow(u: string, link: string) {
  const code = shortcodeOf(link);
  if (!code) throw new InstagramRefused("Needs a link to an Instagram post or reel");
  const c = cookiesOf(u);
  if (!c) throw new InstagramRefused("Needs an Instagram sign-in");
  const r = await fetch(`https://www.instagram.com/api/v1/media/${mediaIdOf(code)}/info/`, {
    headers: {
      cookie: `sessionid=${c.sessionid}; csrftoken=${c.csrftoken}; ds_user_id=${c.ds_user_id}`,
      "x-ig-app-id": IG.appId,
      "x-csrftoken": c.csrftoken,
      "x-requested-with": "XMLHttpRequest",
      referer: "https://www.instagram.com/",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
    redirect: "manual",
  });
  const body = (await r.json().catch(() => null)) as { items?: Item[]; message?: string } | null;
  // a signed-out session: Instagram sends to its login page, or says login_required
  if (r.status === 401 || (r.status >= 300 && r.status < 400) || body?.message === "login_required" || body?.message === "checkpoint_required") {
    rmSync(cookieFile(u), { force: true });
    throw new InstagramRefused("Instagram signed this account out. Sign in again");
  }
  if (r.status === 429 || /wait a few minutes/i.test(body?.message ?? "")) throw new InstagramRefused("Instagram asked to wait. Try again later");
  if (r.status === 404 || (r.ok && !body?.items?.length)) throw new InstagramRefused("Post not found");
  if (!r.ok || !body?.items?.[0]) throw new InstagramRefused("Could not read the post. Try again later");
  const item = body.items[0];
  const files = filesOf(item);
  if (!files.length) throw new InstagramRefused("This post has no video or photo");
  return { username: item.user?.username ?? "instagram", code: item.code ?? code, files };
}
