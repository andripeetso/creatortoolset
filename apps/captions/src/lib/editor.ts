import type { Edit, EditStep, EditSummary, NewEdit, PlansPatch, Sentence, Take, VersionPlan } from "@contracts/editor";

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
export const createEdit = (e: NewEdit) => send<{ id: string }>("/api/editor", "POST", e);
export const getEdit = (id: string) => send<Edit>(base(id));
export const runEdit = (id: string, from?: EditStep) => send<Edit>(`${base(id)}/run`, "POST", from ? { from } : {});
export const retryJob = (id: string, jobId: number) => send<Edit>(`${base(id)}/jobs/${jobId}/retry`, "POST");
export const stopEdit = (id: string) => send<Edit>(`${base(id)}/stop`, "POST");
export const deleteEdit = (id: string) => send<{ ok: true }>(base(id), "DELETE");
export const setEyeline = (id: string, versionId: string, y: number) => send<Edit>(`${base(id)}/eyeline/${versionId}`, "PUT", { y });
export const getSentences = (id: string) => send<Sentence[]>(`${base(id)}/sentences`);
export const putLines = (id: string, body: PlansPatch) => send<Edit>(`${base(id)}/lines`, "PUT", body);
export const reviewDraft = (id: string, name: string) => send<Edit>(`${base(id)}/drafts/${name}/review`, "POST");
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
