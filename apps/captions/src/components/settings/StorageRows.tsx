import { useEffect, useRef, useState } from "react";
import { EVERY_WORKSPACE, LEAVE_OUT_MAX, THIS_COMPUTER, connectFor, exportsOf, folderIn, underFolder, type AddFolderBody, type Disk, type MoveFolderBody, type StorageFolder, type StorageState, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PROJECT_COLORS, projectColor, useWorkspace } from "@/lib/workspace";
import { chooseFolderOnMac, macImports, pairThisMac, thisMacBridge, thisMacState, type ThisMacState } from "@/lib/thisMac";
import { askMediaFolder, folderGrant, foldersChanged, macReadFolders } from "@/lib/local-files";
import { thisMacDevice } from "@/lib/providers";
import { timeAgo } from "@/lib/exports";
import { WORDS, diskAway, onComputer, uncheckedOn } from "@/lib/wording";
import { Card, FormDialog, Section, ListRow, Row, RowMenu, SettingsDialog, SettingsDialogContent, SettingsSelect, Status, WorkspaceTag, WorkspacesDialog, inWorkspace, saveFailed, type SettingsWorkspace } from "./ui";
import { msg } from "./helpers";
import { WorkspaceBadge } from "@/components/assistant/Workspaces";
import { cn } from "@/lib/utils";

/** The computers an account owns (the list the Storage rows pick from). */
export type Computer = ProvidersView["devices"][number];

/** One JSON call to a storage route: the server's own sentence on a failure. `workspace`: the one the call works in, when it is not the window's. */
export async function call<T>(url: string, method = "GET", body?: unknown, workspace?: string | null): Promise<T> {
  const r = await fetch(url, inWorkspace(workspace, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}
export const STORAGE_API = "/api/devices/storage";
/** Every workspace's folders (Settings → Folders on All workspaces). */
export const STORAGE_ALL = `${STORAGE_API}?all=1`;
export const getStorage = () => call<StorageView>(STORAGE_API);
// a new folder goes to the workspace the call works in; one is moved or removed by its id, whatever workspace it is in
const addStorageFolder = (b: AddFolderBody, workspace?: string | null) => call<StorageState>(`${STORAGE_API}/folders`, "POST", b, workspace);
const moveStorageFolder = (id: string, workspaces: string[] | null) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}`, "PATCH", { workspaces } satisfies MoveFolderBody);
export const leaveOutOfFolder = (id: string, leaveOut: string[]) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}/leave-out`, "PUT", { leaveOut });
export const removeStorageFolder = (id: string) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}`, "DELETE");
const repointStorageFolder = (id: string, path: string) => call<StorageState>(`${STORAGE_API}/folders/${encodeURIComponent(id)}/re-point`, "POST", { path });

/** The drives a computer reported (its system disk, external drives, network shares). Empty until it reports one. */
export const disksOf = (d: Computer): Disk[] => d.report?.machine?.disks ?? [];
/** The drives a folder on `host` can be on: that computer's, or the server's own when it reports none (a local install). */
export const disksFor = (devices: Computer[], host: string, serverDisks: Disk[] = []): Disk[] => {
  const d = devices.find((x) => x.id === host);
  return d && disksOf(d).length ? disksOf(d) : serverDisks;
};
/** The computer a folder is on, as its row names it. A folder whose computer is none of the account's is listed and says so. */
const UNKNOWN_COMPUTER = "Computer not found";
const nameOf = (devices: Computer[], f: StorageFolder) =>
  f.origin.host === THIS_COMPUTER ? "This computer" : f.missing ? UNKNOWN_COMPUTER : (devices.find((d) => d.id === f.origin.host)?.name ?? UNKNOWN_COMPUTER);

/** A folder as the row shows it: the computer it is on, then its full path (the Library's own Footage too). */
/** Where a folder is: a network share by its server and path there (any computer that connects it reads the same
 *  folder; the rows under it say which do), else the computer that added it and its path. */
export const whereOf = (f: StorageFolder, devices: Computer[]) =>
  f.mount ? `${f.mount.server} · ${[f.mount.share.replace(/^\/+/, ""), f.mount.sub].filter(Boolean).join("/")}` : `${nameOf(devices, f)} · ${f.origin.path}`;

/** Show in Finder for a folder on this very Mac, in a Mac app that shows Settings → Folders folders (its mark). */
export const canRevealFolder = (f?: StorageFolder): f is StorageFolder =>
  !!f && !!thisMacBridge() && !!thisMacDevice() && f.origin.host === thisMacDevice() && typeof document !== "undefined" && document.documentElement.dataset.macFolderReveal === "1";

/** The Mac app shows the folder only when the window's server lists it as one of this Mac's (Reveal.swift). */
export async function revealFolder(f: StorageFolder): Promise<void> {
  const r = (await thisMacBridge()!.postMessage(`reveal:${JSON.stringify({ folder: f.origin.path })}`)) as unknown as { ok?: boolean; problem?: string };
  if (!r?.ok) throw new Error(r?.problem ?? "Folder not found on this Mac");
}

const size = (gb: number) => (gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`);
/** Almost full: under 20 GB free, or under a tenth of the disk. */
export const isFull = (d: { freeGb: number; totalGb?: number }) => d.freeGb < 20 || (d.totalGb !== undefined && d.freeGb / d.totalGb < 0.1);
/** "29 GB free of 460 GB", and an amber "almost full" after it on the drive that is (`mark` false: the row says so itself). */
export const spaceOf = (d: { freeGb: number; totalGb?: number }, mark = true) => (
  <>
    {size(d.freeGb)} free{d.totalGb !== undefined && ` of ${size(d.totalGb)}`}
    {mark && isFull(d) && <span className="text-amber-600 dark:text-amber-400"> · almost full</span>}
  </>
);

/** A drive as the Drive select names it: "BABY ACROBATICS · nas-name · 2.8 TB free" (a network share says whose it is). */
export const driveLabel = (d: Disk) => `${d.name}${d.network ? ` · ${d.server && d.server !== d.name ? d.server : "Network"}` : ""} · ${size(d.freeGb)} free`;
/** Where a folder field starts once a drive is picked: the home folder on the system disk, else the drive's own folder. */
export const driveStart = (d: Disk) => (d.path === "/" ? "~" : d.path.replace(/\/+$/, ""));
/** The drive a typed path is on: the longest drive folder that holds it; "~" and any other full path are the system disk. */
export function driveOf(disks: readonly Disk[], typed: string): Disk | undefined {
  const p = typed.trim();
  if (!p) return undefined;
  const under = (d: Disk) => d.path !== "/" && (p === d.path.replace(/\/+$/, "") || p.startsWith(`${d.path.replace(/\/+$/, "")}/`));
  const holding = disks.filter(under).sort((a, b) => b.path.length - a.path.length)[0];
  return holding ?? (p.startsWith("/") || p.startsWith("~") ? disks.find((d) => d.path === "/") : undefined);
}

const NO_DRIVE = "no-drive";
const CONNECT = "connect-network-storage";

/**
 * What a person types for a network share, as the address Finder connects to: "nas.local/Footage", "\\nas\Footage" and
 * "smb://nas.local/My Footage" all become smb://…, with spaces written the way an address needs. Only smb and afp are
 * taken (the address becomes a link, so nothing else may get through); null for anything that is not a share.
 */
export function shareAddress(typed: string): string | null {
  const t = typed.trim().replace(/\\/g, "/");
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(t);
  const scheme = m ? m[1].toLowerCase() : "smb";
  const rest = (m ? m[2] : t).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!["smb", "afp"].includes(scheme) || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?(\/.+)?$/i.test(rest)) return null;
  let plain = rest;
  try {
    plain = decodeURI(rest);
  } catch {
    /* a stray % in a share's name: taken as typed */
  }
  return `${scheme}://${encodeURI(plain)}`;
}

/** A link like smb:// only opens Finder on a Mac: the page offers Connect there and nowhere else. */
const onMac = () => typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

/**
 * The drives of the chosen computer (its system disk, external drives, network shares), above a folder field: picking one
 * starts the path there, and a typed path shows the drive it is on. Nothing is shown for a computer that reported none.
 * On a Mac the list ends with "Connect network storage…": an address, and Connect hands it to Finder on this Mac, which
 * asks for the share's name and password itself. While that form is open the drives are read again every few seconds
 * (`onLook`), and a share that appears is picked.
 */
export function DriveSelect({ disks, path, onPick, onLook }: { disks: readonly Disk[]; path: string; onPick: (start: string) => void; onLook?: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState("");
  const known = useRef<string[] | null>(null);
  useEffect(() => {
    if (!connecting || !onLook) return;
    const t = window.setInterval(onLook, 5000);
    return () => window.clearInterval(t);
  }, [connecting, onLook]);
  // the share Finder just connected: the first network drive that was not in the list when the form opened
  useEffect(() => {
    if (!connecting) {
      known.current = null;
      return;
    }
    if (!known.current) known.current = disks.map((d) => d.path);
    const fresh = disks.find((d) => d.network && !known.current!.includes(d.path));
    if (!fresh) return;
    onPick(driveStart(fresh));
    setConnecting(false);
    setAddress("");
  }, [connecting, disks, onPick]);
  if (disks.length === 0) return null;
  const on = driveOf(disks, path);
  const href = shareAddress(address);
  return (
    <>
      <SettingsSelect
        label="Drive"
        value={connecting ? CONNECT : (on?.path ?? NO_DRIVE)}
        onValueChange={(v) => {
          setConnecting(v === CONNECT);
          const d = disks.find((x) => x.path === v);
          if (d) onPick(driveStart(d));
        }}
        options={[
          ...(on || connecting ? [] : [{ value: NO_DRIVE, label: "Choose a drive" }]),
          ...disks.map((d) => ({ value: d.path, label: driveLabel(d) })),
          ...(onMac() ? [{ value: CONNECT, label: "Connect network storage…" }] : []),
        ]}
        className="sm:w-full"
      />
      {connecting && (
        <>
          <div className="flex items-center gap-2">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="smb://nas.local/Footage" aria-label="Network storage address" autoFocus />
            {href ? (
              <Button asChild type="button" size="sm" variant="outline">
                <a href={href}>Connect</a>
              </Button>
            ) : (
              <Button type="button" size="sm" variant="outline" disabled>
                Connect
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Finder asks for its name and password.</p>
        </>
      )}
    </>
  );
}

/** The workspaces a folder is in, as its tag and its Workspaces name them: null for one every workspace uses. */
/** A Remove confirm: a folder in two or more workspaces names them all, since it goes from each (a card shows one). */
export const removeBody = (f: StorageFolder, w?: SettingsWorkspace): string => {
  const names = (workspacesOf(f) ?? []).map((id) => w?.workspaces.find((p) => p.id === id)?.name).filter((n): n is string => !!n);
  return names.length > 1 ? `Removes it from ${names.join(", ")}; its files are not deleted.` : "The folder's files are not deleted.";
};

const workspacesOf = (f: StorageFolder) => (f.workspace === EVERY_WORKSPACE ? null : (f.workspaces ?? (f.workspace ? [f.workspace] : [])));

/**
 * Where the files are: Exports (finished videos, one folder per workspace), Projects (AI Editor working files, one per
 * workspace) and Media (any number). Each is a header row with Add folder and its folders indented under it with their menu.
 * Used by Settings → Folders and the setup's Folders step. `w`: the workspace Settings shows (workspace-pick.tsx).
 */
/** Media first, then Projects, then Exports (owner, 2026-11-23): the order work goes through. */
const ORDER = ["footage", "projects", "library"] as const;

/** A folder for every workspace, or one from before workspaces kept their own. */
const everyWorkspace = (f: StorageFolder) => f.workspace === EVERY_WORKSPACE || (!f.workspace && !f.workspaces?.length);

/**
 * The page's folders. One workspace: its lists in one card, Exports and Projects only the folder it uses (its own before
 * the one for every workspace, exportsOf). All workspaces: a card per workspace, then the folders for every workspace.
 * Allowed folders last: everything this Mac reads besides them.
 */
export function Storage({ devices, storage, onChanged, w }: { devices: Computer[]; storage: StorageView | null; onChanged: () => void; w?: SettingsWorkspace }) {
  if (!storage) return null;
  const shared = { devices, serverDisks: storage.serverDisks, onChanged, w };
  const allowed = <AllowedFolders rows={storage.folders.filter((f) => f.origin.host === thisMacDevice()).map((f) => f.origin.path)} />;
  if (!w?.all || !w.many) {
    return (
      <Card>
        {ORDER.map((role) => (
          <FolderList key={role} role={role} storage={storage} inUse searchable {...shared} />
        ))}
        {allowed}
      </Card>
    );
  }
  const groups = [
    ...w.workspaces.map((p) => ({ id: p.id as string | null, name: p.name, ws: p as { id: string; name: string; color?: string } | undefined, folders: storage.folders.filter((f) => !everyWorkspace(f) && folderIn(f, (own) => own === p.id)) })),
    { id: null, name: "Every workspace", ws: undefined, folders: storage.folders.filter(everyWorkspace) },
    // a folder of a workspace not in the list (another person's, one removed): still listed, never hidden
    { id: null, name: "Other workspaces", ws: undefined, folders: storage.folders.filter((f) => !everyWorkspace(f) && !w.workspaces.some((p) => folderIn(f, (own) => own === p.id))) },
  ].filter((g) => g.id !== null || g.folders.length > 0);
  return (
    <div className="space-y-6">
      {groups.map((g, i) => (
        <Section
          key={g.id ?? g.name}
          title={
            g.ws ? (
              // the workspace's coloured letters, as in the chat list: each card tells itself apart at a glance
              <span className="inline-flex items-center gap-2">
                <WorkspaceBadge ws={g.ws} className="h-5 min-w-6 text-[10px]" />
                {g.name}
              </span>
            ) : (
              g.name
            )
          }
        >
          {/* outlined in the workspace's colour, as its letters are: each card reads as that workspace at a glance */}
          <Card style={g.ws ? { borderColor: `rgb(${PROJECT_COLORS[projectColor(g.ws)].rgb} / 0.45)` } : undefined}>
            {ORDER.filter((role) => g.id !== null || g.folders.some((f) => f.role === role)).map((role) => (
              <FolderList key={role} role={role} storage={{ ...storage, folders: g.folders }} forWorkspace={g.id} searchable={i === 0} {...shared} />
            ))}
          </Card>
        </Section>
      ))}
      {/* empty outside the Mac app (AllowedFolders draws nothing there): no bare border */}
      <Card className="empty:hidden">{allowed}</Card>
    </div>
  );
}

type ReadList = { folders: string[]; reads: string[] };

/**
 * In the Mac app: the folders this Mac reads media from besides `rows` (this Mac's own rows above), from its open panel
 * (Allow folder), a drop or a pick (apps/mac MediaFiles.readList). Files in an allowed one are added where they are; a
 * drop's or a pick's are copied on import (Import.tsx readFoldersHere), and Allow makes one allowed. Remove takes the
 * folder off this Mac's list. The page never grants a folder itself: Add folder and Allow open the Mac's own panel.
 */
export function AllowedFolders({ rows }: { rows: string[] }) {
  const [list, setList] = useState<ReadList | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void macReadFolders().then((l) => live && setList(l));
    return () => void (live = false);
  }, []);
  if (!list) return null;
  // the panel's answer comes back after a wait: the button is off meanwhile, and the list read again after it
  const ask = (start: string) => async () => {
    setBusy(true);
    try {
      await askMediaFolder(start);
      setList((await macReadFolders()) ?? list);
    } finally {
      setBusy(false);
    }
  };
  return <AllowedRows list={list} rows={rows} busy={busy} onAsk={ask} onRemove={async (f) => setList((await macReadFolders(f)) ?? list)} />;
}

/** The rows of AllowedFolders, drawn from its list (the tests draw them alone). */
export function AllowedRows({ list, rows, busy, onAsk, onRemove }: {
  list: ReadList; rows: string[]; busy: boolean; onAsk: (start: string) => () => Promise<void>; onRemove: (folder: string) => Promise<void>;
}) {
  const shown = list.folders.filter((f) => !rows.some((r) => underFolder(f, r)));
  return (
    <>
      <Row
        title="Allowed folders"
        description="Folders this Mac reads media from; files in them are added where they are."
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={onAsk("/Volumes")}>
            Add folder
          </Button>
        }
      />
      {shown.map((f) => {
        const name = f.split("/").filter(Boolean).pop() ?? f;
        const allowed = list.reads.includes(f);
        return (
          <ListRow
            key={f}
            className="pl-8 sm:pl-10"
            title={name}
            subtitle={f}
            status={
              allowed ? undefined : (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Status tone="attention">Copied on import</Status>
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={onAsk(f)}>
                    Allow
                  </Button>
                </span>
              )
            }
            actions={
              <RowMenu
                label={`Actions for ${name}`}
                items={[{ label: "Remove", destructive: true, confirm: { title: `Remove ${name}?`, body: "The folder's files are not deleted.", ok: "Remove" }, onSelect: () => onRemove(f) }]}
              />
            }
          />
        );
      })}
    </>
  );
}

/** The three lists of folders: Exports (where finished edits are saved), Projects (the AI Editor's working files), Media (what the Media Library takes in). */
const LISTS = {
  library: { id: "finished-videos", title: "Exports", description: "Where finished edits are saved: the folder you pick, one per workspace." },
  projects: { id: "projects-folder", title: "Projects", description: "Working files for the AI Editor, one folder per workspace. Never read as footage." },
  footage: { id: "footage-folder", title: "Media", description: "Footage, music and sound effects. The Media Library takes in everything in these folders." },
} as const;

/**
 * One list of folders under a row with Add folder, each folder indented under it with its menu: Exports, or the folders
 * the Media Library takes in (footage, music, sound effects: the Library sorts them; a music folder from before is one of
 * them, api/lib/storage.ts mediaFolders). Only folders someone added are listed.
 */
function FolderList({ role, storage, devices, serverDisks, w, onChanged, forWorkspace, inUse, searchable }: {
  role: keyof typeof LISTS; storage: StorageView; devices: Computer[]; serverDisks: Disk[]; w?: SettingsWorkspace; onChanged: () => void;
  /** in the All workspaces view: the workspace this card is (null: the folders for every workspace, added from a workspace's own) */
  forWorkspace?: string | null;
  /** one workspace shown: Exports and Projects list only the folder it uses */
  inUse?: boolean;
  /** the row search lands on (once per page) */
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const all = storage.folders.filter((f) => f.role === role);
  // Exports only: Projects is one folder per computer, so every row of it is in use
  const used = inUse && role === "library" ? exportsOf(all) : undefined;
  const mine = used ? [used] : all;
  return (
    <>
      <Row
        id={searchable ? LISTS[role].id : undefined}
        title={LISTS[role].title}
        // said once on the page: in All workspaces only the first card carries it
        description={searchable ? LISTS[role].description : undefined}
        control={
          forWorkspace !== null && (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              Add folder
            </Button>
          )
        }
      />
      {mine.map((f) => (
        <FolderRow key={f.id} folder={f} devices={devices} w={w} onChanged={onChanged} />
      ))}
      <AddFolderDialog open={open} onOpenChange={setOpen} role={role} devices={devices} serverDisks={serverDisks} here={storage.here} w={w} workspace={forWorkspace} onChanged={onChanged} />
    </>
  );
}

/**
 * One Media or Exports folder: its name, the computer it is on and its full path, its workspaces (always for Exports with
 * two or more workspaces: which one saves where), and its menu: Show in Finder (on this Mac), Workspaces (any of them, or
 * all), Remove.
 */
export function FolderRow({ folder: f, devices, w, onChanged, locked }: { folder: StorageFolder; devices: Computer[]; w?: SettingsWorkspace; onChanged: () => void; /** a default folder: only Show in Finder */ locked?: boolean }) {
  const exports = f.role === "library";
  const tagged = !!w?.all || (exports && !!w?.many);
  const [picking, setPicking] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // the buttons work on this Mac's own folders, in the Mac app's window, and only when pressed (no prompt opens by itself)
  const mine = !!thisMacDevice() && f.origin.host === thisMacDevice();
  const press = (run: () => Promise<unknown>) => async () => {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      onChanged();
    } catch (x) {
      setProblem(msg(x));
    } finally {
      setBusy(false);
    }
  };
  const allow = mine && f.folderState === "needs_ok" && (
    <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy} onClick={press(() => folderGrant(f.origin.path, f.id))}>
      {WORDS.allowOnThisMac}
    </Button>
  );
  const repoint = mine && f.folderState === "not_found" && macImports() && (
    <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={busy}
      onClick={press(async () => {
        const path = await chooseFolderOnMac();
        if (path) await repointStorageFolder(f.id, path);
      })}>
      Re-point
    </Button>
  );
  return (
    <>
    <ListRow
      className="pl-8 sm:pl-10"
      title={f.name}
      subtitle={<span title={f.origin.path}>{whereOf(f, devices)}</span>}
      status={
        <span className="flex flex-col gap-0.5">
          {tagged && <WorkspaceTag id={workspacesOf(f)} />}
          {f.error && <Status tone="broken">{f.error}</Status>}
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {/* a computer nobody knows has nothing to report: its subtitle says Computer not found, once */}
            {nameOf(devices, f) !== UNKNOWN_COMPUTER && <Status tone={!f.folderState ? undefined : f.folderState === "ok" ? "ok" : "attention"}>{folderLine(f, nameOf(devices, f), mine)}</Status>}
            {allow}
            {repoint}
          </span>
          {!!f.leaveOut?.length && <Status>{`Leaves out ${f.leaveOut.join(", ")}`}</Status>}
          {problem && <Status tone="broken">{problem}</Status>}
          <FolderReach folder={f} devices={devices} />
        </span>
      }
      actions={
        <RowMenu
          label={`Actions for ${f.name}`}
          items={[
            ...(w?.many && !locked ? [{ label: "Workspaces", onSelect: () => setPicking(true) }] : []),
            ...(f.role === "footage" && !locked ? [{ label: "Folders left out", onSelect: () => setLeaving(true) }] : []),
            ...(canRevealFolder(f) ? [{ label: "Show in Finder", onSelect: () => revealFolder(f) }] : []),
            ...(locked
              ? []
              : [
                  {
                    label: "Remove",
                    destructive: true,
                    confirm: { title: `Remove ${f.name}?`, body: removeBody(f, w), ok: "Remove" },
                    onSelect: () => removeStorageFolder(f.id).then(onChanged),
                  },
                ]),
          ]}
        />
      }
    />
    {leaving && <LeaveOutDialog folder={f} onClose={() => setLeaving(false)} onChanged={onChanged} />}
    {picking && w && (
      <WorkspacesDialog
        title={`Workspaces that use ${f.name}`}
        note={exports ? "Each workspace saves to one Exports folder. Switching a workspace on here takes it off the folder it saved to." : undefined}
        workspaces={w.workspaces}
        on={workspacesOf(f)}
        save={(to) => moveStorageFolder(f.id, to).then(onChanged, (e: Error) => (saveFailed(e.message), Promise.reject(e)))}
        onClose={() => setPicking(false)}
      />
    )}
    </>
  );
}

/** A Media folder's Folders left out: one folder name a line, left out wherever it sits inside the folder. */
function LeaveOutDialog({ folder: f, onClose, onChanged }: { folder: StorageFolder; onClose: () => void; onChanged: () => void }) {
  const [text, setText] = useState((f.leaveOut ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await leaveOutOfFolder(f.id, text.split("\n").map((n) => n.trim()).filter(Boolean));
      onChanged();
      onClose();
    } catch (x) {
      setError(msg(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Folders left out of ${f.name}`}
      description={`Files in folders with these names are not imported, at any depth inside ${f.name}, in any case. One name a line, at most ${LEAVE_OUT_MAX}. Clips already added from them go to the trash; taking a name off the list doesn't bring them back (Restore does). Nothing on disk is moved.`}
      submitLabel="Save"
      onSubmit={save}
      busy={busy}
      error={error}
    >
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} disabled={busy} aria-label="Folder names" />
    </FormDialog>
  );
}

/**
 * A folder's state on its computer, from that computer's last report (contracts/places.ts FolderState): "Last checked
 * 5 min ago", "Folder not found, re-point?", "Needs your OK", "<drive> isn't connected", or "Not checked yet" (on
 * another computer: "Not checked yet on <computer>"). `mine`: the folder is on this Mac (the window's own computer).
 */
export function folderLine(f: StorageFolder, computer: string, mine: boolean): string {
  switch (f.folderState) {
    case "ok":
      if (f.checkedAt) return `${WORDS.lastChecked} ${timeAgo(f.checkedAt)}`;
      break;
    case "not_found":
      return WORDS.folderNotFound;
    case "needs_ok":
      return WORDS.needsOk;
    case "disk_away":
      return diskAway(/^\/Volumes\/([^/]+)/.exec(f.origin.path)?.[1] ?? "The drive");
  }
  return mine ? WORDS.unchecked : uncheckedOn(computer);
}

/**
 * Which of the account's computers can read a folder: its own, and those that found it (a share they mounted). One that
 * hasn't gets Connect when the folder is on a share. Nothing with one computer.
 */
function FolderReach({ folder, devices }: { folder: StorageFolder; devices: Computer[] }) {
  const [connect, setConnect] = useState<Computer | null>(null);
  if (devices.length < 2) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1">
      {devices.map((d) => {
        const has = folder.origin.host === d.id || !!folder.reach[d.id];
        const os = d.report?.machine?.os;
        const how = !has && folder.mount && os ? connectFor(folder.mount, os) : null;
        return (
          <span key={d.id} className="inline-flex items-center gap-1.5">
            <Status tone={has ? "ok" : undefined}>{has ? onComputer(d.name) : uncheckedOn(d.name)}</Status>
            {how && (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConnect(d)}>
                Connect
              </Button>
            )}
          </span>
        );
      })}
      {connect && folder.mount && <ConnectDialog folder={folder} computer={connect} onClose={() => setConnect(null)} />}
    </span>
  );
}

/** How to connect a folder's share on one computer: the Finder link on a Mac, the one line to run on Linux or Windows.
 *  `onUsed`: Open or Copy was pressed (the Help screen checks the computer's drives again). */
export function ConnectDialog({ folder, computer, onClose, onUsed }: { folder: StorageFolder; computer: Computer; onClose: () => void; onUsed?: () => void }) {
  const how = connectFor(folder.mount!, computer.report?.machine?.os ?? "mac");
  const where = `${folder.mount!.server}/${folder.mount!.share}`;
  return (
    <SettingsDialog open onOpenChange={(o) => !o && onClose()}>
      <SettingsDialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Connect {folder.name} on {computer.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {how && "url" in how ? (
            <>
              <p>Open the shared drive {where} on {computer.name}.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">{how.url}</code>
                <Button size="sm" variant="outline" asChild>
                  <a href={how.url} onClick={onUsed}>Open</a>
                </Button>
              </div>
            </>
          ) : how ? (
            <>
              <p>Run this on {computer.name}.</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted/60 px-2 py-1.5 font-mono text-xs">{how.line}</code>
                <Button size="sm" variant="outline" onClick={() => (void navigator.clipboard?.writeText(how.line), onUsed?.())}>
                  Copy
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </SettingsDialogContent>
    </SettingsDialog>
  );
}

/** The Add folder dialog's "This Mac" before this Mac is on the server (pairThisMac on submit). */
const NEW_MAC = "this-mac:new";

/**
 * A folder the person already has, as a Media folder, on a drive of one of the account's computers. With two or more
 * workspaces the first field is the workspace it is for: the one Settings shows, else the window's.
 */
export function AddFolderDialog({ open, onOpenChange, role, devices, serverDisks, w, workspace: forWorkspace, onChanged, onAdded }: {
  open: boolean; onOpenChange: (o: boolean) => void; role: AddFolderBody["role"]; devices: Computer[]; serverDisks?: Disk[]; here?: string[]; w?: SettingsWorkspace;
  /** the workspace the folder is for, when the page names one (Library settings' own) */ workspace?: string | null;
  onChanged: () => void; /** only after a folder was added (onChanged also runs while a network share is looked at) */ onAdded?: () => void;
}) {
  // a folder added joins the Media Library at once (11-19: no dialog; its row says what indexing it takes, and the
  // library's monthly budget guards the cost). `here` (the server's own computers) is kept for callers, not read now
  const windowIn = useWorkspace((s) => s.currentProjectId);
  const [pickWorkspace, setPickWorkspace] = useState("");
  const [pickHost, setPickHost] = useState("");
  const [path, setPath] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // in the Mac app, on a server this Mac isn't on yet: "This Mac" is offered, and added to the server when the folder is
  const [mac, setMac] = useState<ThisMacState | null>(null);
  useEffect(() => {
    if (!open) return;
    setPickWorkspace("");
    setPath("");
    setTyping(false);
    setErr(null);
    void thisMacState().then(setMac);
  }, [open]);
  const unpaired = !!mac?.pairs && !mac.paired;
  const hosts = [...(unpaired ? [{ id: NEW_MAC, name: mac.computer ?? "This Mac" }] : []), ...devices];
  // the computer the person is at first, not whichever the server lists first (a helper or another Mac)
  const host = hosts.some((d) => d.id === pickHost) ? pickHost : (hosts.find((d) => d.id === thisMacDevice())?.id ?? hosts[0]?.id ?? "");
  const known = (id?: string | null) => (id && w?.workspaces.some((p) => p.id === id) ? id : null);
  const workspace = forWorkspace ?? known(pickWorkspace) ?? known(w?.id) ?? known(windowIn) ?? w?.workspaces[0]?.id ?? null;

  // a folder on this Mac is chosen in its own panel: no drive list, no path to type (owner, 2026-11-23)
  const here = macImports() && (host === NEW_MAC || host === thisMacDevice());

  const submit = async () => {
    const p = path.trim();
    if (!p) return setErr("Needs a folder");
    setBusy(true);
    setErr(null);
    const add = async () => {
      try {
        const on = host === NEW_MAC ? (await pairThisMac())?.device : host;
        if (!on) throw new Error("This Mac could not be added to this server");
        await addStorageFolder({ role, host: on, path: p }, workspace);
        foldersChanged();
        onOpenChange(false);
        onChanged();
        onAdded?.();
      } catch (x) {
        setErr(msg(x));
      }
    };
    try {
      await add();
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={role === "projects" ? "Projects folder" : role === "library" ? "Exports folder" : "Add folder"} submitLabel="Add folder" onSubmit={submit} busy={busy} submitDisabled={hosts.length === 0} error={err}>
      {hosts.length === 0 ? (
        <Status tone="attention">Needs a computer</Status>
      ) : (
        <>
          {w?.many && workspace && forWorkspace === undefined && w.all && (
            <SettingsSelect label="Workspace" value={workspace} onValueChange={setPickWorkspace} options={w.workspaces.map((p) => ({ value: p.id, label: p.name }))} className="sm:w-full" />
          )}
          {hosts.length > 1 && (
            <SettingsSelect label="Computer" value={host} onValueChange={setPickHost} options={hosts.map((d) => ({ value: d.id, label: d.name }))} className="sm:w-full" />
          )}
          {here && !typing ? (
            <div className="flex flex-col gap-2">
              <div className="flex min-w-0 items-center gap-3">
                <Button type="button" variant="outline" className="shrink-0" onClick={() => void chooseFolderOnMac().then((p) => p && setPath(p))}>
                  Choose folder
                </Button>
                <span className={cn("min-w-0 truncate text-sm", path ? "text-foreground" : "text-muted-foreground")} title={path || undefined}>
                  {path || "No folder"}
                </span>
              </div>
              <button type="button" className="self-start text-xs text-muted-foreground hover:text-foreground" onClick={() => setTyping(true)}>
                Type a path
              </button>
            </div>
          ) : (
            <>
              <DriveSelect disks={host === NEW_MAC ? [] : disksFor(devices, host, serverDisks)} path={path} onPick={setPath} onLook={onChanged} />
              <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder={role === "projects" ? "/Volumes/Drive/Projects" : role === "library" ? "/Volumes/Drive/Exports" : "/Volumes/Drive/Footage"} aria-label="Folder path" required />
            </>
          )}
        </>
      )}
    </FormDialog>
  );
}

/** The drives of the account's computers, and this server's own when it runs on an owner's computer. Admins only (Advanced). */
export function driveList(devices: Computer[], serverDisks: Disk[]): Array<{ key: string; disk: Disk; on: string }> {
  return [
    ...devices.flatMap((d) => disksOf(d).map((disk) => ({ key: `${d.id}:${disk.path}`, disk, on: d.name }))),
    ...serverDisks.map((disk) => ({ key: `server:${disk.path}`, disk, on: "this server" })),
  ];
}
