/**
 * Whether this server takes a file's bytes into a library: the one rule, asked by every upload route (the route table is
 * upload-gate.test.ts). A library's Hosted media (hostsOriginals / hostsProxies, UNIFIED-PRD §4.2) says what the server
 * keeps. A computer's original is taken only under originals or all: under proxies and none it is refused, with or without
 * the computer's proof. A person's own file (browser) is taken under originals or all only; the iPhone app's own file is taken
 * under any setting, held until a computer has it. A proxy is taken only under proxies or all, except the iPhone app's own
 * 720p copy, which every library takes; a computer's proxy must hash to the SHA-256 it declared, and from every sender a proxy
 * no smaller than its original is refused. On This Mac the server and the computer are one, so its own files are always taken.
 */
import { blursFaces, fileBlur, finalsUpload, isBlurred, isFinalsCollection, libraryDb, libraryUpload, libraryUploadStored, versionUpload } from "./db";
import { hostsNone, hostsOriginals, hostsProxies, type LibraryUpload } from "../../contracts/library";
import type { Device } from "../../contracts/providers";
import { accountOf, librariesHere, libraryRole } from "./access";
import { workspaceOf } from "../lib/workspaces";
import { projectOf } from "../lib/project-of";
import { findUser, type SessionUser } from "../users";
import type { Blur } from "../../contracts/library";
import { serverKind } from "../work/server-work";

/**
 * original: the file itself; proxy: a smaller copy made of it; derivative: a picture or sheet the Library shows; serving:
 * bytes the server made; data: numbers made of the file, never a picture (a waveform); held: pictures kept only for one AI
 * call and deleted after it (a description's stills).
 */
export type ReceiveKind = "original" | "proxy" | "derivative" | "serving" | "data" | "held";
/**
 * person: someone chose to send it from a browser; computer: a computer sends a file it holds, nobody sent it by hand;
 * phone: the iPhone app sends the person's own file to their computers (`x-ct-origin: phone`, stored on the upload). A
 * phone's original is taken under none too and held until a computer has it (local-first PLAN-final decision 1).
 */
export type ReceiveOrigin = "person" | "computer" | "phone";

export const REFUSED_NONE = "Upload is off for this workspace. Add footage in the Mac app, or turn on Originals in Settings → Media Library.";
export const REFUSED_COMPUTER_OFF = "Upload is off for this workspace, so files can't be added from this computer.";
export const REFUSED_PROXIES = "This library takes proxies only. Your computer makes the proxy and sends that.";
export const REFUSED_NO_PROXY = "This library keeps no proxies on the server.";
export const REFUSED_PROOF = "These bytes are not the proxy your computer declared. Nothing was kept.";
export const REFUSED_BLUR = "Blur faces is on for this workspace: only blurred videos leave your computer.";
export const BLUR_UPLOADS = "With Blur faces on, Upload is Off or Blurred.";
export const REFUSED_NOT_BLURRED = "These bytes are the original, not its blurred video. Nothing was kept.";

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

/**
 * Where bytes go: a library, the collection they are sent into, or the version they belong to. `blurredOf`: a new file a
 * computer declares a blurred render of the original with that full SHA-256 (asset_versions.blurred_of).
 */
export type ReceiveInto = { id: string; collectionId?: string | null; versionId?: string; blurredOf?: string | null; blur?: Blur };

/** The setting a file sent into `library` follows: a final the Finals one, anything else the library's Upload. */
export const uploadFor = (library: ReceiveInto): LibraryUpload =>
  library.versionId
    ? versionUpload(library.versionId)
    : (library.blurredOf || library.blur === "no") && blursFaces(library.id)
      ? libraryUploadStored(library.id)
      : library.collectionId && isFinalsCollection(library.collectionId)
      ? finalsUpload(library.id)
      : libraryUpload(library.id);

/** Whether the library's owner gave its workspace to at least one member (Settings → Team): the library is shared (the migration and the list read it). */
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

export const refuse = (message: string): Extract<Received, { ok: false }> => ({ ok: false, status: 409, body: { error: message, code: "upload_refused", message } });
const HEX = /^[0-9a-f]{64}$/;
/** A proxy no smaller than its original is not kept, from every sender (UNIFIED-PRD §4.1 rule 4). */
export const proxyTooBig = (bytes: number, original: number | undefined): boolean => original !== undefined && bytes >= original;

/**
 * Blur faces, the one rule (contracts Blur): whether a file of `libraryId` may be stored on or served by this server. A
 * file marked no (kept as filmed) always; a file marked yes only as a blurred render and what is cut from it, by its
 * version (asset_versions.blurred_of), or a new file declared one (`blurredOf`, a computer's; `blurred`, an editor that
 * blurred its own render). A new file with no answer (`blur`) gets its library's Blur faces. A yes-file's original, its
 * proxy, and a thumbnail, strip or still cut from it never leave the owner's computers. Asked by every route that takes
 * or hands out a clip's bytes or pictures, the plug-ins' too (upload-gate.test.ts).
 */
export function mayLeave(
  libraryId: string | null | undefined,
  /** asFilmed: a new file with nothing left to blur and some of it as filmed (an AI Editor cut of blurred renders and files
   *  kept as filmed, editor/preview.ts editLeaves), computed on the server, never a client's word; blurred stays "every
   *  picture is a blurred render" (SPEC "Honest marks") */
  file: { versionId?: string; blurredOf?: string | null; blurred?: boolean; blur?: Blur; asFilmed?: boolean },
): Received {
  if (!libraryId) return { ok: true };
  if (file.versionId) {
    const f = fileBlur(file.versionId);
    if (!f) return blursFaces(libraryId) ? refuse(REFUSED_BLUR) : { ok: true };
    return f.blur === "no" || f.blurredVersionId === file.versionId ? { ok: true } : refuse(REFUSED_BLUR);
  }
  if (file.asFilmed || (file.blur ?? (blursFaces(libraryId) ? "yes" : "no")) === "no") return { ok: true };
  return file.blurred || (!!file.blurredOf && HEX.test(file.blurredOf)) ? { ok: true } : refuse(REFUSED_BLUR);
}

/**
 * A public path (a library share link, an AI card's bearer link): under Blur faces only a blurred render goes, never a
 * file kept as filmed (ruling 5: faces may show to the team, never in public; SPEC "Honest marks"). Elsewhere mayLeave.
 */
export function mayGoPublic(versionId: string): Received {
  const lib = (libraryDb().prepare("SELECT a.library_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?").get(versionId) as { library_id: string } | undefined)?.library_id;
  if (lib && blursFaces(lib) && !isBlurred(versionId)) return refuse(REFUSED_BLUR);
  return mayLeave(lib, { versionId });
}

/** Whether `username` may mark a file of `libraryId` no (kept as filmed): the library's owner or an admin, nobody else. */
export const mayKeepAsFilmed = (username: string, libraryId: string): boolean => findUser(username)?.role === "admin" || libraryRole(username, libraryId) === "owner";

/**
 * The blur answer a new file of `libraryId` is stored with (contracts Blur): `asked` false (kept as filmed) only where
 * mayKeepAsFilmed, ignored from anyone else; true is yes. Null when nobody chose: it reads the library's Blur faces
 * (db.ts BLUR_SQL), so that switch still decides for files nobody answered for.
 */
export function blurAtIntake(username: string, libraryId: string, asked: unknown): Blur | null {
  if (asked === false && mayKeepAsFilmed(username, libraryId)) return "no";
  return asked === true ? "yes" : null;
}

/**
 * The library of `owner`'s workspace `workspace` (none made) that mayLeave asks for a file filed by workspace (Review, a
 * plug-in's): one with Blur faces on when the workspace has any, so a second library never lets its files past the rule.
 */
export async function workspaceLibrary(owner: string, workspace?: string): Promise<string | null> {
  const libs = await librariesHere(owner, workspace).catch(() => []);
  return (libs.find((l) => blursFaces(l.id)) ?? libs[0])?.id ?? null;
}

export function mayReceive(
  kind: ReceiveKind,
  library: ReceiveInto,
  origin: ReceiveOrigin,
  opts: { sender?: Pick<Device, "work"> | null; proof?: ProxyProof } = {},
): Received {
  // This Mac: the server is the owner's computer, so nothing leaves it
  if (kind === "data" || kind === "held" || serverKind() === "local") return { ok: true };
  // a blurred render is a computer's own (the job that blurred it), never a person's or a phone's declaration
  const left = mayLeave(library.id, { ...(library.versionId ? { versionId: library.versionId } : {}), blurredOf: origin === "computer" ? library.blurredOf : null, ...(library.blur ? { blur: library.blur } : {}) });
  if (!left.ok) return left;
  if (kind === "derivative" || kind === "serving") return { ok: true };
  const upload = uploadFor(library);
  // under Blur faces what passed is a blurred render: it is the clip's proxy, kept under Blurred (stored "proxies"). A file
  // kept as filmed follows the stored Upload as any file does (uploadFor)
  if (blursFaces(library.id) && library.blur !== "no" && !(library.versionId && fileBlur(library.versionId)?.blur === "no")) return hostsNone(upload) ? refuse(origin === "computer" ? REFUSED_COMPUTER_OFF : REFUSED_NONE) : { ok: true };
  // a person's own file is refused under proxies too (UNIFIED-PRD §4.2): nothing drops it yet, so the server would keep it
  if (kind === "original") {
    // a person's own file (browser or phone) is theirs to send under proxies too: the server keeps its proxy (UNIFIED-PRD §4.2)
    if (hostsOriginals(upload) || origin === "phone" || (origin === "person" && upload === "proxies")) return { ok: true };
    return refuse(upload === "proxies" ? REFUSED_PROXIES : REFUSED_NONE);
  }
  // the iPhone app's 720p copy is the one proxy every library takes (held as its original is); any other needs Hosted proxies
  if (origin !== "phone" && !hostsProxies(upload)) {
    const off = !hostsOriginals(upload);
    return refuse(off ? (origin === "computer" ? REFUSED_COMPUTER_OFF : REFUSED_NONE) : REFUSED_NO_PROXY);
  }
  const p = opts.proof ?? {};
  if (p.sha256 !== undefined && !HEX.test(p.sha256)) return refuse(REFUSED_PROOF);
  if (p.got !== undefined && p.sha256 !== undefined && p.got !== p.sha256) return refuse(REFUSED_PROOF);
  if (p.bytes !== undefined && proxyTooBig(p.bytes, p.original)) return refuse(REFUSED_PROOF);
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
  // under Blur faces only a blurred render is handed out, on This Mac too (its owner sees the blurred one in the app)
  const left = mayLeave(version.id, { versionId: version.versionId });
  if (!left.ok) return left;
  if (serverKind() === "local") return { ok: true };
  const upload = uploadFor(version);
  if (blursFaces(version.id) && fileBlur(version.versionId)?.blur !== "no") return hostsNone(upload) ? refuse(REFUSED_NONE) : { ok: true };
  if (what === "original" ? hostsOriginals(upload) : hostsProxies(upload)) return { ok: true };
  // held until a computer has it (PLAN-final decision 1): the server hands it to a computer of the owner, and only until then
  // only the iPhone app's own file (asset_versions.origin): any other original under none is refused, held or not
  if (what === "original" && opts.toComputer && libraryDb().prepare("SELECT 1 FROM asset_versions WHERE id = ? AND origin = 'phone'").get(version.versionId) && !libraryDb().prepare("SELECT 1 FROM version_places WHERE version_id = ? AND kind = 'original' AND state = 'verified'").get(version.versionId)) {
    return { ok: true };
  }
  return refuse(hostsProxies(upload) ? REFUSED_PROXIES : REFUSED_NONE);
}
