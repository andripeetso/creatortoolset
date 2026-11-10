import type { ProvidersView } from "@contracts/providers";

export type Listed = ProvidersView["devices"][number];
/** One Mac: the records that are it (the app and the worker each pair one; the team's copy shows for an admin). */
export interface ComputerGroup {
  records: Listed[];
  primary: Listed;
}

/**
 * The Mac a record is, from what its report says: hostname, chip, cores and memory. Records with no report keep their
 * own id, so they are never merged. ponytail: a different Mac with the same hostname, chip and memory would merge too;
 * a stable machine id from the Mac app would replace this key.
 */
const machineKey = (d: Listed): string => {
  const m = d.report?.machine;
  return m?.host ? [m.host, m.cpu ?? "", m.cpus, m.memGb].join("|") : d.id;
};

/** The record that speaks for the group: online first, then this account's own, then the one seen last. */
function primaryOf(records: Listed[], me: string): Listed {
  return [...records].sort(
    (a, b) =>
      Number(b.online) - Number(a.online) ||
      Number(b.owner === me) - Number(a.owner === me) ||
      (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
  )[0]!;
}

/** Groups the computers list by Mac, in the order each Mac first appears. */
export function groupComputers(devices: Listed[], me: string): ComputerGroup[] {
  const byKey = new Map<string, Listed[]>();
  for (const d of devices) {
    const k = machineKey(d);
    byKey.set(k, [...(byKey.get(k) ?? []), d]);
  }
  return [...byKey.values()].map((records) => ({ records, primary: primaryOf(records, me) }));
}
