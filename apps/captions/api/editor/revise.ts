import type { Timeline } from "../../contracts/editor";
import { describeEdits } from "../../contracts/edit-summary";
import { cleanEdits, stackEdits, type ItemEdit, type TimelineView } from "../../contracts/edit-timeline";
import { aiFor, completeWithFallback } from "../ai-complete";
import { completeVisionWithFallback } from "../ai-vision";
import { parseJsonObject } from "../lib/instagram/vision";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import { enqueueJob } from "../library/jobs";
import { NeedsKey, wordsOf } from "../library/transcribe";
import { answerComments, frameJpeg, readComments, refLooks, sourcePath } from "../review";
import { applyEdits, draftView, EditRefused } from "./edits";
import type { StepContext } from "./engine";
import { macAway } from "./script";
import { readDraft, readFiled, readStep, saveDraft } from "./store";

/**
 * Revise a cut from its Review comments: a targeted revision of the version filed in Review, never a new plan. Each open
 * comment on its newest Review version is one unit: its own timeline edits (made in Review, sent with it) as they are,
 * and what an AI reads its words to ask for, as the same timeline edits Review makes by hand (contracts/edit-timeline.ts
 * ItemEdit, cut in by edits.ts applyEdits). An AI edit may touch only what its comment is about: the clips it is pinned
 * to, or its moment ± half a second; a comment with neither (a general note) may touch any. Everything else stays as it
 * was. A unit is made whole or not at all; each comment gets a reply, and only the ones that changed the cut are
 * resolved. The revision is the draft's next version, filed in Review as /cut files one (post, preview, file).
 */

const LABEL = "AI Editor revise";
const AUTHOR = "AI Editor";
/** Review's own key for the timeline edits a comment carries (src/components/ReviewEdits.tsx REVIEW_TIMELINE_ID). */
const TIMELINE_EDITS = "timeline-edits";
const MAX_WORDS = 2500;

type Anchor = { track: string; rec: number; len: number; label: string };
export interface ReviseComment {
  id: string;
  /** seconds into the version, and the end of a range */
  t?: number;
  tEnd?: number;
  text: string;
  /** the clips it is pinned to (Review's anchor, or every clip picked for it) */
  anchors: Anchor[];
  drawn: boolean;
  refs: number;
  replies: string[];
  /** the timeline edits it carries, made as they are */
  edits: ItemEdit[];
}
export interface Answer {
  comment: string;
  reply: string;
  edits: ItemEdit[];
}
export interface Reply {
  id: string;
  reply: string;
  resolve: boolean;
}

/** Each library source's transcript, for the words lane and the shots' labels (as preview.ts files them). */
export function wordsFor(tl: Timeline) {
  const db = libraryDb();
  return Object.fromEntries(Object.keys(tl.sources).flatMap((id) => {
    const w = tl.sources[id]!.file ? null : wordsOf(db, id);
    return w ? [[id, w]] : [];
  }));
}

/** The record frames a comment is about; null for a general one (no moment, nothing pinned): any of the cut may change. */
export function zonesOf(c: Pick<ReviseComment, "t" | "tEnd" | "anchors">, fps: number): [number, number][] | null {
  if (c.anchors.length) return c.anchors.map((a) => [a.rec, a.rec + Math.max(1, a.len)]);
  if (c.t === undefined) return null;
  const pad = Math.round(fps / 2);
  return [[Math.round(c.t * fps) - pad, Math.round((c.tEnd ?? c.t) * fps) + pad]];
}

export const SYSTEM = `You revise a video edit from its Review comments. You get the cut's timeline and the open comments. Answer each comment with timeline edits that do what it asks, as literally as the timeline allows, and change nothing it didn't ask for.

Items are keyed "<track>:<record frame>": V1 the speaker's shots (each with its voice on A1), V2 B-roll over them, A2 music, A3 sound effects. Frames are the cut's own. An edit on an item:
- "remove": true takes it out (a V1 shot takes its voice with it and everything after moves up).
- "head" / "tail": frames longer (> 0) or shorter (< 0) at that end. A V1 shot made shorter loses those words and everything after moves up; made longer, it shows more of its take (never past the room it has).
- "move" (V2, A2, A3 only): frames later (< 0 earlier).
- "slip" (V2, A2, A3 only): plays that many frames later in its clip (< 0 earlier), where it is.
- "split": [record frames] cuts the item there first. Each piece after the first is a new item "<track>:<frame>" that can get its own edit in the same answer. To take words out of the middle of a shot: split it at the first unwanted word's start and at the next kept word's start, then remove the piece "<track>:<first unwanted word's frame>".
- "gain" (A tracks): dB louder (< 0 quieter). "off" (V2, A2, A3): switched off.
- "track": an A2 clip to "A3" or back.
Not possible here: zoom or punch-ins, speed, colour, another take, a new clip, new versions. For those answer with no edits and say in the reply what would do it (swap the take in the take list, the editor's timeline, a note for a new version); that comment stays open.

Rules: touch only the items the comment is about (the clips it is pinned to, or what plays at its moment); a general comment may touch any. A comment's own timeline edits are made already: never redo them, answer only what its words ask beyond them. Use the words lane (word@frame) to find where words start. One answer per comment; "reply" is one short, plain sentence to the reviewer saying what changed, or why not.

Answer with JSON only:
{"answers":[{"comment":"<comment id>","reply":"...","edits":[{"key":"V1:45","label":"<what the item is>","tail":-12}]}]}`;

const s2 = (f: number, fps: number) => (f / fps).toFixed(2);

/** The cut and the comments, for the AI. */
export function reviseText(view: TimelineView, comments: ReviseComment[]): string {
  const fps = view.fps;
  const rows = [`Cut "${view.name}", ${fps} fps, ${view.duration} frames (${s2(view.duration, fps)} s).`, "", "Timeline:"];
  for (const t of view.tracks) {
    for (const i of t.items) {
      const room = t.id === "A1" ? "" : ` (room: ${i.before ?? "?"} frames before, ${i.after ?? "?"} after)`;
      rows.push(`${i.key} frames ${i.rec}-${i.rec + i.len} (${s2(i.rec, fps)}-${s2(i.rec + i.len, fps)} s) ${i.detail ? `${i.detail}: "${i.label}…"` : i.label}${room}`);
    }
  }
  if (view.words.length) rows.push("", `Words (word@frame): ${view.words.slice(0, MAX_WORDS).map((w) => `${w.t}@${w.rs}`).join(" ")}`);
  rows.push("", "Open comments:");
  for (const c of comments) {
    const where = c.anchors.length
      ? `pinned to ${c.anchors.map((a) => `${a.track}:${a.rec} (${a.label})`).join(", ")}`
      : c.t !== undefined ? `at ${c.t.toFixed(2)} s (frame ${Math.round(c.t * fps)})${c.tEnd !== undefined ? ` to ${c.tEnd.toFixed(2)} s (frame ${Math.round(c.tEnd * fps)})` : ""}` : "general";
    const extra = [
      c.drawn ? "drew on the frame (shown below)" : "",
      c.refs ? `attached ${c.refs} reference${c.refs === 1 ? "" : "s"} (shown below)` : "",
      c.edits.length ? `their own timeline edits, made already: ${describeEdits(c.edits, fps)}` : "",
    ].filter(Boolean).map((x) => ` [${x}]`).join("");
    rows.push(`- ${c.id} ${where}${extra}: ${c.text}`, ...c.replies.map((r) => `    reply: ${r}`));
  }
  return rows.join("\n");
}

/** The AI's answers, each edit kept only as Review would keep it. */
export function parseAnswers(text: string): Answer[] {
  const list = parseJsonObject(text).answers;
  if (!Array.isArray(list)) throw new Error("The AI's answer has no answers");
  return list.flatMap((a) => {
    const x = a as Record<string, unknown> | null;
    if (!x || typeof x.comment !== "string") return [];
    return [{ comment: x.comment, reply: typeof x.reply === "string" ? x.reply.trim().slice(0, 600) : "", edits: cleanEdits(x.edits) }];
  });
}

/**
 * The revision, comment by comment (oldest first): each one's own edits and its answer's edits inside its zones, made
 * whole on top of the ones before or refused whole. An AI edit on an item an earlier comment changed is left out (that
 * comment's change stands). `timeline` is null when nothing changed.
 */
export function planRevision(tl: Timeline, view: TimelineView, comments: ReviseComment[], answers: Answer[]): { timeline: Timeline | null; edits: ItemEdit[]; replies: Reply[] } {
  const items = new Map(view.tracks.flatMap((t) => t.items).map((i) => [i.key, i]));
  const span = (key: string): [number, number] => {
    const it = items.get(key);
    const f = Number(key.split(":")[1]);
    return it ? [it.rec, it.rec + it.len] : [f, f + 1]; // a piece a split makes starts at its frame
  };
  const inside = (e: ItemEdit, zs: [number, number][] | null) => !zs || zs.some(([a, b]) => span(e.key)[0] < b && a < span(e.key)[1]);
  let kept: ItemEdit[] = [];
  let timeline: Timeline | null = null;
  const replies: Reply[] = [];
  for (const c of comments) {
    const a = answers.find((x) => x.comment === c.id);
    const zs = zonesOf(c, view.fps);
    const taken = new Set(kept.map((e) => e.key));
    const asked = (a?.edits ?? []).filter((e) => !c.edits.some((h) => h.key === e.key));
    const out = asked.filter((e) => !inside(e, zs));
    const clash = asked.filter((e) => inside(e, zs) && taken.has(e.key));
    const mine = [...c.edits, ...asked.filter((e) => inside(e, zs) && !taken.has(e.key))];
    const left = [
      out.length ? ` Left alone, as the comment isn't about ${out.length === 1 ? "it" : "them"}: ${out.map((e) => e.label).join(", ")}.` : "",
      clash.length ? ` Kept as an earlier comment changed ${clash.length === 1 ? "it" : "them"}: ${clash.map((e) => e.label).join(", ")}.` : "",
    ].join("");
    if (!mine.length) {
      replies.push({ id: c.id, reply: `${a?.reply || "Nothing on the timeline was changed for this."}${left}`.trim(), resolve: false });
      continue;
    }
    const next = stackEdits([kept, mine]);
    try {
      timeline = applyEdits(tl, next);
      kept = next;
      const said = a?.reply || (c.edits.length ? "Made your timeline edits." : "Changed.");
      replies.push({ id: c.id, reply: `${said} In the next version.${left}`.trim(), resolve: true });
    } catch (e) {
      if (!(e instanceof EditRefused)) throw e;
      replies.push({ id: c.id, reply: `Not done: ${e.message}. This stays open.`, resolve: false });
    }
  }
  return { timeline, edits: kept, replies };
}

type ReviewComment = Awaited<ReturnType<typeof readComments>>[number];

/** A Review comment as the revision reads it. */
export function reviseComment(x: ReviewComment, all: ReviewComment[]): ReviseComment {
  const payload = x.plugins?.[TIMELINE_EDITS] as { edits?: unknown } | undefined;
  return {
    id: x.id,
    ...(x.t !== undefined ? { t: x.t } : {}),
    ...(x.tEnd !== undefined ? { tEnd: x.tEnd } : {}),
    text: x.text.trim(),
    anchors: x.anchors?.length ? x.anchors : x.anchor ? [x.anchor] : [],
    drawn: !!x.drawing?.length,
    refs: x.refs?.length ?? 0,
    replies: all.filter((r) => r.parentId === x.id).map((r) => r.text.trim()).filter(Boolean),
    edits: cleanEdits(payload?.edits),
  };
}

/** The newest Review version of a draft whose cut is the one filed, and its open comments; a line for the person when there is none. */
export async function openComments(id: string, variant: string): Promise<{ at: { assetId: string; n: number }; tl: Timeline; open: ReviewComment[]; all: ReviewComment[] } | string> {
  const at = readStep(id, "review")?.[variant];
  const filed = at && readFiled(id, at.assetId, at.n);
  if (!at || !filed || filed.variant !== variant) return "File this version in Review first";
  const all = await readComments(at.assetId);
  const open = all.filter((x) => x.version === at.n && !x.parentId && !x.resolved && (x.text.trim() || cleanEdits((x.plugins?.[TIMELINE_EDITS] as { edits?: unknown } | undefined)?.edits).length));
  if (!open.length) return `There are no open comments on version ${at.n} in Review`;
  return { at, tl: filed.timeline, open, all };
}

/** The revise step (one version): the AI reads the comments, the cut is made, each comment is answered (planRevision). */
export async function reviseStep({ edit, job, variant, signal }: StepContext): Promise<void> {
  const d = readDraft(edit.id, variant);
  const got = await openComments(edit.id, variant);
  if (!d) throw new Error(`No draft ${variant}`);
  if (typeof got === "string") throw new Error(got);
  const { at, tl, open, all } = got;
  const comments = open.sort((a, b) => a.createdAt - b.createdAt).map((x) => reviseComment(x, all));
  const view = draftView(tl, wordsFor(tl));
  const worded = comments.filter((c) => c.text);
  let answers: Answer[] = [];
  if (worded.length) {
    const who = whoFor(job.actor ?? "");
    const route = aiFor(who, "editor", LABEL);
    if (route.off) throw new NeedsKey(route.off);
    // what the reviewer drew, on the frame it was drawn on, and the references they attached
    const images: { jpegBase64: string }[] = [];
    const shown: string[] = [];
    for (const x of open) {
      if (!worded.some((c) => c.id === x.id)) continue;
      if (x.drawing?.length && x.t !== undefined) {
        const jpeg = await frameJpeg(sourcePath(at.assetId, at.n), x.t, 540, x.drawing, job.actor ?? "").catch(() => null);
        if (jpeg) {
          images.push({ jpegBase64: jpeg.toString("base64") });
          shown.push(`Picture ${images.length}: what comment ${x.id} drew on its frame.`);
        }
      }
      for (const r of await refLooks(at.assetId, at.n, x.refs)) {
        images.push({ jpegBase64: r.image });
        shown.push(`Picture ${images.length}: a reference comment ${x.id} attached, "${r.name}"${r.kind === "video" ? " (a video: frames across it)" : ""}.`);
      }
    }
    const user = [reviseText(view, worded), ...(shown.length ? ["", ...shown] : [])].join("\n");
    try {
      answers = images.length
        ? (await completeVisionWithFallback(SYSTEM, user, images, signal, parseAnswers, who, { label: LABEL, job: "editor" })).value
        : await completeWithFallback(SYSTEM, user, signal, parseAnswers, route);
    } catch (e) {
      const away = macAway(e);
      if (away) throw new NeedsKey(away.message);
      throw e;
    }
  }
  if (signal.aborted) return;
  const plan = planRevision(tl, view, comments, answers);
  if (plan.timeline) {
    const n = plan.replies.filter((r) => r.resolve).length;
    // "Cut by the AI" leads, as routes.ts saveCutDraft writes it, so the chat and the next hand cut read it as a cut
    await saveDraft(edit.id, variant, { timeline: plan.timeline, notes: [...d.notes, `Cut by the AI from ${n} Review comment${n === 1 ? "" : "s"} on version ${at.n} (${describeEdits(plan.edits, tl.fps)})`] });
    enqueueJob(libraryDb(), edit.workspaceId, job.version_id ?? "", "post", job.actor, true, "edit_jobs");
  }
  await answerComments(at.assetId, at.n, AUTHOR, plan.replies);
}
