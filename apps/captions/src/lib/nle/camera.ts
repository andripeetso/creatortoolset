import { detectCamera, type ReadBytes } from "@contracts/camera";
import type { EdjCamera } from "@contracts/editor";
import { getEditSteps } from "@/lib/editor";

/** The files whose metadata says their camera curve (QuickTime / MP4 boxes). */
export const CAMERA_FILE = /\.(mov|mp4|m4v)$/i;

/** Byte-range reads of a file the page plays (the Mac app's ctlocal:// serves ranges); a 416 is past its end. Any other
 *  answer than a range stops it, so a server that sends the whole file is never read whole. */
export const rangeReader = (url: string, get: typeof fetch = fetch): ReadBytes => async (offset, length) => {
  const r = await get(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (r.status === 416) return new Uint8Array(0);
  if (r.status !== 206) {
    void r.body?.cancel().catch(() => {});
    throw new Error(`no range read (${r.status})`);
  }
  return new Uint8Array(await r.arrayBuffer());
};

/** The Colour step is switched on in Settings → AI Editor. */
export const colourStepOn = async () => (await getEditSteps()).steps.some((s) => s.id === "colour" && s.state === "on" && s.use);

/** The camera curve a clip's file names, as its source keeps it (`on` only while the Colour step is on); null when the
 *  file names none or a read fails. */
export async function readCamera(read: ReadBytes, colourOn: () => Promise<boolean> = colourStepOn): Promise<EdjCamera | null> {
  try {
    const found = await detectCamera(read);
    return found && { ...found, on: await colourOn().catch(() => false) };
  } catch {
    return null;
  }
}
