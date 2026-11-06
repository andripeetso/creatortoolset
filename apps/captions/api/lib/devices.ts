import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Device, MacReport } from "../../contracts/providers";
import { env } from "./env";

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

/** The record without its token hash. */
const strip = (d: Stored): Device => {
  const copy: Stored = { ...d };
  delete copy.tokenHash;
  return copy;
};

function find(id: string): Stored | undefined {
  return all().find((d) => d.id === id);
}

/** Any relay call says the Mac is here (lastSeen). Written at most once a minute: online is in memory anyway. */
export function touchDevice(id: string): void {
  const d = find(id);
  if (!d) return;
  d.lastSeen = Date.now();
  if (d.lastSeen - persistedAt > 60_000) persist();
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

/** A new app device for `owner`; the token is returned once and never stored. */
export function pairDevice(owner: string, name: string, version?: string): { device: Device; token: string } {
  const token = `ctd_${randomBytes(32).toString("base64url")}`;
  const d: Stored = {
    id: `dev_${randomBytes(8).toString("hex")}`,
    owner,
    name,
    createdAt: Date.now(),
    tokenHash: sha(token),
    ...(version ? { version } : {}),
  };
  all().push(d);
  persist();
  return { device: strip(d), token };
}

export const listDevices = (keep: (d: Device) => boolean): Device[] => all().filter((d) => keep(strip(d))).map(strip);

export function renameDevice(id: string, name: string): Device | undefined {
  const d = find(id);
  if (!d) return undefined;
  d.name = name;
  persist();
  return strip(d);
}

/** Revoking deletes the record: its token stops working at once. */
export function revokeDevice(id: string): boolean {
  const before = all().length;
  list = all().filter((d) => d.id !== id);
  if (list.length === before) return false;
  persist();
  return true;
}

/** A device's report (the Mac relay `report`). */
export function saveReport(id: string, r: MacReport, version?: string): void {
  const d = find(id);
  if (!d) return;
  d.report = r;
  if (version) d.version = version;
  persist();
}

/** What the device reported last. */
export function reportOf(id: string): MacReport | null {
  return find(id)?.report ?? null;
}
