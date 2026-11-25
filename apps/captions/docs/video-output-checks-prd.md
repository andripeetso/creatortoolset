# Finished video checks — Product Requirements

Status: draft 2, 2026-11-24 (after a review of draft 1: 9 findings, all taken; the open questions decided, §8) ·
Tools: Caption Studio, AI Editor, Content Workshop, Designer · Touches: `contracts/design.ts`, `contracts/reading.ts`
(new), `src/lib/types.ts`, `src/lib/caption-layout.ts`, `src/components/CaptionRenderSurface.tsx`, the Caption Studio
player, new-project and export dialog code, `api/lib/render-check.ts` (new), `api/work/tasks/export.ts`,
`api/editor/preview.ts`, `api/editor/plan-render.ts`, `api/editor/plan.ts`, `api/editor/qa.ts`,
`api/editor/cards/prompts.ts`, `api/lib/workshop/prompt.ts`, `api/lib/workshop/chat-prompt.ts`, `api/designs.ts`

Aim: a video the app finishes is checked the way a viewer will see it. Text stays clear of the reel's buttons and
caption and holds long enough to read; the file is as long as asked, has its sound and can be read; a person can make
the frame they pick the video's first frame.

## 1. Problem

The AI Editor's QA checks the timeline (gaps, flash frames, loudness). Nothing checks the file that comes out, and the
rules for where text goes and how long it stays are missing or differ by tool.

| What a viewer gets | Why (today's code) |
|---|---|
| Captions under the username and post description on a reel | Three style presets put the box at 74–92 % of the height: the second "Classic" (centre 84 %), "Boxed" (82 %) and "Minimal" (86 %) (`src/lib/types.ts` `STYLE_PRESETS`); the default Classic and Creator end 1–2 % past the line. Our own rule says the bottom 35 % of a reel is covered (`contracts/design.ts` `DESIGN_SAFE`, `reel`). Caption Studio shows no guide |
| AI Editor plan texts in the top bar or under the caption | Top text starts at 12 % of the height, bottom text ends at 82 % (`api/editor/plan-render.ts:203`), whatever the format |
| A card or a text gone before it can be read | Card words are written with no idea of the time they get (`cards/prompts.ts` `planPrompt`: lines carry only their words), then a card holds for its window (1.2–2.4 s for a cutaway) with up to 60 characters (`cards/state.ts` `CARD_TEXT_MAX`); plan texts may be 0.3 s for 120 characters (`plan.ts:1052`); a caption ends 0.08 s after its last word (`caption-layout.ts:304`). A 0.28 s pop or fade entrance (`CaptionRenderSurface.tsx:81`) comes out of that time |
| A file that is short, silent or unreadable counted as done | A clean ffmpeg exit is success (`api/exports.ts` `exportRendered`); sound is mapped as optional (`0:a?`); a joined AI Editor preview is not looked at |
| A first frame nobody picked | Platforms take the first frame when no cover is chosen. The cover picked for a Final is a separate JPEG (`collections.ts:927`) |
| Real people's details in a post | No prompt that writes public text (Content Workshop, Designer, cards) says to keep names, emails or customer details from files and footage out |

## 2. Goals and non-goals

Goals:

1. Text meant to be read on a vertical video sits inside the reel band by default, wherever the app places it, and
   Caption Studio shows the band.
2. Every exported file and every joined AI Editor preview is checked (length, sound, one readable frame, and the frame
   count where the frame rate is the app's) before it counts as done, and fails with what was wrong.
3. Text a viewer reads holds long enough to read, counted from when it is fully on screen.
4. A Caption Studio export can make a picked frame its first frame.
5. Prompts that write public text keep private details out, and the rules the Content Workshop's prompts share are
   written once.

Non-goals:

- Moving the captions of existing projects, or of a Caption Studio project the AI Editor burns in: the AI Editor draws
  the person's project as it is (`api/editor/captions.ts` `captionsOverlay`). New projects and a newly applied preset
  are placed in the band, so later edits get it from there.
- Review stills with captions on and a plan-text/caption overlap note: the preview does not draw captions yet
  (`api/editor/preview.ts:48`), and `qa.ts` never sees the caption box. Revisit when the preview draws captions.
- A cover picture stored inside downloaded Finals: platforms ignore it, and keeping a second copy of every Final
  doubles storage.
- Crossfades in the AI Editor (dissolves dip through black, `plan-render.ts:198`), automatic best-frame picking, the
  Designer (it has guides and snapping), and rewriting the assistant's and Designer's long prompts.
- Measuring each platform's buttons per phone. `DESIGN_SAFE` stays the one source, with its `shortcut:` note.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The reel band is `DESIGN_SAFE`'s `reel` inset (top 14 %, bottom 35 %, sides 6 % / 14 %), read through one helper | One source; the Designer already uses it |
| D2 | A video counts as vertical when its height ÷ width as shown (after its turn) is ≥ 1.7 | 9:16 is 1.78; 4:5 and square have no reel buttons over them. An upright phone clip is stored on its side with a quarter turn |
| D3 | The band moves text only when it is placed (new project, preset applied, AI Editor plan text drawn), never on open | Moving text people placed themselves breaks trust |
| D4 | A file that fails its check fails the job; nothing is kept as "done with a note" | A short or silent file that looks done gets posted |
| D5 | Reading time is 0.3 s a word, at least 0.8 s, counted after the entrance | A common subtitle rate; one number for every tool |
| D6 | The first-frame cover is a checkbox in the export dialog, off by default | The one-frame change at the start happens only when the person asks for it |
| D7 | Captions get a minimum hold only from free time: never into the next caption, never past the end | Captions follow speech; overlapping them is worse than a short one |
| D8 | The frame count is checked only where the app sets the frame rate (MOV, WebM, PNG frames); a burn-in keeps the source's rate, which a phone or screen recording may vary | A 60 fps or variable-rate clip must not fail a good export |

## 4. Requirements

### 4.1 The reel band

Shared (`contracts/design.ts`, beside `DESIGN_SAFE`):

- `isVertical(w, h)` (D2): callers pass the size as shown.
- `REEL_BAND`: the reel inset.
- `intoBand(box, w, h)`: a caption box (centre and size in % of the frame) moved the least distance that puts it inside
  the band, up or down only (centred captions stay centred). Its size stays; a box taller than the band is centred in it. Not vertical: returned unchanged.
- `intoBandMargin(position, marginVPct, w, h)`: for a style placed by edge (`fitBox: false`), the margin raised to the
  band (bottom 35 %, top 14 %); centre and non-vertical unchanged. Packs' caption styles may use this mode.

Caption Studio:

- A new project on a vertical video, and a preset or caption-style pack applied to one, place the captions with
  `intoBand` (and `intoBandMargin` for `fitBox: false`). `STYLE_PRESETS` keeps its values (landscape uses them).
- The player gets a **Reel buttons and caption** guide on vertical videos: the covered parts tinted, as in the
  Designer. Off by default, remembered per browser.
- The export dialog of a vertical video whose captions are outside the band shows one row, **Captions under the
  reel's buttons**, with **Move up** (the two helpers). Never a block; nothing when they are inside.
- The second preset named "Classic" (`types.ts:344`) becomes **Classic Low**.

AI Editor:

- Plan texts (`plan-render.ts:203`) on a vertical timeline: top text at 14 %, bottom text ending at 65 %. Landscape
  keeps 12 % and 82 %.
- Cards on a vertical timeline: `stage()` in `cards/prompts.ts` gives the band in CSS pixels ("words stay between
  y 269 and 1248 and left of x 929; the rest is under the reel's buttons and caption", computed from `REEL_BAND`).
  `LOOK` adds "words under the reel's buttons" to what is broken, for vertical only.

### 4.2 Checking the file

New `api/lib/render-check.ts`:

```ts
checkRender(file, want: { duration: number; sound: boolean; fps?: number; width?: number; height?: number })
  → { ok: true } | { ok: false; why: string }
```

- One ffprobe: a video stream exists; its duration is within 1 frame + 0.05 s of `duration`; width and height match
  when given.
- `fps` given (D8): its frame count (`-count_packets`) is within 1 frame of `ceil(duration × fps)`.
- `sound`: an audio stream exists and its length is within 0.1 s of the video's.
- One frame decoded at the middle (`-ss mid -frames:v 1 -f null -`) without an error.
- `why` is one short line for a tooltip ("Video is 3.2 s short", "No sound", "Frame at 0:12 could not be read"), never
  ffmpeg's output.

Where it runs:

- **Caption Studio export** (`api/work/tasks/export.ts`), on the computer that rendered it, after ffmpeg and before the
  file is sent. Burn-in: `duration`, `sound` = the source has sound. MOV and WebM: `duration`, `fps`, no sound. PNG
  frames: the count of PNGs equals `ceil(duration × fps)`. A failure fails the task with `why`, as an ffmpeg error does.
- **AI Editor preview** (`api/editor/preview.ts`): the joined preview, with `duration` and `sound`. A failure fails the
  render as a failed ffmpeg does now.
- Every PNG frame input gets `format=rgba` as its first filter, so the overlay and encoders always get one pixel format
  (a guard; burn-in: `[1:v]format=rgba[c];[0:v][c]overlay=…`).

### 4.3 Reading time

New `contracts/reading.ts`: `READING = { perWordS: 0.3, minS: 0.8, entranceS: 0.3 }`, `readS(text)` (seconds a text
needs once fully shown), and `wordBudget(seconds)` (words that fit a hold of that length after the entrance).

- **Caption entrance**: `CaptionRenderSurface.tsx` takes its pop and fade lengths from `READING.entranceS`, so the two
  never differ.
- **Captions** (`src/lib/caption-layout.ts:304`): a caption ends at the later of its last word + 0.08 s and
  `start + entranceS + 0.5 s`, never after the next caption's start or the video's end (D7). Fill gaps is unchanged.
  Every renderer reads the layout, so all of them follow.
- **Cards**: the card's words are written at planning (`planPrompt`), so each line in `PlanLine` carries the seconds of
  room it has (`cardWindow` in `cards/place.ts`, in seconds), and the prompt shows its word budget. `parsePlan` refuses
  a card longer than its line's budget, as it refuses a line that cannot carry one. `CARD_TEXT_MAX` stays the cap.
- **Plan texts** (`plan.ts:1052`): the minimum `dur` becomes `readS(text) + entranceS`, bounded by what is left of the
  video. The plan prompt says so in one sentence.
- **AI Editor QA** (`qa.ts`): a note for a plan text held less than its reading time ("Text at 0:08 holds 9 words for
  1.6 s (needs 3.0 s)"). A note, never a block.

### 4.4 First frame as cover

- Caption Studio export dialog: a **Cover as first frame** checkbox (off) with a frame picker (the Finals cover picker's
  control, reused). The export request carries `coverAt` (seconds).
- `api/work/tasks/export.ts`, burn-in only: frame 0 is replaced by the frame at `coverAt` in the encode the export does
  anyway (the picked frame as a second input, overlaid with `enable='eq(n,0)'`), so length and sound stay the same.
- Not for MOV, WebM or PNG overlays (they are laid over something else).

### 4.5 Prompts that write public text

- `KEEP_PRIVATE` in `api/lib/workshop/prompt.ts`: "Never copy people's names, emails, phone numbers, addresses or
  customer details from the files, footage or notes into what will be posted, unless the author wrote them into the
  piece." Used by the Content Workshop's draft and chat prompts, the Designer's guide (`api/designs.ts`) and the card
  plan prompt.
- The rules both Content Workshop prompts copy become constants used by both: the "kept for format" rule
  (`prompt.ts:47`, `:92`, `chat-prompt.ts:111`), "workspace instructions are always on" (`prompt.ts:49`,
  `chat-prompt.ts:114`), the source weights (`prompt.ts:52`, `chat-prompt.ts:33`, `:110`). The four copies of "Do not
  call set_caption or set_pinned." in `KIND_RULES` become one line said once.
- `api/mcp.ts` is not changed (its tool text needs the store check first).

## 5. Wording

| Where | Text |
|---|---|
| Caption Studio player guide | Reel buttons and caption |
| Export dialog row | Captions under the reel's buttons · **Move up** |
| Export dialog checkbox | Cover as first frame |
| Failed export | Could not export video · **Retry** · the `why` on hover |
| Failed AI Editor preview | Could not make the preview · **Retry** · the `why` on hover |
| QA note | As in §4.3, in the style of the notes `qa.ts` writes now |

Each follows AGENTS.md's app wording.

## 6. Changes by file

| File | Change | Part |
|---|---|---|
| `contracts/design.ts`, `contracts/reading.ts` | The helpers and constants | Shared, first |
| `api/lib/render-check.ts` (new), `api/work/tasks/export.ts`, `api/editor/preview.ts`, export dialog | Checks, `format=rgba`, first-frame cover, the band row | A |
| `src/lib/types.ts`, Caption Studio new-project / preset / pack code, the player, `api/editor/plan-render.ts` | Band placement, guide, rename, plan text positions | B |
| `src/lib/caption-layout.ts`, `CaptionRenderSurface.tsx`, `api/editor/plan.ts`, `api/editor/qa.ts` | Reading time | C |
| `api/editor/cards/prompts.ts` (+ where `PlanLine` is built), `api/lib/workshop/prompt.ts`, `chat-prompt.ts`, `api/designs.ts` | Card band and budget, `KEEP_PRIVATE`, shared rules | D |

No new environment variable, dependency or status. The checks run in the work task code the Mac app's bundled server
carries, so an older Mac app exports without them until it updates; nothing on the page needs a newer Mac app, so
`MIN_MAC_APP` stays.

## 7. Tests

Each next to its file:

- `contracts/design-band.test.ts`: `intoBand` moves an 84 % box to end at 65 %, leaves a 50 % box, leaves every box on
  16:9 and 4:5, centres a box taller than the band; `intoBandMargin` raises a 6 % bottom margin to 35 %.
- `contracts/reading.test.ts`: `readS`, `wordBudget`.
- `api/lib/render-check.test.ts` (in the ffmpeg group of `vitest.config`): passes a good 1 s file; fails one cut short,
  one silent when sound is wanted, one with the wrong frame count, each with its `why`.
- `api/work/tasks/export.test.ts`: a burn-in with `coverAt` has the picked frame at frame 0 and the same frame count.
- `src/lib/caption-layout.test.ts`: a 0.2 s one-word caption holds into free time, never past the next start.
- `api/editor/qa.test.ts`, `plan-render.test.ts`, `cards/prompts.test.ts`, `workshop/prompt.test.ts`: the note, the
  positions, the budget refusal and band text, `KEEP_PRIVATE` in every public-text prompt and each shared rule once.

## 8. Decided (were open questions)

1. The second "Classic" is **Classic Low**.
2. The band guide starts off; the export row says when captions are under the buttons.
3. The caption hold applies to every style: it only uses free time.
4. The first-frame cover is opt-in (D6), so the one-frame change happens only when asked.

## 9. Order

The shared helpers first (one commit), then parts A–D in parallel, each its own commit with its tests.
