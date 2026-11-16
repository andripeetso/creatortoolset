/**
 * Item 4C: the server side of a computer's AI calls and server reads, run as the held job's account. Whatever the
 * computer sends picks no account, provider or edit: those come from the job row, read again here at every call.
 */
import type { JobId } from "../../contracts/providers";
import type { PackSlot } from "../../contracts/packs";
import { aiErrorJson, aiFor, completeWithFallback } from "../ai-complete";
import { completeVisionWithFallback, type VisionImage } from "../ai-vision";
import { packInstructions } from "../lib/packs";
import { skillText } from "../lib/skills";
import { footageProfile } from "../lib/workshop/context";
import { whoFor } from "../library/describe";
import type { JobRow } from "../library/jobs";
import { workspaceSetup } from "../editor/plan";
import { editRole, gradeOf, ownerOf, readEdit, type EditMeta } from "../editor/store";
import { finishedProfile, styleBlock } from "../editor/styles";

/** A call the job may not make: not its account's edit, or a read that isn't on the list. The route answers 403. */
export class Refused extends Error {}

/** The job's edit, while its account still sees it (store.ts editRole), and whose job it is. */
async function heldEdit(job: JobRow): Promise<{ edit: EditMeta; actor: string }> {
  const vid = job.version_id ?? "";
  const cut = vid.indexOf(":");
  const edit = cut > 0 ? readEdit(vid.slice(0, cut)) : null;
  if (!job.actor || !edit || !(await editRole(job.actor, edit))) throw new Refused("Not this account's edit");
  return { edit, actor: job.actor };
}

/** The asker's own AI for the step, resolved here: the computer only names which use (the AI Editor's or the Analyzer's). */
const useOf = (job: unknown): JobId => (job === "analyzer" ? "analyzer" : "editor");
const labelOf = (label: unknown) => (typeof label === "string" && label ? label.slice(0, 80) : "AI Editor");
const routeFor = (actor: string, label = "AI Editor") => aiFor(whoFor(actor), "editor", label);

/**
 * One AI call of a computer's step: `{ system, user, job?, label?, retries?, images?, background?, preferKey? }`. The
 * text comes back unparsed (`{ text, provider, mac }`, the computer parses), or the error it threw (`{ error }`,
 * ai-complete.ts aiErrorJson). Refused (thrown) when the job's account no longer sees the edit.
 */
export async function serveAi(job: JobRow, body: unknown): Promise<unknown> {
  const { actor } = await heldEdit(job);
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.system !== "string" || typeof b.user !== "string") throw new Refused("An AI call needs its text");
  const use = useOf(b.job);
  const label = labelOf(b.label);
  try {
    if (b.images !== undefined) {
      const images = Array.isArray(b.images) ? b.images.filter((i): i is VisionImage => typeof (i as VisionImage)?.jpegBase64 === "string") : [];
      const r = await completeVisionWithFallback(b.system, b.user, images, undefined, (t) => t, whoFor(actor), {
        label,
        job: use,
        ...(b.background === true ? { background: true } : {}),
        ...(b.preferKey === true ? { preferKey: true } : {}),
      });
      return { text: r.value, provider: r.provider, mac: r.provider !== "anthropic" };
    }
    const route = aiFor(whoFor(actor), use, label);
    const retries = typeof b.retries === "number" ? Math.max(0, Math.min(2, Math.floor(b.retries))) : 0;
    // ponytail: the call runs to its end even when the computer stops the step; pass the route's signal when that costs
    const text = await completeWithFallback(b.system, b.user, undefined, (t) => t, { ...route, ...(retries ? { retries } : {}) });
    const provider = route.only?.[0] ?? "anthropic";
    return { text, provider, mac: provider === "mac" };
  } catch (e) {
    return { error: aiErrorJson(e) };
  }
}

const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

/** The reads a computer's step may ask for, each bound to the held job's account and edit; the args are plain extras. */
const CALLS: Record<string, (h: { edit: EditMeta; actor: string }, args: unknown[]) => Promise<unknown>> = {
  workspaceSetup: ({ edit }, [max]) => workspaceSetup(edit, typeof max === "number" ? Math.max(0, Math.min(100_000, max)) : 24_000),
  footageProfile: ({ edit }) => footageProfile(edit.projectId),
  styleBlock: ({ edit }) => styleBlock(edit.style, edit),
  finishedProfile: ({ edit }) => finishedProfile(ownerOf(edit), edit.projectId ?? ""),
  // the edit's own workspace or none; a slot of the AI Editor's only
  packInstructions: ({ edit, actor }, [slot, projectId, tools]) => {
    if (typeof slot !== "string" || !slot.startsWith("editor.")) throw new Refused("Not an AI Editor slot");
    return packInstructions(actor, slot as PackSlot, str(projectId) === edit.projectId ? edit.projectId : null, { ai: routeFor(actor), ...(tools === true ? { tools: true } : {}) });
  },
  skillText: ({ edit, actor }, [ids, projectId, tools]) => {
    const names = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    return skillText(ownerOf(edit), names, str(projectId) === edit.projectId ? edit.projectId : null, tools === null ? undefined : { ai: routeFor(actor), ...(tools === true ? { tools: true } : {}) });
  },
  grade: async ({ edit }) => (await gradeOf(ownerOf(edit), edit.bundle)) ?? null,
};

/** A named server read (an allow-list: workspace context, styles, packs, skills, grade); unknown names are refused. */
export async function serveCall(job: JobRow, fn: string, args: unknown[]): Promise<unknown> {
  const read = Object.hasOwn(CALLS, fn) ? CALLS[fn] : undefined;
  if (!read) throw new Refused(`No such read: ${fn}`);
  return read(await heldEdit(job), Array.isArray(args) ? args : []);
}
