import { useSyncExternalStore } from "react";
import type { AssetCard, AssetDetail, ShareRow, TagCount } from "@contracts/library";
import { macPageMarked, thisMacBridge } from "@/lib/thisMac";
import { thisMacDevice } from "@/lib/providers";
import { getAsset } from "@/lib/library";
import { allGranted, askMediaFolder, listMediaFolders } from "@/lib/local-files";

/**
 * What the clip view decides from a clip and its detail (its facts, what its player says, its share links), and the
 * two things it keeps on this device: how a clip opens, and the addresses of the share links made here.
 */

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

type Shot = NonNullable<AssetDetail["shots"]>[number];
type Moment = NonNullable<AssetDetail["timeline"]>[number];

/**
 * A clip's shots under the timeline moment each starts in, in order (What happens on the clip panel); the shots before
 * the first moment come first, with no moment. Without a timeline: one group of every shot.
 */
export function shotsByMoment(events: Moment[], shots: Shot[]): { event?: Moment; shots: Shot[] }[] {
  const groups: { event?: Moment; shots: Shot[] }[] = [{ shots: [] }, ...events.map((event) => ({ event, shots: [] as Shot[] }))];
  for (const s of shots) {
    let i = 0;
    while (i < events.length && events[i]!.a <= s.a + 0.05) i++;
    groups[i]!.shots.push(s);
  }
  return groups.filter((g) => g.event || g.shots.length);
}
export const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

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

export { clipHref } from "./folders";

/** The library's tags that fit what is typed and the clip lacks: those starting with it first, then the most used; at most 8. */
export function tagSuggestions(all: TagCount[], have: string[], typed: string): string[] {
  const t = typed.trim().toLowerCase();
  const on = new Set(have.map((h) => h.toLowerCase()));
  return all
    .filter((x) => !on.has(x.tag.toLowerCase()) && x.tag.toLowerCase().includes(t))
    .sort((a, b) => Number(b.tag.toLowerCase().startsWith(t)) - Number(a.tag.toLowerCase().startsWith(t)) || b.count - a.count)
    .slice(0, 8)
    .map((x) => x.tag);
}

/** On the server on this Mac (the Mac app's own): its clips' files are on this Mac. */
export const servedHere = () => typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

/** The Mac app shows a clip's file in Finder (<html data-mac-reveal>, apps/mac Reveal.swift). */
export const canReveal = () => macPageMarked();

const revealMark = () => (typeof document === "undefined" ? undefined : document.documentElement.dataset.macReveal);

/** From '2' the Mac app shows a video, sound or picture file in Finder with no folder granted first. */
export const revealsAnywhere = () => revealMark() === "2";

/** Show in Finder only where this Mac has the file: the server on this Mac, or a card's "here" on this Mac (never another computer's path). */
export const revealsHere = (placeWord: AssetCard["placeWord"]) => canReveal() && (servedHere() || (placeWord?.word === "here" && !!thisMacDevice()));

/** On a server elsewhere an older Mac app shows only files inside the folders granted to it, so a folder not granted yet
 *  is asked for first, from this click, in the app's own open panel. false: the panel closed without a folder that holds it. */
async function granted(local: string): Promise<boolean> {
  return servedHere() || revealsAnywhere() || allGranted([local], await listMediaFolders()) || allGranted([local], await askMediaFolder(local.slice(0, local.lastIndexOf("/")) || "/"));
}

/** Shows the clip's file in Finder: null when it did, "" when no folder was granted, else what went wrong. The Mac app
 *  asks the server for the file itself; `path` (the detail's sourcePath, else asked here) only picks the folder to grant. */
export async function revealClip(libraryId: string, assetId: string, path?: string): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return "Needs the Mac app";
  const local = servedHere() ? undefined : (path ?? (await getAsset(libraryId, assetId).catch(() => null))?.sourcePath);
  if (local && !(await granted(local))) return "";
  const r = ((await bridge.postMessage(`reveal:${JSON.stringify({ library: libraryId, asset: assetId })}`).catch(() => null)) ?? {}) as unknown as { ok?: boolean; problem?: string };
  return r.ok ? null : (r.problem ?? "File not found on this Mac");
}

/** Shows a Review version's own file in Finder (its `local`, from the server): null when it did, else what went wrong.
 *  Its folder is granted first, as for a clip. */
export async function revealReviewFile(assetId: string, n: number, local: string): Promise<string | null> {
  const bridge = thisMacBridge();
  if (!bridge) return "Needs the Mac app";
  if (!(await granted(local))) return ""; // the panel closed without a folder that holds it: nothing to say
  const r = ((await bridge.postMessage(`reveal:${JSON.stringify({ review: assetId, v: n })}`).catch(() => null)) ?? {}) as unknown as { ok?: boolean; problem?: string };
  return r.ok ? null : (r.problem ?? "File not found on this Mac");
}
