// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/lib/auth";
import { clearLocalCache } from "@/lib/local-cache";
import type { InstagramAccount, InstagramPost, QueueView } from "@/lib/instagram";
import { PostCard } from "@/components/instagram/PostCard";
import { QueueMenu } from "@/components/instagram/QueueMenu";

// The Content Analyzer's home, a card and the account header in a DOM, against a stubbed server: the rules the
// redesign was built on and that slipped before (one mark for "your account", a quiet card, plain failure words).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: InstagramPage } = await import("./InstagramPage");
const { default: InstagramAccountPage } = await import("./InstagramAccountPage");

/** Words that are the code's, never what a person reads (REPORT line 13). */
const BANNED = /catalog|pulled|\bsync|ingest|\bjobs?\b|workers?/i;

const account = (over: Partial<InstagramAccount>): InstagramAccount => ({
  id: "acc-own",
  igUserId: "1",
  username: "tinyacrobatics",
  fullName: "Tiny Acrobatics",
  counts: { followers: 12_300, posts: 40, fetchedAt: 1 },
  lastCatalogAt: 1,
  owner: "local",
  tags: [],
  status: "ready",
  progress: 1,
  createdAt: 1,
  updatedAt: 1,
  libraryCount: 3,
  ...over,
});

const post = (over: Partial<InstagramPost>): InstagramPost => ({
  id: "post-1",
  status: "ready",
  progress: 1,
  input: "https://www.instagram.com/reel/abc/",
  url: "https://www.instagram.com/reel/abc/",
  shortcode: "abc",
  mediaId: "m1",
  kind: "reel",
  creator: { username: "otheraccount", id: "2" },
  takenAt: 1_790_000_000_000,
  caption: "A rolling game for the living room",
  counts: { plays: 4200, likes: 300, fetchedAt: 1 },
  slides: [{ kind: "video", durationS: 43, thumb: "thumbs/00.jpg", vision: {} } as InstagramPost["slides"][number]],
  comments: { status: "skipped", count: 0, replies: 0 },
  bytes: 0,
  createdAt: 1,
  updatedAt: 1,
  hasComments: false,
  ideaStatus: "inbox",
  savedFor: ["content"],
  rank: 4,
  tags: [{ id: "t1", label: "rolling-games", kind: "topic" } as NonNullable<InstagramPost["tags"]>[number]],
  ...over,
});

const failed = post({
  id: "post-failed",
  status: "error",
  error: "Download failed: fetch failed (ETIMEDOUT)",
  jobs: [{ type: "media", status: "error" } as NonNullable<InstagramPost["jobs"]>[number]],
  slides: [{ kind: "video", durationS: 30, vision: {} } as InstagramPost["slides"][number]],
  caption: "Tummy time without tears",
});

let server: {
  accounts: InstagramAccount[];
  posts: InstagramPost[];
  /** Every post in the project, whatever list it is on (?shelf=all); the listed posts when unset. */
  all?: InstagramPost[];
  queue: QueueView;
  account?: InstagramAccount;
  canRead: boolean;
};
let root: Root | null = null;

beforeEach(() => {
  // each test starts with nothing saved on the device (the lists' cache keeps a copy in memory too)
  clearLocalCache();
  localStorage.clear();
  server = {
    accounts: [account({ own: true }), account({ id: "acc-other", username: "otheraccount", fullName: "Other", own: false })],
    posts: [post({}), failed],
    queue: { running: 0, max: 4, items: [] },
    canRead: true,
  };
  useAuth.setState({ required: false, me: { username: "local", role: "admin", cloud: false, off: [] } });
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(input, "http://x");
    const path = url.pathname;
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path === "/api/instagram") return reply(url.searchParams.get("shelf") === "all" ? (server.all ?? server.posts) : server.posts);
    if (path === "/api/instagram/accounts") return reply(server.accounts);
    if (path.startsWith("/api/instagram/accounts/")) return reply(server.account ?? server.accounts[0]);
    if (path === "/api/instagram/queue") return reply(server.queue);
    if (path === "/api/instagram/availability")
      return reply({ available: server.canRead, allowed: true, ai: true, apify: { configured: server.canRead, valid: server.canRead || null }, graph: { configured: false } });
    if (path === "/api/instagram/stacks" || path === "/api/workshop/sessions") return reply([]);
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
  return host;
}

const page = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/instagram" element={<InstagramPage />} />
      <Route path="/instagram/accounts/:accountId" element={<InstagramAccountPage />} />
    </Routes>
  </MemoryRouter>
);

/** How often "your account" (or the old Mine / My account) is said, in the text and in the names a screen reader reads. */
const mineMarks = (host: HTMLElement) => {
  const said = [...host.querySelectorAll("*")].flatMap((el) => [
    ...[...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? ""),
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
  ]);
  return said.filter((s) => /your account|\bmine\b|my account/i.test(s) && !/add your account/i.test(s));
};

describe("Content Analyzer home", () => {
  it("says your account once, beside the paste box, and leaves it out of the accounts count", async () => {
    const host = await mount(page("/instagram"));
    expect(host.textContent).toContain("@tinyacrobatics");
    expect(mineMarks(host)).toEqual(["Your account, @tinyacrobatics"]);
    expect(host.textContent).toContain("1 account");
    expect(host.textContent).not.toMatch(/2 accounts/);
  });

  it("shows none of the code's words", async () => {
    const host = await mount(page("/instagram"));
    expect(host.textContent).toContain("Inbox");
    expect(host.textContent).not.toMatch(BANNED);
  });

  it("offers Add your account once there are posts and the app does not know which is yours", async () => {
    server.accounts = server.accounts.map((a) => ({ ...a, own: false }));
    const host = await mount(page("/instagram"));
    expect(host.textContent).toContain("Add your account");
    expect(mineMarks(host)).toEqual([]);
  });

  it("keeps the filters away until there is a post: an account alone is the paste box and the account", async () => {
    server.accounts = [account({ own: true })];
    server.posts = [];
    const host = await mount(page("/instagram"));
    expect(host.textContent).toContain("@tinyacrobatics");
    expect(host.querySelector('[aria-label="Status"]')).toBeNull();
    expect(host.textContent).not.toContain("Add your account");
    expect(host.textContent).not.toContain("Collect posts you like");
  });

  it("keeps the filters when the project holds posts the chosen list hides", async () => {
    server.accounts = [];
    server.posts = [];
    server.all = [post({ ideaStatus: "done" })];
    const host = await mount(page("/instagram"));
    expect(host.querySelector('[aria-label="Status"]')).not.toBeNull();
    expect(host.textContent).not.toContain("Collect posts you like");
  });

  it("offers no Try again on a failed post while posts can't be read: one amber line says so, with Set up", async () => {
    server.canRead = false;
    const host = await mount(page("/instagram"));
    expect(host.textContent).toContain("Couldn’t download");
    expect(host.textContent).not.toContain("Try again");
    expect(host.textContent?.match(/Can’t read/g)).toHaveLength(1);
    expect(host.textContent).toContain("Set up");
  });

  it("is the name, one line and the paste box for a project with nothing in it", async () => {
    server.accounts = [];
    server.posts = [];
    const host = await mount(page("/instagram"));
    expect(host.textContent).toContain("Collect posts you like. The AI works out the idea in each one. You rank them.");
    expect(host.querySelector('[aria-label="Status"]')).toBeNull();
    expect(host.textContent).not.toContain("Add your account");
  });
});

describe("Account page", () => {
  it("says your account once, and no Mine, verified or code words in the header", async () => {
    server.account = account({ own: true, isVerified: true, posts: [], catalog: [] });
    const host = await mount(page("/instagram/accounts/acc-own"));
    expect(host.textContent).toContain("@tinyacrobatics");
    expect(mineMarks(host)).toEqual(["Your account"]);
    expect(host.textContent).not.toMatch(/verified/i);
    expect(host.textContent).toContain("Update");
    expect(host.textContent).not.toMatch(BANNED);
  });
});

describe("Post card", () => {
  const card = (p: InstagramPost, onRetry = vi.fn(async () => {})) =>
    mount(
      <MemoryRouter>
        <PostCard post={p} selected={false} anySelected={false} onSelect={() => {}} onOpen={() => {}} onMark={() => {}} onRetry={onRetry} />
      </MemoryRouter>,
    );

  it("at rest is the post: no status menu, kept-for chips, tags or stars to click", async () => {
    const host = await card(post({}));
    expect(host.querySelector("select")).toBeNull();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.textContent).not.toMatch(/Content|Format|Know-how|rolling-games|Inbox/);
    expect(host.textContent).toContain("00:43");
    expect(host.textContent).not.toMatch(BANNED);
  });

  it("brings up the rating and Skip / To make with the keyboard's focus", async () => {
    const host = await card(post({}));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.focus());
    expect(host.querySelector('[role="radiogroup"][aria-label="Rating"]')).not.toBeNull();
    expect(host.textContent).toContain("To make");
  });

  it("a failed download says so in plain words, with Try again and no raw error", async () => {
    const onRetry = vi.fn(async () => {});
    const host = await card(failed, onRetry);
    expect(host.textContent).toContain("Couldn’t download");
    expect(host.textContent).not.toMatch(/ETIMEDOUT|fetch failed|Download failed|Failed/);
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => again.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("Post card, Try again refused", () => {
  it("says it couldn't, in plain words, never the server's reason", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onRetry = vi.fn(async () => {
      throw new Error("Apify token is invalid or expired");
    });
    await act(async () =>
      root!.render(
        <MemoryRouter>
          <PostCard post={failed} selected={false} anySelected={false} onSelect={() => {}} onOpen={() => {}} onMark={() => {}} onRetry={onRetry} />
        </MemoryRouter>,
      ),
    );
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => again.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Couldn’t try again");
    expect(host.textContent).not.toMatch(/Apify|token/);
  });
});

describe("Queue chip", () => {
  const chip = () =>
    mount(
      <MemoryRouter>
        <QueueMenu base="/instagram" />
      </MemoryRouter>,
    );

  it("renders nothing when nothing runs or needs you", async () => {
    const host = await chip();
    expect(host.innerHTML).toBe("");
  });

  it("is an amber dot, not a count of failures, when something failed", async () => {
    server.queue = {
      running: 0,
      max: 4,
      items: [{ kind: "post", id: "p", label: "@tinyacrobatics", detail: "Tummy time", state: "failed", progress: 0, jobs: ["media"], error: "fetch failed" }],
    };
    const host = await chip();
    expect(host.textContent).toBe("Queue");
    expect(host.querySelector('[aria-label="Something failed"]')).not.toBeNull();
  });
});
