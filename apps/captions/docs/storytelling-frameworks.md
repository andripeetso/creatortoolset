# Storytelling frameworks — the library behind the Content Workshop

Distilled from common storytelling structures (a podcast-style cold open, AIDA for shorts and ads,
a long-form three-act spec, a five-stage spine for short scripts) and the CTA and ad shapes the Workshop seeds.

Two kinds of thing are in here, and only the first is in the Workshop picker:

1. **Storytelling frameworks** — structures that work in any medium (a reel,
   a carousel, an ad, an email, a talk). These are seeded into the Workshop
   (`api/lib/workshop/seeds.ts`), twenty-one of them in three roles, one of each per piece.
2. **Format layouts and techniques** — how a science reel is laid out, slide
   maps for carousels, CTA shapes, hook tests. Reference only; they describe
   packaging for one medium, not a story.

Voice, facts and the hard gates (no invented moments, no new metaphors, CTAs
on-platform, no hashtags) live in the project profile, not here.

Source value, used by search, packs and the prompt: the creator's on-screen
slide text counts most, then what they said (transcript), then the caption,
then comments — the audience talking, useful for objections and language,
never as facts.

## In the picker — storytelling frameworks

Shape (narrative, sets the order): Five-Stage Spine · Two Loops · Three-Act Revelation · Backwards Reveal · Pixar Pitch · I Was Wrong · Story Circle · StoryBrand · Kishōtenketsu. Persuasion (shapes the ask): AIDA with Story Loops · Problem–Agitate–Solve · Before–After–Bridge · Hook–Story–Offer · Deliver, Then Tease · Promise–Picture–Proof–Push · PASTOR · Monroe's Motivated Sequence. Argument (shapes the reasoning): Myth–Truth–Proof · SCQA · Toulmin · Rogerian. One of each role per piece; the shape sets the order and every step of the other two must be present inside it. The but/therefore rule (Stone & Parker) is not a framework: it applies to every piece and is written into the generation prompt.

## Reference — format layouts and techniques

### Which layout for which piece

| You are writing… | Start with |
| --- | --- |
| A science / education reel | Reel · 10-Step Science Reel (check), Reel · Five-Stage Spine (skeleton) |
| A counterintuitive take or myth-bust | Reel · Default Arc, Reel · Contrarian Detonator |
| Something that must sell without sounding like it | Reel · Read-the-Comment Answer (needs an honest clock), Reel · Origin Story |
| A how-to | Reel · Utility Demo, Carousel · Step-by-Step |
| Something funny | Reel · Deadpan Inversion |
| Long-form | YouTube · Three-Act Revelation or Mini-Payoff Sections; Podcast · 60-Second Cold Open |
| A carousel | Backwards Reveal (safest slide 2), Pixar Pitch, Promise-Picture-Proof-Push, Parent Case Study, Letter, Myth-Bust, Step-by-Step, I Was Wrong |
| Ads, sales, email | Ad · Hook-Agitate-Solve-Prove-Ask, Sales · VSL, Sales · PASTOR, Email · Teach-Example-Exercise |
| The last ten seconds | CTA · Reel Close, CTA · Next-Video Bridge |
| The first ten seconds | Hooks · Component-First Hook Lab |

Fit-check first (marketing-copy.md): walk the draft against the framework's
beats; if three of four already fire, augment surgically instead of
restructuring. Forcing a framework on a working arc destroys the beats that
carry the brand.

## Rules — the gates that apply inside every framework

These are not frameworks. They are the Workshop's **Rules** tab: ten starters
seeded per user, on by default, editable, and switchable off per run in the
Generate panel. Every rule that is on is written into the generation prompt
under "Rules for this piece".

- **But / therefore** (Stone & Parker): between every beat you must be able to
  say "but" or "therefore", never "and then". A beat sheet is 5–8 story moments
  joined that way, not section labels.
- **Jenga** (Colin & Samir): tension rises over the whole piece; at every
  point ask "why is the viewer still watching, what are they waiting for". When
  they have no questions left, the video is over.
- **Loops**: the hook opens a loop and never closes one; nest if needed, close
  the inner loop first, close causally, never by announcement. Never open a
  loop you don't close.
- **Payoff last**: the answer lands in the final 5–10 s, then the CTA, then
  stop. No recap. A mid-video payoff needs an immediate re-hook.
- **Write payoffs first** (Blackman): decide what the parent will do, then
  write the hook, then the tension in between.
- **One concept, one finding, one named researcher** per short piece.

### Reel layouts

### Reel · Five-Stage Spine
Hook/trigger (0–3 s) → Credibility shown in story (3–8 s) → Tension: cost of
staying the same (8–20 s) → Resolution/reframe (20–40 s) → Grand takeaway →
CTA bridge (40–60 s). Emotional arc calm → curiosity → friction → revelation →
conviction. "Never say I'm an expert — demonstrate it." "The CTA should feel
like the next sentence of the content, not a commercial break." Never end on
fear; end on agency.

### Reel · 10-Step Science Reel
Hook (5–12 words) → Spoken qualifier → Context (1–2 lines) → Research (1 line)
→ Explain (2–4 short paragraphs) → Re-hook (~8–12 s) → Reassure (1 sentence)
→ Action (3–6 steps, ≤12 words, with counts/times) → Bridge (1 sentence) → CTA.
Body 250–600 words; on-screen hook 2–8 words, never over 12. Spoken research
stays plain ("researchers found…"); the paper, name and year go on screen. The
reassure line must not be the stock phrase. It is a checklist after drafting,
not a template while drafting. Re-hook types: payoff tease, emotional pivot,
new concrete detail, visual proof, restate the stakes; 6–12 words; at ~10 s,
~22 s and ~37 s.

### Reel · Origin Story
Proof hook → Juxtaposition → Origin beat → Authority stack → Systemic
revelation → Escalation → Accidental villain → Simple solution → Social-proof
bridge → Identity close. Derived from the 4M-view origin reel. The accidental
villain beat does three things in one move: names the villain, uses the word
"accidentally", validates necessity ("many of these are necessary, and in some
cases legally mandated"). The "not X, but Y" ban is suspended here, once, at
the top. Gravity of problem ÷ simplicity of solution = shareability.

### Reel · Default Arc
Extracted from 83 published scripts: personal confession or stance →
acknowledge the objection → why the normal approach fails, naming the
reader's own behaviour → the named researcher told as a story → the turn →
personal proof → compressed thesis line → CTA to profile. Variants: Manifesto
(one line per shot) and Sarcastic inversion (advice delivered backwards).


### Reel · Stop, Hook, Journey, Payoff (Ernesto Perez)
Scroll stopper 0–3 s (visual: kinetic = mid-action, potential = about to
happen; the wordless test: can the first frame carry the hook silently) → Hook
0–5 s → Journey 30–40 s (outline the goal → preparation → first obstacle →
final obstacle; escalating stakes, not information delivery) → Payoff last 5–10
s. Three payoff principles: don't signal "it's over" early; target one emotion
(inspired, awe, love, calm, surprise, joy, fascinated — never end anxious);
elasticity — end with the opposite emotion of the setup (tension → relief →
agency). Retention diagnosis: drop at 0–3 s = visual, 3–8 s = qualifier,
8–15 s = mechanism too abstract, 15–30 s = pacing (cut 10%, add a re-hook),
30 s+ = weak action or CTA.

### Reel · AIDA with Story Loops
Attention (provocative statement, never a question, teases the takeaway) →
Interest (open the loop, first mini-payoff: set-up → tension → resolution) →
Desire (re-hook every 2–3 sentences: readdress the pain with new urgency,
tease the next takeaway, pattern interrupts) → Action (close the loop by
delivering the promise, quick CTA before they notice the end). 250–400 words,
spoken words only, teach how to do something, never a fear hook.

### Reel · Emotional Entry, then Reframe
Feeling parents recognise → reframe as positive or surprising → one finding
backs it → one thing to do → reassure after the ask. "Parents scroll past
information. They stop for feelings."

### Reel · Progressive Revelation
Micro-payoff early → medium payoff mid → full payoff late → action → CTA.
Each payoff earns the next stretch of attention.

### Reel · Read-the-Comment Answer (Engine A, "VSL in disguise")
Cold open on a real comment → frequency framing → mental model → honest
biological clock → resolve → tease → soft CTA. Router question: does the topic
have an honest biological clock (a window closing, a library filling, an
aversion compounding)? Strong clock → this engine can sell. Weak or none →
run a contrarian or a demo and don't force the sell.

### Reel · Contrarian Detonator (Engine B)
Cold open contradicting the mainstream → grant the honest case for it
(validate-then-reframe, the anti-backlash move) → where it breaks → one
finding → the culture is the villain → what to do instead → soft CTA. Wins
reach.

### Reel · Utility Demo (Engine C)
Relatable pain → one checkable mechanism on screen → why it works → exact
steps → common mistake → when they'll notice → soft CTA. Wins saves and trust.

### Reel · Deadpan Inversion
The whole piece ironic; escalate straight-faced; reveal in the last two lines
or let the comments do it; follow with a stitch reply.

### Reel · Manifesto
One line per shot, staccato, no science.

### Long-form layouts

### YouTube · Three-Act Revelation
Act 1 setup (relatable problem, promise, credibility, first breadcrumb, major
loop) → Act 2 investigation (discovery, expert validation, personal stakes,
mounting evidence, counterarguments) → Act 3 revelation (final piece, complete
picture, implementation) → ending (payoff summary, one action, vision, tease).
3–5 loops open at once (major, section, bridge, curiosity); micro-hook every
45–60 s; 140–160 words per minute; the grand payoff must exceed the promise.


### YouTube · Mini-Payoff Sections
Provocative opening (no question) → sections of set-up / tension / resolution
→ re-hooks between → close the opening loop → seamless ending (summarise,
reveal a sudden related problem, tease its solution, direct to the next
video). Cite sources in plain words, name the complicated things and explain
them simply, assume a smart audience.

### Podcast · 60-Second Cold Open
Hook (0–10 s) → credibility and context (10–25 s) → key insight 1 (25–40 s) →
key insight 2 (40–55 s) → closing "next, on [show]" (55–60 s). Soundbites
verbatim with timestamps, trimmed only of filler; VO original, conversational,
never generic praise. Priority quotes: hook, credibility, insight, curiosity.


### Carousel slide maps

Common rules (carousel-mechanics.md): slide 1 carries most of the swipe-through
and must not be split; slide 2 must work as a standalone entry; one idea per
slide; cliffhanger bridges; a pattern interrupt at slides 3–4; loop the last
slide back to the first; one CTA per warm-audience carousel (save/send or the
product, never both). Slide-2 reliability: Promise-Picture and Backwards Reveal
highest; PAS, BAB, Pixar, In Medias Res, Vulnerability Arc high; AIDA, FAB,
Hero's Journey, Freytag low. Name the framework when you ship it ("The 4-Step
Rule") so it becomes reusable.

- **Backwards Reveal** — S1 outcome → S2 negation ("and I didn't do any of these 5 things") → S3–7 myths → S8 what I did → S9 why → S10 how → S11 CTA.
- **Pixar Pitch** — once upon a time / every day / until one day / because of that ×3 / until finally → mechanism → meaning → one thing today → CTA.
- **Promise, Picture, Proof, Push** — show the after, don't sell the before.
- **Parent Case Study** — headline, background, the moment, the wrong first try, the three things, where they are now, the pull-quote, how to start, CTA.
- **Letter with a Vulnerability Arc** — "Dear …" / specific moment / confident wrong claim / evidence / unfolding as witness / late reframe / "— the creator's name" / CTA.
- **Myth-Bust** (highest shares and comments), **Step-by-Step** (saves), **I Was Wrong** (comments).

### Ads, sales, email layouts

- **Ad · Hook, Agitate, Solve, Prove, Ask** — primary text ≤125 chars opener, headline ≤40, description ≤30; video 0–3 / 3–8 / 8–20 / 20–30 s, captions always. Test in this order: angle → hook → visual → body → CTA. Eight angles: pain, outcome, proof, curiosity, comparison, urgency, identity, contrarian.
- **Sales · VSL** — origin → big domino → three secrets (vehicle, internal, external) → stack → close. Connect then educate. Psychology: endowment (free content creates ownership of the method), Zeigarnik (open loops across the funnel), hyperbolic discounting (lead with the immediate win).
- **Sales · PASTOR** — problem, amplify, story/solution, transformation, offer, response.
- **Email · Teach, Example, Exercise** — one belief per email; 3–5 emails over 5–7 days for a mini-course; one CTA; no escalating discounts, a single one in the final email with a reason; every email worth reading even if they never buy. Warm texture: promise kept, spring-cleaning opt-out, reply-with-a-word.

### CTAs and hook techniques

- **CTA · Reel Close** — link to this script's insight → name the mechanism → how it's matched to the audience's stage → on-platform destination → reassurance after. Variants from cta-playbook.md: gap bridge (after a complete tip), mechanism reveal (after a why), objection dissolve (after reassurance), DM hook ("DM me TUMMY…"). Eight angles to rotate: progression, stage-match, weekly routine, environment, self-generated movement, science-built, time-efficient, what-comes-next. Swap test: if the CTA fits any script, rewrite. Mix: 75% profile/pinned, 15–20% DM, ≤10% comment (on pause), plus a pure-value piece every 8–10 scripts.
- **CTA · Next-Video Bridge** — link to the current video → widen the curiosity gap → promise a specific transformation → point to the next video.
- **Hooks · Component-First Hook Lab** — target / transformation / stakes as three lines → combine → loop check → Visualise, Falsify, Only-you (3/3 strong, 2/3 workable, else rewrite) → spoken qualifier → five variations (A myth-bust, B knowledge gap, C "try this", D identity, E emotional entry). Banned shapes: "people assume X but…", questions on screen, "something every parent should know", hooks that give the answer. Gap sizing (Loewenstein): moderate — resolvable in 5–15 s.

