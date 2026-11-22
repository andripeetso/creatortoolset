import type { PlaceWord } from "../../contracts/places";

/**
 * The words for where a file is (one place: every screen and the Mac app's strings use these). Never "missing" for a
 * file nobody has looked for: that is "Not checked yet". Also what a computer's library work waits on (api/work/waits.ts).
 */
export const WORDS = {
  here: "On this computer",
  found: "Found, not checked yet",
  unchecked: "Not checked yet",
  folderNotFound: "Folder not found, re-point?",
  needsOk: "Needs your OK",
  allowOnThisMac: "Allow on this Mac",
  waits: "Waits for one of your computers.",
  waitsInternet: "Waits for the internet.",
  visitorNoProxy: "This clip isn't available to view right now.",
  lastChecked: "Last checked",
  addComputer: "Add a computer in Settings → Computers",
  notOnComputers: "Video work is off on this server, and no computer of yours can make these",
  fileUnchecked: "Where the file is: not checked yet",
} as const;

export const onComputer = (computer: string) => `On ${computer}`;
export const missingOn = (computer: string) => `Missing on ${computer}`;
export const diskAway = (disk: string) => `${disk} isn't connected`;
export const offline = (computer: string) => `${computer} is offline`;
export const uncheckedOn = (computer: string) => `${WORDS.unchecked} on ${computer}`;
export const switchOff = (computer: string) => `Take work from this server is off on ${computer}`;
export const addAgain = (computer: string) => `Add ${computer} again in Settings → Computers`;
export const addComputer = WORDS.addComputer;
export const offInBalancing = (computer: string) => `${computer} is Off in Load balancing`;
export const notThisLibrary = (computer: string) => `${computer} doesn't take this library`;
export const noOriginals = (computer: string) => `${computer} doesn't download originals`;
export const updateOn = (computer: string) => `Update Creator Toolset on ${computer}`;
export const lowDiskOn = (computer: string) => `${computer} is short of disk space`;
export const noLooksOn = (computer: string) => `${computer}'s app doesn't make shot descriptions`;
export const notOnComputers = WORDS.notOnComputers;
export const fileUnchecked = WORDS.fileUnchecked;
export const aheadOf = (computer: string, peer: string) => `${peer} takes these before ${computer}`;
export const keptFor = (computer: string) => `Load balancing gives these to ${computer}`;
export const notStarted = (computer: string) => `${computer} hasn't started on these`;
export const notTaking = (computer: string) => `${computer} hasn't taken these yet`;
export const ownerKeeps = (computer?: string) =>
  `Your owner keeps its files on their computers${computer ? ` · ${offline(computer)}` : ""}`;

/**
 * The viewer's own Mac (the Mac app's bridge) with Take work from this server off: a wait whose computers are all offline
 * and that names this Mac among them is his to change, at that switch. null for every other wait and viewer.
 */
export function ownMacLine(
  entry: { wait?: string; devices?: string[] },
  bridge?: { device?: string | null; aiOn: boolean; computer?: string } | null,
): { reason: string; href: string } | null {
  if (entry.wait !== "offline" || !bridge?.device || bridge.aiOn || !entry.devices?.includes(bridge.device)) return null;
  return { reason: switchOff(bridge.computer || "this Mac"), href: "/settings/devices#use-this-mac" };
}

/** The line for a place word (contracts/places.ts placeWordOf). */
export function placeLine(w: PlaceWord): string {
  switch (w.word) {
    case "here": return WORDS.here;
    case "on": return onComputer(w.computer);
    case "found": return WORDS.found;
    case "unchecked": return WORDS.unchecked;
    case "folder_not_found": return WORDS.folderNotFound;
    case "missing": return missingOn(w.computer);
    case "disk_away": return diskAway(w.disk);
    case "offline": return offline(w.computer);
    case "needs_ok": return WORDS.needsOk;
  }
}
