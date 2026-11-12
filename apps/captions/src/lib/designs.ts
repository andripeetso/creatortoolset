import type { Design, DesignAnswer, DesignPage, DesignSummary, NewDesign } from "@contracts/design";

/** The designer's calls to api/designs.ts. */

async function send<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}

const base = (id: string) => `/api/designs/${id}`;

/** My designs, newest first; `piece` narrows them to one Workshop carousel piece's. */
export const listDesigns = (piece?: { session: string; doc: string }) => send<DesignSummary[]>(`/api/designs${piece ? `?session=${encodeURIComponent(piece.session)}&doc=${encodeURIComponent(piece.doc)}` : ""}`);
export const createDesign = (d: NewDesign) => send<Design>("/api/designs", "POST", d);
export const getDesign = (id: string) => send<Design>(base(id));
export const saveDesign = (id: string, body: { name?: string; pages?: DesignPage[] }) => send<Design>(base(id), "PUT", body);
export const deleteDesign = (id: string) => send<{ ok: true }>(base(id), "DELETE");
/** The person's AI designs the pages: `look` is an animation style's id (null: none), `notes` what they ask for this time. */
export const designWithAi = (id: string, body: { look?: string | null; notes?: string }) => send<DesignAnswer>(`${base(id)}/design`, "POST", body);
export const pictureUrl = (id: string, picture: string) => `${base(id)}/pictures/${picture}`;

/** A picture from this computer into the design's own folder, as it is (no shrinking, transparency kept); answers its id. */
export async function addPicture(id: string, file: File): Promise<string> {
  const data = await new Promise<string>((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
  return (await send<{ id: string }>(`${base(id)}/pictures`, "POST", { name: file.name, type: file.type, data })).id;
}
