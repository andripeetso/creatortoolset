/**
 * Carousel preview: type (how the reader moves), slide role (what this
 * slide does), layout (how areas sit). Blank lines split areas.
 * A small review pass maps those areas onto the layout; cards render it.
 */

export const CAROUSEL_TYPE_IDS = ["explainer", "compare", "replace", "myths", "cases", "conversation"] as const;
export type CarouselTypeId = (typeof CAROUSEL_TYPE_IDS)[number];
export const DEFAULT_CAROUSEL_TYPE: CarouselTypeId = "explainer";

/** Older chips still stored on documents. */
const LEGACY: Record<string, CarouselTypeId> = {
  insight: "explainer",
  listicle: "explainer",
  experiment: "explainer",
  proof: "explainer",
  tally: "explainer",
  "myth-bust": "myths",
  "how-to": "replace",
};

export type SlideRole =
  | "cover"
  | "explain"
  | "example"
  | "consequence"
  | "change"
  | "choice"
  | "replace"
  | "myth"
  | "case"
  | "message"
  | "close";

export const CARD_LAYOUT_IDS = ["cover", "teaching", "twoCol", "replace", "myth", "case", "thread", "closer"] as const;
export type CardLayout = (typeof CARD_LAYOUT_IDS)[number];
export const isCardLayout = (v: unknown): v is CardLayout =>
  typeof v === "string" && (CARD_LAYOUT_IDS as readonly string[]).includes(v);

export type SlideField = "headline" | "body" | "left" | "right" | "said" | "instead";

export const ROLE_LABEL: Record<SlideRole, string> = {
  cover: "Cover",
  explain: "Explain",
  example: "Example",
  consequence: "Consequence",
  change: "What to change",
  choice: "Choice",
  replace: "Say / do this",
  myth: "Myth",
  case: "Case",
  message: "Exchange",
  close: "Takeaway",
};

export const LAYOUT_LABEL: Record<CardLayout, string> = {
  cover: "Cover",
  teaching: "Explain",
  twoCol: "Two sides",
  replace: "Replacement",
  myth: "Myth",
  case: "Case",
  thread: "Thread",
  closer: "Takeaway",
};

/** Photo hole on the card — size is a moving part, not a type. */
export const IMAGE_WELL_IDS = ["banner", "square", "tall", "strip", "pair"] as const;
export type ImageWellSize = (typeof IMAGE_WELL_IDS)[number];
export type ImageWellPick = ImageWellSize | "none";
export const isImageWell = (v: unknown): v is ImageWellSize =>
  typeof v === "string" && (IMAGE_WELL_IDS as readonly string[]).includes(v);

export interface SlideCompose {
  layout: CardLayout;
  well: ImageWellPick;
}

const HEADLINE_MAX = 90;
const AREA = "A blank line on a slide is a new area on the card — never glue two areas into one paragraph. The last slide is a takeaway (what the examples collectively show), not a generic follow-for-more unless they asked to sell.";

export interface CarouselType {
  id: CarouselTypeId;
  label: string;
  summary: string;
  min: number;
  max: number;
  prompt: string;
}

export const CAROUSEL_TYPES: CarouselType[] = [
  {
    id: "explainer",
    label: "Explainer",
    summary: "One argument: claim → why → examples → what to change",
    min: 6,
    max: 12,
    prompt:
      "Build one argument across slides — they are not interchangeable tips. Slide 1 is the claim (headline, optional support, optional kicker). Middles: explanation, then familiar examples, then consequences, then what to change. Last slide is the takeaway. Each blank line is a new area.",
  },
  {
    id: "compare",
    label: "Choice comparison",
    summary: "Two approaches side by side, same question each time",
    min: 4,
    max: 12,
    prompt:
      "Each middle slide is two approaches the reader might recognize in themselves. Blank line between side A and side B. Optional last line is the repeated framing question. Do not write a replacement script here — this is identification, not instruction.",
  },
  {
    id: "replace",
    label: "Say / do this instead",
    summary: "Familiar phrase → why it fails → the actual replacement",
    min: 5,
    max: 12,
    prompt:
      "Each middle slide is a situation: the familiar phrase or move, why you challenge it, then the replacement with concrete wording. The reader should leave knowing what to say or do. Last slide is the common principle across the examples (not a new item).",
  },
  {
    id: "myths",
    label: "Myth corrections",
    summary: "Self-contained belief corrections, then one shared mistake",
    min: 5,
    max: 12,
    prompt:
      "Slide 1 names the set. Each middle slide is one belief: the myth as the headline (a complete thought), then the correction as explanation — not a MYTH/TRUTH stamp. Optional first line 'Myth 8'. Last slide is the mistake they share. This changes what they believe, not a script for what to say.",
  },
  {
    id: "cases",
    label: "Case collection",
    summary: "Cases, then what they have in common",
    min: 5,
    max: 12,
    prompt:
      "Curiosity hook, then one case per slide: place/period, the unusual practice, why. After the cases, interpret what they share.",
  },
  {
    id: "conversation",
    label: "Conversation",
    summary: "Two voices: the next message answers the question they just had",
    min: 3,
    max: 12,
    prompt:
      "The exchange is the structure. Prefix each area 'them:' (the parent/reader) or 'you:' (the reply). Them asks the question the reader is already thinking; you answer, then they react. Images are attachments in the thread. No conventional headline/body. Last beat can be a product question they asked, or a takeaway.",
  },
];

export const isCarouselTypeId = (v: unknown): v is string =>
  typeof v === "string" && ((CAROUSEL_TYPE_IDS as readonly string[]).includes(v) || v in LEGACY);

export function resolveCarouselType(id?: string | null): CarouselType {
  const mapped = (id && LEGACY[id]) || id;
  return CAROUSEL_TYPES.find((t) => t.id === mapped) ?? CAROUSEL_TYPES[0]!;
}

export function carouselTypePrompt(id?: string | null): string | null {
  if (!isCarouselTypeId(id)) return null;
  const t = resolveCarouselType(id);
  return `Carousel type (${t.label}): ${t.prompt} ${AREA}`;
}

export interface SlideBlock {
  key?: string;
  id?: string;
  text: string;
}

export interface ThreadMsg {
  from: "them" | "you";
  text: string;
}

export interface ParsedSlide {
  headline: string;
  body: string;
  kicker: string;
  areas: string[];
  hasHeading: boolean;
  isShort: boolean;
  left?: string;
  right?: string;
  leftTitle?: string;
  rightTitle?: string;
  question?: string;
  label?: string;
  said?: string;
  instead?: string;
  why?: string;
  messages?: ThreadMsg[];
}

export interface VisualSlide {
  key: string;
  blockKey?: string;
  blockId?: string;
  ghost: boolean;
  layout: CardLayout;
  role: SlideRole;
  n: number;
  step?: number;
  well?: ImageWellSize;
  parsed: ParsedSlide;
  missing: SlideField[];
}

export interface CarouselGap {
  id: string;
  text: string;
}

export interface VisualizeModel {
  type: CarouselType;
  slides: VisualSlide[];
  gaps: CarouselGap[];
}

const emptyParsed = (): ParsedSlide => ({
  headline: "",
  body: "",
  kicker: "",
  areas: [],
  hasHeading: false,
  isShort: true,
});

const coverLike = (layout?: CardLayout) => layout === "cover" || layout === "closer";

export function splitSlideAreas(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").trim();
  if (!raw) return [];
  const paras = raw.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
  if (paras.length >= 2) return paras;
  const lineBreak = raw.indexOf("\n");
  if (lineBreak > 0) {
    const rest = raw.slice(lineBreak + 1).trim();
    if (rest) return [raw.slice(0, lineBreak).trim(), rest];
  }
  return [raw];
}

const SPEAKER = /^(you|me|us|them|they|parent|reader|alex|coach)\s*:\s*/i;

export function reviewThread(areas: string[]): ThreadMsg[] {
  const out: ThreadMsg[] = [];
  for (const a of areas) {
    const m = SPEAKER.exec(a);
    if (m) {
      const who = /^(you|me|us|alex|coach)$/i.test(m[1]!) ? "you" : "them";
      out.push({ from: who, text: a.slice(m[0].length).trim() });
    } else {
      out.push({ from: out.length % 2 === 0 ? "them" : "you", text: a });
    }
  }
  return out.filter((m) => m.text);
}

export function reviewCompare(areas: string[]): Pick<ParsedSlide, "left" | "right" | "leftTitle" | "rightTitle" | "question"> {
  const last = areas[areas.length - 1];
  const question = last && /\?\s*$/.test(last) && areas.length > 1 ? last : undefined;
  const rest = question ? areas.slice(0, -1) : areas;
  const col = (s: string) => {
    const parts = s.split(/\n[ \t]*\n/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return { title: parts[0], body: parts.slice(1).join("\n\n") };
    return { title: undefined as string | undefined, body: s };
  };
  if (!rest.length) return { left: "", right: "", question };
  if (rest.length === 1) {
    const vs = rest[0]!.split(/\s+vs\.?\s+/i);
    if (vs.length === 2) return { left: vs[0]!.trim(), right: vs[1]!.trim(), question };
    return { left: rest[0], right: "", question };
  }
  if (rest.length === 2) {
    const L = col(rest[0]!);
    const R = col(rest[1]!);
    return { leftTitle: L.title, left: L.body, rightTitle: R.title, right: R.body, question };
  }
  if (rest.length >= 4 && rest.length % 2 === 0) {
    const mid = rest.length / 2;
    const L = rest.slice(0, mid);
    const R = rest.slice(mid);
    return {
      leftTitle: L[0],
      left: L.slice(1).join("\n\n"),
      rightTitle: R[0],
      right: R.slice(1).join("\n\n"),
      question,
    };
  }
  const mid = Math.ceil(rest.length / 2);
  return { left: rest.slice(0, mid).join("\n\n"), right: rest.slice(mid).join("\n\n"), question };
}

export function reviewReplace(areas: string[]): Pick<ParsedSlide, "said" | "instead" | "why" | "headline"> {
  if (!areas.length) return { said: "", instead: "", why: "", headline: "" };
  const idx = areas.findIndex((a, i) => i > 0 && /\binstead\b|do this|say this/i.test(a));
  if (idx > 0) {
    return {
      headline: areas[0],
      said: areas[0],
      why: areas.slice(1, idx).join("\n\n"),
      instead: areas.slice(idx).join("\n\n"),
    };
  }
  if (areas.length === 1) return { headline: areas[0], said: areas[0], instead: "", why: "" };
  if (areas.length === 2) return { headline: areas[0], said: areas[0], instead: areas[1], why: "" };
  return {
    headline: areas[0],
    said: areas[0],
    why: areas[1],
    instead: areas.slice(2).join("\n\n"),
  };
}

function reviewSlide(base: ParsedSlide, layout?: CardLayout): ParsedSlide {
  const a = base.areas;
  if (layout === "twoCol") return { ...base, ...reviewCompare(a), hasHeading: true };
  if (layout === "replace") return { ...base, ...reviewReplace(a), hasHeading: true };
  if (layout === "myth") {
    const lab = a[0] && /^myth\s*\d+/i.test(a[0].trim()) && a[0].length < 28;
    if (lab) {
      return { ...base, label: a[0], headline: a[1] ?? "", body: a.slice(2).join("\n\n"), kicker: "", hasHeading: !!a[1] };
    }
    return { ...base, headline: a[0] ?? "", body: a.slice(1).join("\n\n"), kicker: "", hasHeading: !!a[0] };
  }
  if (layout === "case") {
    const loc = a[0] && a[0].length <= 42 && a.length > 1;
    if (loc) return { ...base, label: a[0], headline: a[1] ?? "", body: a.slice(2).join("\n\n"), hasHeading: !!a[1] };
    return { ...base, headline: a[0] ?? "", body: a.slice(1).join("\n\n"), hasHeading: !!a[0] };
  }
  if (layout === "thread") {
    const messages = reviewThread(a);
    return { ...base, messages, headline: "", body: "", hasHeading: false };
  }
  return base;
}

export function parseSlideText(text: string, layout?: CardLayout): ParsedSlide {
  const areas = splitSlideAreas(text);
  if (!areas.length) return emptyParsed();
  const isShort = areas.length === 1 && areas[0]!.length <= HEADLINE_MAX;

  const placed = (headline: string, body: string, kicker: string, hasHeading: boolean): ParsedSlide =>
    reviewSlide({ headline, body, kicker, areas, hasHeading, isShort }, layout);

  if (areas.length === 1) {
    const one = areas[0]!;
    if (layout === "thread") return placed("", "", "", false);
    if (isShort || coverLike(layout) || layout === "myth" || layout === "case" || layout === "twoCol" || layout === "replace") {
      return placed(one, "", "", true);
    }
    return placed("", one, "", false);
  }

  const headline = areas[0]!;
  if (coverLike(layout)) {
    const kicker = areas[areas.length - 1]!;
    const body = areas.length > 2 ? areas.slice(1, -1).join("\n\n") : "";
    return placed(headline, body, kicker, true);
  }
  return placed(headline, areas.slice(1).join("\n\n"), "", true);
}

function requiredFields(layout: CardLayout, parsed: ParsedSlide): SlideField[] {
  const missing: SlideField[] = [];
  if (layout === "thread") return missing;
  if (layout === "twoCol") {
    if (!parsed.left?.trim()) missing.push("left");
    if (!parsed.right?.trim()) missing.push("right");
    return missing;
  }
  if (layout === "replace") {
    if (!(parsed.said ?? parsed.headline).trim()) missing.push("said");
    if (!parsed.instead?.trim()) missing.push("instead");
    return missing;
  }
  if (layout === "myth" || layout === "case" || layout === "cover") {
    if (!parsed.headline.trim()) missing.push("headline");
    if (layout === "myth" && !parsed.body.trim()) missing.push("body");
    return missing;
  }
  if (layout === "teaching") {
    if (!parsed.headline.trim() && !parsed.body.trim()) missing.push("headline");
    return missing;
  }
  if (layout === "closer") {
    if (!parsed.headline.trim() && !parsed.body.trim() && !parsed.kicker.trim()) missing.push("headline");
  }
  return missing;
}

function ghostSlide(layout: CardLayout, role: SlideRole, n: number, extra?: Partial<VisualSlide>): VisualSlide {
  const parsed = emptyParsed();
  return {
    key: `ghost-${role}-${n}`,
    ghost: true,
    layout,
    role,
    n,
    parsed,
    missing: requiredFields(layout, parsed),
    ...extra,
  };
}

function realSlide(
  block: SlideBlock,
  layout: CardLayout,
  role: SlideRole,
  n: number,
  extra?: Partial<Pick<VisualSlide, "step" | "well">>,
): VisualSlide {
  const parsed = parseSlideText(block.text, layout);
  const key = block.key || block.id || `s${n}`;
  return {
    key,
    blockKey: block.key || block.id,
    blockId: block.id,
    ghost: false,
    layout,
    role,
    n,
    parsed,
    missing: requiredFields(layout, parsed),
    ...extra,
  };
}

const EXPLAIN_CYCLE: SlideRole[] = ["explain", "example", "consequence", "change"];

function middleGhost(type: CarouselTypeId): { layout: CardLayout; role: SlideRole } {
  if (type === "compare") return { layout: "twoCol", role: "choice" };
  if (type === "replace") return { layout: "replace", role: "replace" };
  if (type === "myths") return { layout: "myth", role: "myth" };
  if (type === "cases") return { layout: "case", role: "case" };
  if (type === "conversation") return { layout: "thread", role: "message" };
  return { layout: "teaching", role: "explain" };
}

export function allowedCompose(type: CarouselTypeId, role: SlideRole): { layouts: CardLayout[]; wells: ImageWellPick[] } {
  if (type === "conversation") return { layouts: ["thread"], wells: ["none", "strip"] };
  if (role === "cover") return { layouts: ["cover"], wells: ["none", "strip", "banner"] };
  if (role === "close") return { layouts: ["closer"], wells: ["none", "strip", "banner"] };
  if (type === "compare") return { layouts: ["twoCol"], wells: ["none", "pair", "banner", "tall"] };
  if (type === "replace") return { layouts: ["replace", "twoCol"], wells: ["none", "pair", "banner", "tall"] };
  if (type === "myths") return { layouts: ["myth", "teaching"], wells: ["none", "banner", "square", "tall"] };
  if (type === "cases") return { layouts: ["case", "teaching"], wells: ["none", "banner", "square", "tall", "strip"] };
  return { layouts: ["teaching", "twoCol"], wells: ["none", "strip", "banner", "square", "tall"] };
}

export function rolesForCarousel(type: CarouselTypeId, n: number): SlideRole[] {
  if (n < 1) return [];
  if (type === "conversation") return Array.from({ length: n }, () => "message" as const);
  if (n === 1) return ["cover"];
  const roles: SlideRole[] = ["cover"];
  for (let i = 1; i < n - 1; i++) {
    if (type === "compare") roles.push("choice");
    else if (type === "replace") roles.push("replace");
    else if (type === "myths") roles.push("myth");
    else if (type === "cases") roles.push("case");
    else roles.push(EXPLAIN_CYCLE[(i - 1) % EXPLAIN_CYCLE.length]!);
  }
  roles.push("close");
  return roles;
}

export function fallbackLayout(role: SlideRole): CardLayout {
  if (role === "cover") return "cover";
  if (role === "close") return "closer";
  if (role === "choice") return "twoCol";
  if (role === "replace") return "replace";
  if (role === "myth") return "myth";
  if (role === "case") return "case";
  if (role === "message") return "thread";
  return "teaching";
}

function defaultWell(type: CarouselTypeId, layout: CardLayout, n: number, role: SlideRole): ImageWellSize | undefined {
  if (layout === "thread" || role === "cover" || role === "close") return undefined;
  const i = Math.max(0, n - 2);
  if (type === "compare" || type === "replace") return (["pair", "banner", "tall"] as const)[i % 3];
  return (["banner", "square", "tall", "strip"] as const)[i % 4];
}

export function clampCompose(
  type: CarouselTypeId,
  role: SlideRole,
  n: number,
  chosen?: { layout: CardLayout; well?: ImageWellPick } | null,
): SlideCompose {
  const allow = allowedCompose(type, role);
  const layout = chosen && allow.layouts.includes(chosen.layout) ? chosen.layout : fallbackLayout(role);
  const raw = chosen?.well;
  const well: ImageWellPick = raw && allow.wells.includes(raw) ? raw : (defaultWell(type, layout, n, role) ?? "none");
  return { layout, well };
}

export const isImageWellPick = (v: unknown): v is ImageWellPick => v === "none" || isImageWell(v);

function blockIndex(all: SlideBlock[], block: SlideBlock): number {
  let i = all.indexOf(block);
  if (i < 0) i = all.findIndex((b) => (block.id && b.id === block.id) || (block.key && b.key === block.key));
  return i;
}

function pickCompose(
  type: CarouselTypeId,
  role: SlideRole,
  n: number,
  pack?: SlideCompose[],
  index?: number,
): { layout: CardLayout; well?: ImageWellSize } {
  const chosen = index != null && index >= 0 ? pack?.[index] : undefined;
  const { layout, well } = clampCompose(type, role, n, chosen);
  return { layout, well: well === "none" ? undefined : well };
}

function mapMiddles(
  type: CarouselTypeId,
  middles: SlideBlock[],
  all: SlideBlock[],
  pack: SlideCompose[] | undefined,
): VisualSlide[] {
  return middles.map((block, i) => {
    const n = 2 + i;
    const idx = blockIndex(all, block);
    if (type === "compare") {
      const { layout, well } = pickCompose(type, "choice", n, pack, idx);
      return realSlide(block, layout, "choice", n, { step: i + 1, well });
    }
    if (type === "replace") {
      const { layout, well } = pickCompose(type, "replace", n, pack, idx);
      return realSlide(block, layout, "replace", n, { step: i + 1, well });
    }
    if (type === "myths") {
      const { layout, well } = pickCompose(type, "myth", n, pack, idx);
      return realSlide(block, layout, "myth", n, { step: middles.length - i, well });
    }
    if (type === "cases") {
      const { layout, well } = pickCompose(type, "case", n, pack, idx);
      return realSlide(block, layout, "case", n, { step: i + 1, well });
    }
    if (type === "conversation") {
      const { layout, well } = pickCompose(type, "message", n, pack, idx);
      return realSlide(block, layout, "message", n, { well });
    }
    const role = EXPLAIN_CYCLE[i % EXPLAIN_CYCLE.length]!;
    const { layout, well } = pickCompose(type, role, n, pack, idx);
    return realSlide(block, layout, role, n, { well });
  });
}

function lastSlide(type: CarouselTypeId, block: SlideBlock, n: number, all: SlideBlock[], pack?: SlideCompose[]): VisualSlide {
  const idx = blockIndex(all, block);
  if (type === "conversation") {
    const { layout, well } = pickCompose(type, "message", n, pack, idx);
    return realSlide(block, layout, "message", n, { well });
  }
  const { layout, well } = pickCompose(type, "close", n, pack, idx);
  return realSlide(block, layout, "close", n, { well });
}

export function visualizeCarousel(input: {
  typeId?: string | null;
  blocks: SlideBlock[];
  caption?: string;
  compose?: SlideCompose[];
}): VisualizeModel {
  const type = resolveCarouselType(input.typeId);
  const blocks = input.blocks;
  const n = blocks.length;
  const pack = input.compose;
  const ghostMid = middleGhost(type.id);
  let slides: VisualSlide[] = [];

  if (n === 0) {
    slides = [
      ghostSlide("cover", "cover", 1),
      ghostSlide(ghostMid.layout, ghostMid.role, 2, { well: defaultWell(type.id, ghostMid.layout, 2, ghostMid.role) }),
      ghostSlide("closer", "close", 3),
    ];
  } else if (n === 1) {
    const firstRole: SlideRole = type.id === "conversation" ? "message" : "cover";
    const first = pickCompose(type.id, firstRole, 1, pack, 0);
    slides = [
      realSlide(blocks[0]!, first.layout, firstRole, 1, { well: first.well }),
      ghostSlide(ghostMid.layout, ghostMid.role, 2, { well: defaultWell(type.id, ghostMid.layout, 2, ghostMid.role) }),
      ghostSlide("closer", "close", 3),
    ];
  } else {
    const firstRole: SlideRole = type.id === "conversation" ? "message" : "cover";
    const first = pickCompose(type.id, firstRole, 1, pack, 0);
    slides.push(realSlide(blocks[0]!, first.layout, firstRole, 1, { well: first.well }));
    const middles = blocks.slice(1, -1);
    if (!middles.length) {
      slides.push(ghostSlide(ghostMid.layout, ghostMid.role, 2, { well: defaultWell(type.id, ghostMid.layout, 2, ghostMid.role) }));
    } else {
      slides.push(...mapMiddles(type.id, middles, blocks, pack));
    }
    slides.push(lastSlide(type.id, blocks[n - 1]!, slides.length + 1, blocks, pack));
  }

  slides.forEach((s, i) => {
    s.n = i + 1;
  });

  const gaps: CarouselGap[] = [];
  if (n < type.min) {
    gaps.push({
      id: "too-few",
      text: `Need at least ${type.min} slides for a ${type.label.toLowerCase()} (you have ${n})`,
    });
  }
  if (n < 3 && type.id !== "conversation") {
    gaps.push({ id: "no-body", text: "Nothing between the opening and the takeaway" });
  }
  for (const s of slides) {
    if (s.ghost) continue;
    for (const field of s.missing) {
      const label =
        field === "left"
          ? "side A"
          : field === "right"
            ? "side B"
            : field === "said"
              ? "the familiar phrase"
              : field === "instead"
                ? "the replacement"
                : field === "body"
                  ? "the correction"
                  : "a headline";
      gaps.push({ id: `field:${s.key}:${field}`, text: `Slide ${s.n} is missing ${label}` });
    }
  }
  if (!(input.caption ?? "").trim()) {
    gaps.push({ id: "caption", text: "No post description" });
  }

  return { type, slides, gaps };
}
