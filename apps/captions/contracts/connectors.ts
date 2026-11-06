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
}

export interface SocialStats {
  followers?: number;
  following?: number;
  posts?: number;
  views?: number;
  likes?: number;
  /** Daily numbers the login's analytics give (YouTube Analytics, Page insights), newest last. */
  days?: Array<{ day: string; views?: number; watchMinutes?: number; followersGained?: number; reach?: number }>;
}

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
  pulledAt?: number;
  pullError?: string;
  pulling?: boolean;
  stats?: SocialStats;
  posts?: SocialPost[];
  /** The Analyzer account an Instagram login fills (its deep view: catalog, comments, insights). */
  analyzerId?: string;
}

export interface ConnectorsView {
  /** Which logins this server has an app registered for. */
  logins: Record<LoginKind, boolean>;
  /** Where each login sends people back, for registering the apps (admins). */
  redirects: Record<LoginKind, string>;
  apify: { configured: boolean; valid: boolean | null };
  accounts: ConnectedAccount[];
}
