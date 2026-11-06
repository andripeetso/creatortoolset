import type { Framework } from "./types";

export type SeedFramework = Omit<Framework, "id" | "owner" | "createdAt" | "updatedAt"> & {
  seedKey: string;
};

/**
 * Storytelling structures that work in any medium — a reel, a carousel,
 * an ad, an email, a talk. Format-specific layouts (10-step science reel,
 * carousel slide maps, CTA shapes) live in docs/storytelling-frameworks.md
 * as reference and are deliberately not in this list.
 * Seeded per user, once per key; editable and deletable; a deleted one
 * never comes back. Stacking: one narrative shape sets the order, one
 * persuasion formula shapes the ask, one argument structure shapes the
 * reasoning — at most one of each role on a piece.
 */
export const SEED_FRAMEWORKS: SeedFramework[] = [
  {
    seedKey: "spine",
    name: "Five-Stage Spine",
    role: "narrative",
    pairsWith: "Any persuasion formula; Hook – Story – Offer for the ask, Myth – Truth – Proof when the piece argues against a belief.",
    summary: "A concrete trigger, proof shown not claimed, the cost of staying the same, a simpler lens, and a takeaway that makes the ask feel inevitable.",
    steps: [
      "Trigger: one concrete moment that breaks an assumption or exposes an irony",
      "Credibility: lived proof or authority shown inside the story, never claimed",
      "Tension: the cost of staying the same — what is at risk if nothing changes",
      "Reframe: a clearer, simpler lens on the problem",
      "Takeaway: the moral insight, then the ask as the next sentence, not a commercial break",
    ],
    whenToUse: "The skeleton under most persuasive pieces. Emotional arc: calm → curiosity → friction → revelation → conviction. Never end on fear; end on agency.",
    example: "A bread that never rises (trigger) → the baker weighs every bag of flour (proof) → the same loaf every week, nothing changes (cost) → the yeast is dead, not the oven (reframe) → fresh yeast is the answer, not the recipe (takeaway).",
  },
  {
    seedKey: "aida-loops",
    name: "AIDA with Story Loops",
    role: "persuasion",
    pairsWith: "Any narrative shape; Myth – Truth – Proof inside the Interest section.",
    summary: "Attention, Interest, Desire, Action — with a loop opened at the top, mini-payoffs inside (set-up, tension, resolution), re-hooks between them, and the loop closed right into the ask.",
    steps: [
      "Attention: a provocative statement that teases the takeaway without giving it away",
      "Interest: open the story loop and deliver a first mini-payoff — set-up, tension, resolution",
      "Desire: raise the stakes; re-hook every few beats by naming the pain again or teasing the next takeaway",
      "Second mini-payoff with the non-obvious value",
      "Action: close the loop by delivering the opening promise, then the ask before it feels like an ending",
    ],
    whenToUse: "Teaching pieces of any length. The hook opens a loop; nested loops close inner first; never open a loop you don't close.",
    example: "\"Burning a candle in your living room is basically burning a jar of diesel.\" → the loop → the mechanism → the fix → one-line ask.",
  },
  {
    seedKey: "two-loops",
    name: "Two Loops",
    role: "narrative",
    pairsWith: "Myth – Truth – Proof for the turn; Hook – Story – Offer or Deliver, Then Tease for the ask.",
    summary: "The hook promises two things. The first is answered within seconds, so the viewer knows the piece pays; the second stays open and carries the rest. Before the first answer is explained, a turn says what people get wrong about it.",
    steps: [
      "Hook: promise two things in one line",
      "Answer the first one right away, in a sentence or two",
      "Turn before explaining it: what people get wrong about it, or why it isn't what they'd think",
      "Explain only the part the viewer doesn't already know",
      "Open the second: what it is and what it costs to miss it; each smaller answer opens the next question",
      "Answer the second last, then the ask",
    ],
    whenToUse: "Teaching pieces where the answer is short and the why is the value: reels, carousels (slide 1 promises two, slide 2 answers the first), long-form chapters. Not for a piece with one point.",
    example: "\"Two things decide how fast dough rises. The first is temperature.\" → but not the way most of us do it: the kitchen is colder than we think → what that cold does to the timing → \"the second is how long you let it rest\" → one thing to check tonight.",
  },
  {
    seedKey: "three-act",
    name: "Three-Act Revelation",
    role: "narrative",
    pairsWith: "PASTOR or Problem – Agitate – Solve for the close; Myth – Truth – Proof for the investigation act.",
    summary: "Setup, investigation, revelation: a grand payoff promised at the start, evidence and mini-reveals layered toward it, then the complete picture and what to do with it.",
    steps: [
      "Setup: a relatable problem, the promise of a transformation, credibility, a first breadcrumb",
      "Investigation: the surprising discovery, validation, personal stakes, mounting evidence, the counterargument handled",
      "Revelation: the final piece falls into place and the complete picture appears",
      "Implementation: exactly what to do, and what life looks like after",
      "Tease the next piece of the puzzle",
    ],
    whenToUse: "Long-form explainers, deep-dive carousels, essays. Keep 3–5 questions open at once; each answer opens a new one; the payoff must exceed the promise.",
    example: "Everyday item → the hidden process → why it's hidden → what it does to you → how to find the real version.",
  },
  {
    seedKey: "backwards-reveal",
    name: "Backwards Reveal",
    role: "narrative",
    pairsWith: "Myth – Truth – Proof (the negated causes are the myths); Promise – Picture – Proof – Push for the push at the end.",
    summary: "Lead with the outcome, negate the expected causes, walk the myths one by one, then show what actually worked and why.",
    steps: [
      "The surprising outcome, stated plainly",
      "\"And I didn't do any of these things\" — negate the causes people expect",
      "The myths, one at a time",
      "What actually made the difference",
      "Why it works",
      "How to apply it at your stage",
    ],
    whenToUse: "Results-led stories. The negation on the second beat is the most reliable hook-after-the-hook there is.",
    example: "Ran my first five kilometres at fifty. And I didn't do any of these five things.",
  },
  {
    seedKey: "pixar",
    name: "Pixar Pitch",
    role: "narrative",
    pairsWith: "Problem – Agitate – Solve or Before – After – Bridge: the until-one-day beat is the problem, the until-finally beat is the after.",
    summary: "Once upon a time, every day, until one day, because of that, until finally — then what it means and one thing to do.",
    steps: [
      "Once upon a time…",
      "Every day…",
      "Until one day…",
      "Because of that… (repeat until the chain is complete)",
      "Until finally…",
      "What it means",
      "One thing to do today",
    ],
    whenToUse: "Any story with a real turning point. The \"every day\" beat is where the audience recognises themselves.",
    example: "Every day we fill the kettle for the same tea. Until one day the kettle breaks and we find the café down the road does it better.",
  },
  {
    seedKey: "four-ps",
    name: "Promise – Picture – Proof – Push",
    role: "persuasion",
    pairsWith: "Backwards Reveal, Three-Act Revelation.",
    summary: "A promise, the after painted in sensory detail, proof, proof against the objections, then the push.",
    steps: [
      "Promise: what changes",
      "Picture: the after, in sensory detail — show it, don't argue it",
      "Proof: evidence, numbers, a real example",
      "Proof against the objections they are already forming",
      "Push: the ask",
    ],
    whenToUse: "Warm audiences and conversion pieces. Show the after, don't sell the before.",
    example: "Your loaf on the rack, the crust still crackling, and you already reaching for the knife with both hands.",
  },
  {
    seedKey: "i-was-wrong",
    name: "I Was Wrong",
    role: "narrative",
    pairsWith: "Myth – Truth – Proof (your old belief is the myth); Before – After – Bridge for what you do now.",
    summary: "A confident wrong claim, the evidence that broke it, the unfolding told as a witness, a reframe that lands late, and what you do now.",
    steps: [
      "The moment, in a specific time and place",
      "The confident claim you held",
      "The evidence that didn't fit",
      "The unfolding, told as a witness rather than a narrator",
      "The reframe, landing late — not right after the evidence",
      "What you do now",
      "Leave them in the new position — no question back, no invitation to reply",
    ],
    whenToUse: "The confession arc: personal stories and comment-heavy pieces. Specificity over confession; the lesson lands near the end.",
    example: "I was standing in the kitchen at 6:47 in the morning holding a bread manual, certain twenty minutes was nothing.",
  },
  {
    seedKey: "story-circle",
    name: "Story Circle",
    role: "narrative",
    pairsWith: "Monroe's Motivated Sequence for the ask; Myth – Truth – Proof when the 'find' beat overturns a belief.",
    summary: "Dan Harmon's eight-step compression of the Hero's Journey: leave comfort for a need, adapt, get it, pay for it, come back changed.",
    steps: [
      "You: a character in a zone of comfort",
      "Need: but they want something",
      "Go: so they enter an unfamiliar situation",
      "Search: adapt to it",
      "Find: get what they wanted",
      "Take: pay a heavy price for it",
      "Return: come back to the familiar situation",
      "Change: having changed",
    ],
    whenToUse: "Any story with a real journey: a parent's change of mind, a family's routine, a brand origin. The 'take' beat is what most drafts skip.",
    example: "Comfortable with the bread machine → wants a loaf that tastes like a bakery → the first class → learning the dough → the rise arrives → the method costs twenty minutes a day → back to normal life → a different baker.",
  },
  {
    seedKey: "storybrand",
    name: "StoryBrand",
    role: "narrative",
    pairsWith: "Promise – Picture – Proof – Push; Before – After – Bridge. The audience is the hero, you are the guide.",
    summary: "Donald Miller's seven-part brand story: a character with a want meets a problem, meets a guide with a plan, is called to act, avoids failure, ends in success.",
    steps: [
      "A character who wants something",
      "Meets a problem: external (the thing), internal (how it feels), philosophical (why it's wrong)",
      "Meets a guide who shows empathy and authority",
      "Who gives them a plan",
      "And calls them to action",
      "That helps them avoid failure",
      "And ends in success",
    ],
    whenToUse: "Marketing and brand messaging of any length. Never make yourself the hero; the audience is the hero and you are the guide.",
    example: "A cook wants a better stock → jars everywhere, guilt, \"this can't be right\" → a chef who did the work → a method matched to the week → start tonight → skip the shortcut → a stock worth keeping.",
  },
  {
    seedKey: "kishotenketsu",
    name: "Kishōtenketsu",
    role: "narrative",
    pairsWith: "Myth – Truth – Proof (the twist is where the belief breaks); Backwards Reveal.",
    summary: "The four-act East Asian structure with no conflict: introduce, develop, twist, reconcile. The twist recontextualises everything before it.",
    steps: [
      "Ki — introduce: the setting and the people, calmly",
      "Shō — develop: deepen it, no conflict yet",
      "Ten — twist: a new element that recontextualises what came before",
      "Ketsu — reconcile: bring the two together into a conclusion",
    ],
    whenToUse: "Reveal-driven pieces where the surprise is the point, and audiences tired of manufactured conflict. Works for a carousel as well as a two-minute talk.",
    example: "A quiet morning with the same cereal → the same every day, contentedly → a textbook page on what breakfast costs → the morning again, with a real breakfast.",
  },
  {
    seedKey: "monroe",
    name: "Monroe's Motivated Sequence",
    role: "persuasion",
    pairsWith: "Story Circle, Three-Act Revelation, Five-Stage Spine.",
    summary: "The classic five-step persuasion sequence for speeches: attention, need, satisfaction, visualisation, action.",
    steps: [
      "Attention: earn it with something specific",
      "Need: the problem, with evidence, and why it touches them",
      "Satisfaction: the solution and how it meets the need",
      "Visualisation: life with the solution, or without it",
      "Action: exactly what to do next",
    ],
    whenToUse: "Talks, videos, emails and pages that end in one clear action. Visualisation is the beat that separates it from PAS.",
    example: "Attention: thirty-one thousand steps a day → need: a day at a desk is a day of none → satisfaction: fifteen minutes outside → visualisation: the first sunny walk → action: tonight.",
  },
  {
    seedKey: "scqa",
    name: "SCQA",
    role: "argument",
    pairsWith: "Three-Act Revelation, Backwards Reveal; any persuasion formula for the close.",
    summary: "Barbara Minto's Pyramid Principle opener: situation, complication, question, answer — then the support beneath the answer.",
    steps: [
      "Situation: what everyone already agrees on",
      "Complication: what changed and made it a problem",
      "Question: the question that raises",
      "Answer: the answer, stated first",
      "Support: the reasons beneath the answer, grouped, strongest first",
    ],
    whenToUse: "Explainers, memos, long captions, anything that has to argue clearly. The answer comes before the reasons, never after.",
    example: "Cooks used to knead by hand all day → now the day is the machine, the timer, the mixer → what does that cost? → the feel of the dough the hands never learn → the three findings behind that.",
  },
  {
    seedKey: "toulmin",
    name: "Toulmin",
    role: "argument",
    pairsWith: "Any shape; Myth – Truth – Proof when the claim overturns a belief.",
    summary: "Stephen Toulmin's anatomy of an argument: claim, grounds, warrant, backing, qualifier, rebuttal. Makes the reasoning inspectable.",
    steps: [
      "Claim: what you are asserting",
      "Grounds: the evidence for it",
      "Warrant: why that evidence supports the claim",
      "Backing: what supports the warrant",
      "Qualifier: how far the claim holds (most, usually, in this age range)",
      "Rebuttal: where it does not hold, said before the audience says it",
    ],
    whenToUse: "Science-led pieces and anything that will be challenged in the comments. The qualifier and the rebuttal are what make a claim trustworthy.",
    example: "Claim: shortcuts ruin the crumb → grounds: the study → warrant: they skip the step that builds structure → backing: the mechanism → qualifier: with daily use → rebuttal: one slow loaf is not the problem.",
  },
  {
    seedKey: "rogerian",
    name: "Rogerian",
    role: "argument",
    pairsWith: "I Was Wrong, Five-Stage Spine; a softer partner for Myth – Truth – Proof.",
    summary: "Argue by common ground: state the other side so fairly they would sign it, show where it is right, find the shared goal, then make your case.",
    steps: [
      "State the other side so fairly they would sign it",
      "Where it is right",
      "The common ground: the goal you share",
      "Your position, and how it serves that goal better",
      "What changes if they take it",
    ],
    whenToUse: "Hostile or divided audiences, topics where parents feel judged. Wins fewer arguments and more people than refutation.",
    example: "Shortcuts save time while you cook, and that's true → the goal we share is a loaf worth the wait → fifteen minutes of folding gives both → here is what a week of it looks like.",
  },
  {
    seedKey: "pastor",
    name: "PASTOR",
    role: "persuasion",
    pairsWith: "Three-Act Revelation, I Was Wrong.",
    summary: "Problem, Amplify, Story and solution, Transformation, Offer, Response.",
    steps: [
      "Problem: name it in the audience's words",
      "Amplify: what it costs if nothing changes",
      "Story and solution: how it was solved",
      "Transformation: the before and the after",
      "Offer: what exactly they get",
      "Response: the ask, one step",
    ],
    whenToUse: "Sales copy, launch emails, landing pages.",
    example: "The afternoons at the desk → the slump → the walk → the stretch → the routine matched to the week → start today.",
  },
  {
    seedKey: "pas",
    name: "Problem – Agitate – Solve",
    role: "persuasion",
    pairsWith: "Pixar Pitch, Five-Stage Spine, Three-Act Revelation.",
    summary: "Name a problem the audience already feels, make the cost of leaving it real, then hand them the way out.",
    steps: [
      "Name the problem in the audience's own words",
      "Agitate: what it costs them day to day if nothing changes",
      "Show the solution and why it works",
      "Proof: one concrete example, number or story",
      "Call to action tied to the solution",
    ],
    whenToUse: "Pain-led topics where the audience knows the problem but not the fix.",
    example: "Your evenings lose to the phone every night → the whole evening is a wreck → a ten-minute wind-down that ends the scroll → what it did for one reader this week → save this for tonight.",
  },
  {
    seedKey: "bab",
    name: "Before – After – Bridge",
    role: "persuasion",
    pairsWith: "Pixar Pitch, I Was Wrong.",
    summary: "Paint where they are, where they could be, and the bridge between the two.",
    steps: [
      "Before: their current situation, specific and recognisable",
      "After: what it looks like once it is solved",
      "Bridge: the steps that get them there",
      "Call to action that starts the bridge",
    ],
    whenToUse: "Transformations and routines, where the payoff is easy to picture.",
    example: "Morning rush in tears → the morning as the calmest part of the day → three small changes in order → try step one tonight.",
  },
  {
    seedKey: "hso",
    name: "Hook – Story – Offer",
    role: "persuasion",
    pairsWith: "Five-Stage Spine, Three-Act Revelation, I Was Wrong.",
    summary: "Stop the scroll, earn trust with a short first-person story, then make the ask.",
    steps: [
      "Hook: a pattern interrupt in the first line",
      "Story: one moment with a turning point, told in first person",
      "Lesson: what the story taught, in one sentence",
      "Offer: the next step, product or follow",
    ],
    whenToUse: "Personal-brand content and anything where credibility comes from lived experience.",
    example: "\"I almost quit running\" → the lesson that changed how I train → what I do now → join the next run.",
  },
  {
    seedKey: "deliver-then-tease",
    name: "Deliver, Then Tease",
    role: "persuasion",
    pairsWith: "Two Loops, Five-Stage Spine, Backwards Reveal.",
    summary: "Give one complete payoff, open a real second question that matters more, stop before it closes, and say where it continues.",
    steps: [
      "Deliver one complete thing: an exercise, an answer, a result the viewer can use today",
      "Open a second question, real and bigger than the first",
      "Stop before it closes",
      "The ask: where the answer is (the app, the full video, the next post)",
    ],
    whenToUse: "Promos for the app, a course or a longer video. A cut that holds back the payoff it promised makes people angry at the ask; one that delivered first makes the ask welcome. Cutting at the reaction drew angry comments; delivering the reaction and cutting before the second turn did not.",
    example: "One stretch, shown in full → \"the next part is what to do when your back starts to ache\" → cut → the week-by-week plan is in the app, on the profile.",
  },
  {
    seedKey: "mtp",
    name: "Myth – Truth – Proof",
    role: "argument",
    pairsWith: "Any narrative shape; Backwards Reveal and I Was Wrong especially.",
    summary: "Take a belief the audience holds, grant the honest case for it, overturn it, and back the new view with evidence.",
    steps: [
      "State the common belief as people say it",
      "Grant the honest case for it — validate before you reframe",
      "Where it breaks",
      "What is actually true",
      "Proof from experience, research or the comments",
      "What to do instead",
    ],
    whenToUse: "Contrarian and educational angles; comment-heavy topics. Validating first is what keeps the comments from turning on you.",
    example: "\"Strength training is only for the young\" → why people believe it → the study everyone misquotes → what supervised strength work does → three rules anyone can use.",
  },
];

export type SeedRule = { seedKey: string; name: string; text: string };

/**
 * No starter rules. The Workshop's Claude reads the author's
 * posts, sessions and context instead (folder.ts). The 17 starters that were
 * here are retired below; rules a user wrote or edited stay theirs.
 */
export const SEED_RULES: SeedRule[] = [];

/** Untouched starters sort in list order, ahead of homemade rules. */
export const RULE_SEED_ORDER_BASE = 1_000;

export function ruleSeedAt(seedKey: string): number {
  const i = SEED_RULES.findIndex((s) => s.seedKey === seedKey);
  return i < 0 ? RULE_SEED_ORDER_BASE : RULE_SEED_ORDER_BASE + i;
}

/** Untitled rules take the first 40 characters of the text as a name. */
const AUTO_RULE_NAME_LEN = 40;

/**
 * Starter rules that were merged or withdrawn. An untouched copy is removed
 * from a user's library on the next visit; one the user edited stays.
 */
export const RETIRED_RULE_SEED_KEYS = [
  "loops",
  "payoff-last",
  "rising-tension",
  "end-on-agency",
  "progressive-payoffs",
  // the starters that were retired
  "priority",
  "one-concept",
  "strong-but-true",
  "show-dont-claim",
  "ordinary-words",
  "write-like-you-talk",
  "natural-rhythm",
  "picturable",
  "cut-words",
  "no-strawman",
  "earn-the-next-line",
  "but-therefore",
  "lead-with-what-is",
  "payoff-ask-agency",
  "no-engagement-bait",
  "descriptions-on-request",
  "revise-the-thought",
];

export type RuleSeedRecord = {
  id: string;
  seedKey?: string;
  name: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export type RuleSeedPlan = {
  retireIds: string[];
  refresh: { id: string; name: string; text: string; createdAt: number; updatedAt: number }[];
  adopt: { id: string; seedKey: string; name: string; text?: string; createdAt?: number; updatedAt?: number }[];
  toAdd: SeedRule[];
};

const untouched = (r: RuleSeedRecord) => r.updatedAt === r.createdAt;

function keepSeedCopy(copies: RuleSeedRecord[], seed?: SeedRule): string {
  const exact = seed ? copies.filter((c) => c.name === seed.name && c.text === seed.text) : [];
  const pool = exact.length ? exact : copies;
  const at = seed ? ruleSeedAt(seed.seedKey) : undefined;
  const canonical = at !== undefined ? pool.find((c) => c.createdAt === at) : undefined;
  if (canonical) return canonical.id;
  return [...pool].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]!.id;
}

/** Match a homemade rule that is the same starter with no name (first 40 chars). */
function matchesSeed(rule: RuleSeedRecord, seed: SeedRule): boolean {
  if (rule.text === seed.text || rule.name === seed.text.slice(0, AUTO_RULE_NAME_LEN)) return true;
  return seed.seedKey === "lead-with-what-is" && (
    rule.name.startsWith("Never open a line with a negation") ||
    rule.text.startsWith("Never open a line with a negation just to reverse it")
  );
}

/**
 * Upgrade a user's rule library: rewrite untouched starters, drop merged ones
 * and extra copies of the same starter, claim a matching homemade copy
 * instead of duplicating it, add the rest.
 */
export function planRuleSeedSync(owned: RuleSeedRecord[], seededKeys: Iterable<string>): RuleSeedPlan {
  const claimed = new Set(seededKeys);
  const retireIds: string[] = [];
  for (const rule of owned) {
    if (rule.seedKey) claimed.add(rule.seedKey);
    if (rule.seedKey && RETIRED_RULE_SEED_KEYS.includes(rule.seedKey) && untouched(rule)) retireIds.push(rule.id);
  }
  const byKey = new Map<string, RuleSeedRecord[]>();
  for (const rule of owned) {
    if (!rule.seedKey || retireIds.includes(rule.id)) continue;
    const list = byKey.get(rule.seedKey) ?? [];
    list.push(rule);
    byKey.set(rule.seedKey, list);
  }
  for (const [key, copies] of byKey) {
    if (copies.length < 2) continue;
    const keep = keepSeedCopy(copies, SEED_RULES.find((s) => s.seedKey === key));
    for (const copy of copies) if (copy.id !== keep) retireIds.push(copy.id);
  }
  const retiring = new Set(retireIds);
  const refresh: RuleSeedPlan["refresh"] = [];
  for (const rule of owned) {
    if (retiring.has(rule.id)) continue;
    const seed = rule.seedKey ? SEED_RULES.find((s) => s.seedKey === rule.seedKey) : undefined;
    if (seed && untouched(rule)) {
      const at = ruleSeedAt(seed.seedKey);
      if (rule.name !== seed.name || rule.text !== seed.text || rule.createdAt !== at || rule.updatedAt !== at) {
        refresh.push({ id: rule.id, name: seed.name, text: seed.text, createdAt: at, updatedAt: at });
      }
    }
  }
  const adopt: RuleSeedPlan["adopt"] = [];
  for (const seed of SEED_RULES) {
    if (claimed.has(seed.seedKey)) continue;
    const match = owned.find((r) => !r.seedKey && !retiring.has(r.id) && matchesSeed(r, seed));
    if (!match) continue;
    const at = ruleSeedAt(seed.seedKey);
    adopt.push({
      id: match.id,
      seedKey: seed.seedKey,
      name: seed.name,
      ...(untouched(match) ? { text: seed.text, createdAt: at, updatedAt: at } : {}),
    });
    claimed.add(seed.seedKey);
  }
  return { retireIds, refresh, adopt, toAdd: SEED_RULES.filter((s) => !claimed.has(s.seedKey)) };
}

export function missingRuleSeeds(seededKeys: Iterable<string>): SeedRule[] {
  return planRuleSeedSync([], seededKeys).toAdd;
}

/**
 * Seeds that were shipped and then withdrawn (devices and formats, or a
 * renamed key). An untouched copy is removed from a user's library on the
 * next visit; one the user edited stays.
 */
export const RETIRED_SEED_KEYS = [
  "emotional-entry",
  "progressive-reveal",
  "case-study",
  "deadpan-inversion",
  "vulnerability-arc",
];

/** The keys the very first seeding wrote, for upgrading markers that predate per-key tracking. */
export const ORIGINAL_SEED_KEYS = ["pas", "bab", "hso", "mtp"];

/** Seeds this user has never been given (deleted ones stay in the seeded list and never return). */
export function missingSeeds(seededKeys: Iterable<string>): SeedFramework[] {
  const have = new Set(seededKeys);
  return SEED_FRAMEWORKS.filter((s) => !have.has(s.seedKey));
}

export type FrameworkSeedRecord = {
  id: string;
  seedKey?: string;
  name: string;
  summary: string;
  steps?: string[];
  createdAt: number;
  updatedAt: number;
};

const sameSteps = (a?: string[], b?: string[]) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((s, i) => s === b[i]);

function keepFrameworkCopy(copies: FrameworkSeedRecord[], seed?: SeedFramework): string {
  const pick = (pool: FrameworkSeedRecord[]) =>
    [...pool].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]!.id;
  if (seed) {
    const full = copies.filter((c) => c.name === seed.name && c.summary === seed.summary && sameSteps(c.steps, seed.steps));
    if (full.length) return pick(full);
    const summary = copies.filter((c) => c.name === seed.name && c.summary === seed.summary);
    if (summary.length) return pick(summary);
    const named = copies.filter((c) => c.name === seed.name);
    if (named.length) return pick(named);
  }
  return pick(copies);
}

/** Extra starter copies of the same framework — keep the one that matches the seed. */
export function extraFrameworkCopyIds(owned: FrameworkSeedRecord[]): string[] {
  const byKey = new Map<string, FrameworkSeedRecord[]>();
  for (const fw of owned) {
    if (!fw.seedKey) continue;
    const list = byKey.get(fw.seedKey) ?? [];
    list.push(fw);
    byKey.set(fw.seedKey, list);
  }
  const drop: string[] = [];
  for (const [key, copies] of byKey) {
    if (copies.length < 2) continue;
    const keep = keepFrameworkCopy(copies, SEED_FRAMEWORKS.find((s) => s.seedKey === key));
    for (const copy of copies) if (copy.id !== keep) drop.push(copy.id);
  }
  return drop;
}
