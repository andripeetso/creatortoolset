/**
 * Connected social accounts (api/connectors.ts), shared by the API and the browser. A platform is read through the
 * account's own login (official API, its numbers) or by handle through the user's own Apify token (public numbers).
 */

export type SocialPlatform = "instagram" | "facebook" | "youtube" | "tiktok" | "x";

/** The logins a user can start: each needs the app registered on our side (env), see api/lib/connectors/oauth.ts. */
export type LoginKind = "meta" | "google" | "tiktok";

export const PLATFORMS: Array<{ id: SocialPlatform; label: string; login?: LoginKind; scrape: boolean }> = [
  { id: "instagram", label: "Instagram", login: "meta", scrape: true },
  { id: "facebook", label: "Facebook", login: "meta", scrape: true },
  { id: "youtube", label: "YouTube", login: "google", scrape: true },
  { id: "tiktok", label: "TikTok", login: "tiktok", scrape: true },
  { id: "x", label: "X", scrape: true },
];

export const LOGINS: Array<{ id: LoginKind; label: string; gives: string }> = [
  { id: "meta", label: "Instagram & Facebook", gives: "Instagram professional accounts and Facebook Pages: insights, reach, saves, shares, comments" },
  { id: "google", label: "YouTube", gives: "your channels: subscribers, views, watch time per day, every upload's numbers" },
  { id: "tiktok", label: "TikTok", gives: "your profile: followers, likes, every video's views, likes, comments, shares" },
];

export interface SocialPost {
  id: string;
  url?: string;
  at: number;
  text: string;
  kind?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
  /** Seconds, for videos. */
  duration?: number;
  /** The video's own URL, when the login gives one (Instagram). Server only: read once for the duplicate check, never sent to the browser. */
  mediaUrl?: string;
}

export interface SocialStats {
  followers?: number;
  following?: number;
  posts?: number;
  views?: number;
  likes?: number;
  /** Daily numbers the login's analytics give (YouTube Analytics, Page insights), newest last. */
  days?: Array<{ day: string; views?: number; watchMinutes?: number; followersGained?: number; reach?: number; engagements?: number; videoViews?: number }>;
}

/** A YouTube video from the channel's own analytics (every video, over the channel's lifetime). `kind` is the API's creatorContentType. */
export interface SocialVideo {
  id: string;
  kind: string;
  views?: number;
  watchMinutes?: number;
  averageViewSeconds?: number;
  averageViewPercent?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  subscribersGained?: number;
  /** Audience retention for the newest videos only, at each point of the length: `elapsed` is 0 to 1, `watch` the audience watch ratio (share of views still playing there), `relative` the retention against similar-length videos. */
  retention?: Array<{ elapsed: number; watch?: number; relative?: number }>;
}

/** A login's state. Written only by the pull (api/connectors.ts `pullOne`); missing on rows from before it existed = connected. */
export type LoginStatus = "connected" | "needs_reconnect" | "error";

export interface ConnectedAccount {
  /** `${platform}:${platformId}` */
  key: string;
  platform: SocialPlatform;
  platformId: string;
  handle: string;
  name?: string;
  avatar?: string;
  via: "login" | "apify";
  /** Which project this account is (missing = not linked). */
  projectId?: string;
  connectedAt: number;
  loginExpiresAt?: number;
  loginStatus?: LoginStatus;
  pulledAt?: number;
  pullError?: string;
  pulling?: boolean;
  stats?: SocialStats;
  posts?: SocialPost[];
  /** YouTube login: every video's analytics, Shorts and long videos by `kind`. */
  videos?: SocialVideo[];
  /** The Analyzer account an Instagram login fills (its deep view: catalog, comments, insights). */
  analyzerId?: string;
}

/** A source a server plug-in reads through a session login. Its words are the plug-in's own, shown under "Turn on extra things". */
export interface SessionSource {
  id: string;
  label: string;
  hint: string;
}

export interface OwnInstagram {
  /** The Analyzer account's id. */
  id: string;
  handle: string;
  followers?: number;
  /** The Analyzer's "my account" flag (read through the server's own Instagram token where it has one). */
  mine: boolean;
  /** The project that links it as its Instagram. */
  projectId?: string;
}

export interface ConnectorsView {
  /** Which logins a person can ask for here: this server has an app registered, or a sign-in service is set that may offer it. */
  logins: Record<LoginKind, boolean>;
  /**
   * Of those, the ones only the sign-in service can give. It is not asked for a list: the page asks when the person
   * presses Add (GET /api/connectors/apps/<kind>), and says so on the row if the service does not offer the platform.
   */
  viaService?: LoginKind[];
  /** The person's own Instagram accounts in the Content Analyzer: the one marked Mine, and each project's linked one. */
  instagram: OwnInstagram[];
  apify: { configured: boolean; valid: boolean | null };
  /** A YouTube Data API key serves this person: public channels are read through YouTube's own API, not Apify. */
  youtubeKey?: boolean;
  accounts: ConnectedAccount[];
  /** Session sources registered on this server. Empty in the public build, so the section stays hidden. */
  extras: { sessions: SessionSource[] };
}
