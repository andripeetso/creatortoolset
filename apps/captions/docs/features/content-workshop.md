# Content Workshop

The Workshop turns research into pieces (reel, carousel, ad, free and YouTube scripts). A **project** is one brand (audience, voice, CTA). A **session** is one idea: its sources, notes, pieces and chat. A **piece** is one document with blocks (lines or slides), hook variations, a caption (post description) and a pinned comment.

## The writer and what it reads

- **A folder per session on the Mac.** A chat turn runs in a Claude Code (or other CLI) session in a folder with everything the project allows: every post with its views and saves + shares per 1,000 views, the session's sources, the context files as reference, the other sessions, the Analyzer library, and the account's own posts (`turnFolder`, `api/lib/workshop/folder.ts`; the Mac side is the Mac relay). An index (`sessions/INDEX.md`) lists each session and the post it became.
- **Only the current project.** A turn reads that project's sessions, its saved Analyzer posts and followed accounts (`projectScope`), and its own Instagram account's posts. A project with no Instagram account linked has no `my-posts/` and never falls back to another account. Frameworks and rules belong to the account and are on in every project; a project can switch any of them off (`Project.off`).
- **Closest posts first.** Each turn gets the five of the author's posts closest in words to the piece, with their numbers (`closest.ts`), and the rewrites of AI text closest to it. Writing in one person's voice stops improving after about five of their own texts, so the rest stays in the folder. `GET /api/workshop/kept` reports how much AI text the author kept unchanged, by week.
- **Resuming.** A session keeps its Claude session on the Mac. A later turn sends only what changed (edited blocks, new sources). It starts over when the reply it saw is no longer the last one, a source was removed, the project's frameworks changed, the session is over 24 hours old, or it has grown past 100k tokens (`RESUME_MAX_TOKENS`). Nothing is summarised: the CLI's automatic compaction is off for Workshop sessions, and every note the author wrote on the piece is sent on every turn. If the Mac no longer has the session, the turn runs once in full and says so.
- **Scope slider.** Slight / Normal / Rewrite, beside the chat chips and kept in the browser. Slight changes only what the message points at; Rewrite may open the whole piece; Normal adds nothing. Sent with each message as `scope`.
- **Rules.** The prompt carries the mechanics only. Starter writing rules are retired (`seeds.ts`); fix causes in code rather than adding rules.
- **Long chats.** The last 40 messages are sent, plus the folder turn. Older turns drop, the newest never does, and the prompt says how many are not shown.

## Edits, locks and checks

- **Locks.** A lock per block (`doc.locked`). `applyEdits` refuses a replace or delete on a locked block and the turn says which it left. A single fix on a locked block answers 400 and leaves no version behind.
- **"My words only" and "Not mine".** The first makes a turn build only from what the author said. The second (doc toolbar, `src/lib/mine.ts`) shades every word on the AI's slides that the author never said in the session.
- **Other ways to say this.** Select words on a slide (`POST …/docs/:docId/lines`, `lines.ts`) to get three alternatives to click.
- **Read-through.** After every edit, `readthrough.ts` adds findings to the reply: two sentences in a row with the same opening, a four-word phrase on two slides, slides longer than the author's posted carousels, clipped fragments.
- **Read as a follower.** A chat chip asks a second model, on the Mac, to read only the piece, the audience line and the author's most saved posts, and to say where it would stop. The reply is labelled as another model's read.
- **Accuracy check.** `AUDIT_SYSTEM` reads each post the way a viewer would: a slide that simplifies is doing its job; it rewords only a claim that would be false as posted. Nothing in the audit modal is pre-accepted.
- **Description.** Kept up to 10,000 characters and flagged past Instagram's 2,200 (a counter under the field), never cut mid-sentence. The writer sees the author's most saved captions and the usual length of their descriptions.
- **Rewrites teach.** Each time the author rewrites AI text (a slide, hook, script or description), the pair AI text → author's version is kept (`edit-log.ts`, `$DATA_DIR/workshop/users/<name>.edits.json`, 300 pairs). The newest pairs go to the writer on every turn, raw and unlabelled. More pairs are the fix, not more instructions.
- **Changes shown.** "Edited N slides" under a turn opens each changed block's before and after, word by word.

## Web, stop and retry

- **No web search without a yes.** A turn that wants one ends with a proposal (the question, editable): Search · Deep research · Skip. Search lets only the next turn use web tools; deep research and accuracy checks run when asked.
- **Stop.** A thinking reply shows a Stop button (`POST …/chat/:messageId/stop`). It ends "Stopped", its partial edits are undone, and research and audits stop too. Once the model has answered, Stop does not cancel the reply.
- **Retry.** A failed or timed-out question can be sent again (`retryOf`). When the Mac is off, the reply says so; there is no API-key fallback.
- **Words are kept.** Send clears the box only once the server has the message. A refused send keeps the words. A network failure reads the chat back and keeps them unless the message is there.
- **Streaming.** `GET /sessions/:id/chat/:messageId/live` pushes the reply as it arrives (server-sent events, `live.ts`).
- **Notices.** A finished turn posts a notification ("Reply ready", "Stopped", "Failed"). The tab title shows "● " while a reply runs. Audits and research do not notify.

## Pictures, files and citations

- **Pictures.** Drop, paste or pick images with the paperclip. Each is shrunk to 1568 px JPEG and ordered by the number in its name. They're kept in `sessions/<id>/images/`; on the Mac they're files in the folder that the CLI can read (the Workshop runs only on the person's own AI, never an API key). Into an empty piece, slides go in first, word for word.
- **Other files.** Text-like files are read in the browser and sent whole. PDFs are sent as files (up to 10 MB) and written into the Mac folder.
- **Pictures in a piece.** A picture dropped into a piece field is stored as `![label](pic:<id>)` and shown inline.
- **Citing.** Select words on a slide or in a reply, then Cite puts them above the composer as a chip (`ChipComposer`, `⟦1⟧` marks in the text). Ask opens a side chat about just that part (`aside.ts`); it answers and cannot edit.

## Sharing and the share-link comments

- **Share links.** Share sits in the session's top bar. One link per session shows every piece live, notes never. Making the link moves an idea, writing or ready session to In Production. Statuses in order: Idea (`draft`) → Writing → Ready → In Production → Published.
- **Freelancer page.** `/ws/:token` (`WorkshopSharePage`) needs no account. It shows each piece's text with a Copy button, the status and dates, "I'm producing it" and "It's done" marks, and uploads (streamed into `sessions/<id>/deliveries/<did>/`, 2 GB each). Each mark or upload notifies the owner (`notifyWorkshopOwner`). Stopping the link stops all of it.
- **Comments on a share link.** Signed in with access to the session, the link's comments show at the top of the sidebar with open questions first. Reply drafts are for the author to copy; the app never posts them. Comments are read only when the author asks (Read comments / Refresh). The AI gets the pieces, the notes, the chat and the comments, and edits nothing. The thread lives in `sessions/<id>/answers.json`.
- **Posted sessions.** Opening the sessions list matches, at most every 10 minutes, each session without a post against the author's own posts (`posted.ts`: a text-similarity match, one post per session, only a clear winner). A matched session shows a Post link. "Link post" pastes an Instagram link by hand.

## Obsidian

The Obsidian plugin (`apps/obsidian`) links one vault folder with the Workshop, using an access key with Full access.
Code: `api/workshop.ts` (routes), `api/lib/workshop/notes.ts` (rules, templates, reading a note as a piece),
`api/lib/workshop/export.ts` (the status values).

- `session.note = { path, mtime }` links a session to its note; `session.statusAt` is when its status last changed.
- `PUT /api/workshop/notes` upserts by path among the account's own sessions. A linked session takes a newer note's
  status (note `mtime` > `statusAt`) and nothing else: its text is never rewritten. A new session is made only for
  👍 Ready, 🎥 Filming, ✂️ Editing, or with `create: "send"`; its body becomes a reel (hooks from leading `// ` lines),
  a carousel (slides apart by `---`) or a free piece (🎞️ Reel / 🎪 Carousel / else).
- `GET /api/workshop/notes?since=<ms>` lists linked sessions whose status changed since, for the plugin to write back.
- Exports (Settings → Exports, `$DATA_DIR/workshop/exports/<user>.json`): the built-in Obsidian Markdown first, then the
  account's own, each with a name, target (`download` or `plugin`), folder, file name pattern and template.
  Placeholders `{{title}} {{status}} {{media}} {{body}} {{caption}} {{date}}`.
- `POST /api/workshop/sessions/:id/export/:exportId`: a download answers the file; a plugin export queues one file per
  piece (`GET /api/workshop/exports/pending`, `POST …/pending/:id/done`) and links the session to the first path.
  Pictures are not carried by custom exports.

## Navigation and usage

- **Sidebar.** Writing now (a reply running), Waiting for you (a finished reply not yet looked at), Ideas & writing, Ready & in production, Published. ⌘K finds a session by name; ⌘1–9 open the first nine in the Mac app.
- **Summary poll.** `GET /api/workshop/sessions/summary`, every 3 s in front and 10 s behind. "Seen" is stored per account, so the unread dot shows on every device.
- **Instant switching.** A session opened before paints from memory (`workshop-cache.ts`) while it refreshes. The piece is read-only until the fresh copy lands, so typing never overwrites a newer AI edit.
- **Usage.** Replies, lines, asides, audits, drafts and research show tokens and the API-equivalent cost (`PRICE_PER_MTOK` in `api/ai-complete.ts`). A stopped Mac run's cost is not known; its tokens are counted under "Stopped".
- **Transcripts.** A source video without one is transcribed before a Mac turn reads the folder (up to 90 s).

## Projects

A project is one brand. Its form holds the audience, voice, CTA and notes. "Draft from my posts" drafts the project's instructions from the linked account's bio and most-viewed posts, for the author to rewrite. Records with no project are shared by every project; once a second project exists, older records go to the project linked to the account, else to the oldest one.

## Knowledge

Knowledge is whatever the author adds at onboarding or later (Workshop → Knowledge, `KnowledgePanel`):

- PDFs are read to text in the browser (`pdf-text.ts`). A scan is rendered to JPEG pages in the browser and the author's own AI writes the pages out before filing.
- Word, OpenDocument and EPUB files are unzipped on the server (`api/lib/workshop/source-files.ts`).
- Recordings are transcribed in the browser with Whisper; nothing is uploaded.
- Links: a web page's text (private addresses refused, every redirect checked, 8 MB cap), and a YouTube video's title, description and captions on the author's own Apify token. Instagram posts belong in the Content Analyzer.
- Markdown, text and pasted text.

Each source is read once in the background on the account's AI provider. The reader files it: kind (book, study, article, course, script, transcript, examples, brand, notes, other), title, what it is, the questions it answers, and its sections by line range (`READ_SYSTEM` in `api/lib/workshop/sources.ts`). The filing says what a source contains, never how to write. The author can change any part of it or ask for a new read.

Scope: every project reads a source unless it is limited to one project or switched off there. Records are `workshop/sources/<id>.json` (`KnowledgeSource`, `contracts/knowledge.ts`) with the text beside them.

What a turn gets: on the Mac, each file in `context/` plus `context/INDEX.md`. Without the Mac, a section index that the writer can fetch from. Files over 256 KB go through a relay that keeps them, so each is fetched once (`resolveBlobs` in the Mac app).
