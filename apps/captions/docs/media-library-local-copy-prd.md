# Media Library on this computer — Product Requirements

Status: draft 2, 2026-11-22 (after a four-lens audit with adversarial checks: 43 findings kept, 2 refuted, 12 gaps) ·
Tool: Media Library · Touches: `src/lib/warm-thumbs.ts`, `src/lib/local-thumbs.ts`, `src/lib/local-cache.ts`,
`api/library/routes.ts` (`serveBlob`), `api/lib/stalls.ts`, the Mac app's `ThumbCache.swift` (unchanged)

Aim: on a computer that has opened the Media Library before, the grid paints complete (clips **and** their pictures)
on its first frame from what that computer keeps, whatever the server is doing. The server stays where the data
lives; each computer keeps a copy and refreshes it in the background.

## 1. Problem

Opened in the Mac app after an update, the Media Library showed its frame and empty tiles for about ten seconds.
Measured on 2026-11-22 (a library of about 2,000 clips on a Server) from the server's access log and the Mac app's
saved data:

- **The list was there.** The window had a saved copy of the exact view it opened (`local-cache.ts`, IndexedDB
  `ct-local`/`lists`) and painted it from memory. Every shown list also refetches once in the background when its
  screen opens (`useCachedLoad`'s mount effect), so the list never waits on the server.
- **The pictures were not.** All 130 picture requests in those seconds came from the Mac app's own picture store
  (`ThumbCache.swift`, `ctlocal://thumb/`, 1 GB, least recently used dropped first). That store keeps a picture only
  once it has been drawn, and it was new that afternoon (its folder was made at 18:37), so the B-Roll pictures had
  never been drawn on that Mac. Each miss went to the server.
- **The server was blocked** for about ten seconds (a 25-second long poll answered after 35), and for about five
  seconds roughly once a minute for twenty-five minutes earlier. `node:sqlite` is synchronous: one slow query stops
  every request, the picture misses included. The cause is not named yet (§5).
- In a browser on a Server whose library is in a bucket, a picture is a `302` to a 15-minute signed address with no
  cache header (`serveBlob`), so the browser asks the server again on every screen.
- The saved copy only grows: 650 lists and 17 MB on one Mac (144 Media Library views), all read into memory before
  the first render.

## 2. Goals and non-goals

Goals:

- **G1** A view opened before paints with its pictures on the first frame in the Mac app, with no request to the
  server, for the newest 5,000 clips of a library.
- **G2** In a browser, a picture once drawn is kept by the browser, on every kind of storage.
- **G3** The saved copy stays bounded without a setting.
- **G4** Server blocks are named in the log, then fixed at their cause.

Non-goals (decided by the audit, §6): per-clip saved records, a server change log, "changes since N" catch-up, a
schema version per saved record, a second picture store in Cache Storage. Writes stay server-first.

## 3. Requirements

### Pictures

- **R1** In the Mac app, the Media Library fills this Mac's picture store ahead of time: five seconds after the page
  has a library, it lists the library newest first and loads each clip's thumbnail through `ctlocal://thumb/`, three
  at a time, between idle moments (`warm-thumbs.ts`). A kept picture is read from this Mac's disk, so a second pass
  asks the server for nothing. Outside the Mac app it does nothing.
- **R2** At most 5,000 pictures per pass (about half of the store at ~90 KB each), so the pass never pushes the
  newest clips' pictures out of the store, which drops the least recently used.
- **R3** After a whole pass, the next 24 hours warm only the newest page (200 clips): new clips are the ones opened
  next. The time is kept per library on this computer; a pass that fails is tried again by the next window.
- **R4** A thumb or sprite asked for by its versioned address (`?v=`) is answered by the server with
  `private, max-age=31536000, immutable` on every storage kind: from a bucket the server sends the bytes from its
  own blob cache (`blobs.localCopy`) instead of redirecting. Everything else from a bucket still redirects.
- **R5** Sprites (the hover strip) are not warmed; they are kept once drawn, as today.

### The saved copy

- **R6** Each saved list records when it was last saved. A list not saved for 30 days is removed at start
  (`hydrateLocalCache`); since a shown list refetches and saves on every open, that is a list not shown for 30 days.
  Lists saved before this change get their time on the first start.

### Server blocks

- **R7** The log names any block of the server process longer than two seconds and every library query over half a
  second, with its SQL (`api/lib/stalls.ts`). Each block found is fixed where it is (an index, a smaller read, a
  background step that yields); if a block is not a query, the next step is a timer around each minute loop in
  `boot.ts`. Pictures from this Mac (R1) keep the grid drawing through a block; they do not excuse one.

## 4. Tests

- `warm-thumbs.test.ts`: every page's thumbnails load through this Mac's address, once per library; nothing outside
  the Mac app; a failed list is tried again; a pass stops at 5,000; within a day of a whole pass only the newest page.
- `serve-blob.test.ts`: a kept picture from a bucket comes through the server with its header; anything else still
  redirects.
- `local-cache.test.ts` `ageOf`: drop after 30 days, keep newer, stamp a record with no time.
- `stalls.test.ts`: a slow statement is logged with its SQL and still returns its rows; a fast one is not.

## 5. Rollout and measures

1. Shipped together (no Mac app release needed: the page and the server change; `MIN_MAC_APP` stays).
2. Measure after a day in the Mac app: picture requests from the Mac app's user agent in the first ten seconds of
   opening the Media Library should be near zero for clips among the newest 5,000.
3. Read the server log for `[stall]` and `[slow query]` lines and fix each cause.

## 6. What the audit removed, and why

Draft 1 also proposed one saved record per clip, a durable change log per library and a "changes since N" route.
The audit found, and the code confirms:

- It would not change what the person sees: lists already paint from the saved copy and refresh in the background
  on open. It would only save server work.
- It cannot be complete as written: about 37 files write the tables a card reads; the central `libraryChanged()`
  names no clip; a clip's preparation changes its card about 30 times; card fields differ per computer (`here`,
  `placeWord`, `onComputer`, `proxy.cached`).
- The change id would have shared the one counter every topic uses, so lists would have missed changes or refetched
  without end.
- A picture store in Cache Storage cannot draw on the first frame (no service worker) and would have duplicated the
  Mac app's store; its Settings place was the Server group's Storage page.

## 7. Open

- Team members on a shared library do not hear each other's changes (notices go to one account,
  `api/lib/sync.ts`); a shown list still refreshes on open. Fan-out per grant is its own change.
- The picture address carries the picture's byte count (`v`), not a content hash: a remade picture of the same size
  keeps its address and stays kept for a year. Rare; a content hash in `derivatives` closes it.
- The iPhone app's web view keeps pictures only in its HTTP cache (R4 makes that reliable); a native store like the
  Mac's is not planned.
