/**
 * Whether this server takes a file's bytes into a library: the one rule, asked by every upload route (the route table is
 * upload-gate.test.ts). A library's Upload setting (none / proxies / all) says what its computers send. Bytes a person
 * chose to send (a browser upload, the phone's Upload) are taken under any setting: the upload is the choice. Bytes a
 * computer would send of a file it holds (an upload naming where the file is on that computer) are taken only where the
 * setting sends originals; under none the file is indexed where it is and nothing is sent. A proxy a computer made of
 * a file it holds is taken under proxies and all, and under none in a library its owner shares with members (team
 * proxies); its bytes must hash to the SHA-256 the computer declared before sending, and must not be the original's
 * size. On This Mac the server and the computer are one, so its own files are always taken.
 */
import { finalsUpload, isFinalsCollection, libraryDb, libraryUpload, versionUpload } from "./db";
import type { LibraryUpload } from "../../contracts/library";
import type { Device } from "../../contracts/providers";
import { accountOf } from "./access";
import { workspaceOf } from "../lib/workspaces";
import { serverKind } from "../work/server-work";

/** original: the file itself; proxy: a smaller copy made of it; derivative: a picture, sheet or text the Library shows; serving: bytes the server made. */
export type ReceiveKind = "original" | "proxy" | "derivative" | "serving";
/** person: someone chose to send it; computer: a computer sends a file it holds, nobody sent it by hand. */
export type ReceiveOrigin = "person" | "computer";

export const REFUSED_NONE = "This library keeps its files on your computers. Add them from the Mac app, or from the computer that has them.";
export const REFUSED_PROXIES = "This library takes proxies only. Your computer makes the proxy and sends that.";
export const REFUSED_PROOF = "These bytes are not the proxy your computer declared. Nothing was kept.";

export type Received = { ok: true } | { ok: false; status: 409; body: { error: string; code: "upload_refused"; message: string } };

/**
 * The proxy proof: `sha256` the computer declared before sending; at the finish `got` (what the bytes hash to here),
 * `bytes` received and `original` (the original's size). Absent at the start of an upload, the declaration is checked.
 */
export interface ProxyProof {
  sha256?: string;
  got?: string;
  bytes?: number;
  original?: number;
}

/**
 * Release order (local-first plan, D11): a computer whose worker declares its proxies (claim `proof`, api/work/computer.ts)
 * makes the proxy before it sends. One that does not yet (an older Mac app) keeps the earlier rule until it updates: its
 * original is still taken under proxies, and its proxies without a declaration.
 */
export const provesProxies = (sender: Pick<Device, "work"> | undefined | null): boolean => !!sender?.work?.proof;

/** Where bytes go: a library, the collection they are sent into, or the version they belong to. */
export type ReceiveInto = { id: string; collectionId?: string | null; versionId?: string };

/** The setting a file sent into `library` follows: a final the Finals one, anything else the library's Upload. */
export const uploadFor = (library: ReceiveInto): LibraryUpload =>
  library.versionId
    ? versionUpload(library.versionId)
    : library.collectionId && isFinalsCollection(library.collectionId)
      ? finalsUpload(library.id)
      : libraryUpload(library.id);

/** Whether the library's owner gave its workspace to at least one member (Settings → Team): its computers send team proxies. */
export function hasMembers(libraryId: string): boolean {
  const row = libraryDb().prepare("SELECT workspace_id, json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(libraryId) as
    | { workspace_id: string; ws: string | null }
    | undefined;
  const owner = row && accountOf(row.workspace_id);
  const team = owner ? workspaceOf(owner) : null;
  // a library from before workspaces (no projectId) is the first brand's: any member given a workspace sees it
  return !!team?.members.some((m) => m.role !== "owner" && !!m.workspaces?.length && (!row!.ws || m.workspaces.includes(row!.ws)));
}

const refuse = (message: string): Received => ({ ok: false, status: 409, body: { error: message, code: "upload_refused", message } });
const HEX = /^[0-9a-f]{64}$/;

export function mayReceive(
  kind: ReceiveKind,
  library: ReceiveInto,
  origin: ReceiveOrigin,
  opts: { sender?: Pick<Device, "work"> | null; proof?: ProxyProof } = {},
): Received {
  if (kind === "derivative" || kind === "serving" || serverKind() === "local") return { ok: true };
  const upload = uploadFor(library);
  if (kind === "original") {
    if (origin === "person" || upload === "all") return { ok: true };
    if (upload === "proxies") return provesProxies(opts.sender) ? refuse(REFUSED_PROXIES) : { ok: true };
    return refuse(REFUSED_NONE);
  }
  // a person's proxy (the phone's 720p copy) is less than the original they could send; a computer's needs the setting
  if (origin === "computer" && upload === "none" && !hasMembers(library.id)) return refuse(REFUSED_NONE);
  const p = opts.proof;
  if (!p) return { ok: true };
  if (p.sha256 !== undefined && !HEX.test(p.sha256)) return refuse(REFUSED_PROOF);
  if (p.got !== undefined && p.sha256 !== undefined && p.got !== p.sha256) return refuse(REFUSED_PROOF);
  // the original under a proxy's name: the same size as the file it was made from
  if (p.bytes !== undefined && p.original !== undefined && p.bytes === p.original) return refuse(REFUSED_PROOF);
  return { ok: true };
}
