import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_VERSIONS } from "../../contracts/editor";
import {
  ANIMATION_BRIEF_MAX,
  MAX_PROPOSALS,
  PACES,
  PICTURE_MAX_BYTES,
  PICTURE_MAX_SIDE,
  PROPOSAL_STILLS,
  PUNCHES,
  STYLE_NAME_MAX,
  STYLE_NOTES_MAX,
  type EditingStyle,
  type Pace,
  type ProposalSource,
  type StyleProposal,
} from "../../contracts/editor-styles";
import { env } from "../lib/env";
import { libraryDb } from "../library/db";
import { addPicture, createAnimation, deleteAnimation, fitJpeg } from "./animation-styles";
import { answer } from "./cards/step";
import { finishedOf } from "./finished";
import { sourcesWorkspace } from "./store";
import { change, createStyle, read } from "./styles";

/**
 * Style proposals (contracts/editor-styles.ts StyleProposal): the AI reads a reference (stills of a library video,
 * pictures the person picked, or the edits they finished) and proposes an editing style, and a look for the cards when
 * it read pictures. A proposal is kept apart from the styles in the caller's file and nothing reads it: it becomes a
 * style, and an animation style of its stills, only on keep(), which the route lets only the person's own screen call.
 * What they keep, edited or not, is theirs from then on, as any style they made.
 */

const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const dirOf = (username: string, id: string) => path.join(env.dataDir, "editor-styles", username, "proposals", id);

export const SYSTEM = `You read a reference for a short video's editing style and propose settings for it. Answer with one JSON object and nothing else:
{"name": "...", "seen": "...", "pace": "tight", "punch": 1.15, "versions": 1, "target_s": 0, "notes": "...", "cards": "..."}
- name: two to four words for the style.
- seen: two to four plain sentences on what you saw: the cut rhythm, the pauses, the B-roll, the captions, the music and sound, the titles and their motion. Only what is there.
- pace: "tight" when pauses are cut out and cuts come fast, "natural" when short pauses stay.
- punch: the zoom-in on every other shot: 1 none, 1.15 light, 1.3 strong.
- versions: how many versions to cut, 1 unless the reference asks for more.
- target_s: the length in seconds it runs to, 0 when you cannot tell.
- notes: how to cut a video in this style, as short lines an editor follows (at most 1200 characters): pace, pauses, B-roll density, captions look, music and sound effects.
- cards: how its titles and animated cards look and move, at most 400 characters; "" when there are none or you read no pictures.`;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** The AI's answer as a proposal's words and settings, every field checked and cut to its cap. Throws when it holds no object or says nothing it saw. */
export function parseProposal(text: string): Pick<StyleProposal, "seen" | "style"> & { cards: string } {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const o = JSON.parse(json || "null") as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("The AI's answer held no proposal");
  const seen = str(o.seen, 1000);
  if (!seen) throw new Error("The AI's answer said nothing it saw");
  const punch = num(o.punch, 1, 1.3, 1.15);
  return {
    seen,
    style: {
      name: str(o.name, STYLE_NAME_MAX) || "Proposed style",
      notes: str(o.notes, STYLE_NOTES_MAX),
      pace: PACES.includes(o.pace as Pace) ? (o.pace as Pace) : "tight",
      punch: PUNCHES.map((p) => p.value as number).reduce((a, b) => (Math.abs(b - punch) < Math.abs(a - punch) ? b : a)),
      versions: Math.round(num(o.versions, 1, MAX_VERSIONS, 1)),
      targetS: Math.round(num(o.target_s, 0, 3600, 0)),
    },
    cards: str(o.cards, ANIMATION_BRIEF_MAX),
  };
}

/** The person's finished edits as the AI reads them (finished.ts: their own brief and spoken words, numbers measured), newest first. A string: none yet. */
export function finishedText(username: string): { text: string; count: number } | string {
  const all = read(username)
    .editing.flatMap((s) => finishedOf(username, s.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, 6);
  if (!all.length) return "No finished edits yet: an edit made in a style counts once its Review video is approved or it is sent to Finals";
  const text = all
    .map((f, k) => [`Edit ${k + 1}: ${f.seconds} s${f.targetS ? ` (asked for ${f.targetS} s)` : ""}.`, f.brief && `Asked for: ${f.brief.slice(0, 300)}`, `Said, one line of the cut each:\n${f.said.slice(0, 600)}`, f.cut.length > 0 && `Lines taken out: ${f.cut.join(" | ").slice(0, 300)}`].filter(Boolean).join("\n"))
    .join("\n\n");
  return { text: `These are short videos the person cut and approved. Propose the style they share; you read no pictures, so cards is "".\n\n${text}`, count: all.length };
}

/** `count` stills spread over a library video the person may read (designs.ts videoFrame: Blur Faces kept). `waiting`: a computer is still making them. */
export async function videoStills(username: string, clip: string, count = PROPOSAL_STILLS): Promise<{ frames: Buffer[]; title: string } | { waiting: string } | { error: string; status: 400 | 404 | 409 }> {
  if (!sourcesWorkspace(username, [clip])) return { error: "Not found", status: 404 };
  const row = libraryDb().prepare("SELECT probe FROM asset_versions WHERE id = ?").get(clip) as { probe: string | null } | undefined;
  if (!row) return { error: "Not found", status: 404 };
  const dur = row.probe ? Number((JSON.parse(row.probe) as { duration?: number }).duration) || 0 : 0;
  if (!dur) return { error: "That video is not ready yet", status: 409 };
  const { videoFrame, DesignError } = await import("../designs");
  const frames: Buffer[] = [];
  let title = "";
  for (let k = 0; k < count; k++) {
    try {
      const f = await videoFrame(username, clip, ((k + 0.5) / count) * dur);
      frames.push(f.frame);
      title = f.title;
    } catch (e) {
      if (!(e instanceof DesignError)) throw e;
      if (e.more?.code === "waiting") return { waiting: e.message };
      return { error: e.message, status: e.status === 404 ? 404 : e.status === 409 ? 409 : 400 };
    }
  }
  return { frames, title };
}

/**
 * Reads the reference and keeps what the AI proposes in the caller's file (the oldest past MAX_PROPOSALS goes).
 * `stills`: pictures in any format a picture can be read in, made small JPEGs first (a still that can't be read is
 * passed over). `text`: what is read besides them (the finished edits). A string: why there is no proposal.
 */
export async function propose(username: string, input: { from: ProposalSource; label: string; stills: Buffer[]; text?: string }, projectId?: string): Promise<StyleProposal | string> {
  if (!USER.test(username)) return "Bad account name";
  const id = randomUUID();
  const dir = dirOf(username, id);
  await mkdir(dir, { recursive: true });
  try {
    const images: { jpegBase64: string }[] = [];
    for (const [k, bytes] of input.stills.slice(0, PROPOSAL_STILLS).entries()) {
      const src = path.join(dir, `in-${k}`);
      const out = path.join(dir, `${images.length}.jpg`);
      await writeFile(src, bytes);
      const made = await fitJpeg(username, src, out, PICTURE_MAX_SIDE, PICTURE_MAX_BYTES);
      await rm(src, { force: true });
      if (made === true) images.push({ jpegBase64: (await readFile(out)).toString("base64") });
      else await rm(out, { force: true });
    }
    if (input.from !== "finished" && !images.length) throw new Error("None of those pictures could be read");
    const ask = input.from === "video" ? `Stills spread evenly over a reference video, in order.` : input.from === "pictures" ? `Pictures the person picked as the look they want.` : "";
    const got = await answer(username, { system: SYSTEM, user: [ask, input.text].filter(Boolean).join("\n\n") }, images, parseProposal);
    const p: StyleProposal = {
      id,
      from: input.from,
      fromLabel: input.label.slice(0, 200),
      seen: got.seen,
      style: got.style,
      ...(images.length ? { animation: { brief: got.cards, stills: images.length } } : {}),
      ...(projectId ? { projectId } : {}),
      at: Date.now(),
    };
    const gone = change(username, (f) => {
      const all = [p, ...(f.proposals ?? [])];
      f.proposals = all.slice(0, MAX_PROPOSALS);
      return all.slice(MAX_PROPOSALS).map((x) => x.id);
    });
    for (const old of gone) await rm(dirOf(username, old), { recursive: true, force: true });
    return p;
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    return e instanceof Error ? e.message : String(e);
  }
}

export const findProposal = (username: string, id: string): StyleProposal | null => read(username).proposals?.find((p) => p.id === id) ?? null;

/** One still a proposal read, by its number. Null: no such proposal or still. */
export function stillFile(username: string, id: string, n: number): string | null {
  const p = findProposal(username, id);
  return p?.animation && Number.isInteger(n) && n >= 0 && n < p.animation.stills ? path.join(dirOf(username, id), `${n}.jpg`) : null;
}

/** The proposal goes with its stills. False: no such proposal. */
export async function dismiss(username: string, id: string): Promise<boolean> {
  const had = change(username, (f) => {
    const n = f.proposals?.length ?? 0;
    f.proposals = (f.proposals ?? []).filter((p) => p.id !== id);
    return f.proposals.length < n;
  });
  if (had) await rm(dirOf(username, id), { recursive: true, force: true });
  return had;
}

/**
 * The person keeps a proposal: an editing style of the fields they send (the proposal's, edited or not, on its sheet)
 * and, when they send `animationBrief` as text, an animation style of that brief and the stills, named for the style
 * and set on it. Then the proposal goes. Null: no such proposal. A string: why nothing was kept.
 */
export async function keep(username: string, id: string, body: Record<string, unknown>, projectId?: string): Promise<EditingStyle | string | null> {
  const p = findProposal(username, id);
  if (!p) return null;
  const { animationBrief, ...fields } = body;
  let animation: string | undefined;
  if (typeof animationBrief === "string" && p.animation) {
    const name = typeof fields.name === "string" && fields.name.trim() ? fields.name : p.style.name;
    const made = createAnimation(username, { name, brief: animationBrief });
    if (typeof made === "string") return made;
    animation = made.id;
    for (let n = 0; n < p.animation.stills; n++) await addPicture(username, made.id, path.join(dirOf(username, id), `${n}.jpg`), "inspiration");
  }
  const style = createStyle(username, { ...p.style, ...fields, ...(animation ? { animation } : {}) }, undefined, false, projectId);
  if (typeof style === "string") {
    if (animation) await deleteAnimation(username, animation);
    return style;
  }
  await dismiss(username, id);
  return style;
}
