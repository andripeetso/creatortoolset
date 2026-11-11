import type { StepsView } from "@contracts/editor-steps";
import type { AnimationStyle, AnimationStylesView, EditingStyle, EditingStyleInput, EditingStylesView } from "@contracts/editor-styles";
import type { Edit, EditPatch, EditSlot, EditStep, EditSummary, EditorDefaults, FootageTarget, NewEdit, PlansPatch, Sentence, Take, VersionPlan } from "@contracts/editor";

/** The AI Editor's calls to api/editor/routes.ts. */

async function send<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}

const base = (id: string) => `/api/editor/${id}`;

export const listEdits = () => send<EditSummary[]>("/api/editor");
export const footageTarget = () => send<FootageTarget>("/api/editor/footage-target", "GET");
export const createEdit = (e: NewEdit) => send<{ id: string }>("/api/editor", "POST", e);
export const getEdit = (id: string) => send<Edit>(base(id));
export const runEdit = (id: string, from?: EditStep) => send<Edit>(`${base(id)}/run`, "POST", from ? { from } : {});
export const retryJob = (id: string, jobId: number) => send<Edit>(`${base(id)}/jobs/${jobId}/retry`, "POST");
export const stopEdit = (id: string) => send<Edit>(`${base(id)}/stop`, "POST");
export const deleteEdit = (id: string) => send<{ ok: true }>(base(id), "DELETE");
export const patchEdit = (id: string, body: EditPatch) => send<Edit>(base(id), "PATCH", body);
export const getEditorDefaults = () => send<EditorDefaults>("/api/editor/defaults");
/** Sets one slot's default to an item, or back to the pack's or built-in one with null. */
export const setEditorDefault = (slot: EditSlot, id: string | null) => send<EditorDefaults>(`/api/editor/defaults/${slot}`, "PUT", { id });
/** Settings → AI Editor: the post-processing steps (contracts/editor-steps.ts). */
export const getEditSteps = () => send<StepsView>("/api/edit-steps");
export const setEditStep = (id: string, change: { use?: boolean; values?: Record<string, string> }) => send<StepsView>(`/api/edit-steps/${id}`, "PUT", change);
/** Puts a step that comes with the app into the plug-ins folder; the Mac app's own alert then switches it on. */
export const addEditStep = (folder: string) => send<{ folder: string }>(`/api/edit-steps/add/${encodeURIComponent(folder)}`, "POST");
/** The person's editing styles (contracts/editor-styles.ts). `fromEdit` copies an edit's choices into a new one. */
export const listStyles = () => send<EditingStylesView>("/api/editor/styles");
export const createStyle = (body: EditingStyleInput | { fromEdit: string; name: string }) => send<EditingStyle>("/api/editor/styles", "POST", body);
export const updateStyle = (id: string, body: EditingStyleInput) => send<EditingStyle>(`/api/editor/styles/${id}`, "PUT", body);
export const deleteStyle = (id: string) => send<{ ok: true }>(`/api/editor/styles/${id}`, "DELETE");
/** The person's animation styles (contracts/editor-styles.ts): a name, a brief and pictures. */
const animation = "/api/editor/animation-styles";
export const listAnimationStyles = () => send<AnimationStylesView>(animation);
export const createAnimationStyle = (body: { name: string; brief: string }) => send<AnimationStyle>(animation, "POST", body);
export const updateAnimationStyle = (id: string, body: { name?: string; brief?: string }) => send<AnimationStyle>(`${animation}/${id}`, "PUT", body);
export const deleteAnimationStyle = (id: string) => send<{ ok: true }>(`${animation}/${id}`, "DELETE");
export const stylePictureUrl = (id: string, pictureId: string) => `${animation}/${id}/pictures/${pictureId}`;
export const removeStylePicture = (id: string, pictureId: string) => send<AnimationStyle>(stylePictureUrl(id, pictureId), "DELETE");
/** Adds pictures to a style, each as an inspiration. */
export async function addStylePictures(id: string, files: File[]): Promise<AnimationStyle> {
  const form = new FormData();
  for (const f of files) form.append("file", f);
  const r = await fetch(`${animation}/${id}/pictures`, { method: "POST", body: form });
  const out = (await r.json().catch(() => ({}))) as AnimationStyle & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}
export const setEyeline = (id: string, versionId: string, y: number) => send<Edit>(`${base(id)}/eyeline/${versionId}`, "PUT", { y });
export const getSentences = (id: string) => send<Sentence[]>(`${base(id)}/sentences`);
export const putLines = (id: string, body: PlansPatch) => send<Edit>(`${base(id)}/lines`, "PUT", body);
export const reviewDraft = (id: string, name: string) => send<Edit>(`${base(id)}/drafts/${name}/review`, "POST");
/** A version's cards (contracts/editor.ts): a card's still, the 👍 that keeps it in the animation style, and making them again. */
export const cardStillUrl = (id: string, variant: string, card: string) => `${base(id)}/cards/${variant}/${card}/still`;
export const likeCard = (id: string, variant: string, card: string) => send<Edit>(`${base(id)}/cards/${variant}/${card}/like`, "POST");
export const makeCardsAgain = (id: string, variant: string) => send<Edit>(`${base(id)}/cards/${variant}/again`, "POST");
export const exportUrl = (id: string, name: string, format: "otio" | "fcpxml" | "zip") => `${base(id)}/drafts/${name}/export?format=${format}`;

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
