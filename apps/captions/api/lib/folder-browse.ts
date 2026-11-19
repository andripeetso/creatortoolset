import { FOLDER_BROWSE_KIND, type DeviceJob, type FolderBrowse } from "../../contracts/devices";
import { cantFind } from "../../contracts/library";
import type { Device } from "../../contracts/providers";
import { isOnline } from "./devices";
import { wakeEditorPolls } from "./mac-claude";
import type { DeviceJobSlot } from "./plugin";

/**
 * A chat card's folder browser on a computer that is not the one showing the card (D14: the phone, a browser): one
 * level of folders, asked of that computer through its device job road (FOLDER_BROWSE_KIND, the Mac app's
 * FolderBrowseJob.swift). The path is checked here and again on the computer once its links are followed.
 */

const OUTSIDE = "Only folders in your home folder or on your drives";
const WAIT_MS = 15_000;

/** Whether `p` may be browsed on a computer running `os`: its home ("~", or /Users, /home), or a drive. */
export function browsable(p: string, os: string | undefined): boolean {
  if (p.length > 1000 || /[\0\n\r]/.test(p) || p.split("/").includes("..")) return false;
  if (p === "~" || p.startsWith("~/")) return true;
  const under = (root: string) => p.startsWith(`${root}/`) && p.length > root.length + 1;
  return os === "linux" ? ["/home", "/media", "/mnt"].some(under) : ["/Users", "/Volumes"].some(under);
}

type Pick = { status: 200; body: FolderBrowse } | { status: 400 | 409 | 501; body: { error: string; code?: string } };
type Ask = { id: number; device: string; owner: string; path: string; held?: true; end: (r: Omit<FolderBrowse, "device" | "deviceName"> | Error) => void };
const asks = new Map<number, Ask>();
let lastId = 0;

/** One level of folders at `path` on device `d` (the caller checked it is theirs): the answer and its status. */
export async function browseOn(d: Device, path: string): Promise<Pick> {
  if (!browsable(path, d.report?.machine?.os)) return { status: 400, body: { error: OUTSIDE } };
  if (!isOnline(d.id)) return { status: 409, body: { error: cantFind(d.name), code: "computer_offline" } };
  if (!d.kinds?.includes(FOLDER_BROWSE_KIND)) return { status: 501, body: { error: `Update Creator Toolset on ${d.name} to choose a folder from here`, code: "update_needed" } };
  try {
    const got = await new Promise<Omit<FolderBrowse, "device" | "deviceName">>((resolve, reject) => {
      const id = ++lastId;
      const timer = setTimeout(() => end(new Error("")), WAIT_MS);
      const end: Ask["end"] = (r) => {
        clearTimeout(timer);
        asks.delete(id);
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
      asks.set(id, { id, device: d.id, owner: d.owner, path, end });
      void wakeEditorPolls();
    });
    return { status: 200, body: { device: d.id, deviceName: d.name, ...got } };
  } catch (e) {
    const why = (e as Error).message;
    // no answer in time: the computer is as good as offline; its own refusal (outside, unreadable) is said as it is
    return why ? { status: 400, body: { error: why } } : { status: 409, body: { error: cantFind(d.name), code: "computer_offline" } };
  }
}

const pairs = (v: unknown): { name: string; path: string }[] =>
  Array.isArray(v) ? v.flatMap((x) => (typeof x?.name === "string" && typeof x?.path === "string" && x.path.startsWith("/") ? [{ name: x.name, path: x.path }] : [])).slice(0, 5000) : [];

export const folderBrowseJob: DeviceJobSlot = {
  kind: FOLDER_BROWSE_KIND,
  waits: (owner, device) => [...asks.values()].some((a) => !a.held && a.device === device && a.owner === owner),
  claim: (d): DeviceJob | null => {
    const a = [...asks.values()].find((x) => !x.held && x.device === d.id && x.owner === d.owner);
    if (!a) return null;
    a.held = true;
    return { id: a.id, kind: FOLDER_BROWSE_KIND, editId: "", variant: "", options: { path: a.path } };
  },
  input: async () => null,
  answer: async (device, id, body) => {
    const a = asks.get(id);
    if (a?.device !== device) return { error: "Not found", status: 404 };
    const b = body as Record<string, unknown> | null;
    if (typeof b?.path !== "string") return { error: "Send the folders.", status: 400 };
    a.end({ path: b.path, parent: typeof b.parent === "string" ? b.parent : null, roots: pairs(b.roots), dirs: pairs(b.dirs) });
    return { reply: {} };
  },
  file: async () => ({ error: "Send the folders as JSON.", status: 400 }),
  fail: (device, id, why) => {
    const a = asks.get(id);
    if (a?.device !== device) return false;
    a.end(new Error(why || OUTSIDE));
    return true;
  },
};
