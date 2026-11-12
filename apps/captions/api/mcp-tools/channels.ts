import { pick, sleep, when, type Args, type ToolModule } from "./types";

// The connected social accounts (Settings → Social accounts): their numbers and recent posts, through api/connectors.ts's
// own routes. Numbers are read when they are asked for: a login read over an hour ago is read again first (free,
// official APIs); an account added by handle only on refresh, since each read spends the user's Apify.

const STALE_MS = 60 * 60_000;
const WAIT_MS = 30_000;

export const channelsTools: ToolModule = {
  defs: [
    {
      name: "channel_posts",
      description:
        "The user's connected social accounts (TikTok, YouTube, Facebook, X, Instagram logins): followers, views, last read, read error, recent posts with their numbers. A login read over an hour ago is read again first; refresh=true reads all now (a handle read spends the user's Apify).",
      inputSchema: { type: "object", properties: { platform: { type: "string" }, refresh: { type: "boolean" } } },
    },
  ],
  handlers: {
    channel_posts: async (a, ctx) => {
      const mine = async () => (await ctx.json<{ accounts: Args[] }>("/api/connectors")).accounts.filter((x) => !a.platform || x.platform === String(a.platform).toLowerCase());
      let accounts = await mine();
      const stale = accounts.filter((x) => a.refresh === true || (x.via === "login" && x.loginStatus !== "needs_reconnect" && Date.now() - Number(x.pulledAt ?? 0) > STALE_MS));
      const before = new Map(stale.map((x) => [String(x.key), x.pulledAt]));
      for (const x of stale) await ctx.json(`/api/connectors/accounts/${encodeURIComponent(String(x.key))}/pull`, "POST");
      // the reads run on the server: look again until each is done, at most WAIT_MS (a slower one says "reading")
      for (const end = Date.now() + WAIT_MS; before.size && Date.now() < end; ) {
        await sleep(1000);
        accounts = await mine();
        if (accounts.every((x) => !before.has(String(x.key)) || before.get(String(x.key)) !== x.pulledAt)) break;
      }
      if (!accounts.length) return { accounts: [], note: "No social account connected: Settings → Social accounts." };
      return {
        accounts: accounts.map((x) => ({
          platform: x.platform,
          handle: x.handle,
          via: x.via,
          status: before.has(String(x.key)) && before.get(String(x.key)) === x.pulledAt ? "reading" : (x.loginStatus ?? "connected"),
          read: when(x.pulledAt),
          ...pick(x, ["pullError"]),
          stats: pick((x.stats ?? {}) as Args, ["followers", "following", "posts", "views", "likes"]),
          posts: ((x.posts as Args[] | undefined) ?? []).map((p) => ({ when: when(p.at), ...pick(p, ["views", "likes", "comments", "shares", "saves", "url"]), text: String(p.text ?? "").slice(0, 200) })),
        })),
      };
    },
  },
  steps: { channel_posts: "Reading your social accounts" },
};
