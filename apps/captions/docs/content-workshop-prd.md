# Content Workshop — Product Requirements

Status: v1 built 2026-09-14
Route: `/workshop` · API: `/api/workshop` · Source: the Instagram Analyzer library

## 1. Problem

The Analyzer collects research: accounts, posts, media, transcripts, slide text,
comments, tags, ranks, stacks. It has no place to *work* with it — to gather
the posts about one topic, read them side by side, keep notes, and write the
next piece. the author's own description: "I remember there was a topic about plants
— I type *plants and gardens*, it brings up everything that talks about it,
reels and carousels separately, I select them, read what's in them, write notes
on the left while I browse on the right, then generate: *based on these
sources and this prompt, write this piece for this project* — a reel, a
carousel or an ad — using the storytelling frameworks. Download as markdown."

## 2. Objects

| Object | What it is | Storage |
| --- | --- | --- |
| Project | Who you write for: name, audience, voice, CTA and links, notes | `workshop/projects/<id>.json` |
| Framework | A storytelling structure: name, summary, ordered steps, when to use, example. Four starters are seeded once per user and are editable / deletable | `workshop/frameworks/<id>.json`, marker `workshop/users/<username>.json` |
| Rule | A writing rule the AI follows on every turn (but/therefore, space the payoffs…); seeded per user, on by default, toggled per document | `workshop/rules/<id>.json` |
| Session | One topic: title, last query, project, ordered sources (post ids + optional note), documents, chat | `workshop/sessions/<id>/meta.json` |
| Document | One piece being written with the AI: kind (reel / carousel / ad / free / notes), title, stacked framework ids, rule ids, blocks (`{id, text, author: ai \| user}`), versions (snapshots, newest last, cap 30) | `workshop/sessions/<id>/docs/<docId>.json` |
| Chat | The conversation with the AI for the session: messages with the document they targeted, pinned context, what was being read, and what each turn edited | `workshop/sessions/<id>/chat.json` |
| Draft | Legacy one-shot generation, kept for API compatibility; ready drafts become documents on first open | `workshop/sessions/<id>/drafts/<draftId>.md` + `.json` |

English only. Ownership follows the Analyzer: owner or admin.

## 3. Analyzer additions (M1)

- `GET /api/instagram/find?q=&kind=&limit=` — ranked topic search. Terms are
  stemmed (plants → plant, gardens → garden), stopwords dropped, any term may
  match; score = weighted field hits (caption / hook / tags 4, slide text 3,
  transcript 2, comments 1) + coverage + phrase bonus + a weak embedding
  tie-breaker. Returns per-kind counts before the kind filter.
- `POST /api/instagram/packs { ids }` — markdown packs (caption, slide text,
  transcripts, top comments) fitted to a reading budget: 12k chars per post,
  40k total, small packs untouched, big ones shortened proportionally.
- `src/lib/instagram-markdown.ts` — `postToMarkdown` shared by the browser
  (Copy as Markdown) and the server (packs), ISO dates so both match.

## 4. Workshop API (M2, M4, C1)

`GET /availability` · projects, frameworks and rules CRUD · `GET/POST /sessions`,
`GET/PATCH/DELETE /sessions/:id` (PATCH fields are independent) ·
`GET /sessions/:id/export.md` (notes, sources, every document).

Co-writing (C1): `GET/POST /sessions/:id/docs`, `GET/PATCH/DELETE
/sessions/:id/docs/:docId` (PATCH `title | kind | frameworkIds | ruleIds |
blocks`; blocks from the editor — changed or new text becomes `author: user`),
`POST /sessions/:id/docs/:docId/revert { versionId }`,
`GET /sessions/:id/docs/:docId/export.md` · `GET /sessions/:id/chat` (poll) ·
`POST /sessions/:id/chat { docId, text, context?, reading?, sources?, comments? }`
(202 with the user message and a `thinking` assistant message; 409 while a
turn runs; `sources` = all | reading | none, `comments` = include the sources'
comments this turn, off by default) · `DELETE /sessions/:id/chat/:messageId`
(retry after an error).

A turn: one user string, in order — project, stacked frameworks (roles), rules,
the deliverable rules for the document's kind, the document block by block
(`[b3 · ai]` / `[b7 · you]`) with its version list, pinned context with
provenance and value (slide text > transcript > caption > comments), the
source being read (12k), the other session sources (24k), the last 12 turns,
the message. Before the pinned context the prompt lists the author's edits
since the last turn (block, what it was, what they made it) with the
instruction to work out why and write that way from now on; what the model
learned so far (`session.learned`) sits with the rules. The model answers one
JSON object: `reply`, `edits` (`replace | insert_after | insert_before |
append | delete` by block id), `learned` (≤ 2 short rules taken from the
author's edits), optional `newDocument { kind, title }` (a variation or another
format), `revertTo "vN"`, `needComments` (the answer needs the comments that
were not sent — the server rebuilds the prompt with them and calls once more)
and `search` (a library query; the hits beyond the session's sources come back
on the message for the author to add). The document is the deliverable only —
plain blocks, no labels, no analysis; thinking stays in the reply. Any block may
be edited; the author's blocks are the strongest voice signal, never undone.
Versions: every turn snapshots "after"; "before" is the head version, or a
snapshot of the author's unsaved edits; `revert` to the head is a no-op, so
restoring never piles up versions. `completeWithFallback` with the strict
`parseTurn` parser; an unusable answer moves to the next provider. Restart
recovery marks a stale `thinking` message as an error.

Streaming (C7): a turn uses `streamWithFallback` in `api/ai-complete.ts`
(SSE for Kimi, ChatGPT and Anthropic; a failed provider hands over to the
next and the caller drops what it showed). `stream-json.ts` reads the answer
while it is written — the reply first, then every edit whose object is
complete, but only after `newDocument` and `revertTo` have been seen (the
contract fixes that key order). Finished edits are applied to the document
at once and undone with `revert` if the provider or the turn fails. The
assistant message carries `stage` (packing / thinking / writing / applying /
searching / researching), `provider`, the partial `text` and the block ids
so far; the client polls every second and refreshes the document as blocks
land. Comments join automatically when the message is about the audience
(`wantsComments`). The model can call tools: `search` (library),
`research {question, depth}` — quick runs inline through Perplexity and the
findings go back into the same turn as a "Research findings" block; deep
becomes a `proposal` — and `audit` ("quick" | "deep"), also a proposal.
`POST /sessions/:id/chat/:messageId/proposal { action, depth? }` runs the
audit or the deep research (`runResearch`) as a new message, or declines.
Sources are an index, not a dump (C8): every turn lists each session source
(`sourceIndexForUser` — handle, kind, hook, how much slide text / transcript /
caption / comments it has) with its slide text loaded; the model pulls more
with `fetch: [{source: "S2", parts: [...]}]` (a tool call, at most two rounds
per turn) and what it pulled is remembered on `session.loaded`, so later
turns carry it without asking again. A question about the audience pulls
comments straight away (`wantsComments`). The composer's Deep research
toggle (`deep: true` on the message) runs Perplexity deep research on the
message before the model answers. Nothing is learned or stored as rules; the
author's edits since the last turn are shown as evidence only.

Every reel/carousel/free document has blocks plus two optional companions,
written only when the author asks (Generate on the description field, or
chat): the post description (`set_caption` — one take, extra finding + search
terms, not a recap) and the pinned comment (`set_pinned` — only to sell or
occupy a comment; usually empty; no Generate). Both are versioned, editable
(author-marked), exported as sections and audited.
`session.model` picks the provider that answers first (Auto = Kimi → ChatGPT
→ Anthropic); `GET /availability` lists the providers with their models.

Accuracy audit: `POST /sessions/:id/audits { docId, postId?, depth }` (202;
`depth` = quick | deep) puts a user message and a `thinking` assistant message
carrying `audit { target, depth }` on the chat, then `runAudit` sends the
piece — the document block by block, or a source's pack without comments —
to Perplexity Sonar (`api/lib/research/perplexity.ts`; quick =
`RESEARCH_QUICK_MODEL`, default sonar-pro; deep = `RESEARCH_MODEL`, default
sonar-deep-research) with a fact-checker system prompt and a JSON schema.
The answer becomes `AuditResult { score, summary, claims[{ where, claim,
verdict: supported | partly | contradicted | unverifiable, confidence,
evidence, sources, fix }], citations }` on the message, and the message text
is a plain summary so the co-writing model sees it in history. The chat
shows an Open row; the review UI is a modal (Accept / Skip each rewording,
then Process). `POST /sessions/:id/chat/:messageId/apply-fixes { claimIds }`
replaces those blocks in one snapshot (caption and pinned included).
`POST .../apply-fix { claimId }` still applies one. `GET /availability`
reports `research` (the key is set). The turn prompt also forbids moving a
fact to a different subject than its source studied.

Legacy: `POST /sessions/:id/generate` and the drafts routes stay for API
compatibility; the UI no longer uses them.

## 5. UI (M3, M4)

- `/workshop`: Sessions · Projects · Frameworks tabs; New session; `?add=ids`
  opens a session pre-filled from the Analyzer ("Send to Workshop").
- `/workshop/sessions/:id`: three compact islands (Writing, Cowork, Content)
  that never share one slab. Default geometry is **Stacked** (writing above
  cowork, content beside). **Columns** is Cowork | Writing | Content. Header
  controls: Stacked / Columns / Focus (writing only; Esc restores) plus
  Writing / Cowork / Content toggles (pressed = visible). Light/dark from
  the account menu. Each island header moves left or right and can hide;
  the choice persists in `localStorage`. Writing is tabs + the editor
  (beats, slides, or lines — drag to reorder; never “blocks”; post
  description and pinned comment side by side and quiet; Preview; 700 ms
  autosave). Cowork is the chat; Context, model, research, accuracy, and
  Making / Shape / Rules sit behind a Tools toggle above the composer. The
  thinking bubble streams the reply (stage, provider, units written, elapsed);
  finished
  answers carry the provider tag, research cards, proposals with Run / Not
  now, a quiet **Undo** on edited turns, and a compact **Open** row when an
  accuracy audit finishes (the claims, Accept / Skip, and **Process** live
  in a modal). Content
  is Browse (library + search) and Read (slide viewer; select text to pin for
  the next message). Source-level accuracy check stays on the reader.

## 6. Out of scope for v1

Streaming replies (the AI layer is one request per turn), real-time
multi-user editing, semantic embeddings beyond the hashed model, renaming the
Analyzer.
