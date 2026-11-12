import { PACK_SKILL_SLOTS, PACK_SLOTS, type PackSkill, type PackSkillSlot } from "./packs";

/**
 * Skills: reference text for one place in the app where an AI works. A skill is a name, the place it acts, the text,
 * and for the places where the AI opens a skill when the job fits (the assistant, the Workshop's writing) one line
 * saying when to use it. Shared by the API and the browser.
 *
 * A skill is text and nothing else: nothing in it is run, and it never gives the AI a tool, a key, a permission or a
 * wider folder. A person's own skills may go to every place; a skill from Community or a plug-in only to the places
 * PACK_SKILL_SLOTS names (contracts/packs.ts), never to the assistant.
 */

/** Every place a skill can act, in the order Community → Skills shows them. */
export const SKILL_PLACES = ["assistant", "workshop.write", ...PACK_SKILL_SLOTS] as const;
export type SkillPlace = (typeof SKILL_PLACES)[number];
export const isSkillPlace = (s: unknown): s is SkillPlace => (SKILL_PLACES as readonly unknown[]).includes(s);

/** The place in the tool's own words: the heading of its section. */
export const placeLabel = (p: SkillPlace): string => (p === "assistant" ? "Assistant" : PACK_SLOTS[p]);

/** Places where the AI gets one line per skill and opens one when the job fits: a skill there says when to use it. */
export const opensByLine = (p: SkillPlace): boolean => p === "assistant" || p === "workshop.write";

/** The script step reads a skill only for an edit whose editing style names it: nothing to switch, no projects. */
export const pickedByStyle = (p: SkillPlace): boolean => p === "editor.script";

/** Places whose job runs with no project (the script step, the caption lines): a skill there has no projects to tick. */
export const everyProject = (p: SkillPlace): boolean => p === "editor.script" || p === "captions.lines";

/** A skill saved before skills had a place was the assistant's (and the Workshop's): it stays the assistant's. */
export const placeOf = (s: { place?: unknown }): SkillPlace => (isSkillPlace(s.place) ? s.place : "assistant");

export const SKILL_LIMITS = {
  /** Characters in a name. */
  name: 60,
  /** Characters in the line that says when to use it: the only part of a skill every turn carries. */
  when: 160,
  /** Characters in a body: what the Workshop's project instructions may hold (api/lib/workshop/prompt.ts INSTRUCTIONS_MAX). */
  body: 20_000,
  /** Skills an account keeps. */
  perAccount: 30,
  /** Skills on for one project, so the most skill lines one AI turn gets. */
  perTurn: 8,
  /** Characters of a dropped file read to find a skill in it. */
  file: 200_000,
} as const;

export interface Skill {
  id: string;
  name: string;
  /** Where it acts. Missing in a file from before places: the assistant (placeOf). */
  place?: SkillPlace;
  /** One line: when the AI should open it ("" where nothing opens a skill by its line, opensByLine). */
  when: string;
  body: string;
  on: boolean;
  /** Only these projects; missing = every project. */
  projectIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** The three things a person types, pastes or drops. */
export type SkillDraft = Pick<Skill, "name" | "when" | "body">;

/** A skill from an installed Community pack or a plug-in (api/lib/skills.ts sharedSkills): read only, never the assistant's. */
export interface SharedSkill extends Omit<PackSkill, "slot"> {
  /** `pack:<pack id>:<name key>` or `plugin:<plug-in id>:<name key>`: what its switch and an editing style keep. */
  id: string;
  place: PackSkillSlot;
  source: "community" | "plugin";
  /** The pack's or the plug-in's name. */
  from: string;
  /** Its own switch (always true where a style picks it, pickedByStyle). */
  on: boolean;
}

/** One line of plain text: line breaks, control and invisible formatting characters become a space. */
export const oneLine = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();

/** A body as plain text: Unix line ends, no control characters but the line break and the tab. */
export const plainText = (s: string): string =>
  s.replace(/\r\n?/g, "\n").replace(/[\p{Zl}\p{Zp}]/gu, "\n").replace(/[^\P{Cc}\n\t]/gu, "").trim();

/** A draft as it is kept for its place, or what is wrong with it in words for the person. */
export function checkSkill(raw: { name?: unknown; when?: unknown; body?: unknown }, place: SkillPlace = "assistant"): { skill: SkillDraft } | { error: string } {
  const name = typeof raw.name === "string" ? oneLine(raw.name) : "";
  // a line nothing reads is not kept
  const when = typeof raw.when === "string" && opensByLine(place) ? oneLine(raw.when) : "";
  const body = typeof raw.body === "string" ? plainText(raw.body) : "";
  if (!name) return { error: "Give the skill a name." };
  if (name.length > SKILL_LIMITS.name) return { error: `A name takes up to ${SKILL_LIMITS.name} characters.` };
  if (!when && opensByLine(place)) return { error: "Say when to use it, in one line." };
  if (when.length > SKILL_LIMITS.when) return { error: `That line takes up to ${SKILL_LIMITS.when} characters. This one has ${when.length}.` };
  if (!body) return { error: "The skill has no text yet." };
  if (body.length > SKILL_LIMITS.body)
    return { error: `A skill takes up to ${SKILL_LIMITS.body.toLocaleString("en-US")} characters. This one has ${body.length.toLocaleString("en-US")}.` };
  return { skill: { name, when, body } };
}

/** One field of a skill file's header: `key: value` on one line, or a value on the indented lines under it. */
function headerField(head: string, key: string): string {
  const lines = head.split("\n");
  const at = lines.findIndex((l) => l.toLowerCase().startsWith(`${key}:`));
  if (at < 0) return "";
  const first = lines[at]!.slice(key.length + 1).trim();
  const more: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!/^[ \t]+\S/.test(l)) break;
    more.push(l.trim());
  }
  // `>` and `|` only say the value is on the lines below
  const value = [/^[>|][+-]?$/.test(first) ? "" : first, ...more].filter(Boolean).join(" ");
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * A skill file in the shape coding AIs use: a header between two `---` lines with `name` and `description`, then the
 * body. Only those two fields and the body are read. Whatever else the header names (tools it wants allowed, a model,
 * commands to run) is left out, and a file that is not text is refused. `fileName` names the skill when the header and
 * the body's first heading do not.
 */
export function parseSkillFile(text: string, fileName = ""): SkillDraft | { error: string } {
  if (text.length > SKILL_LIMITS.file) return { error: "That file is too long to be a skill." };
  // a NUL, or many characters that could not be decoded: a picture, an archive, a program
  if (text.includes("\u0000") || (text.match(/\uFFFD/g)?.length ?? 0) > 8) return { error: "That file is not text." };
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const header = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  const body = plainText(header ? src.slice(header[0].length) : src);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  const fromFile = fileName.replace(/^.*[\\/]/, "").replace(/\.[a-z0-9]+$/i, "");
  const name = oneLine((header && headerField(header[1]!, "name")) || heading || (/^skill$/i.test(fromFile) ? "" : fromFile));
  const when = oneLine(header ? headerField(header[1]!, "description") : "");
  return { name: name.slice(0, SKILL_LIMITS.name), when: when.slice(0, SKILL_LIMITS.when), body };
}

/**
 * Of the files in a dropped folder, the one that is the skill: `SKILL.md` nearest the top, else the only Markdown or
 * text file. Everything else in the folder (scripts, pictures, other notes) is never read.
 */
export function pickSkillFile(paths: string[]): string | null {
  const depth = (p: string) => p.split("/").length;
  const named = paths.filter((p) => /(^|\/)skill\.md$/i.test(p)).sort((a, b) => depth(a) - depth(b));
  if (named.length) return named[0]!;
  const texts = paths.filter((p) => /\.(md|markdown|txt)$/i.test(p));
  return texts.length === 1 ? texts[0]! : null;
}
