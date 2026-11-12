import { useSyncExternalStore } from "react";
import type { AssetCard, AssetDetail, ShareRow } from "@contracts/library";

/**
 * What the clip view decides from a clip and its detail (its facts, what its player says, its share links), and the
 * two things it keeps on this device: how a clip opens, and the addresses of the share links made here.
 */

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The clip's facts as label and value: when it was filmed, its length, size, roll, and its version past the first. */
export function factsOf(a: AssetCard): [string, string][] {
  const out: [string, string][] = [];
  if (a.capturedAt) out.push(["Filmed", day(a.capturedAt)]);
  if (a.durationS !== undefined) out.push(["Length", clock(a.durationS)]);
  if (a.width) out.push(["Size", `${a.width}×${a.height}`]);
  if (a.roll) out.push(["Roll", a.roll === "a" ? "A-roll" : "B-roll"]);
  if (a.versionN > 1) out.push(["Version", String(a.versionN)]);
  return out;
}

/** How a clip opens from the grid (Settings → Appearance): a window in the middle of the page, or a panel at the side. */
export type ClipView = "window" | "side";
const VIEW_KEY = "appearance:clip-view";
const VIEW_EVENT = "clip-view-change";
export function storedClipView(): ClipView {
  try {
    return localStorage.getItem(VIEW_KEY) === "side" ? "side" : "window";
  } catch {
    return "window";
  }
}
export function persistClipView(view: ClipView): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* private mode: the choice holds for this visit only */
  }
  window.dispatchEvent(new Event(VIEW_EVENT));
}
export function useClipView(): ClipView {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener(VIEW_EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(VIEW_EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    storedClipView,
    () => "window",
  );
}

/**
 * A share link's address, kept on the device that made it: the server keeps only a hash of the token, so this is the
 * one place the address can be read again. ponytail: per device; a link made elsewhere lists with Stop but no Copy.
 */
const linkKey = (shareId: string) => `library-share:${shareId}`;
export function rememberLink(shareId: string, url: string): void {
  try {
    localStorage.setItem(linkKey(shareId), url);
  } catch {
    /* private mode: the address shows for this visit only */
  }
}
export function knownLink(shareId: string): string | null {
  try {
    return localStorage.getItem(linkKey(shareId));
  } catch {
    return null;
  }
}

/** The days a link can work for; a link whose time left is none of them shows its own count beside them. */
export const LINK_DAYS = [1, 7, 30, 90] as const;
export const daysLeft = (expiresAt: number, now = Date.now()) => Math.max(1, Math.ceil((expiresAt - now) / 86_400_000));

/** What the player says in its place when the file did not play. */
export type PlayerNote = "missing" | "preparing" | "unplayable" | "unknown";

const busy = (d: AssetDetail, kind: string) => d.jobs.some((j) => j.kind === kind && (j.state === "queued" || j.state === "running"));

/** Why a clip did not play, from its detail (null: not read yet). */
export function playerNote(state: AssetCard["state"], detail: AssetDetail | null): PlayerNote {
  if (state === "missing") return "missing";
  if (!detail) return "unknown";
  // the probe decides whether a lighter copy is made; a copy queued or running is on its way
  const probed = detail.jobs.some((j) => j.kind === "probe" && j.state === "done");
  if (busy(detail, "probe") || busy(detail, "proxy") || (!probed && detail.state === "processing")) return "preparing";
  return "unplayable";
}

/** The lighter copy is there: a file that failed is worth one more try. */
export const copyReady = (detail: AssetDetail | null) => !!detail?.jobs.some((j) => j.kind === "proxy" && j.state === "done");

/** The original's address and the name it is saved under: the title, with the file's own extension when its path is known. */
export function original(a: AssetCard, detail: AssetDetail | null) {
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(detail?.sourcePath ?? "")?.[0] ?? "";
  return { href: `/api/library/media/${a.versionId}/source`, name: `${a.title}${ext}` };
}

/** The library's live links that open this clip (the list is the whole library's). */
export const linksOf = (shares: ShareRow[], assetId: string, versionId: string) =>
  shares.filter((s) => (s.target.kind === "asset" && s.target.id === assetId) || (s.target.kind === "version" && s.target.id === versionId));
