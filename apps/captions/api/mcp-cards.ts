import { Hono } from "hono";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./lib/env";
import { innerCall, sessionOf } from "./auth";
import { findUser } from "./users";
import { hasProxy } from "./library/routes";
import { libraryGatedByPlugin } from "./library/sources";
import { CARD_HTML } from "./mcp-card-view";

/**
 * Cards: what an AI app outside (ChatGPT, Claude) shows in the chat for some tool answers, instead of text about
 * them. A tool with a card names the card's page in its listing (`_meta.ui.resourceUri`, MCP Apps); the app reads that
 * page once (resources/read) and hands it each answer's `_meta.card`, which only the page sees, never the model. The
 * model still gets the answer as text, so a card adds nothing to what it reads.
 *
 * How things reach a person from a chat:
 * - a link into the app (`href`): opens the session, video or edit on this server, behind the person's own sign-in;
 * - a share link (review_share, media_share): the public link the tools already make, for other people;
 * - a picture or a video in a card: a signed link (below), since the card's frame has no sign-in of its own.
 */

type Args = Record<string, unknown>;

/** The card's address. Its name carries a hash of the page: AI apps keep a page for a long time, so a new page needs a new name. */
export const CARD_URI = `ui://creator-toolset/card-${createHash("sha256").update(CARD_HTML).digest("hex").slice(0, 10)}.html`;
export const CARD_MIME = "text/html;profile=mcp-app";

/** The tools whose answer has a card, and the kind it draws. */
const KIND: Record<string, "script" | "footage" | "review" | "edit" | "posts"> = {
  workshop_session: "script",
  workshop_new_session: "script",
  workshop_new_piece: "script",
  workshop_edit_piece: "script",
  media_search: "footage",
  get_review: "review",
  editor_get: "edit",
  editor_create: "edit",
  instagram_posts: "posts",
};
export const hasCard = (tool: string): boolean => tool in KIND;
/** Tools a card's own button calls (Resolve on a comment): the AI app must let the card reach them, with no card of their own. */
const CARD_CALLS = new Set(["resolve_comment"]);

/** What a tool adds to its listing for the card. Both spellings: MCP Apps', and the older one ChatGPT also reads. */
export const cardToolMeta = (tool: string): Args | undefined =>
  hasCard(tool) ? { ui: { resourceUri: CARD_URI }, "openai/outputTemplate": CARD_URI, "openai/widgetAccessible": true } : CARD_CALLS.has(tool) ? { "openai/widgetAccessible": true } : undefined;

export const cardResourceList = () => [{ uri: CARD_URI, name: "Creator Toolset card", description: "Shows a script, footage, a Review video, an edit or an account's posts in the chat.", mimeType: CARD_MIME }];

/** The card's page for resources/read. It may load pictures and video from this server only, and connects nowhere. */
export function cardResource(origin: string) {
  return {
    uri: CARD_URI,
    mimeType: CARD_MIME,
    text: CARD_HTML,
    _meta: {
      ui: { csp: { resourceDomains: [origin], connectDomains: [] }, prefersBorder: true },
      "openai/widgetCSP": { resource_domains: [origin], connect_domains: [] },
      "openai/widgetPrefersBorder": true,
      "openai/widgetDescription": "A card with the script, footage, Review video, edit or posts this answer is about. It already shows the content: add only what it does not.",
    },
  };
}

/* ---- signed media links ---- */

/** How long a card's links work. A chat opened later shows the card without pictures or video. */
export const CARD_LINK_MS = 6 * 60 * 60_000;
const mac = (body: string) => createHmac("sha256", env.appSecret).update(`card:${body}`).digest("base64url").slice(0, 32);
const keyOf = (authorization: string | null | undefined) => /^Bearer (ctk_[a-f0-9]{48})$/.exec(authorization ?? "")?.[1];
/** The first characters of a key's stored hash: enough to tell whether that key is still on, and nothing a key can be made from. */
const tagOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/**
 * What a link may fetch. lt / lp: a library clip's thumbnail / its playable copy (the proxy the library made, never the
 * camera original). rt / rp: a Review version's thumbnail / the video its viewers watch.
 */
export type CardMedia = "lt" | "lp" | "rt" | "rp";
type Token = { u: string; k: string; m: CardMedia; i: string; n?: number; e: number };
export type Sign = (what: CardMedia, id: unknown, n?: unknown) => string | undefined;

const ID = /^[A-Za-z0-9_-]{1,80}$/;
/** The app's own route a link stands for, built from the token's fields and nothing else: one GET of one file. */
function pathOf(t: Pick<Token, "m" | "i" | "n">): string | null {
  if (typeof t.i !== "string" || !ID.test(t.i) || t.i.startsWith("ext_")) return null;
  if (t.m === "lt") return `/api/library/media/${t.i}/thumb`;
  if (t.m === "lp") return hasProxy(t.i) ? `/api/library/media/${t.i}/play` : null;
  if (t.m !== "rt" && t.m !== "rp") return null;
  return Number.isInteger(t.n) && t.n! > 0 && t.n! < 10_000 ? `/api/review/assets/${t.i}/v/${t.n}/${t.m === "rt" ? "thumb" : "play"}` : null;
}

/**
 * A maker of signed media links for one caller, or one that makes none. A link names the account, the file and the
 * key the caller came with, and works for CARD_LINK_MS; removing that key (Settings → Headless access) ends its links
 * at once. None on a server without accounts (nothing to sign with), for a plug-in's source (its own stream decides
 * who sees it), or anywhere on an install where a plug-in guards the library with a check of its own: there no picture
 * or video leaves on a link, Review's included.
 */
export function mediaLinks(authorization: string | null | undefined, username: string, origin: string): Sign {
  const key = keyOf(authorization);
  if (!key || !env.appSecret || libraryGatedByPlugin()) return () => undefined;
  const k = tagOf(key);
  const e = Date.now() + CARD_LINK_MS;
  return (m, id, n) => {
    const t: Token = { u: username, k, m, i: String(id ?? ""), ...(n == null ? {} : { n: Number(n) }), e };
    if (!pathOf(t)) return undefined;
    const body = Buffer.from(JSON.stringify(t)).toString("base64url");
    return `${origin}/api/card/media/${body}.${mac(body)}`;
  };
}

type Call = (path: string, init: RequestInit) => Promise<Response>;
const PASS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified"];

/**
 * The route a card's links point at, mounted before the account gate (boot.ts): the signature is the only credential.
 * Every rule is checked again here, then the file is asked for from the app's own route as the account the link names
 * (`call`, the same inner call the MCP tools use), so that route's checks stay the only checks on who sees what.
 */
export function cardApp(call: Call) {
  const app = new Hono();
  app.get("/api/card/media/:token", async (c) => {
    const gone = () => c.json({ error: "Not found" }, 404);
    const [body, sig] = c.req.param("token").split(".");
    if (!env.appSecret || !body || !sig) return gone();
    const want = mac(body);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return gone();
    let t: Token;
    try {
      t = JSON.parse(Buffer.from(body, "base64url").toString()) as Token;
    } catch {
      return gone();
    }
    const user = typeof t.u === "string" ? findUser(t.u) : undefined;
    const live = !!user && [user.fullKeyHash, ...(user.aiKeys ?? []).map((x) => x.hash)].some((h) => !!h && h.startsWith(String(t.k)));
    const path = pathOf(t);
    if (!user || !live || !(t.e > Date.now()) || !path || libraryGatedByPlugin()) return gone();
    // a player asks for a video in ranges: the range goes in, and the answer's own status and range headers come back out
    const range = c.req.header("range");
    const ask = (to: string) => innerCall.run(sessionOf(user), () => call(to, { headers: range ? { range } : {} }));
    let res = await ask(path);
    // a bucket's own address is not one the card may load from, so its bytes are passed on from here (streamed, never held)
    if (res.status === 302) res = await fetch(res.headers.get("location") ?? "", { headers: range ? { range } : {} }).catch(() => new Response(null, { status: 404 }));
    if (res.status !== 200 && res.status !== 206) return gone();
    const headers = new Headers({ "Cache-Control": "private, max-age=3600" });
    for (const h of PASS) if (res.headers.get(h)) headers.set(h, res.headers.get(h)!);
    return new Response(res.body, { status: res.status, headers });
  });
  return app;
}

/* ---- the card's data ---- */

const list = (v: unknown): Args[] => (Array.isArray(v) ? (v as Args[]) : []);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/**
 * A tool's answer as its card, or null when it has none. `answer` is what the tool returned (the same the model reads);
 * `sign` makes a media link, or nothing where none may be made. Kept small: the page shows the first rows and folds the rest.
 */
export function cardFor(tool: string, args: Args, answer: Args, origin: string, sign: Sign): Args | null {
  switch (KIND[tool]) {
    case "script": {
      const session = String(answer.pieces ? answer.id : (args.session ?? ""));
      const pieces = answer.pieces ? list(answer.pieces) : [answer];
      if (!session || !pieces.length) return null;
      return { kind: "script", title: text(answer.pieces ? answer.title : undefined, 200), status: answer.pieces ? answer.status : undefined, href: `${origin}/workshop/sessions/${encodeURIComponent(session)}`, pieces };
    }
    case "footage": {
      const files = list(answer.files);
      const q = text(args.q, 80);
      return {
        kind: "footage",
        q,
        href: `${origin}/library`,
        open: "Open Media Library",
        total: files.length,
        ...(files.length ? {} : { empty: q ? `Nothing in your footage matches "${q}".` : "Your Media Library is empty. Add footage in Creator Toolset on your computer and it shows here." }),
        items: files.slice(0, 24).map((f) => {
          const said = list(f.said)[0];
          return {
            title: text(f.title, 120),
            type: f.kind,
            roll: f.roll,
            s: typeof f.durationS === "number" ? f.durationS : undefined,
            ...(said ? { said: { at: said.at, text: text(said.text, 160) } } : f.description ? { about: text(f.description, 160) } : {}),
            thumb: sign("lt", f.versionId),
            ...(f.kind === "video" ? { play: sign("lp", f.versionId) } : {}),
          };
        }),
      };
    }
    case "review": {
      if (!answer.id) return null;
      const versions = list(answer.versions).filter((v) => !v.removed);
      const newest = versions.filter((v) => v.status === "ready").at(-1);
      const poster = newest ? sign("rt", answer.id, newest.n) : undefined;
      return {
        kind: "review",
        title: text(answer.name, 200),
        approval: answer.approval,
        href: answer.link,
        open: "Open in Review",
        versions: versions.length,
        ...(newest ? { v: newest.n, poster, play: sign("rp", answer.id, newest.n) } : {}),
        // the frames the answer carries for its comments are shown only where pictures may leave this install
        frames: !!poster,
        comments: list(answer.comments).slice(0, 40).map((c) => ({
          id: c.id,
          // a card shows whole seconds: 0:03.20–0:05.00 reads as 0:03–0:05
          at: typeof c.at === "string" ? c.at.replace(/\.\d+/g, "") : undefined,
          t: typeof c.start === "number" ? c.start : undefined,
          text: text(c.text, 400),
          author: text(c.author, 60),
          v: c.version,
          resolved: !!c.resolved,
          replies: list(c.replies).length,
        })),
      };
    }
    case "edit": {
      if (!answer.id) return null;
      const jobs = list(answer.jobs);
      return {
        kind: "edit",
        id: answer.id,
        title: text(answer.name, 200),
        href: answer.link,
        open: "Open the edit",
        // just started (editor_create), or a step is waiting or running
        running: answer.status === "started" || jobs.some((j) => j.state === "queued" || j.state === "running"),
        failed: jobs.some((j) => j.state === "failed" || j.state === "needs_key"),
        // a version whose preview is in Review opens there
        drafts: list(answer.drafts).slice(0, 12).map((d) => ({ name: d.name, title: text(d.title, 120), preview: d.preview, ...(typeof d.review === "string" && d.review.startsWith("/review/") ? { href: `${origin}${d.review}` } : {}) })),
      };
    }
    case "posts": {
      const posts = list(answer.posts);
      if (!answer.account) return null;
      return {
        kind: "posts",
        title: `@${String(answer.account).replace(/^@/, "")}`,
        href: `${origin}/instagram`,
        total: posts.length,
        ...(posts.length ? {} : { empty: "No posts in that range yet. Ask for a refresh to pull the account's newest posts." }),
        items: posts.slice(0, 30).map((p) => ({ text: text(p.caption, 200), when: text(p.when, 10), type: p.kind, href: typeof p.url === "string" && p.url.startsWith("https://") ? p.url : undefined, plays: p.plays, likes: p.likes, comments: p.comments })),
      };
    }
    default:
      return null;
  }
}
