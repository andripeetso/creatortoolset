/**
 * Whether this server takes a file's bytes into a library: the one rule, asked by every upload route (the route table is
 * upload-gate.test.ts). A library's Upload setting (none / proxies / all) says what its computers send. An original is
 * taken only under all (proxies: the P0 rule still takes it from an older computer), and under none no original is taken
 * from anyone, a browser or phone included (local-first 11-18, decision 6): the file stays on the person's computers.
 * A proxy a computer made of a file it holds is taken under proxies and all, and under none in a library its owner
 * shares with members (team proxies); its bytes must hash to the SHA-256 the computer declared before sending, and must
 * not be the original's size. On This Mac the server and the computer are one, so its own files are always taken.
 */
import { finalsUpload, isFinalsCollection, libraryDb, libraryUpload, versionUpload } from "./db";
import type { LibraryUpload } from "../../contracts/library";
import type { Device } from "../../contracts/providers";
import { accountOf } from "./access";
import { workspaceOf } from "../lib/workspaces";
import { projectOf } from "../lib/project-of";
import type { SessionUser } from "../users";
import { serverKind } from "../work/server-work";

/** original: the file itself; proxy: a smaller copy made of it; derivative: a picture, sheet or text the Library shows; serving: bytes the server made. */
export type ReceiveKind = "original" | "proxy" | "derivative" | "serving";
/**
 * person: someone chose to send it from a browser; computer: a computer sends a file it holds, nobody sent it by hand;
 * phone: the iPhone app sends the person's own file to their computers (`x-ct-origin: phone`, stored on the upload). A
 * phone's original is taken under none too and held until a computer has it (local-first PLAN-final decision 1).
 */
export type ReceiveOrigin = "person" | "computer" | "phone";

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
export async function hasMembers(libraryId: string): Promise<boolean> {
  const row = libraryDb().prepare("SELECT workspace_id, json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(libraryId) as
    | { workspace_id: string; ws: string | null }
    | undefined;
  const owner = row && accountOf(row.workspace_id);
  if (!owner) return false;
  const given = new Set((workspaceOf(owner)?.members ?? []).flatMap((m) => (m.role === "owner" ? [] : (m.workspaces ?? []))));
  if (!given.size) return false;
  if (row.ws && given.has(row.ws)) return true;
  // one with no workspace of its own (from before workspaces) is the first brand's, as givenLibrary reads it
  const of = await projectOf({ username: owner } as SessionUser);
  return !!of && given.has(of(row.ws ?? undefined));
}

const refuse = (message: string): Received => ({ ok: false, status: 409, body: { error: message, code: "upload_refused", message } });
const HEX = /^[0-9a-f]{64}$/;

export function mayReceive(
  kind: ReceiveKind,
  library: ReceiveInto,
  origin: ReceiveOrigin,
  /** team: the library is shared with members (hasMembers), asked by the caller for a computer's proxy under none */
  opts: { sender?: Pick<Device, "work"> | null; proof?: ProxyProof; team?: boolean } = {},
): Received {
  if (kind === "derivative" || kind === "serving" || serverKind() === "local") return { ok: true };
  const upload = uploadFor(library);
  if (kind === "original") {
    if (upload === "all") return { ok: true };
    if (upload === "proxies") return provesProxies(opts.sender) ? refuse(REFUSED_PROXIES) : { ok: true };
    return origin === "phone" ? { ok: true } : refuse(REFUSED_NONE);
  }
  // a person's proxy (the phone's 720p copy) is less than the original they could send; a computer's needs the setting
  if (origin === "computer" && upload === "none" && !opts.team) return refuse(REFUSED_NONE);
  const p = opts.proof;
  if (!p) return { ok: true };
  if (p.sha256 !== undefined && !HEX.test(p.sha256)) return refuse(REFUSED_PROOF);
  if (p.got !== undefined && p.sha256 !== undefined && p.got !== p.sha256) return refuse(REFUSED_PROOF);
  // the original under a proxy's name: the same size as the file it was made from
  if (p.bytes !== undefined && p.original !== undefined && p.bytes === p.original) return refuse(REFUSED_PROOF);
  return { ok: true };
}

/**
 * What the server hands a viewer of one version (local-first decision 5, R2): its original only where the library's
 * Upload is all; its proxy where that is proxies or all, and under none only where the library is shared with members
 * (team proxies). Finals follow the Finals setting. On This Mac the server is the computer, so it serves its own.
 */
export async function mayServe(
  version: { id: string; versionId: string },
  what: "original" | "proxy",
  /** the owner's computer asks (its edit's media, the worker's files): an original no computer holds yet is its to take */
  opts: { toComputer?: boolean } = {},
): Promise<Received> {
  if (serverKind() === "local") return { ok: true };
  const upload = uploadFor(version);
  if (what === "original" ? upload === "all" : upload !== "none") return { ok: true };
  if (what === "proxy" && (await hasMembers(version.id))) return { ok: true };
  // held until a computer has it (PLAN-final decision 1): the server hands it to a computer of the owner, and only until then
  // only the iPhone app's own file (asset_versions.origin): any other original under none is refused, held or not
  if (what === "original" && opts.toComputer && libraryDb().prepare("SELECT 1 FROM asset_versions WHERE id = ? AND origin = 'phone'").get(version.versionId) && !libraryDb().prepare("SELECT 1 FROM version_places WHERE version_id = ? AND kind = 'original' AND state = 'verified'").get(version.versionId)) {
    return { ok: true };
  }
  return refuse(upload === "proxies" ? REFUSED_PROXIES : REFUSED_NONE);
}
