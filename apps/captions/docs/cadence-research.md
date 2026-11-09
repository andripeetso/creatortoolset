# Match cadence: findings and improvements

## Current design (2026-09-22)

Measured on a timed test clip (`src/lib/__fixtures__/cadence-clip-01.json`, 382
words of fast, silence-trimmed speech; its words are scrambled placeholders):

- Deepgram word times are contiguous: 370 of 381 word boundaries have zero
  gap, durations come in 80 ms steps, and utterance splits are useless. Pause
  or waveform evidence carries no signal for this kind of speech. Grouping
  has to come from the language. Don't rebuild on gaps.
- Cloud transcription joined its 45 s windows wrongly and kept both copies of
  the words in each overlap ("So So for for example, example,"). Fixed in
  `mergeOverlappingWindows` (`api/transcribe.ts`).

How it works now:

1. **Match cadence** (`api/ai.ts`, `api/lib/cadence-lines.ts`): the model
   rewrites the transcript one thought per line, with `|` where a long line
   may split. Code aligns the lines back to the words (LCS, ≥95 % matched) and
   stores one mark per word on `Word.cut`: 2 new thought, 1 split point, 0
   keep together. Sentence starts are always 2. The marks don't depend on the
   caption box.
2. **Layout** (`src/lib/caption-layout.ts`): each thought is one line when it
   fits; a wider thought splits into the fewest even lines at `|` points, then
   Netflix line treatment. A line never carries the next thought or the next
   sentence. Captions stack whole lines up to the box's line count (a 1-line
   box only ever gets 1-line captions). The chosen lines are stored on
   `Cue.lines`; the preview, server export, local export, ASS and SRT all
   draw those lines.
3. **Resizing** the box or font re-runs only the layout, live, with no model
   call.

Measure changes with `npx tsx scripts/cadence-eval.ts kimi --box 28x1`
against `cadence-clip-01.reference.txt` (a draft reference; correct it before
trusting the numbers). First runs: Kimi k3 ~25 s, 91–93 % of its line breaks
in the reference, ~80 % of the reference breaks found; gpt-4o 5 s, 87 % /
58 % (it fills lines with the next thought).

Fallback (2026-09-24): Claude Opus 5.5 at effort `low`, three runs: 7 s,
97–100 % / 75–81 %, 43–50 of 80 lines exact. At `medium`: 7 s, 98 % / 75 %,
43/80. gpt-4o the same day: 4 s, 100 % / 43 %, 7/80. So Claude runs second
in the chain, at `low`, and ChatGPT last.

Speed (Kimi, same reel, one run at a time):

- One request for the reel: usually 14–16 s, but 2 of 5 runs took 80–90 s.
- Split into ~120-word pieces in parallel: 29–55 s and worse grouping
  (53–72 % of reference breaks found vs ~80 %). The wait is the slowest
  piece, and each piece has less context. Reels stay one request; only
  transcripts over 500 words split, at sentence ends, with the neighbouring
  sentences as context.
- A request still running after 25 s gets an identical second request and
  the first answer wins (`hedged` in `api/lib/cadence-lines.ts`). Five runs:
  17–46 s, no 80–90 s waits, same grouping quality.

Box width (added the same day):

- Telling the thought pass the box width made K3 chop thoughts into short
  lines ("and also actually / getting on the couch / with the author"): only 57 %
  of its breaks were thought breaks. The thought pass never sees the box.
- Asking the thought pass for more `|` marks, or a separate pass for
  "every phrase boundary", didn't work: K3 ignored it or returned whole
  sentences, and both models marked phrases only at commas.
- What works: a second, small request (`splitPoints`, `/api/ai/split`)
  with only the thought lines wider than the box, told the lines are fixed
  and asked where each may split. Six lines per request, in parallel:
  ~27 s on K3 for the reel (85 s as one request); gpt-4o is 4 s but splits
  worse ("So check out my pinned | videos"). Extra line breaks it adds are
  treated as split points, never as thoughts.
- The app lands the thought lines first, then runs this in the background
  (`fitSplits` in the store) and again from "Re-match for this size" when
  the box gets narrower than it was planned for. Reel at 26 chars: 0–5
  lines break where nothing was marked, down from 9–13.
- Cheaper Kimi models on the coding plan (`kimi-for-coding`,
  `kimi-for-coding-highspeed`) were worse: sentence-level lines in one run,
  67–144 s, or no valid JSON. K3 stays.
- Kimi's plan has a 5-hour usage limit, so the second request fires after
  40 s, not sooner.

Transcription: Deepgram's `smart_format` sometimes drops the word after a
number ("these eighteen months" → "these 18,"). On the same audio,
`punctuate=true` returned identical words with numbers spelled out, so the
app uses that.

## Earlier notes (2026-09-06)

The rest of this file predates the design above.

Research date: 2026-09-06. This review uses the repository and synthetic timed
transcripts, including text visible in the user's screenshot. It does not audit
the user's production requests or evaluate their original audio.

## Why the existing grouping can feel awkward

- The old model prompt prioritizes uniform 2–4 word beats and explicitly permits
  ending on small words other than articles. That can favor fragments over
  complete phrases.
- The model receives words and pauses, but previously did not receive individual
  word durations, despite those timings already being available. It does not
  hear the audio, pitch, stress, or delivery.
- After the AI answers, `cuesFromBreaks` greedily splits groups that exceed box
  capacity. This can create an orphan even if the proposed phrase was sensible:
  at 15 characters, `looking at your phone?` becomes `looking at your / desk?`.
- Model requests are chunked at up to 500 words. Every chunk introduces a
  boundary, without a subsequent check of whether its neighbors read well.
- Capacity is an estimated character budget derived from average glyph width,
  not a measurement of every rendered word. Very narrow boxes and indivisible
  long words remain physical constraints.

## What the sources support

1. **Keep linguistic units together.** Netflix's English guide recommends
   breaking before conjunctions/prepositions and avoiding splits inside noun,
   name, subject/verb, and auxiliary/verb combinations. These are useful phrase
   principles; its broadcast line lengths and pacing are not automatically the
   right defaults for short social videos.
   [Netflix English line treatment](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide)

2. **Use more than silence.** Research on spontaneous speech identifies phrase
   boundaries using pauses and changes in speech rate. This supports supplying
   duration information, but raw word length is only an approximation: the paper
   estimates rate from aligned phone durations. A long word alone does not prove
   emphasis, and a fixed pause threshold is not universally optimal.
   [Automatic detection of prosodic boundaries in spontaneous speech](https://pmc.ncbi.nlm.nih.gov/articles/PMC8092678/)

3. **Evaluate neighboring captions and reading time.** Netflix's timing guidance
   recommends merging/resegmenting neighboring subtitles to improve uneven
   reading speeds. Its 0.8-second minimum is a broadcast requirement; this app's
   short-form duration preferences are product choices, not a claim of compliance.
   [Netflix subtitle timing](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines)

4. **Language-aware segmentation is a distinct problem.** ACL research predicts
   subtitle boundaries using linguistic context and punctuation likelihood,
   supporting a separate segmentation stage instead of relying on ASR chunks.
   [Unsupervised Subtitle Segmentation with Masked Language Models, ACL 2023](https://aclanthology.org/2023.acl-short.67/)

## Implemented locally

- Rewrite the prompt around complete, usually 2–5 word spoken phrases; provide
  readable context, word durations, and pauses. Ask it to check both sides of a
  proposed boundary and preserve justified one-word replies/emphasis.
- Add a deterministic optimization pass specifically to Match cadence. It
  prefers AI boundaries while penalizing orphans, dangling function words,
  rapid flashes, and oversized groups. It respects sentence ends, long pauses,
  and estimated box capacity. It evaluates the whole answer across chunk seams.
- Preserve original word objects, text, order, and timing. Keep manual grouping
  and master transfer on their existing explicit-boundary path.
- Reject missing/malformed boundary responses instead of silently labeling a
  fallback grouping as successfully matched.

The optimization weights, 0.3/0.65-second pause thresholds, and soft duration
preferences are heuristics to validate on real clips. The English function-word
list is a limited safeguard; it does not recognize every grammatical phrase.

## Does the first run apply cadence?

Automatic matching is enabled by default but can be disabled per project. The
queue transcribes, enters `matching`, runs the same `refineCues` action used by a
manual request, applies the result, and then marks transcription done. Tests
verify this sequence, failures, and the disabled option. A failed request keeps
the transcript available without setting `cadenceApplied`.

A rerun requests a fresh AI proposal; it does not progressively refine the old
breaks. Model output, updated words, or changed box capacity can produce different
grouping. A different second result is not evidence that the first was skipped.
These tests confirm code behavior, not the history of a particular online clip.

## What to validate next

Use a small set of real clips with hand-reviewed reference breaks. Compare old
and new grouping blindly and count user corrections, accidental singletons,
broken phrases, flashes, and overflow. Include fast speech, deliberate pauses,
long words, narrow boxes, and a transcript crossing a model chunk boundary.

If boundaries still miss the delivery, investigate alignment accuracy and
audio-derived phrase cues. A text model cannot recover all the speaker's
intonation from words and gaps alone. Do not claim audio-level cadence matching
until it has been evaluated against the original sound.
