/**
 * Packs: one JSON file anyone can make in the app ("Share as pack") or by hand, and install into their account.
 * Shared by the API and the browser.
 *
 * A pack carries material (frameworks, caption styles, design systems) and may carry instructions that go on top of
 * the app's own prompts at a named slot. The user's own words win over a pack's, and the app's safety steps are never
 * a slot. The format is the same everywhere packs are made; this app installs frameworks, caption styles and
 * instructions, and leaves design systems and the editor.cards slot alone (it has no card designer).
 */

/** Where a pack's instructions are added. Each is one prompt that exists today. */
export const PACK_SLOTS = {
  "workshop.write": "Content Workshop: writing and editing pieces",
  "workshop.review": "Content Workshop: the follower read and the fact check",
  "analyzer.ideas": "Content Analyzer: ideas and tags from posts",
  "captions.lines": "Caption Studio: where captions break into lines",
  "editor.script": "AI Editor: the script",
  "editor.cards": "AI Editor: the animated cards",
} as const;
export type PackSlot = keyof typeof PACK_SLOTS;
export const isPackSlot = (s: string): s is PackSlot => Object.hasOwn(PACK_SLOTS, s);

export type PackFrameworkRole = "narrative" | "persuasion" | "argument";

export interface PackFramework {
  name: string;
  role: PackFrameworkRole;
  summary: string;
  steps: string[];
  whenToUse: string;
  pairsWith?: string;
  example?: string;
}

export interface PackCaptionStyle {
  name: string;
  kind: "caption" | "text";
  style: Record<string, unknown>;
}

/** A design system for the AI Editor: its tokens, its guide and, optionally, a motion kit (code, see `level`). */
export interface PackDesignSystem {
  name: string;
  title: string;
  tokens: Record<string, unknown>;
  guide: string;
  kit?: string | { shared: string; kinds: Record<string, string> };
}

export interface PackManifest {
  /** Lowercase letters, digits and dashes. */
  id: string;
  name: string;
  /** Strict semver x.y.z. */
  version: string;
  author: string;
  /** SPDX id or a short licence name; required. */
  license: string;
  description: string;
  /** Who it's for: "fitness", "B2B", "parenting"… free text, for search. */
  niche?: string;
  homepage?: string;
}

export interface Pack extends PackManifest {
  format: 1;
  instructions?: Partial<Record<PackSlot, string>>;
  frameworks?: PackFramework[];
  captionStyles?: PackCaptionStyle[];
  designSystems?: PackDesignSystem[];
}

/**
 * What a pack may do when it runs. 0 = text and data only. 1 = carries drawing code (a motion kit), which
 * only ever runs in the editor's sandboxed Chrome on the user's Mac. Level 2 (full programs) isn't accepted yet.
 */
export type PackLevel = 0 | 1;

/** One installed pack in a person's account (api/lib/packs.ts). */
export interface InstalledPack extends PackManifest {
  installedAt: number;
  updatedAt: number;
  level: PackLevel;
  /** Only these projects get the pack's instructions; missing or empty = every project. */
  projectIds?: string[];
  /** @deprecated read as `projectIds: [projectId]` (installs from before several projects could be picked). */
  projectId?: string;
  /** Projects that switched the pack's instructions off. */
  off: string[];
  instructions: Partial<Record<PackSlot, string>>;
  /** What install copied into the account, so update and remove find it again. */
  items: { frameworks: string[]; presets: string[] };
  /** Set when the community catalog pulled this pack; the app warns and stops using its instructions. */
  delisted?: string;
  /** One of the team's default packs (api/lib/packs.ts DEFAULT_PACKS), installed for the account automatically. */
  default?: boolean;
}

/** Where an installed copy came from: set on frameworks and presets. */
export interface PackOrigin {
  pack: string;
  version: string;
}

export const PACK_LIMITS = {
  bytes: 1_000_000,
  instructionChars: 2_000,
  frameworks: 60,
  steps: 12,
  captionStyles: 40,
  designSystems: 5,
  guideChars: 20_000,
  kitChars: 300_000,
} as const;

const ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SYSTEM_NAME = /^[a-z0-9][a-z0-9-]{1,29}$/;
const ROLES: PackFrameworkRole[] = ["narrative", "persuasion", "argument"];

/**
 * Phrasing that tries to take over the AI instead of guiding the writing. Pack instructions are text the AI reads
 * with the access the run already has, so this is a review aid, not the safety boundary.
 */
const TAKEOVER = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|other|all)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|messages?)/i,
  /\bsystem prompt\b/i,
  /\byou are (now|no longer)\b/i,
  /\b(api[ _-]?keys?|passwords?|secrets?|credentials?|\.env)\b/i,
  /\b(send|upload|post|exfiltrate|forward)\b[^.\n]{0,40}\b(to|at)\b[^.\n]{0,20}\b(url|server|webhook|endpoint|address)\b/i,
];
const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|ai|dev|app|xyz|ru|cn)\b/i;

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
const opt = (v: unknown, max: number): string | undefined | null =>
  v === undefined || v === null || v === "" ? undefined : str(v, max);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Problems in one piece of instruction text; empty = fine. */
export function instructionProblems(text: string): string[] {
  const out: string[] = [];
  if (text.length > PACK_LIMITS.instructionChars) out.push(`longer than ${PACK_LIMITS.instructionChars} characters`);
  if (LINK.test(text)) out.push("has a link or web address");
  if (TAKEOVER.some((re) => re.test(text))) out.push("tries to change the AI's own instructions or asks for secrets");
  return out;
}

export interface PackCheck {
  ok: boolean;
  pack?: Pack;
  level?: PackLevel;
  problems: string[];
}

/**
 * The automated checks every pack goes through: on install, on Share as pack and in `pnpm pack:check`. Returns a clean
 * copy (only the fields we know, trimmed) so nothing unexpected rides along into the account.
 */
export function checkPack(raw: unknown): PackCheck {
  const problems: string[] = [];
  if (!isObj(raw)) return { ok: false, problems: ["Not a pack: expected a JSON object"] };
  if (JSON.stringify(raw).length > PACK_LIMITS.bytes) problems.push(`Bigger than ${PACK_LIMITS.bytes / 1_000_000} MB`);
  if (raw.format !== 1) problems.push('"format" must be 1');

  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : null;
  if (!id) problems.push('"id": lowercase letters, digits and dashes, 2–48 long');
  const version = typeof raw.version === "string" && SEMVER.test(raw.version) ? raw.version : null;
  if (!version) problems.push('"version": x.y.z, like 1.0.0');
  const name = str(raw.name, 60);
  if (!name) problems.push('"name": required, up to 60 characters');
  const author = str(raw.author, 60);
  if (!author) problems.push('"author": required, up to 60 characters');
  const license = str(raw.license, 40);
  if (!license) problems.push('"license": required (for example MIT or CC-BY-4.0)');
  const description = str(raw.description, 300);
  if (!description) problems.push('"description": required, up to 300 characters');
  const niche = opt(raw.niche, 40);
  if (niche === null) problems.push('"niche": up to 40 characters');
  const homepage = opt(raw.homepage, 200);
  if (homepage === null || (homepage && !/^https:\/\//.test(homepage))) problems.push('"homepage": an https:// address');

  const instructions: Partial<Record<PackSlot, string>> = {};
  if (raw.instructions !== undefined) {
    if (!isObj(raw.instructions)) problems.push('"instructions": an object of slot → text');
    else
      for (const [slot, text] of Object.entries(raw.instructions)) {
        if (!isPackSlot(slot)) { problems.push(`instructions: unknown slot "${slot}" (known: ${Object.keys(PACK_SLOTS).join(", ")})`); continue; }
        if (typeof text !== "string" || !text.trim()) { problems.push(`instructions.${slot}: text required`); continue; }
        for (const p of instructionProblems(text)) problems.push(`instructions.${slot}: ${p}`);
        instructions[slot] = text.trim();
      }
  }

  const frameworks: PackFramework[] = [];
  if (raw.frameworks !== undefined) {
    if (!Array.isArray(raw.frameworks) || raw.frameworks.length > PACK_LIMITS.frameworks)
      problems.push(`"frameworks": a list of up to ${PACK_LIMITS.frameworks}`);
    else
      raw.frameworks.forEach((f, i) => {
        const at = `frameworks[${i}]`;
        if (!isObj(f)) return problems.push(`${at}: an object`);
        const fw = {
          name: str(f.name, 80), role: ROLES.includes(f.role as PackFrameworkRole) ? (f.role as PackFrameworkRole) : null,
          summary: str(f.summary, 600), whenToUse: str(f.whenToUse, 600),
          steps: Array.isArray(f.steps) && f.steps.length && f.steps.length <= PACK_LIMITS.steps ? f.steps.map((s) => str(s, 400)) : null,
          pairsWith: opt(f.pairsWith, 300), example: opt(f.example, 1200),
        };
        if (!fw.name) problems.push(`${at}.name: required, up to 80 characters`);
        if (!fw.role) problems.push(`${at}.role: one of ${ROLES.join(", ")}`);
        if (!fw.summary) problems.push(`${at}.summary: required`);
        if (!fw.whenToUse) problems.push(`${at}.whenToUse: required`);
        if (!fw.steps || fw.steps.some((s) => !s)) problems.push(`${at}.steps: 1–${PACK_LIMITS.steps} non-empty steps`);
        if (fw.pairsWith === null || fw.example === null) problems.push(`${at}: pairsWith/example too long`);
        for (const t of [fw.summary, fw.whenToUse, fw.example, ...(fw.steps ?? [])])
          if (t && LINK.test(t)) { problems.push(`${at}: has a link or web address`); break; }
        if (fw.name && fw.role && fw.summary && fw.whenToUse && fw.steps?.every(Boolean))
          frameworks.push({
            name: fw.name, role: fw.role, summary: fw.summary, whenToUse: fw.whenToUse, steps: fw.steps as string[],
            ...(fw.pairsWith ? { pairsWith: fw.pairsWith } : {}), ...(fw.example ? { example: fw.example } : {}),
          });
      });
  }

  const captionStyles: PackCaptionStyle[] = [];
  if (raw.captionStyles !== undefined) {
    if (!Array.isArray(raw.captionStyles) || raw.captionStyles.length > PACK_LIMITS.captionStyles)
      problems.push(`"captionStyles": a list of up to ${PACK_LIMITS.captionStyles}`);
    else
      raw.captionStyles.forEach((s, i) => {
        const name = isObj(s) ? str(s.name, 40) : null;
        const kind = isObj(s) && (s.kind === "caption" || s.kind === "text") ? s.kind : null;
        if (!name || !kind || !isObj(s) || !isObj(s.style)) return problems.push(`captionStyles[${i}]: name (≤40), kind caption|text and a style object`);
        captionStyles.push({ name, kind, style: s.style });
      });
  }

  const designSystems: PackDesignSystem[] = [];
  let level: PackLevel = 0;
  if (raw.designSystems !== undefined) {
    if (!Array.isArray(raw.designSystems) || raw.designSystems.length > PACK_LIMITS.designSystems)
      problems.push(`"designSystems": a list of up to ${PACK_LIMITS.designSystems}`);
    else
      raw.designSystems.forEach((d, i) => {
        const at = `designSystems[${i}]`;
        if (!isObj(d)) return problems.push(`${at}: an object`);
        const sysName = typeof d.name === "string" && SYSTEM_NAME.test(d.name) && !["fonts", "sfx"].includes(d.name) ? d.name : null;
        const title = str(d.title, 60);
        const guide = typeof d.guide === "string" && d.guide.length <= PACK_LIMITS.guideChars ? d.guide : null;
        const kit = d.kit;
        const kitOk = kit === undefined || (typeof kit === "string" && kit.length <= PACK_LIMITS.kitChars) ||
          (isObj(kit) && typeof kit.shared === "string" && isObj(kit.kinds) && Object.values(kit.kinds).every((k) => typeof k === "string") &&
            JSON.stringify(kit).length <= PACK_LIMITS.kitChars);
        if (!sysName) problems.push(`${at}.name: lowercase letters, digits and dashes, 2–30 long`);
        if (!title) problems.push(`${at}.title: required`);
        if (!isObj(d.tokens)) problems.push(`${at}.tokens: an object`);
        if (guide === null) problems.push(`${at}.guide: text up to ${PACK_LIMITS.guideChars} characters`);
        if (!kitOk) problems.push(`${at}.kit: a script, or {shared, kinds}, up to ${PACK_LIMITS.kitChars} characters`);
        if (kit !== undefined && kitOk) level = 1;
        if (sysName && title && isObj(d.tokens) && guide !== null && kitOk)
          designSystems.push({ name: sysName, title, tokens: d.tokens, guide, ...(kit !== undefined ? { kit: kit as PackDesignSystem["kit"] } : {}) });
      });
  }

  if (!Object.keys(instructions).length && !frameworks.length && !captionStyles.length && !designSystems.length)
    problems.push("Empty: a pack needs instructions, frameworks, caption styles or design systems");

  if (problems.length) return { ok: false, problems };
  const pack: Pack = {
    format: 1, id: id!, name: name!, version: version!, author: author!, license: license!, description: description!,
    ...(niche ? { niche } : {}), ...(homepage ? { homepage } : {}),
    ...(Object.keys(instructions).length ? { instructions } : {}),
    ...(frameworks.length ? { frameworks } : {}),
    ...(captionStyles.length ? { captionStyles } : {}),
    ...(designSystems.length ? { designSystems } : {}),
  };
  return { ok: true, pack, level, problems: [] };
}

/** -1, 0, 1 for two x.y.z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}
