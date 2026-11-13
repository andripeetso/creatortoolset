import type { Design, DesignListed, DesignPage, NewDesign } from "@contracts/design";

/** The designer's calls to api/designs.ts. */

/** A save the server did not take, because the design was changed somewhere else since this window last read it: `design` is how it is now. */
export class DesignChanged extends Error {
  design: Design;
  constructor(design: Design) {
    super("The design was changed somewhere else");
    this.design = design;
  }
}

async function send<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string; design?: Design };
  if (r.status === 409 && out.design) throw new DesignChanged(out.design);
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}

const base = (id: string) => `/api/designs/${id}`;

/** My designs, newest first; `piece` narrows them to one Workshop carousel piece's. */
export const listDesigns = (piece?: { session: string; doc: string }) => send<DesignListed[]>(`/api/designs${piece ? `?session=${encodeURIComponent(piece.session)}&doc=${encodeURIComponent(piece.doc)}` : ""}`);
export const createDesign = (d: NewDesign) => send<Design>("/api/designs", "POST", d);
export const getDesign = (id: string) => send<Design>(base(id));
/** `since`: the design's last change this window knows of (its updatedAt). Changed after it: DesignChanged, and nothing was saved. */
export const saveDesign = (id: string, body: { name?: string; pages?: DesignPage[]; since?: number }) => send<Design>(base(id), "PUT", body);
export const deleteDesign = (id: string) => send<{ ok: true }>(base(id), "DELETE");
export const pictureUrl = (id: string, picture: string) => `${base(id)}/pictures/${picture}`;

/** One of the design's pictures with its background taken away, as a new picture of the design: its id. Cut by a Mac of the person's own; the error says what is missing when none is on. */
export const cutOutPicture = async (id: string, picture: string) => (await send<{ id: string }>(`${base(id)}/pictures/${picture}/cutout`, "POST", {})).id;

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
