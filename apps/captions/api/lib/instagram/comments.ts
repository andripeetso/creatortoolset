import { DESKTOP_UA, markInvalid, type StoredSession } from "./session";
import type { Comment, CommentsStatus } from "./types";
import { InstagramError } from "./web-api";

/**
 * Comments come from Instagram's own web client: a headless Chromium
 * (playwright-chromium, already deployed for caption renders) opens the
 * post with the burner session, keeps loading more comments, and we read
 * every GraphQL answer the page receives. Nothing here depends on the
 * rotating doc_id or the DOM layout of the comment list — only on the
 * answer shape, which `ingestCommentsPayload` walks generically.
 */

export interface CommentStore {
  top: Map<string, Comment>;
  replies: Map<string, Map<string, Comment>>;
  hasNext: boolean | null;
  endCursor?: string;
  /** Responses that carried comment nodes. */
  hits: number;
}

export function newCommentStore(): CommentStore {
  return { top: new Map(), replies: new Map(), hasNext: null, hits: 0 };
}

export function storeSize(store: CommentStore): number {
  let n = store.top.size;
  for (const m of store.replies.values()) n += m.size;
  return n;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function toComment(node: Rec): Comment | null {
  const user = isRec(node.user) ? node.user : null;
  const username = user && typeof user.username === "string" ? user.username : "";
  const id = String(node.pk ?? node.id ?? "");
  const text = typeof node.text === "string" ? node.text : "";
  if (!id || !username || (!text && !node.created_at)) return null;
  const created = num(node.created_at ?? node.created_at_utc);
  return {
    id,
    text,
    createdAt: created > 1e12 ? created : created * 1000,
    user: { username, id: String(user!.pk ?? user!.id ?? "") },
    likeCount: num(node.comment_like_count ?? node.like_count),
    replyCount: num(node.child_comment_count),
    replies: [],
  };
}

const looksLikeComment = (node: Rec) =>
  ("pk" in node || "id" in node) && "text" in node && isRec(node.user);

function addTo(store: CommentStore, c: Comment, parentId?: string): void {
  if (parentId) {
    let m = store.replies.get(parentId);
    if (!m) {
      m = new Map();
      store.replies.set(parentId, m);
    }
    if (!m.has(c.id)) m.set(c.id, c);
    return;
  }
  const existing = store.top.get(c.id);
  if (!existing) store.top.set(c.id, c);
  else if (!existing.text && c.text) store.top.set(c.id, c);
}

function ingestNode(store: CommentStore, node: Rec, parentId?: string): number {
  const c = toComment(node);
  if (!c) return 0;
  let added = 1;
  const parent = parentId ?? (typeof node.parent_comment_id === "string" ? node.parent_comment_id : undefined);
  addTo(store, c, parent);
  const previews = node.preview_child_comments ?? node.child_comments;
  if (Array.isArray(previews)) {
    for (const child of previews) {
      if (isRec(child) && looksLikeComment(child)) added += ingestNode(store, child, c.id);
    }
  }
  return added;
}

/**
 * Walk any JSON the page received and pull comment nodes out of it:
 * `edges[].node`, bare `comments[]` arrays, single `comment` objects.
 * `page_info` next to a comment connection updates the top-level cursor
 * unless the payload belongs to a replies query (parentId given).
 */
export function ingestCommentsPayload(
  json: unknown,
  store: CommentStore,
  opts: { parentId?: string } = {},
): number {
  let added = 0;
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || !value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const rec = value as Rec;
    if (looksLikeComment(rec)) {
      added += ingestNode(store, rec, opts.parentId);
      return;
    }
    if (Array.isArray(rec.edges)) {
      let commentEdges = 0;
      for (const edge of rec.edges) {
        const node = isRec(edge) && isRec(edge.node) ? edge.node : null;
        if (node && looksLikeComment(node)) {
          added += ingestNode(store, node, opts.parentId);
          commentEdges++;
        } else if (node) {
          walk(node, depth + 1);
        }
      }
      if (commentEdges && !opts.parentId && isRec(rec.page_info)) {
        const pi = rec.page_info;
        if (typeof pi.has_next_page === "boolean") store.hasNext = pi.has_next_page;
        if (typeof pi.end_cursor === "string" && pi.end_cursor) store.endCursor = pi.end_cursor;
      }
      for (const [k, v] of Object.entries(rec)) {
        if (k !== "edges" && k !== "page_info") walk(v, depth + 1);
      }
      return;
    }
    if (!opts.parentId && Array.isArray(rec.comments) && typeof rec.next_min_id === "string") {
      store.endCursor = rec.next_min_id;
      store.hasNext = true;
    }
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  walk(json, 0);
  if (added) store.hits++;
  return added;
}

/** Top-level comments with their replies attached, in the order seen. */
export function finalizeComments(store: CommentStore): Comment[] {
  const out: Comment[] = [];
  for (const c of store.top.values()) {
    const replies = store.replies.get(c.id);
    out.push({ ...c, replies: replies ? [...replies.values()] : [] });
  }
  return out;
}

/** Merge a fresh collection into a stored one, deduping by id. */
export function mergeComments(existing: Comment[], fresh: Comment[]): Comment[] {
  const byId = new Map<string, Comment>();
  for (const c of [...existing, ...fresh]) {
    const prev = byId.get(c.id);
    if (!prev) {
      byId.set(c.id, { ...c, replies: [...(c.replies ?? [])] });
      continue;
    }
    const seen = new Set(prev.replies.map((r) => r.id));
    for (const r of c.replies ?? []) if (!seen.has(r.id)) prev.replies.push(r);
    if (c.likeCount > prev.likeCount) prev.likeCount = c.likeCount;
    if (c.replyCount > prev.replyCount) prev.replyCount = c.replyCount;
  }
  return [...byId.values()];
}

export const countReplies = (list: Comment[]): number =>
  list.reduce((n, c) => n + (c.replies?.length ?? 0), 0);

export interface CollectOptions {
  shortcode: string;
  session: StoredSession;
  /** App user whose session we mark invalid on a login wall. */
  username: string;
  /** Stop once this many comments (top-level + replies) are stored. */
  cap: number;
  /** Instagram's comment_count, to recognise a complete collection. */
  expectedTotal?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface CollectResult {
  comments: Comment[];
  status: CommentsStatus;
  cursor?: string;
  /** Why collection stopped — for logs and warnings. */
  reason: "exhausted" | "cap" | "idle" | "timeout" | "expected";
}

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

let browserGate: Promise<unknown> = Promise.resolve();

/** One browser at a time: Chromium is heavy and Instagram is watchful. */
function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  const next = browserGate.then(fn, fn);
  browserGate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const cancelled = () => new InstagramError("Cancelled", "CANCELLED", false);

type ScrollEl = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

function jitter(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function collectComments(opts: CollectOptions): Promise<CollectResult> {
  return withBrowserSlot(() => collectCommentsNow(opts));
}

async function collectCommentsNow(opts: CollectOptions): Promise<CollectResult> {
  const log = opts.log ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const { chromium } = await import("playwright-chromium").catch(() => {
    throw new InstagramError(
      "playwright-chromium is not installed on the server — comments are unavailable",
      "FAILED",
      false,
    );
  });
  if (opts.signal?.aborted) throw cancelled();

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const store = newCommentStore();
  let reason: CollectResult["reason"] = "idle";
  try {
    const context = await browser.newContext({
      userAgent: DESKTOP_UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    context.setDefaultTimeout(10_000);
    await context.addCookies(
      opts.session.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: ".instagram.com",
        path: "/",
        secure: true,
        sameSite: "Lax" as const,
      })),
    );
    const page = await context.newPage();
    const onAbort = () => void page.close().catch(() => {});
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    page.on("response", (res) => {
      void (async () => {
        try {
          const req = res.request();
          if (!req.url().includes("/graphql/query")) return;
          const post = req.postData() || "";
          if (!/comment/i.test(post)) return;
          const params = new URLSearchParams(post);
          let vars: Rec = {};
          try {
            vars = JSON.parse(params.get("variables") || "{}") as Rec;
          } catch {
            /* ignore */
          }
          const parentId =
            typeof vars.comment_id === "string" && vars.comment_id
              ? vars.comment_id
              : undefined;
          const json = await res.json().catch(() => null);
          if (!json) return;
          const added = ingestCommentsPayload(json, store, { parentId });
          if (added) {
            log(
              `${params.get("fb_api_req_friendly_name") || "graphql"}: +${added} (${storeSize(store)} total)`,
            );
          }
        } catch {
          /* a response we could not read — ignore */
        }
      })();
    });

    await page.goto(`https://www.instagram.com/p/${encodeURIComponent(opts.shortcode)}/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(jitter(2500, 3500));
    if (opts.signal?.aborted) throw cancelled();

    if (
      /\/accounts\/login/.test(page.url()) ||
      (await page.locator('input[name="username"]').count()) > 0
    ) {
      await markInvalid(opts.username, "Login wall while collecting comments");
      throw new InstagramError(
        "Instagram showed the login page — the burner session is expired or logged out",
        "SESSION",
        false,
      );
    }
    if (/checkpoint|challenge/.test(page.url())) {
      await markInvalid(opts.username, "Checkpoint while collecting comments");
      throw new InstagramError(
        "Instagram is asking the burner account to verify itself — log in from a browser, complete the check, then paste fresh cookies",
        "BLOCKED",
        false,
      );
    }

    // The first page of comments may be inlined into the HTML rather
    // than fetched — harvest the embedded JSON too.
    const inline = await page
      .evaluate(() => {
        const { document } = globalThis as unknown as {
          document: {
            querySelectorAll: (sel: string) => ArrayLike<{ textContent: string | null }>;
          };
        };
        return Array.from(document.querySelectorAll('script[type="application/json"]'))
          .map((s) => s.textContent || "")
          .filter((t) => t.includes("comment"));
      })
      .catch(() => [] as string[]);
    for (const text of inline) {
      try {
        ingestCommentsPayload(JSON.parse(text), store);
      } catch {
        /* not JSON we care about */
      }
    }

    // Reels open in a viewer where comments live in a side drawer.
    if (/\/reels?\//.test(page.url())) {
      const btn = page.locator('svg[aria-label="Comment"]').first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 5_000 }).catch(() => {});
        await page.waitForTimeout(jitter(1500, 2500));
      }
    }

    const scrollLists = () =>
      page
        .evaluate(() => {
          const g = globalThis as unknown as {
            document: { querySelectorAll: (sel: string) => ArrayLike<ScrollEl> };
            getComputedStyle: (el: ScrollEl) => { overflowY: string };
            scrollBy: (x: number, y: number) => void;
          };
          const els = Array.from(g.document.querySelectorAll("div, ul, section")).filter((e) => {
            const s = g.getComputedStyle(e);
            return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 40;
          });
          els.sort((a, b) => b.scrollHeight - a.scrollHeight);
          for (const e of els.slice(0, 3)) e.scrollTop = e.scrollHeight;
          g.scrollBy(0, 4000);
        })
        .catch(() => {});

    const deadline = Date.now() + timeoutMs;
    let idle = 0;
    let last = storeSize(store);
    reason = "idle";
    for (;;) {
      if (opts.signal?.aborted) throw cancelled();
      if (storeSize(store) >= opts.cap) {
        reason = "cap";
        break;
      }
      if (store.hasNext === false) {
        reason = "exhausted";
        break;
      }
      if (
        opts.expectedTotal !== undefined &&
        storeSize(store) >= opts.expectedTotal
      ) {
        reason = "expected";
        break;
      }
      if (Date.now() > deadline) {
        reason = "timeout";
        break;
      }
      const loadMore = page.locator('svg[aria-label="Load more comments"]').first();
      if ((await loadMore.count().catch(() => 0)) > 0) {
        await loadMore.click({ timeout: 3_000 }).catch(() => {});
      } else {
        await scrollLists();
      }
      await page.waitForTimeout(jitter(900, 1600));
      const now = storeSize(store);
      if (now === last) {
        idle++;
        if (idle >= 4) {
          reason = "idle";
          break;
        }
      } else {
        idle = 0;
        last = now;
      }
    }

    // Expand reply threads that were only previewed.
    if (reason !== "cap" && !opts.signal?.aborted) {
      for (let round = 0; round < 3; round++) {
        const buttons = page.locator("text=/view (all )?\\d+ (more )?repl/i");
        const n = await buttons.count().catch(() => 0);
        if (!n) break;
        for (let i = 0; i < Math.min(n, 12); i++) {
          if (storeSize(store) >= opts.cap || opts.signal?.aborted) break;
          await buttons.nth(i).click({ timeout: 2_000 }).catch(() => {});
          await page.waitForTimeout(jitter(500, 900));
        }
        if (storeSize(store) >= opts.cap) break;
      }
      await page.waitForTimeout(800);
    }
    opts.signal?.removeEventListener("abort", onAbort);
  } finally {
    await browser.close().catch(() => {});
  }

  const comments = finalizeComments(store);
  const size = storeSize(store);
  if (!size && !store.hits) {
    throw new InstagramError(
      "No comment data was captured from the page — Instagram may have changed its layout",
      "FAILED",
      true,
    );
  }
  const complete =
    reason === "exhausted" ||
    reason === "expected" ||
    (opts.expectedTotal !== undefined && size >= opts.expectedTotal * 0.95);
  const status: CommentsStatus = complete ? "complete" : "capped";
  log(`stopped: ${reason} — ${comments.length} comments, ${countReplies(comments)} replies`);
  return { comments, status, cursor: store.endCursor, reason };
}
