import type { ProvidersView } from "@contracts/providers";

export type Listed = ProvidersView["devices"][number];
/**
 * One Mac: the records that are it (the Mac app's pairing and the AI worker each pair one). `mine` = this Mac, the one
 * the Mac app runs in; `old` = an old pairing of this account that has been offline a day or more and runs no AI.
 */
export interface ComputerGroup {
  records: Listed[];
  primary: Listed;
  mine: boolean;
  old: boolean;
}
/** This Mac's own names as the Mac app reports them (apps/mac ThisMacBridge.swift). Absent in older Mac apps: nothing merges by name then. */
export interface ThisMacNames {
  /** the name the Mac pairs with (its computer name, e.g. "Sam's Mac Studio") */
  computer?: string;
  /** the host name its AI worker reports (report.machine.host) */
  host?: string;
  /** this Mac's own device id, when the app knows it */
  device?: string;
}

const DAY = 86_400_000;

/**
 * The Mac a record is, from what its report says: hostname, chip, cores and memory. Records with no report keep their
 * own id, so they are never merged. ponytail: a different Mac with the same hostname, chip and memory would merge too;
 * a stable machine id from the Mac app would replace this key.
 */
const machineKey = (d: Listed): string => {
  const m = d.report?.machine;
  return m?.host ? [m.host.toLowerCase(), m.cpu ?? "", m.cpus, m.memGb].join("|") : d.id;
};

/** What a record is, in a word: the team's AI worker (owner "workspace") or the Mac app's pairing. */
export const kindOf = (d: Listed): string => (d.owner === "workspace" ? "AI Editor worker" : "Mac app");

/** macOS numbers a second pairing of one Mac: "Sam's Mac Studio (6)" is "Sam's Mac Studio". */
export const baseName = (name: string): string => name.replace(/\s\(\d+\)$/, "");

/**
 * Is this record this Mac? A record that reports a host name is matched by it; an old pairing with no report is matched
 * by its name (this account's own only). The Mac app's own device id counts too.
 */
export function isThisMac(d: Listed, me: string, names: ThisMacNames): boolean {
  if (names.device && d.id === names.device) return true;
  const host = d.report?.machine?.host;
  // host names differ only in case between reporters: the AI Editor worker says "Sams-Mac-Studio.local", the Mac app
  // "sams-mac-studio.local"
  if (host) return !!names.host && host.toLowerCase() === names.host.toLowerCase();
  return !!names.computer && d.owner === me && baseName(d.name) === names.computer;
}

/** An old pairing: this account's own records, none online, last seen a day ago or more, and none runs an AI. */
export function isOld(records: Listed[], me: string, runsAi: (id: string) => boolean, now: number): boolean {
  return records.every((r) => r.owner === me && !r.online && (r.lastSeen ?? 0) < now - DAY && !runsAi(r.id));
}

/** The record that speaks for the group: online first, then this account's own, then the one seen last. */
function primaryOf(records: Listed[], me: string): Listed {
  return [...records].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      Number(b.owner === me) - Number(a.owner === me) ||
      (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
  )[0]!;
}

/**
 * Groups the computers list by Mac, this Mac first, in the order each Mac first appears. `runsAi` says whether an AI
 * runs on a record (an old pairing with an AI is never folded away).
 */
export function groupComputers(
  devices: Listed[],
  me: string,
  names: ThisMacNames = {},
  runsAi: (id: string) => boolean = () => false,
  now = Date.now(),
): ComputerGroup[] {
  const mine = devices.filter((d) => isThisMac(d, me, names));
  const byKey = new Map<string, Listed[]>();
  for (const d of devices) {
    if (mine.includes(d)) continue;
    const k = machineKey(d);
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }
  const rest = [...byKey.values()].map((records) => ({
    records,
    primary: primaryOf(records, me),
    mine: false,
    old: isOld(records, me, runsAi, now),
  }));
  return mine.length ? [{ records: mine, primary: primaryOf(mine, me), mine: true, old: false }, ...rest] : rest;
}
