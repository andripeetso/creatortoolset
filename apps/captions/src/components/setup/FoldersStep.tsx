import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Storage, getStorage } from "@/components/settings/DevicesSection";
import { getProviders } from "@/lib/providers";
import { useAuth, useMe } from "@/lib/auth";
import { timeAgo } from "@/lib/exports";
import { LIBRARY_NAME, THIS_COMPUTER, type FolderScanView, type ScannedFolder, type SourceRole, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";

const STORAGE = "/api/devices/storage";
const DEFAULT_LIBRARY_DISK = "~/Movies";
/** The folders shown in a row before "Show more": the list is capped, the rest is one click away. */
const SHOWN_FIRST = 6;
const ROWS: { role: SourceRole; name: string; why: string }[] = [
  { role: "footage", name: "Footage", why: "Video you film. Read where it is; nothing is moved or uploaded." },
  { role: "music", name: "Music", why: "Music you own. Read where it is; nothing is moved or uploaded." },
];

async function send(url: string, method: string, body?: unknown): Promise<void> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  // a folder that is already there is what the person wanted: not an error
  if (!r.ok && !/already/i.test(j.error ?? "")) throw new Error(j.error ?? `Request failed (${r.status})`);
}

/** A path as the person knows it: "~/Movies/Trip", not "/Users/name/Movies/Trip". */
const shown = (p: string, home: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** Why a scanned folder is listed: what was found in it, and when it last changed. */
const reason = (f: ScannedFolder) =>
  `${f.files} ${f.kind === "footage" ? "video and audio" : "audio, no video"} ${f.files === 1 ? "file" : "files"} · changed ${timeAgo(f.lastChanged)}`;

/** The folder list: what the scan found on this computer, in the Settings → Devices storage the app reads.
 *  `actions`: the dialog footer's slot, where this step's buttons go (the footer has no Continue on this step). */
export function FoldersStep({ onNext, actions }: { onNext: () => void; actions: HTMLElement | null }) {
  const hosted = useAuth((s) => s.hosted);
  const me = useMe();
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [scan, setScan] = useState<FolderScanView | null>(null); // null while the look is on
  const [scanFailed, setScanFailed] = useState(false);
  const [expanded, setExpanded] = useState<Set<SourceRole>>(() => new Set());
  const [picked, setPicked] = useState<Set<string>>(() => new Set()); // nothing is ticked until the person ticks it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const [typing, setTyping] = useState<SourceRole | null>(null); // the row whose typed path is open
  const [customPath, setCustomPath] = useState("");
  // hosted: the folders of the person's own computers; a failed read offers Try again (Continue stays either way)
  const [hostedError, setHostedError] = useState(false);

  const reload = () => getStorage().then(setStorage).catch(() => setStorage(null));
  const loadHosted = () => {
    setHostedError(false);
    void getProviders().then(setProviders).catch(() => setHostedError(true));
    void reload();
  };

  const look = () => {
    setScanFailed(false);
    setScan(null);
    fetch("/api/setup/folders/scan")
      .then((r) => (r.ok ? (r.json() as Promise<FolderScanView>) : Promise.reject(new Error(`Scan failed (${r.status})`))))
      .then(setScan)
      .catch(() => setScanFailed(true));
  };

  useEffect(() => {
    if (hosted) {
      loadHosted();
      return;
    }
    void (async () => {
      await reload();
      // the Library is where finished videos go: a default in Movies, only when the person has none
      const st = await getStorage().catch(() => null);
      if (st && !st.folders.some((f) => f.role === "library")) {
        await send(`${STORAGE}/library`, "POST", { host: THIS_COMPUTER, disk: DEFAULT_LIBRARY_DISK }).catch(() => {});
        await reload();
      }
    })();
    look();
  }, [hosted]);

  const home = scan?.home ?? "";
  // folders the person already uses are not listed again
  const added = (storage?.folders ?? []).filter((f) => f.role !== "library" && f.origin.host === THIS_COMPUTER);
  const addedPaths = new Set(added.map((f) => f.origin.path));
  const offered: ScannedFolder[] = (scan?.folders ?? []).filter((f) => !addedPaths.has(f.path));
  const chosen = offered.filter((f) => picked.has(f.path));
  const library = storage?.folders.find((f) => f.role === "library");
  const libraryShown = shown(library?.origin.path ?? `${DEFAULT_LIBRARY_DISK}/${LIBRARY_NAME}`, home);

  const toggle = (path: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  // the server checks each folder (it must be a folder on this computer); a refusal stays on the step with its reason
  const addAll = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const f of chosen) await send(`${STORAGE}/folders`, "POST", { role: f.kind, host: THIS_COMPUTER, path: f.path });
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the folders. Try again.");
      await reload(); // the ones that were added are no longer listed
    } finally {
      setBusy(false);
    }
  };

  const addTyped = async (role: SourceRole) => {
    const p = customPath.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await send(`${STORAGE}/folders`, "POST", { role, host: THIS_COMPUTER, path: p });
      setCustomPath("");
      setTyping(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that folder. Check the path, then try again.");
    } finally {
      setBusy(false);
    }
  };

  if (hosted) {
    // a hosted server has no disks of its own: the folders are the ones on the person's own computers
    // ponytail: hosted keeps the Settings storage panel for now; its rows need the computer's device id, not the scan
    const own = providers && me ? providers.devices.filter((d) => d.owner === me.username) : [];
    return (
      <div className="space-y-4">
        {hostedError ? (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">Couldn't reach your computers.</p>
            <Button variant="outline" size="sm" onClick={loadHosted}>
              Try again
            </Button>
          </div>
        ) : !providers || !me ? (
          <p className="text-sm text-muted-foreground">Looking for your computers…</p>
        ) : (
          <Storage devices={own} storage={storage} onChanged={() => void reload()} />
        )}
        {actions && createPortal(<Button onClick={onNext}>Continue</Button>, actions)}
      </div>
    );
  }

  const row = (role: SourceRole, name: string, why: string) => {
    const all = offered.filter((f) => f.kind === role);
    const list = expanded.has(role) ? all : all.slice(0, SHOWN_FIRST);
    const mine = added.filter((f) => f.role === role);
    const open = typing === role;
    return (
      <section key={role} aria-labelledby={`ct-row-${role}`} className="space-y-2">
        <div>
          <h3 id={`ct-row-${role}`} className="text-sm font-medium">
            {name}
          </h3>
          <p className="text-xs text-muted-foreground">{why}</p>
        </div>

        {mine.length > 0 && (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {mine.map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{shown(f.origin.path, home)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">Added</span>
              </li>
            ))}
          </ul>
        )}

        {all.length === 0 && mine.length === 0 && <p className="text-sm text-muted-foreground">Nothing found here.</p>}

        {list.length > 0 && (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {list.map((f) => (
              <li key={f.path}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/40">
                  <Checkbox checked={picked.has(f.path)} onCheckedChange={(v) => toggle(f.path, v === true)} aria-label={f.name} disabled={busy} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{shown(f.path, home)}</span>
                    <span className="block text-xs text-muted-foreground">{reason(f)}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {all.length > SHOWN_FIRST && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setExpanded((cur) => {
                const next = new Set(cur);
                if (next.has(role)) next.delete(role);
                else next.add(role);
                return next;
              })
            }
          >
            {expanded.has(role) ? "Show fewer" : `Show ${all.length - SHOWN_FIRST} more`}
          </Button>
        )}

        {open ? (
          <div className="space-y-2 rounded-xl border border-border/60 p-3">
            <label className="block text-sm font-medium" htmlFor={`ct-folder-path-${role}`}>
              Folder path
            </label>
            <input
              id={`ct-folder-path-${role}`}
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="/Volumes/Drive/Footage"
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
            />
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setTyping(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || !customPath.trim()} onClick={() => void addTyped(role)}>
                Add folder
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setTyping(role); setCustomPath(""); setError(null); }}>
            <Plus className="size-3.5" />
            Type a folder path
          </Button>
        )}
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Finished videos are saved to <span className="font-mono text-foreground">{libraryShown}</span>.
      </p>

      {scan && (
        <p className="text-xs text-muted-foreground">
          Looked in {scan.looked.length ? scan.looked.map((p) => shown(p, home)).join(", ") : "no common folders"}. Not searched: Downloads, backup and network drives.
        </p>
      )}

      {scan && scan.blocked.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3 text-sm">
          <span className="min-w-0 flex-1">
            macOS did not let Creator Toolset look in {scan.blocked.map((p) => shown(p, home)).join(", ")}. Allow it in System Settings → Privacy &amp; Security, then try again.
          </span>
          <Button variant="outline" size="sm" onClick={look}>
            Try again
          </Button>
        </div>
      )}

      {scanFailed ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">Couldn't look in your folders.</span>
          <Button variant="outline" size="sm" onClick={look}>
            Try again
          </Button>
        </div>
      ) : !scan ? (
        <p className="text-sm text-muted-foreground">Looking for footage and music on this computer…</p>
      ) : (
        <>
          {ROWS.map((r) => row(r.role, r.name, r.why))}
          {scan.truncated && <p className="text-xs text-muted-foreground">Not every folder was searched.</p>}
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {actions &&
        createPortal(
          chosen.length > 0 ? (
            <>
              <Button variant="ghost" disabled={busy} onClick={onNext}>
                Skip for now
              </Button>
              <Button disabled={busy} onClick={() => void addAll()}>
                {`Use these ${chosen.length} ${chosen.length === 1 ? "folder" : "folders"}`}
              </Button>
            </>
          ) : added.length > 0 ? (
            <Button disabled={busy} onClick={onNext}>
              Continue
            </Button>
          ) : (
            <Button disabled={busy} onClick={onNext}>
              Skip for now
            </Button>
          ),
          actions,
        )}
    </div>
  );
}
