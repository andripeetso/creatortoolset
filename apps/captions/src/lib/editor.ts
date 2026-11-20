import type { CameraLut } from "@contracts/camera";
import type { StepsView } from "@contracts/editor-steps";
import type { AnimationStyle, AnimationStylesView, EditingStyle, EditingStyleInput, EditingStylesView, FinishedEdit } from "@contracts/editor-styles";
import type { ItemEdit } from "@contracts/edit-timeline";
import type { NleRun } from "./nle/commands";
import type { AddClip, AddedClip, Draft, Edit, EditPatch, EditSlot, EditStep, EditSummary, EditorDefaults, FootageTarget, MadeVoice, NewEdit, NewVoice, PlansPatch, Sentence, Take, VersionMark, VersionPlan, VoicesView } from "@contracts/editor";

/** The Editor's calls to api/editor/routes.ts. */

/** `workspace`: the request works in that workspace, whatever the window is in (Settings' selector; X-CT-Workspace). */
async function send<T>(url: string, method = "GET", body?: unknown, workspace?: string | null): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(workspace ? { "X-CT-Workspace": workspace } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}

const base = (id: string) => `/api/editor/${id}`;

/** The person's edits, newest first; with a project, only that project's. */
export const listEdits = (projectId?: string | null) => send<EditSummary[]>(`/api/editor${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`);
export const footageTarget = () => send<FootageTarget>("/api/editor/footage-target", "GET");
export const createEdit = (e: NewEdit) => send<{ id: string }>("/api/editor", "POST", e);
/** The voices of the person's ElevenLabs account, and a voice made from text: saved in the Media Library as a take. */
export const listVoices = () => send<VoicesView>("/api/editor/voice");
export const makeVoice = (v: NewVoice) => send<MadeVoice | { waiting: string }>("/api/editor/voice", "POST", v);
export const getEdit = (id: string) => send<Edit>(base(id));
/** The chat's editor requests for this window (api/editor/nle-bridge.ts), each handed over once, and the page's answer. */
export type NleAsk = { id: string; edit: string; draft: string; kind: "state" | "run"; commands?: NleRun[] };
export const nlePending = (client: string) => send<{ requests: NleAsk[] }>(`/api/editor/nle/pending?client=${encodeURIComponent(client)}`);
export const nleReply = (r: { id: string; result?: unknown; error?: string }) => send<unknown>("/api/editor/nle/reply", "POST", r);
export const runEdit = (id: string, from?: EditStep) => send<Edit>(`${base(id)}/run`, "POST", from ? { from } : {});
export const retryJob = (id: string, jobId: number) => send<Edit>(`${base(id)}/jobs/${jobId}/retry`, "POST");
/** Edit in passes: Carry on queues each version's next pass. */
export const carryOn = (id: string) => send<Edit>(`${base(id)}/pass`, "POST");
export const stopEdit = (id: string) => send<Edit>(`${base(id)}/stop`, "POST");
export const deleteEdit = (id: string) => send<{ ok: true }>(base(id), "DELETE");
export const patchEdit = (id: string, body: EditPatch) => send<Edit>(base(id), "PATCH", body);
/** The defaults of a workspace: `workspace`, else the one the window is in. */
export const getEditorDefaults = (workspace?: string | null) => send<EditorDefaults>("/api/editor/defaults", "GET", undefined, workspace);
/** Sets one slot's default there to an item, or back to the pack's or built-in one with null. */
export const setEditorDefault = (slot: EditSlot, id: string | null, workspace?: string | null) => send<EditorDefaults>(`/api/editor/defaults/${slot}`, "PUT", { id }, workspace);
/** Settings → AI Editor: the post-processing steps (contracts/editor-steps.ts). */
export const getEditSteps = () => send<StepsView>("/api/edit-steps");
export const setEditStep = (id: string, change: { use?: boolean; values?: Record<string, string> }) => send<StepsView>(`/api/edit-steps/${id}`, "PUT", change);
/** Puts a step that comes with the app into the plug-ins folder; the Mac app's own alert then switches it on. */
export const addEditStep = (folder: string) => send<{ folder: string }>(`/api/edit-steps/add/${encodeURIComponent(folder)}`, "POST");
/** The LUTs added under Colour, the window's workspace's (api/editor/luts.ts). */
export const listLuts = () => send<CameraLut[]>("/api/edit-steps/luts");
export const renameLut = (id: string, name: string) => send<CameraLut[]>(`/api/edit-steps/luts/${id}`, "PUT", { name });
export const deleteLut = (id: string) => send<CameraLut[]>(`/api/edit-steps/luts/${id}`, "DELETE");
export async function addLut(file: File): Promise<CameraLut[]> {
  const form = new FormData();
  form.append("file", file);
  const r = await fetch("/api/edit-steps/luts", { method: "POST", body: form });
  const out = (await r.json().catch(() => ({}))) as CameraLut[] & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}
/** The person's editing styles (contracts/editor-styles.ts). `fromEdit` copies an edit's choices into a new one. */
export const listStyles = () => send<EditingStylesView>("/api/editor/styles");
/** `first`: New edit's "How do you like to work?" made it (it becomes the one New edit opens on, and that screen is answered). */
export const createStyle = (body: (EditingStyleInput & { first?: true }) | { fromEdit: string; name: string }) => send<EditingStyle>("/api/editor/styles", "POST", body);
export const updateStyle = (id: string, body: EditingStyleInput) => send<EditingStyle>(`/api/editor/styles/${id}`, "PUT", body);
export const markStylesAsked = () => send<{ ok: true }>("/api/editor/styles/asked", "POST");
export const deleteStyle = (id: string) => send<{ ok: true }>(`/api/editor/styles/${id}`, "DELETE");
/**
 * The person's animation styles, and their carousel styles for the Designer (contracts/editor-styles.ts): each a name,
 * a brief and pictures, kept alike at two places.
 */
export type StyleKind = "animation" | "carousel";
const stylesAt = (kind: StyleKind) => (kind === "carousel" ? "/api/designs/styles" : "/api/editor/animation-styles");
export const listAnimationStyles = (kind: StyleKind = "animation") => send<AnimationStylesView>(stylesAt(kind));
export const createAnimationStyle = (body: { name: string; brief: string }, kind: StyleKind = "animation") => send<AnimationStyle>(stylesAt(kind), "POST", body);
export const updateAnimationStyle = (id: string, body: { name?: string; brief?: string }, kind: StyleKind = "animation") => send<AnimationStyle>(`${stylesAt(kind)}/${id}`, "PUT", body);
export const deleteAnimationStyle = (id: string, kind: StyleKind = "animation") => send<{ ok: true }>(`${stylesAt(kind)}/${id}`, "DELETE");
export const stylePictureUrl = (id: string, pictureId: string, kind: StyleKind = "animation") => `${stylesAt(kind)}/${id}/pictures/${pictureId}`;
export const removeStylePicture = (id: string, pictureId: string, kind: StyleKind = "animation") => send<AnimationStyle>(stylePictureUrl(id, pictureId, kind), "DELETE");
/** Adds pictures to a style, each as an inspiration. */
export async function addStylePictures(id: string, files: File[], kind: StyleKind = "animation", made = false): Promise<AnimationStyle> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  if (made) form.append("made", "1");
  const r = await fetch(`${stylesAt(kind)}/${id}/pictures`, { method: "POST", body: form });
  const out = (await r.json().catch(() => ({}))) as AnimationStyle & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}
/** The edits finished in a style, newest first, and × on one (it never counts for a style again). */
export const listFinished = (styleId: string) => send<FinishedEdit[]>(`/api/editor/styles/${styleId}/finished`);
export const removeFinished = (styleId: string, editId: string) => send<{ ok: true }>(`/api/editor/styles/${styleId}/finished/${editId}`, "DELETE");
export const removeLearned = (styleId: string, editId: string) => send<{ ok: true }>(`/api/editor/styles/${styleId}/learned/${editId}`, "DELETE");
export const setEyeline = (id: string, versionId: string, y: number) => send<Edit>(`${base(id)}/eyeline/${versionId}`, "PUT", { y });
export const getSentences = (id: string) => send<Sentence[]>(`${base(id)}/sentences`);
export const putLines = (id: string, body: PlansPatch) => send<Edit>(`${base(id)}/lines`, "PUT", body);
export const reviewDraft = (id: string, name: string) => send<Edit>(`${base(id)}/drafts/${name}/review`, "POST");
/** Review's timeline edits on version `n` of the draft's Review video, cut into the draft: its next version is made from them. */
export const makeCut = (id: string, name: string, body: { asset: string; n: number; edits: ItemEdit[] }) => send<Edit>(`${base(id)}/drafts/${name}/cut`, "POST", body);
/** Save on the timeline page: the edits made on the draft as it is now (Draft.view), cut into it as the same version, then rendered and filed in Review. */
export const saveCut = (id: string, name: string, edits: ItemEdit[]) => send<Edit>(`${base(id)}/drafts/${name}/cut`, "POST", { edits });
export const getDraft = (id: string, name: string) => send<Draft>(`${base(id)}/drafts/${encodeURIComponent(name)}`);
/** The version's timeline as a new version (no AI); its preview is made. */
export const duplicateVersion = (id: string, name: string) => send<{ name: string }>(`${base(id)}/drafts/${name}/duplicate`, "POST");
/** Rename ({ label }, "" clears) or delete ({ trashed: true }; false is its Undo) a version. */
export const markVersion = (id: string, name: string, change: { label: string } | { trashed: boolean }) => send<Record<string, VersionMark>>(`${base(id)}/versions/${name}`, "PATCH", change);
export const addClip = (id: string, name: string, clip: AddClip) => send<AddedClip>(`${base(id)}/drafts/${name}/clips`, "POST", clip);
/** An edit with no footage and one empty timeline. */
export const createEmpty = (body: { name?: string }) => send<{ id: string; draft: string }>("/api/editor/empty", "POST", body);
export const restoreEdit = (id: string) => send<{ ok: true }>(`${base(id)}/restore`, "POST");
/** A version's cards (contracts/editor.ts): a card's still, the 👍 that keeps it in the animation style, and making them again. */
export const cardStillUrl = (id: string, variant: string, card: string) => `${base(id)}/cards/${variant}/${card}/still`;
export const likeCard = (id: string, variant: string, card: string) => send<Edit>(`${base(id)}/cards/${variant}/${card}/like`, "POST");
export const makeCardsAgain = (id: string, variant: string) => send<Edit>(`${base(id)}/cards/${variant}/again`, "POST");
export const exportUrl = (id: string, name: string, format: "otio" | "fcpxml" | "xml" | "zip") => `${base(id)}/drafts/${name}/export?format=${format}`;

/** The PUT lines body that gives line `index` of `version` the take `take`, the rest of its lines as they are. */
export function swapTake(plan: VersionPlan, index: number, take: Pick<Take, "first" | "last">): PlansPatch {
  return {
    plans: [
      {
        name: plan.name,
        lines: plan.lines.map((l, i) => ({ line: l.line, take: i === index ? { first: take.first, last: take.last } : { first: l.take.first, last: l.take.last } })),
      },
    ],
  };
}

/** Where a take plays: its source and the seconds from its first sentence's start to its last one's end. */
export function takeSpan(take: Pick<Take, "first" | "last">, sentences: Sentence[]): { src: string; s: number; e: number } | null {
  const a = sentences.find((x) => x.n === take.first);
  const b = sentences.find((x) => x.n === take.last);
  return a && b ? { src: a.src, s: a.s, e: b.e } : null;
}

/** Keeps a preview's voice mix for its edit: the next draft is cut again with it (a voice job). */
export const saveVoiceMix = (id: string, name: string, mix: Record<string, number>, voice: string) =>
  send<{ job: { id: number }; voiceMix: Record<string, number>; voice: string }>(
    `${base(id)}/drafts/${encodeURIComponent(name)}/voice`, "POST", { mix, voice });
