import { readFile } from "node:fs/promises";
import { HELPER_CHECK_KIND, parseHelperCheck, weightFor, type DeviceJob, type HelperCheck, type HelperCheckSent } from "../../contracts/devices";
import { sourcesOf, type StorageFolder } from "../../contracts/storage";
import { env } from "./env";
import { deviceOf, isOnline, listDevices, setDeviceCheck } from "./devices";
import { wakeEditorPolls } from "./mac-claude";
import type { DeviceJobSlot } from "./plugin";
import { parseStorageFile, pathOn, storageFilePath, withMounts } from "./storage";

/**
 * Checks one computer for helping with heavy work (setup's Help screen, Settings → Devices, POST /api/devices/:id/check):
 * it reads its disks again and reports them, so a shared drive connected a moment ago counts at once; then, for a test,
 * it reads part of one real file in each of the account's folders it reaches, at its own path, and times a short encode.
 * The device job road carries it (HELPER_CHECK_KIND), as it carries the assistant's folder listings (folder-list.ts).
 */

/** How long a computer has to answer: a test reads a file in every folder and encodes a few seconds of video. */
export const CHECK_WAIT_MS = 60_000;

interface Ask {
  id: number;
  owner: string;
  want: string;
  options: Record<string, string>;
  device?: string;
  end: (r: HelperCheckSent | Error) => void;
}
const asks = new Map<number, Ask>();
let lastId = 0;

/** Asks computer `want` of `owner`'s; rejects with a sentence a person can read. */
function ask(owner: string, want: string, folders: Record<string, string>, test: boolean): Promise<HelperCheckSent> {
  const d = deviceOf(want);
  if (!d || d.owner !== owner) return Promise.reject(new Error("No such computer"));
  if (!isOnline(want)) return Promise.reject(new Error(`${d.name} is offline.`));
  if (!d.kinds?.includes(HELPER_CHECK_KIND)) return Promise.reject(new Error(`Update Creator Toolset on ${d.name} first.`));
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    const timer = setTimeout(() => end(new Error(`${d.name} did not answer in ${CHECK_WAIT_MS / 1000} s.`)), CHECK_WAIT_MS);
    const end = (r: HelperCheckSent | Error) => {
      clearTimeout(timer);
      asks.delete(id);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    asks.set(id, { id, owner, want, options: { folders: JSON.stringify(folders), test: test ? "1" : "" }, end });
    void wakeEditorPolls();
  });
}

/** The Media folders of every workspace of `owner`'s, with each computer that reaches them (withMounts). */
async function foldersOf(owner: string): Promise<StorageFolder[]> {
  const raw = await readFile(storageFilePath(env.dataDir, owner), "utf-8").catch(() => "{}");
  const all = withMounts(parseStorageFile(raw).folders, listDevices((x) => x.owner === owner).map((x) => ({ id: x.id, disks: x.report?.machine?.disks })));
  return sourcesOf(all).filter((f) => f.role !== "library");
}

/**
 * Checks computer `device`: its disks always; with `test`, one file of each folder it reaches and an encode. A test is
 * kept on the computer (Device.check, so its other computers see it at once) with the weight it suggests.
 */
export async function checkComputer(owner: string, device: string, test: boolean): Promise<{ check?: HelperCheck; weight?: number }> {
  // first its disks, read now: the folders it reaches follow from them (lib/storage.ts withMounts)
  await ask(owner, device, {}, false);
  if (!test) return {};
  const reached = (await foldersOf(owner)).flatMap((f) => {
    const at = pathOn(f, device);
    return at ? [{ f, at }] : [];
  });
  const paths = Object.fromEntries(reached.map(({ f, at }) => [f.id, at]));
  const sent = await ask(owner, device, paths, true);
  const names = new Map(reached.map(({ f }) => [f.id, f.name]));
  const check: HelperCheck = { ...sent, at: Date.now(), folders: sent.folders.map((x) => ({ ...x, name: names.get(x.id) ?? x.id })) };
  setDeviceCheck(device, check);
  return { check, weight: weightFor(sent) };
}

const held = (device: string, id: number) => {
  const a = asks.get(id);
  return a?.device === device ? a : undefined;
};

/** The device job road's side of it (api/devices.ts lists it with folder-list). */
export const helperCheckJob: DeviceJobSlot = {
  kind: HELPER_CHECK_KIND,
  waits: (owner, device) => [...asks.values()].some((a) => a.owner === owner && a.want === device && !a.device),
  claim: (d): DeviceJob | null => {
    const a = [...asks.values()].find((x) => x.owner === d.owner && x.want === d.id && !x.device);
    if (!a) return null;
    a.device = d.id;
    return { id: a.id, kind: HELPER_CHECK_KIND, editId: "", variant: "", options: a.options };
  },
  input: async () => null,
  answer: async (device, id, body) => {
    const a = held(device, id);
    if (!a) return { error: "Not found", status: 404 };
    const sent = parseHelperCheck(body, Object.keys(JSON.parse(a.options.folders!) as Record<string, string>));
    if (!sent) return { error: "Send { ffmpeg, encode?, folders }.", status: 400 };
    a.end(sent);
    return { reply: {} };
  },
  file: async () => ({ error: "Send the check as JSON.", status: 400 }),
  fail: (device, id, why) => {
    const a = held(device, id);
    if (!a) return false;
    a.end(new Error(why));
    return true;
  },
};
