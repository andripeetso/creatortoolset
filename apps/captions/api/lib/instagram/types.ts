/**
 * Shared types for the Instagram tool (api/instagram.ts and its lib/).
 * Everything here is persisted as-is in meta.json / comments.json, so
 * keep it JSON-plain.
 */
import type { Moves } from "../transition";

export type PostStatus = "processing" | "ready" | "error";

/** A post's or an account's run. Changed only through `move()`; a restart's reconciliation runs in `resumeInterrupted`. */
export const POST_STATUS_MOVES: Moves<PostStatus> = {
  processing: ["ready", "error"],
  ready: ["processing"],
  error: ["processing"],
};

export type PostStep =
  | "queued"
  | "resolve"
  | "info"
  | "download"
  | "thumbs"
  | "transcribe"
  | "vision"
  | "comments"
  | "idea";

export type PartStatus = "pending" | "done" | "skipped" | "error";

export type PostKind = "reel" | "post" | "carousel";

export type SlideKind = "image" | "video";

/** who read the pictures: a provider instance id, "anthropic" (the API key), or "kimi"/"openai" on old posts */
export type VisionProvider = string;

export type CommentsStatus =
  | "pending"
  | "complete"
  | "capped"
  | "failed"
  | "skipped";

export interface SlideTranscript {
  status: PartStatus;
  words?: number;
  error?: string;
}

export interface SlideVision {
  status: PartStatus;
  onScreenText?: string;
  /** none, only subtitles of what is said, or text of its own (read since 2026-11-05; older slides have none) */
  textKind?: "none" | "captions" | "text";
  description?: string;
  /** Slide 1 only: the opening line as written on the slide. */
  hook?: string;
  /** Video slides: how many sampled frames were sent to the model. */
  frames?: number;
  provider?: VisionProvider;
  error?: string;
}

export interface Slide {
  /** 0-based; carousel order is preserved. */
  index: number;
  kind: SlideKind;
  /** Relative to the post directory, e.g. "media/03.mp4". */
  file: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  durationS?: number;
  hasAudio?: boolean;
  /** Relative to the post directory, e.g. "thumbs/03.jpg". */
  thumb?: string;
  /** Instagram's own alt text when present. */
  accessibilityCaption?: string;
  /** Per-slide caption, when the creator wrote one for this slide. */
  caption?: string;
  transcript: SlideTranscript;
  vision: SlideVision;
  /** Perceptual hash, so a repost of the same media is recognised. */
  fingerprint?: MediaFingerprint;
}

/** dHash per sampled frame (16 hex chars each; images have one) and the video duration. */
export interface MediaFingerprint {
  h: string[];
  d?: number;
}

export interface PostCreator {
  username: string;
  fullName?: string;
  id: string;
}

export interface PostCounts {
  likes?: number;
  comments?: number;
  /** Reels only. */
  plays?: number;
  fetchedAt: number;
}

export interface CommentsSummary {
  status: CommentsStatus;
  /** Top-level comments stored. */
  count: number;
  /** Replies stored. */
  replies: number;
  /** Comments hidden by the low-value filter. */
  filteredOut?: number;
  /** Real questions the creator could answer (Jev). */
  questions?: number;
  /** One-word replies to a call to action ("Blueprint", "Recipe"). */
  keywords?: number;
  error?: string;
  fetchedAt?: number;
}

export type JobType =
  | "info"
  | "stats"
  | "media"
  | "transcript"
  | "vision"
  | "comments"
  | "tags"
  | "idea";

export type AccountJobType = "profile" | "catalog" | "stats" | "tags";

export type JobStatus = "idle" | "pending" | "running" | "done" | "skipped" | "error";

/** A job record's moves. A failed job can be queued again (Retry); "done" and "skipped" are final until a force. */
export const JOB_STATUS_MOVES: Moves<JobStatus> = {
  idle: ["pending"],
  pending: ["running", "skipped", "error", "idle"],
  running: ["done", "skipped", "error", "pending"],
  done: ["pending", "running", "idle"],
  skipped: ["pending", "running", "idle"],
  error: ["pending", "running", "idle"],
};

export type RecipePreset = "stats" | "watch" | "full" | "custom";

export type RunWhen = "now" | "later";

export type PostSource = "paste" | "account-catalog" | "share";

export type TagKind = "topic" | "format" | "hook" | "cta" | "audience" | "custom";

/** Competitor-research mark: have you used this idea yet. */
export type IdeaStatus = "inbox" | "idea" | "done" | "skip";

/** Why the post is in the library — the idea, the layout, or both. */
export type SavedFor = "content" | "format";

export interface Recipe {
  preset: RecipePreset;
  jobs: JobType[];
}

export interface JobRecord {
  type: JobType;
  status: JobStatus;
  requestedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface Snapshot {
  at: number;
  source: "apify" | "session" | "graph";
  likes?: number;
  comments?: number;
  plays?: number;
  followers?: number;
  following?: number;
  posts?: number;
}

export interface Tag {
  id: string;
  label: string;
  kind: TagKind;
  source: "ai" | "user";
  confidence?: number;
}

/** Folder-name thesis plus the sentence a viewer walks away with. */
export interface PostIdea {
  title: string;
  takeaway: string;
}

export type CatalogVisibility = "public" | "trial";

/** Which evidence decided `visibility` (see classifyVisibility). */
export type VisibilityBasis = "grid" | "grid_complete" | "shared_to_feed" | "not_shared_to_feed" | "kind";

/** Raw Graph values from the last fetch that returned the post. CDN URLs expire. */
export interface CatalogGraph {
  mediaType?: string;
  productType?: string;
  permalink?: string;
  mediaUrl?: string;
  thumbnailUrl?: string;
  seenAt: number;
  insightsAt?: number;
}

export interface CatalogItem {
  shortcode: string;
  url: string;
  kind: PostKind;
  takenAt: number;
  thumbnailUrl?: string;
  captionPreview?: string;
  caption?: string;
  graphId?: string;
  graph?: CatalogGraph;
  visibility?: CatalogVisibility;
  visibilityBasis?: VisibilityBasis;
  isSharedToFeed?: boolean;
  insights?: {
    reach?: number;
    saved?: number;
    shares?: number;
    views?: number;
    interactions?: number;
    avgWatchMs?: number;
    /** Reels only. */
    follows?: number;
    /** Reels only. */
    profileVisits?: number;
  };
  counts: { likes?: number; comments?: number; plays?: number };
  /** Counts from the previous stats/catalog fetch, when they changed. */
  prevCounts?: { likes?: number; comments?: number; plays?: number };
  starred?: boolean;
  postId?: string;
  ideaStatus?: IdeaStatus;
  rank?: number;
}

export interface CatalogPage {
  items: CatalogItem[];
  nextMaxId?: string;
  more: boolean;
}

export interface ProfileInfo {
  igUserId: string;
  username: string;
  fullName?: string;
  biography?: string;
  profilePic?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  followers?: number;
  following?: number;
  posts?: number;
}

/** Live snapshot of an Analyzer account, used as Workshop writing context. */
export interface AccountContext {
  id: string;
  username: string;
  fullName?: string;
  biography?: string;
  followers?: number;
  posts?: number;
  fetchedAt?: number;
  lastCatalogAt?: number;
  lastPostedAt?: number;
  postsPerWeek?: number;
  mix?: { reels: number; carousels: number; posts: number };
}

export interface AccountMeta {
  id: string;
  igUserId: string;
  username: string;
  fullName?: string;
  biography?: string;
  profilePic?: string;
  isPrivate?: boolean;
  isVerified?: boolean;
  counts: {
    followers?: number;
    following?: number;
    posts?: number;
    fetchedAt: number;
  };
  lastCatalogAt?: number;
  /** Newest catalog takenAt after a finished backfill — later syncs stop before this date. */
  catalogNewestAt?: number;
  /** Session feed cursor (`next_max_id`) for load-more. */
  catalogCursor?: string;
  catalogHasMore?: boolean;
  /** The Toolset user's own Instagram — at most one per owner. */
  mine?: boolean;
  owner: string;
  /** Workspace project this research belongs to. Missing on older rows. */
  projectId?: string;
  tags: Tag[];
  notes?: string;
  status: PostStatus;
  step?: string;
  progress: number;
  error?: string;
  jobs?: { type: AccountJobType; status: JobStatus; error?: string }[];
  createdAt: number;
  updatedAt: number;
}

export interface PostMeta {
  id: string;
  owner?: string;
  /** Workspace project this research belongs to. Missing on older rows. */
  projectId?: string;
  status: PostStatus;
  step?: PostStep;
  /** 0..1 */
  progress: number;
  error?: string;
  /** Non-fatal problems, e.g. "Comments: session expired". */
  warnings?: string[];
  /** How many times a download that failed on the network was started again by itself; a finished run or a Retry clears it. */
  autoRetries?: number;
  /** Set when a share link resolved to a post already in the library. */
  duplicateOf?: string;
  /** Missing = Instagram. "youtube" posts keep their id in `shortcode` as yt-<videoId>. */
  platform?: "youtube";
  /** What the user pasted. */
  input: string;
  /** Canonical https://www.instagram.com/{p|reel}/<code>/ */
  url: string;
  shortcode: string;
  /** Decimal string (BigInt-safe). */
  mediaId: string;
  kind: PostKind;
  creator: PostCreator;
  /** Toolset account row (uuid), once the creator is known. */
  accountId?: string;
  /** Epoch ms. */
  takenAt: number;
  /** First successful info fetch. */
  pulledAt?: number;
  /** pulledAt - takenAt, stored so it stays stable. */
  ageAtPullMs?: number;
  recipe?: Recipe;
  jobs?: JobRecord[];
  starred?: boolean;
  source?: PostSource;
  tags?: Tag[];
  /** Distilled remakeable thesis + the one-liner takeaway. */
  idea?: PostIdea;
  /** Inbox / in project / done / skip. Independent of pipeline `status`. */
  ideaStatus?: IdeaStatus;
  /** Why it was kept: the idea, the layout, or both. */
  savedFor?: SavedFor[];
  /** Know-how (strategy, reference, other): saved, never indexed, its own list. */
  knowhow?: boolean;
  /** User 1–10 score. Virality (plays) is separate. */
  rank?: number;
  /** Topic stack — same-idea posts share an id. */
  stackId?: string;
  caption: string;
  counts: PostCounts;
  slides: Slide[];
  comments: CommentsSummary;
  /** Sum of media/ bytes. */
  bytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface StackMeta {
  id: string;
  title: string;
  owner: string;
  /** Workspace project this stack belongs to. Missing on older rows. */
  projectId?: string;
  createdAt: number;
  updatedAt: number;
  ideaStatus?: IdeaStatus;
}

/** One media item as reported by Instagram before download. */
export interface PostInfoSlide {
  index: number;
  kind: SlideKind;
  url: string;
  width: number;
  height: number;
  durationS?: number;
  /** Video slides: Instagram's poster image. */
  coverUrl?: string;
  accessibilityCaption?: string;
  /** Per-slide caption, when Instagram reports one for a carousel child. */
  caption?: string;
}

/** One timed word (seconds). YouTube captions are turned into these. */
export interface SpokenWord {
  text: string;
  start: number;
  end: number;
}

/** Normalized media-info response. */
export interface PostInfo {
  shortcode: string;
  mediaId: string;
  kind: PostKind;
  url: string;
  creator: PostCreator;
  takenAt: number;
  caption: string;
  counts: Omit<PostCounts, "fetchedAt">;
  slides: PostInfoSlide[];
  /** YouTube: the video's captions, already timed. */
  words?: SpokenWord[];
}

export interface CommentUser {
  username: string;
  id: string;
}

export interface Comment {
  id: string;
  text: string;
  /** Epoch ms. */
  createdAt: number;
  user: CommentUser;
  likeCount: number;
  replyCount: number;
  replies: Comment[];
  /** Set by the heuristic comment filter, or by Jev's score when judged. */
  lowValue?: boolean;
  /** Jev's read of the comment (see comment-judge.ts). */
  judged?: CommentJudgment;
}

export interface CommentJudgment {
  kind: "question" | "pushback" | "story" | "praise" | "keyword" | "other" | "spam";
  /** Probability the comment is worth the creator reading. */
  worth: number;
  /** Probability it is a real question the creator could answer. */
  needsAnswer: number;
}

export interface CommentsFile {
  status: CommentsStatus;
  fetchedAt: number;
  /** Instagram's comment_count at fetch time. */
  total?: number;
  /** Pagination cursor to continue from ("Fetch more"). */
  cursor?: string;
  error?: string;
  comments: Comment[];
}
