import type { AssetCard, AssetDetail, ShareRow } from "@contracts/library";

/** What the clip panel decides from a clip and its detail: its facts line, what its player says, its share links. */

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** `roll` comes with the A/B-roll sorting; read as optional until every server sends it */
export type WithRoll = AssetCard & { roll?: "a" | "b" };

/** The clip's facts, in one line: length, size, its roll, when it was filmed, its version when there is more than one. */
export function factsOf(a: WithRoll): string {
  return [
    a.durationS !== undefined && clock(a.durationS),
    a.width && `${a.width}×${a.height}`,
    a.roll === "a" ? "A-roll" : a.roll === "b" ? "B-roll" : null,
    a.capturedAt && `Filmed ${day(a.capturedAt)}`,
    a.versionN > 1 && `version ${a.versionN}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

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
