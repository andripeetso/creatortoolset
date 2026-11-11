import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Device, MacReport, ProviderSettings } from "../../contracts/providers";
import { env } from "./env";
import { dropOwnSettings, ownSettings, providerSettings, saveSettings } from "./providers";
import { announce } from "./sync";
import { announceAdmins, findUser } from "../users";

/**
 * The Macs that run AI jobs (contracts/providers.ts `Device`), in $DATA_DIR/devices.json. Any account pairs its
 * own Mac in the Creator Toolset Mac app: a `ctd_` token, shown once, kept as sha256 only (like users' apiKeyHash).
 * A provider runs on one of these devices; an instance with no device runs on nothing until one is picked.
 */

/** online = polled or posted within this many ms */
const ONLINE_MS = 40_000;
const TOKEN_RE = /^ctd_[A-Za-z0-9_-]{43}$/;

type Stored = Device & { tokenHash?: string };

const FILE = () => path.join(env.dataDir, "devices.json");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let list: Stored[] | null = null;
let saving: Promise<void> = Promise.resolve();
let persistedAt = 0;

const all = (): Stored[] => {
  if (!list) {
    try {
      list = JSON.parse(readFileSync(FILE(), "utf-8")) as Stored[];
    } catch {
      list = [];
    }
  }
  return list;
};

/** Writes the whole list as it is now; writes queue behind each other (one tmp file). */
function persist(): void {
  const json = JSON.stringify(all(), null, 2);
  persistedAt = Date.now();
  saving = saving
    .then(async () => {
      const tmp = `${FILE()}.tmp-${process.pid}`;
      await writeFile(tmp, json);
      await rename(tmp, FILE());
    })
    .catch((e: unknown) => console.warn(`[devices] not saved: ${e instanceof Error ? e.message : e}`));
}

/** Resolves once every queued write has landed (a test waits on it before it removes its data dir). */
export const devicesSaved = (): Promise<void> => saving;

/** The record without its token hash. */
const strip = (d: Stored): Device => {
  const copy: Stored = { ...d };
  delete copy.tokenHash;
  return copy;
};

function find(id: string): Stored | undefined {
  return all().find((d) => d.id === id);
}

/**
 * Tells the accounts that are shown a computer that it changed ("devices"): its owner, and every admin for the team's own
 * computer (owner "workspace" is no account) and for an admin's computer, since each admin's list has those too
 * (api/devices.ts, api/providers.ts).
 */
function tell(owner: string): void {
  const shared = owner === "workspace" || findUser(owner)?.role === "admin";
  if (shared) announceAdmins("devices");
  else announce(owner, "devices");
}

/** The timer per device that tells its owner it went offline, ONLINE_MS after its last call. */
const goingOff = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Any relay call says the Mac is here (lastSeen). Written at most once a minute: online is in memory anyway. Its owner's
 * open windows (the admins', for the team's own computer) hear "devices" when it comes online and when it goes quiet,
 * never on each call.
 */
export function touchDevice(id: string): void {
  const d = find(id);
  if (!d) return;
  if (!isOnline(id)) tell(d.owner);
  d.lastSeen = Date.now();
  if (d.lastSeen - persistedAt > 60_000) persist();
  clearTimeout(goingOff.get(id));
  const t = setTimeout(() => {
    goingOff.delete(id);
    if (find(id) && !isOnline(id)) tell(d.owner);
  }, ONLINE_MS + 1000);
  t.unref?.();
  goingOff.set(id, t);
}

export const deviceOf = (id: string): Device | undefined => {
  const d = find(id);
  return d && strip(d);
};

export const deviceExists = (id: string): boolean => !!find(id);

export const deviceName = (id: string): string => find(id)?.name ?? id;

export const isOnline = (id: string): boolean => {
  const last = find(id)?.lastSeen ?? 0;
  return last > 0 && Date.now() - last < ONLINE_MS;
};

/** The device a `ctd_` Bearer token belongs to (boot.ts checks it before the cookie gate). */
export function deviceForToken(authorization: string | undefined): Device | null {
  const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (!token || !TOKEN_RE.test(token)) return null;
  const hash = sha(token);
  const d = all().find((x) => x.tokenHash === hash);
  return d ? strip(d) : null;
}

/**
 * A new app device for `owner`; the token is returned once and never stored. An earlier device of the same owner
 * with the same name is the same Mac paired again (the app re-pairs when its token is lost): it is dropped, so its
 * token stops working and the list keeps one row per Mac. `replaced` are the dropped ids: their providers move to the
 * new one (moveProviders, called by the route).
 */
export function pairDevice(owner: string, name: string, version?: string): { device: Device; token: string; replaced: string[] } {
  const token = `ctd_${randomBytes(32).toString("base64url")}`;
  const d: Stored = {
    id: `dev_${randomBytes(8).toString("hex")}`,
    owner,
    name,
    createdAt: Date.now(),
    tokenHash: sha(token),
    ...(version ? { version } : {}),
  };
  const replaced = all().filter((x) => x.owner === owner && x.name === name).map((x) => x.id);
  list = all().filter((x) => !replaced.includes(x.id));
  list.push(d);
  persist();
  tell(owner);
  return { device: strip(d), token, replaced };
}

export const listDevices = (keep: (d: Device) => boolean): Device[] => all().filter((d) => keep(strip(d))).map(strip);

export function renameDevice(id: string, name: string): Device | undefined {
  const d = find(id);
  if (!d) return undefined;
  d.name = name;
  persist();
  tell(d.owner);
  return strip(d);
}

/**
 * Moves every provider that runs on one of `from` to `to`, or drops them when `to` is null, in the workspace's set and
 * in `owner`'s own set. A dropped provider that the default or a job points at: the default goes to the first one left,
 * the job's pick goes (it then uses the default). An account left with no provider loses its own set (it uses the
 * workspace's again). Writes go through providers.ts so its cache stays right.
 */
export async function moveProviders(owner: string, from: string[], to: string | null): Promise<void> {
  for (const scope of ["workspace", owner]) {
    const cur = scope === "workspace" ? providerSettings() : ownSettings(scope);
    if (!cur || !cur.instances.some((i) => from.includes(i.device ?? ""))) continue;
    if (to) {
      await saveSettings({ ...cur, instances: cur.instances.map((i) => (from.includes(i.device ?? "") ? { ...i, device: to } : i)) }, scope);
      continue;
    }
    const instances = cur.instances.filter((i) => !from.includes(i.device ?? ""));
    if (instances.length === 0 && scope !== "workspace") {
      await dropOwnSettings(scope);
      continue;
    }
    const left = (id: string) => instances.some((i) => i.id === id);
    const next: ProviderSettings = {
      instances,
      default: left(cur.default.instance) ? cur.default : { instance: instances[0]?.id ?? "", model: "", effort: cur.default.effort },
      jobs: Object.fromEntries(Object.entries(cur.jobs).filter(([, s]) => s && left(s.instance))),
    };
    await saveSettings(next, scope);
  }
}

/** Revoking deletes the record: its token stops working at once, and the providers that ran on it go with it. */
export async function revokeDevice(id: string): Promise<boolean> {
  const d = find(id);
  if (!d) return false;
  await moveProviders(d.owner, [id], null);
  list = all().filter((x) => x.id !== id);
  persist();
  tell(d.owner);
  return true;
}

/** The editor step kinds a device declares (its claim). Written only when they change. */
export function setDeviceKinds(id: string, kinds: string[]): void {
  const d = find(id);
  if (!d || JSON.stringify(d.kinds ?? []) === JSON.stringify(kinds)) return;
  d.kinds = kinds;
  persist();
}

/** A device's report (the Mac relay `report`). */
export function saveReport(id: string, r: MacReport, version?: string): void {
  const d = find(id);
  if (!d) return;
  // Two reporters post for one Mac (the Mac app and the editor worker, same token), and one may send no disk list.
  // ponytail: an empty list from the only reporter keeps the old disks; add an explicit clear when a Mac really loses them all.
  const kept = d.report?.machine?.disks;
  if (r.machine && kept && !r.machine.disks) r.machine = { ...r.machine, disks: kept };
  // a CLI installed, signed in or on another plan is a change setup shows, and so is the app's new version; the machine's
  // load in each report is not
  const drivers = (x: MacReport | undefined) => JSON.stringify(x?.drivers ?? []);
  if (drivers(d.report) !== drivers(r) || (!!version && version !== d.version)) tell(d.owner);
  d.report = r;
  if (version) d.version = version;
  persist();
}

/**
 * The device as `viewer` may see it: a Mac it does not own shows no disks. The team's AI worker (owner "workspace") keeps
 * its disks: only admins are sent it (devices.ts, providers.ts), and Storage and Network storage need them.
 */
export function forViewer(viewer: string, d: Device): Device {
  const r = d.report;
  if (d.owner === viewer || d.owner === "workspace" || !r?.machine?.disks) return d;
  return { ...d, report: { ...r, machine: { ...r.machine, disks: undefined } } };
}

/** What the device reported last. */
export function reportOf(id: string): MacReport | null {
  return find(id)?.report ?? null;
}
