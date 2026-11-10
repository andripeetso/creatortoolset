import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Storage, getStorage } from "@/components/settings/DevicesSection";
import { getProviders } from "@/lib/providers";
import { useAuth, useMe } from "@/lib/auth";
import { timeAgo } from "@/lib/exports";
import { cn } from "@/lib/utils";
import { THIS_COMPUTER, type FolderScanView, type ScannedFolder, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";

const STORAGE = "/api/devices/storage";
const DEFAULT_LIBRARY_DISK = "~/Movies";
/** The folders shown before "Show more": the list is capped, the rest is one click away. */
const SHOWN_FIRST = 6;

async function send(url: string, method: string, body?: unknown): Promise<void> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  // a folder that is already there is what the person wanted: not an error
  if (!r.ok && !/already/i.test(j.error ?? "")) throw new Error(j.error ?? `Request failed (${r.status})`);
}

/** A path as the person knows it: "~/Movies/Trip", not "/Users/name/Movies/Trip". */
const shown = (p: string, home: string) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** The folder list: what the scan found on this computer, in the Settings → Devices storage the app reads. */
/** `actions`: the dialog footer's slot, where this step's buttons go (the footer has no Continue on this step). */
export function FoldersStep({ onNext, actions }: { onNext: () => void; actions: HTMLElement | null }) {
  const hosted = useAuth((s) => s.hosted);
  const me = useMe();
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [scan, setScan] = useState<FolderScanView | null>(null); // null while the look is on
  const [scanFailed, setScanFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set()); // nothing is ticked until the person ticks it
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [customPath, setCustomPath] = useState("");
  const [customRole, setCustomRole] = useState<"footage" | "music">("footage");

  const reload = () => getStorage().then(setStorage).catch(() => setStorage(null));
  // hosted: the folders of the person's own computers; a failed read offers Try again (Continue stays either way)
  const [hostedError, setHostedError] = useState(false);
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

  // folders the person already uses are not listed again
  const added = new Set((storage?.folders ?? []).filter((f) => f.role !== "library" && f.origin.host === THIS_COMPUTER).map((f) => f.origin.path));
  const home = scan?.home ?? "";
  const offered: ScannedFolder[] = (scan?.folders ?? []).filter((f) => !added.has(f.path));
  const chosen = offered.filter((f) => picked.has(f.path));
  const listed = showAll ? offered : offered.slice(0, SHOWN_FIRST);

  const toggle = (path: string, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });

  const addAll = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const f of chosen) await send(`${STORAGE}/folders`, "POST", { role: f.kind, host: THIS_COMPUTER, path: f.path });
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the folders. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const addCustom = async () => {
    const p = customPath.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await send(`${STORAGE}/folders`, "POST", { role: customRole, host: THIS_COMPUTER, path: p });
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that folder. Check the path, then try again.");
    } finally {
      setBusy(false);
    }
  };

  if (hosted) {
    // a hosted server has no disks of its own: the folders are the ones on the person's own computers
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

  return (
    <div className="space-y-4">
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
      ) : offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No footage or music folders were found there. Type a folder path below.</p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span role="status">
              {chosen.length} of {offered.length} selected
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy || chosen.length === offered.length} onClick={() => setPicked(new Set(offered.map((f) => f.path)))}>
                Select all
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy || chosen.length === 0} onClick={() => setPicked(new Set())}>
                Select none
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {listed.map((f) => (
              <li key={f.path}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/40">
                  <Checkbox checked={picked.has(f.path)} onCheckedChange={(v) => toggle(f.path, v === true)} aria-label={f.name} disabled={busy} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{shown(f.path, home)}</span>
                    <span className="block text-xs text-muted-foreground">
                      Holds {f.files} {f.kind === "footage" ? "video and audio" : "audio"} {f.files === 1 ? "file" : "files"} · changed {timeAgo(f.lastChanged)}
                    </span>
                  </span>
                  <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-xs", f.kind === "footage" ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground")}>
                    {f.kind === "footage" ? "Footage" : "Music"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {offered.length > SHOWN_FIRST && (
            <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show ${offered.length - SHOWN_FIRST} more`}
            </Button>
          )}
          {scan.truncated && <p className="text-xs text-muted-foreground">The search stopped early, so some folders may be missing. Type a folder path below.</p>}
        </>
      )}

      {choosing ? (
        <div className="space-y-3 rounded-xl border border-border/60 p-4">
          <label className="block text-sm font-medium" htmlFor="ct-folder-path">
            Folder path
          </label>
          <input
            id="ct-folder-path"
            value={customPath}
            onChange={(e) => setCustomPath(e.target.value)}
            placeholder="~/Movies/My footage"
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-sm"
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">It holds</span>
            {(["footage", "music"] as const).map((r) => (
              <Button key={r} size="sm" variant={customRole === r ? "default" : "outline"} onClick={() => setCustomRole(r)}>
                {r === "footage" ? "Footage" : "Music"}
              </Button>
            ))}
            <Button size="sm" className="ml-auto" disabled={busy || !customPath.trim()} onClick={() => void addCustom()}>
              Add folder
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" onClick={() => setChoosing(true)}>
          <Plus className="size-3.5" />
          Type a folder path
        </Button>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {actions &&
        createPortal(
          <>
            <Button variant="ghost" disabled={busy} onClick={onNext}>
              Skip for now
            </Button>
            <Button disabled={busy || chosen.length === 0} onClick={() => void addAll()}>
              {chosen.length > 0 ? `Use these ${chosen.length} ${chosen.length === 1 ? "folder" : "folders"}` : "Use these folders"}
            </Button>
          </>,
          actions,
        )}
    </div>
  );
}
