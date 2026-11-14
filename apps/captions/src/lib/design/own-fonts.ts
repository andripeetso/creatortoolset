import { useSyncExternalStore } from "react";
import type { DesignFont } from "@contracts/design";

/**
 * The person's own fonts in this window: read from the server once, each made known to the browser under the name its
 * face gives itself, so a text set in it draws in it on the canvas, in a card's small picture and in the saved PNG.
 * A face's file is fetched when something is first drawn in it, not before.
 * (Kept apart from fonts.ts, which the server reads too.)
 */
let own: readonly DesignFont[] = [];
const faces = new Map<string, FontFace>();
const heard = new Set<() => void>();
let asked: Promise<void> | null = null;

const fontUrl = (id: string) => `/api/designs/fonts/${id}`;

/** The list as it is now: the faces that are new are made known, and the ones that are gone are forgotten. */
function set(list: readonly DesignFont[]) {
  for (const f of list) {
    if (faces.has(f.id)) continue;
    const face = new FontFace(f.family, `url("${fontUrl(f.id)}")`, { weight: "400" });
    faces.set(f.id, face);
    document.fonts.add(face);
  }
  for (const [id, face] of faces) {
    if (list.some((f) => f.id === id)) continue;
    document.fonts.delete(face);
    faces.delete(id);
  }
  own = list;
  for (const h of heard) h();
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}

/** Read from the server, once a window (a failed read is tried again at the next ask). */
export function loadOwnFonts(): Promise<void> {
  asked ??= send<{ fonts: DesignFont[] }>("GET", "/api/designs/fonts").then(
    (r) => set(r.fonts),
    () => void (asked = null),
  );
  return asked;
}

/** A font file from this computer added to the person's fonts: the faces added, and in words which were not and why. */
export async function addOwnFont(file: File): Promise<{ added: DesignFont[]; notes: string[] }> {
  const data = await new Promise<string>((done, fail) => {
    const r = new FileReader();
    r.onload = () => done(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(new Error(`${file.name} could not be read`));
    r.readAsDataURL(file);
  });
  const out = await send<{ added: DesignFont[]; notes: string[]; fonts: DesignFont[] }>("POST", "/api/designs/fonts", { name: file.name, data });
  set(out.fonts);
  return out;
}

export async function removeOwnFont(id: string): Promise<void> {
  set((await send<{ fonts: DesignFont[] }>("DELETE", fontUrl(id))).fonts);
}

const subscribe = (h: () => void) => (heard.add(h), () => void heard.delete(h));
/** The person's own fonts, read on first use; what draws words draws again when the list changes. */
export function useOwnFonts(): readonly DesignFont[] {
  void loadOwnFonts();
  return useSyncExternalStore(subscribe, () => own);
}
