import type { PlaceWord } from "@contracts/places";

/**
 * The words for where a file is (one place: every screen and the Mac app's strings use these). Never "missing" for a
 * file nobody has looked for: that is "Not checked yet".
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
} as const;

export const onComputer = (computer: string) => `On ${computer}`;
export const missingOn = (computer: string) => `Missing on ${computer}`;
export const diskAway = (disk: string) => `${disk} isn't connected`;
export const offline = (computer: string) => `${computer} is offline`;
export const uncheckedOn = (computer: string) => `${WORDS.unchecked} on ${computer}`;

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
