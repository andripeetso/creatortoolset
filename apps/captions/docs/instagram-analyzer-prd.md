# Instagram Analyzer — Product Requirements

Status: draft for approval
Date: 2026-09-13
Owner: Creator Toolset (`/instagram` today)
Live product name today: Instagram ingest
Target product name: **Instagram Analyzer**

> **How it reads Instagram today (2026-11).** Two sources, nothing else:
>
> - **The official Meta login** (Settings → Connectors, or `META_ACCESS_TOKEN` for the server admin's own account):
>   your own professional account only. It gives your posts, their insights and comments, your account's numbers,
>   and whether a reel was shared to the feed (trial reels). It gives nothing about other creators, and a reel it
>   has no shared-to-feed flag for stays "visibility unknown".
> - **Your own Apify key** (Settings → Connectors): other creators' public profiles, posts and comments. Apify bills
>   you for each read; nobody else's key, and no server-wide key, is ever used for you (`APIFY_TOKEN` serves only
>   the one local account when `APP_SECRET` is unset).
>
> There are no session cookies, burner accounts or browser collectors, and the app never reads Instagram's web
> pages, logged in or not. The sections below are the original plan: where they mention a burner, a session, cookies
> or a browser comment scraper, that part was removed.

This document turns the nine requests below into one product: objects, jobs, UI, data, and a build order. Nothing here is implemented yet except what is called out under Current state.

---

## 1. Problem

The current tool is a **one-shot ingester**. Paste a post URL and the server always tries to do everything: resolve, download every slide, transcribe, vision, comments. That is expensive, slow, and the wrong shape for research.

What you actually want is a **library of Instagram accounts and their posts**, where:

1. You choose **what to pull** per item (stats vs media vs comments vs AI).
2. You can **run those jobs later**, not only at paste time.
3. Everything hangs off the **creator account** you crawled it from.
4. Posts remember **when they were published**, **how old they were when you pulled them**, and a **history of public counts** so later refresh can show what changed.
5. AI writes **tags** so you can find ideas and connect posts. Heavier analysis tools plug in later.
6. Nobody else on the app spends **your Apify token**.

---

## 2. Requests mapped to product

| # | You asked | Product meaning |
| --- | --- | --- |
| 1 | For each IG item, choose what to scrape and do | Per-record **recipe** of jobs (stats / media / transcript / vision / comments / tags). Same recipe can apply to a batch. |
| 2 | Run processes after the fact | Records can exist in a light state. Select them later and **enqueue jobs**. Jobs are first-class, retryable, not a hidden side effect of paste. |
| 3 | Sort by accounts crawled | First-class **Account** object. Library filters and sorts by `@username`. Posts always point at an account. |
| 4 | AI meta tags + smart search; analysis later | Structured **tags** on accounts and posts now. Keyword + tag search now. Embeddings / “vector fetch” as a later phase. Analysis tools consume tags, snapshots, and transcripts — they are not in v1. |
| 5 | Posted date, age at pull, refresh views/comments, see what changed | Persist `takenAt`, `pulledAt`, `ageAtPull`. **Snapshots** of public counts. Refresh job appends a snapshot and a **diff**. |
| 6 | Account-level scrape, not everything at once | Account flow: pull profile → list videos (catalog) → optional stats-for-all → **pick** which posts to deepen (media / comments / tags). |
| 7 | Connect to account-level things | Account is the hub. Catalog, posts, snapshots, tags, and future analysis all join on `accountId`. |
| 8 | Rename to Instagram Analyzer | Home tile, page chrome, docs. Keep `/instagram` as the URL (PWA share target) and add `/analyzer` as an alias. |
| 9 | Apify key per login, not shared | **Not true today.** Fix: credentials live per Creator Toolset user. Other logins cannot use your token. |

---

## 3. Current state (do not assume this already works)

- Paste post/reel/share URLs (including a batch list). Pipeline always runs full: info → download → thumbs → Deepgram → vision → comments.
- `takenAt` is stored when Instagram/Apify returns it. The UI barely uses it. There is **no age-at-pull**, **no snapshot history**, **no diff**.
- `refresh-counts` overwrites `counts` in place. Previous numbers are lost.
- Creator is a `{ username, id }` blob on the post. There is **no account record**, no catalog, no “all videos for @x”.
- Search is lowercase token-and over `search.txt` (caption, slides, transcripts, comments). No tags, no vectors.
- Access: same gate as cloud transcription (`admin` or `user.cloud`).
- **Apify token and burner cookies were global** (2026-09; the cookies are gone since, and the token is per user), pasted in an admin-only card. Any user who can open the tool **runs jobs on that shared token**. `savedBy` is audit only.
- Persistence is JSON under `$DATA_DIR/instagram/<postId>/`. No database.

The rebuild is: **keep the fetchers** (Apify + download + Deepgram + vision + comments), **stop treating “ingest” as one atomic pipeline**.

---

## 4. Product vision

**Instagram Analyzer** is a private research library of Instagram creators.

You pull the cheapest true layer first (who posted, when, caption, public numbers). You only spend Apify/Deepgram/vision/comment budget on posts you decide matter. Every post belongs to an account. Accounts are how you browse, filter, and later analyze.

This is not a posting tool, not Meta Graph, not a social inbox.

### Jobs to be done

- “Dump 40 links. Get stats and dates. I will decide later which ones to download.”
- “Pull @creator. Show me their reels with plays. I’ll star ten. Then transcribe those ten. Comments only on the top three.”
- “Find posts I already have about ‘first 3 seconds hooks’ from accounts I crawled this month.”
- “This reel had 12k plays when I pulled it 6 weeks ago. What is it now?”
- “My Apify bill is mine. Other Toolset users bring their own token.”

---

## 5. Principles

1. **Light first.** Default recipe for a new post is metadata + public stats. Default for a new account is profile + catalog. Media, transcript, comments, tags are opt-in.
2. **Records ≠ jobs.** Saving an account or post must not imply a full scrape. Jobs are explicit, queued, and re-runnable.
3. **Account is the hub.** If a post has no account yet, resolving it creates one. UI never shows a post as an orphan if we know the creator.
4. **Snapshots are append-only.** Refresh never silently overwrites history.
5. **Credentials are per Toolset user.** Shared env fallback is local-dev only (`APIFY_TOKEN`), never production multi-user.
6. **Analysis tools come later**, but the schema must not block them: tags, snapshots, transcripts, and account ids are the join keys.
7. **JSON files stay** until something actually needs a DB (vector index is the likely first reason). Do not introduce Drizzle for this.

---

## 6. Objects

### 6.1 Toolset user (already exists)

Creator Toolset login. Owns credentials, owns library rows (`owner` on records). Admins can inspect others’ libraries as they can today.

### 6.2 Credentials (new, per user)

Stored at `$DATA_DIR/instagram/users/<username>/` mode `0600`, never returned to the client.

| File | Purpose |
| --- | --- |
| `apify.json` | Their Apify token (set in Settings → Connectors) |

Ingest and jobs always use **the calling user’s** credentials. If they have none, the UI says so. An admin token is not a fallback for other people.

### 6.3 Account (new)

An Instagram creator we have crawled.

| Field | Notes |
| --- | --- |
| `id` | Instagram user id (string) |
| `username` | `@handle`, updateable if they rename |
| `fullName`, `biography`, `profilePic` | From profile pull |
| `isPrivate`, `isVerified` | If the source returns them |
| `counts` | followers, following, posts — latest |
| `snapshots[]` | Same idea as posts: counts over time |
| `lastCatalogAt` | When we last listed videos |
| `owner` | Toolset username who pulled it |
| `tags[]` | AI + manual |
| `notes` | Free text, later analysis |

One account row per `(owner, igUserId)`. Two Toolset users pulling the same `@nike` get two rows (separate libraries, separate Apify bills).

### 6.4 Post (existing, extended)

Today’s `meta.json`, plus:

| Field | Notes |
| --- | --- |
| `accountId` | Required once resolved |
| `takenAt` | Publish time (already have) |
| `pulledAt` | First successful info fetch |
| `ageAtPullMs` | `pulledAt - takenAt` (stored, not only computed, so it stays stable) |
| `recipe` | Which jobs were requested / completed |
| `jobs` | Per-job status (see §7) |
| `snapshots[]` | Public counts over time |
| `tags[]` | AI + manual |
| `starred` | User pick from a catalog |
| `source` | `paste` \| `account-catalog` \| `share` |

Media files stay in the post directory. A post with stats-only has empty `slides[]` until a media job runs.

### 6.5 Catalog item (new, cheap)

A row on the account, **not** a full post yet:

`shortcode, url, kind, takenAt, thumbnailUrl (remote), captionPreview, counts, starred, postId?`

Starring or “pull this one” **promotes** a catalog item into a Post and runs the chosen recipe. Until then there is no `media/` folder.

### 6.6 Snapshot (new)

Append-only public numbers.

```
{
  at: number,             // when we fetched
  source: "apify" | "graph",
  likes?, comments?, plays?,
  followers?              // account snapshots only
}
```

Diff between snapshot A and B: `Δlikes`, `Δcomments`, `Δplays`, elapsed time, rate (plays/day) as a derived view. Do not persist rates; compute them.

### 6.7 Tag (new)

```
{
  id: string,
  label: string,          // "hook-on-screen", "fitness", "storytime"
  kind: "topic" | "format" | "hook" | "cta" | "audience" | "custom",
  source: "ai" | "user",
  confidence?: number
}
```

Tags live on accounts and posts. Searchable. They are the v1 stand-in for “vector fetch”.

### 6.8 Embedding (later, not v1)

A vector over (caption + on-screen text + transcript + tag labels). Storage TBD (`embeddings.json` or sqlite). Analysis tools in the future query this. **Do not build a vector DB in the first slices.**

---

## 7. Jobs (the unit of work)

A job is `{ target: account|post, type, status, requestedAt, startedAt, finishedAt, error }`.

The queue already exists (`INSTAGRAM_CONCURRENCY`). Reuse it. One job at a time per post to avoid truncating `meta.json`; different posts may run in parallel.

### 7.1 Account jobs

| Job | Does | Cost |
| --- | --- | --- |
| `account.profile` | Username, bio, follower counts, avatar | Cheap (one Apify profile, or the official login for your own account) |
| `account.catalog` | List posts/reels (paginated, cap e.g. 50/100/all-capped) | Medium |
| `account.stats` | Refresh public counts for catalog items (no download) | Medium |
| `account.tags` | AI tags from bio + recent captions | AI |

### 7.2 Post jobs

| Job | Does | Cost |
| --- | --- | --- |
| `post.info` | Resolve URL, caption, creator, `takenAt`, first snapshot | Cheap |
| `post.stats` | New snapshot of likes/comments/plays | Cheap |
| `post.media` | Download slides + thumbs | Bandwidth / disk |
| `post.transcript` | Deepgram per video slide | Cloud |
| `post.vision` | On-screen text, description, hook | AI |
| `post.comments` | Comment scrape (cap 1000, fetch more as today) | Expensive on Apify |
| `post.tags` | AI tags from caption + vision + transcript | AI |

Dependencies (enforced by the queue, not by the user):

- `transcript` / `vision` require `media`
- `tags` can run on caption-only; quality is better after vision/transcript
- `comments` require `info` (need url/shortcode)
- `stats` require `info`

Skipping a job stores `status: "skipped"` (already exists on slides).

### 7.3 Recipe (what you tick per item)

A recipe is a set of job types plus options (`commentCap`, `catalogLimit`).

**Presets**

| Preset | Jobs |
| --- | --- |
| Stats | `info` + `stats` |
| Watch | Stats + `media` + `transcript` + `vision` |
| Full | Watch + `comments` + `tags` |
| Custom | Checkboxes |

Batch paste applies **one recipe to every URL**. Account catalog “pull selected” applies one recipe to the starred set.

**Run after the fact:** multi-select in the library or on an account page → “Run jobs…” → same recipe UI → enqueue. Already-done jobs are skipped unless “force”.

---

## 8. User flows

### 8.1 Paste posts (batch stays)

1. Paste one or many post/reel/share links.
2. Pick a recipe (default: Stats).
3. Optional: “Run now” vs “Save and run later” (later = create records with jobs `pending`, nothing hits Apify until you run).
4. Library shows rows immediately, grouped/filterable by account.
5. Single URL may still open the post. A batch stays on the library.

### 8.2 Paste / add an account

1. Paste `instagram.com/<user>/` (profile URL) or `@user`.
2. Jobs: profile + catalog (default). Not “download every video”.
3. Account page: header (bio, followers, last snapshot), table of catalog items (date, kind, caption, plays, likes, comments, age, starred).
4. Optional “Refresh stats for all listed videos”.
5. Star / multi-select → recipe → promote to full posts and run.

Profile URLs are **rejected today**. That is a parser change, not a new product.

### 8.3 Browse

- Default library: posts, newest pulled first.
- Filter: account, kind, recipe completeness (has comments / has transcript), date posted, age at pull, tags, starred.
- Sort: pulled at, posted at, plays (latest snapshot), Δplays since first snapshot, account name.
- Group: “by account” (section headers `@user` with post counts).

### 8.4 Post detail

Keep today’s viewer for media/transcript/comments.

Add:

- Posted date, relative age **now**, and **age when first pulled**
- Snapshot sparkline / table + “Refresh stats”
- Diff vs previous snapshot and vs first pull
- Recipe checklist with Run / Retry per job
- Tags (AI + edit)

### 8.5 Search (v1)

Extend `search.txt` (or a sibling `tags.txt`) with tag labels and account username. Keep every-token-must-match.

v1.5: filter chips (account, tag kind).

v2: embeddings over caption+transcript+tags (“smart fetch”). Out of scope until tags exist and you have enough posts to care.

---

## 9. Rename

| Surface | Change |
| --- | --- |
| Home tile | “Instagram Analyzer” — “Accounts, posts, stats, then the heavy jobs.” |
| Page H1 | Instagram Analyzer |
| PWA share target name | Instagram Analyzer (URL stays `/instagram` so existing installs keep working) |
| Extra route | `/analyzer` → same page |
| README / `.env.example` | Analyzer language |
| Admin storage line | “N · M IG” can stay; tooltip “analyzer posts” |

Do not rename `$DATA_DIR/instagram/` on disk. Folder name is storage, not the product.

---

## 10. Credentials (request 9) — required correction

**Then (2026-09):** one Apify token and a cookie jar (since removed), admin UI, shared by every cloud user.

**Required:**

- Settings card moves from “admin-only global” to **each user’s Analyzer page**.
- The Apify token is read and saved per user in `$DATA_DIR/instagram/users/<username>/apify.json` (Settings → Connectors).
- Jobs read credentials of `jobUsers.get(id)`, never the global file.
- Migrate existing `instagram/apify.json` once: copy into the admin user’s folder, then stop reading the global path (keep a read fallback for one release).
- Env `APIFY_TOKEN` only seeds the **local** user when `APP_SECRET` is unset.
- Never log or return tokens. Same as today.
- Usage: optional `usage.apifyRuns` later so you can see who spent what. Not blocking.

There are no burner cookies or sessions: Apify on the user's own token and the official login are the only sources.

---

## 11. Data layout

```
$DATA_DIR/instagram/
  users/<toolsetUser>/apify.json
  accounts/<uuid>/meta.json
  accounts/<uuid>/catalog.json
  accounts/<uuid>/snapshots.json
  <postId>/meta.json          # existing
  <postId>/snapshots.json     # new
  <postId>/media/ …
```

`accounts/<uuid>` is a Toolset-side id (not Instagram’s), so two users can store the same creator independently. `meta.json` holds `igUserId` + `username`.

Index: continue directory scan for lists in v1. If that gets slow after thousands of posts, add `index.json` per user. Not day one.

Quota: keep `INSTAGRAM_MAX_TOTAL_GB` on **downloaded media**, not on catalog-only rows.

---

## 12. API sketch (additive)

Keep existing post media/transcript/comment routes.

New / changed:

| Method | Path | Purpose |
| --- | --- | --- |
| GET/PUT | `/api/instagram/apify` | **Per-user** token |
| GET | `/api/instagram/accounts` | List accounts (`?q=`) |
| POST | `/api/instagram/accounts` | `{ url or username, recipe, run: now\|later }` |
| GET | `/api/instagram/accounts/:id` | Profile + catalog |
| POST | `/api/instagram/accounts/:id/jobs` | `{ types[], force? }` catalog/stats/tags |
| POST | `/api/instagram/accounts/:id/pull` | `{ shortcodes[], recipe, run }` promote catalog → posts |
| GET | `/api/instagram` | Posts; add `?account=&tag=&sort=` |
| POST | `/api/instagram` | `{ urls[], recipe, run: now\|later }` |
| POST | `/api/instagram/:id/jobs` | `{ types[], force? }` |
| POST | `/api/instagram/:id/refresh-counts` | Append snapshot + return diff (change today’s overwrite) |
| GET | `/api/instagram/:id/snapshots` | History |
| PUT | `/api/instagram/:id/tags` | Manual tag edit |

`POST /` response stays `{ posts, errors }` so batch paste keeps working.

---

## 13. UI inventory

- Home tile rename.
- Analyzer home: accounts strip + post library + paste box with **recipe**.
- Account page (new).
- Post page: recipe + snapshots + age; existing media/comments.
- Credentials: per user, the Apify key and the Meta login in Settings → Connectors.
- “Run jobs” dialog (shared by library, account, post).
- Group/sort controls on the library.

No new design system. Same zinc/violet chrome as the rest of the Toolset.

---

## 14. Non-goals (v1)

- Meta Graph / “connect my Instagram” (since built: the official login for your own account)
- Stories, highlights, DMs, followers list
- Posting, scheduling, replies
- Cross-user shared libraries
- Vector database, RAG chat, “idea graph” UI
- Analysis dashboards (hooks that work, posting cadence charts, comment sentiment). **Interface only:** tags + snapshots + transcripts must be queryable so those tools can land without a rewrite.
- Changing how Deepgram / Kimi billing works beyond per-user Apify
- Moving storage to Postgres

---

## 15. Risks

| Risk | Mitigation |
| --- | --- |
| Apify profile/catalog actors differ from post scrape | Isolate account fetch next to `apify.ts`; same token, different actor input (`resultsType` / profile URL). Prove with one fixture account before UI. |
| Catalog of 500+ videos is huge and expensive | Cap default (50), “load more”, never auto-download. |
| Parallel comment jobs | Apify comments run within the queue's concurrency (no browser collector). |
| Disk: people tick Full on 40 links | Recipe default Stats. Quota on media bytes. Warn when a recipe includes media or comments. |
| Username changes | Key accounts on `igUserId`. Username is a display field. |
| Shared token leftover | Per-user credentials is P0, before account scrape, so bills don’t explode. |

---

## 16. Build order

Ship in vertical slices. Each slice is usable alone.

### P0 — Rename + per-user credentials

Why first: you asked for Analyzer, and you asked that others not spend your Apify key. Account scrape on a shared key would make that worse.

- Tile, H1, `/analyzer` alias.
- Move the Apify token under `users/<username>/`.
- Migrate existing global files to the admin who saved them.
- Non-admin users see their own token card and cannot read anyone else’s.

Exit: two logins, two tokens, jobs billed to the caller.

### P1 — Recipes + deferred jobs on posts

Why: request 1 and 2, and it reuses today’s post pipeline.

- Recipe presets + checkboxes on paste (batch included).
- Split `processPost` into job types; skip unchecked.
- “Run later” creates `ready`/`pending` records without hitting Apify beyond nothing (or only `info` if you prefer a resolvable row — **decision: `info` always runs on paste-now; run-later stores the URL and waits**).
- Post page: job checklist, run/retry.
- Library multi-select → run jobs.

Default paste recipe: **Stats** (`info` + first snapshot).

Exit: paste 10 links as stats-only; later select 2 and run media+transcript.

### P2 — Accounts as hub + catalog

Why: requests 3, 6, 7.

- Parse profile URLs and `@user`.
- Account records + catalog job.
- Account page; group/filter library by account.
- Promote starred catalog rows with a recipe.
- Backfill `accountId` on existing posts from `creator.id`.

Exit: pull an account, see videos, pick three, pull those three as Watch.

### P3 — Time, snapshots, refresh diffs

Why: request 5. `takenAt` already exists; this is persistence + UI.

- Store `pulledAt` / `ageAtPullMs` on first info.
- `snapshots.json`; refresh-counts appends.
- UI: posted, age now, age at pull, snapshot table, Δ vs first and vs previous.
- Account follower snapshots on profile refresh.

Exit: refresh a week later and see plays went from A → B.

### P4 — Tags + smarter search

Why: request 4, without a vector product yet.

- `post.tags` / `account.tags` job (Kimi JSON: topic, format, hook, cta).
- Manual add/remove.
- Library filter by tag; search haystack includes tags.
- This is the metadata analysis tools will consume.

Exit: filter “format: talking-head” across two accounts.

### P5 — Embeddings / smart fetch (later)

- Embed caption + tags + transcript.
- “Similar to this post” and a meaning search box.
- Pick a local vector store only when P4 is in daily use.

### P6 — Analysis tools (later)

Separate PRDs. Candidates that this schema already supports:

- Hook / first-3s patterns (vision hook + transcript)
- Count velocity between snapshots
- Comment themes (needs comments job)
- Account posting cadence from catalog `takenAt`

Do not start P6 until P2–P4 exist.

---

## 17. Decisions to confirm

1. **Default recipe is Stats**, not today’s Full. (Recommended yes.)
2. **Run later** stores URLs and does not call Apify until you hit Run. (Recommended yes.)
3. **Catalog cap** default 50, with load more. (Recommended.)
4. **Keep URL `/instagram`**, name “Instagram Analyzer”. (Recommended.)
5. **Per-user Apify** even for admin-created users. No org-wide token. (You asked for this.)
6. **Vectors after tags**, not in the first PR. (Recommended.)

---

## 18. Success

You can:

- Log in as you, paste your Apify token; a second user cannot use it.
- Pull an account, browse videos, pull stats, then download only the ones you star.
- Paste a list of links as stats-only and transcribe a subset the next day.
- Sort/filter the library by `@account`.
- See when a video was posted, how old it was when you pulled it, and what plays/comments did between refreshes.
- Get AI tags and find posts by those tags.
- Open something called Instagram Analyzer, not a generic ingest box.

Analysis dashboards are explicitly the next product, not this one.
