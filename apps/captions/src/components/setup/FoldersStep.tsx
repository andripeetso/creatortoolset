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
import { LIBRARY_NAME, THIS_COMPUTER, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";
import type { ScannedFolder } from "@contracts/storage";

const STORAGE = "/api/devices/storage";
const DEFAULT_LIBRARY_DISK = "~/Movies";
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

async function send(url: string, method: string, body?: unknown): Promise<void> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  // a folder that is already there is what the person wanted: not an error
  if (!r.ok && !/already/i.test(j.error ?? "")) throw new Error(j.error ?? `Request failed (${r.status})`);
}

/** The folder list: what the scan found on this computer, in the Settings → Devices storage the app reads. */
/** `actions`: the dialog footer's slot, where this step's buttons go (the footer has no Continue on this step). */
export function FoldersStep({ onNext, actions }: { onNext: () => void; actions: HTMLElement | null }) {
  const hosted = useAuth((s) => s.hosted);
  const me = useMe();
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [found, setFound] = useState<ScannedFolder[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
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
    fetch("/api/setup/folders/scan")
      .then((r) => (r.ok ? (r.json() as Promise<{ folders: ScannedFolder[]; truncated: boolean }>) : null))
      .then((v) => {
        setFound(v?.folders ?? []);
        setTruncated(!!v?.truncated);
      })
      .catch(() => setFound([]));
  }, [hosted]);

  // folders the person already uses are not listed again
  const added = new Set((storage?.folders ?? []).filter((f) => f.role !== "library" && f.origin.host === THIS_COMPUTER).map((f) => f.origin.path));
  const offered = (found ?? []).filter((f) => !added.has(f.path));
  // the ones changed in the last 30 days start picked
  const selected = picked ?? new Set(offered.filter((f) => f.lastChanged >= Date.now() - RECENT_MS).map((f) => f.path));
  const chosen = offered.filter((f) => selected.has(f.path));
  const setSelected = (next: Set<string>) => setPicked(next);
  const toggle = (path: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(path);
    else next.delete(path);
    setSelected(next);
  };
  const library = storage?.folders.find((f) => f.role === "library");
  const libraryShown = library ? `${library.origin.path}` : `${DEFAULT_LIBRARY_DISK}/${LIBRARY_NAME}`;

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
      setCustomPath("");
      setChoosing(false);
      await reload();
      setFound(found?.filter((f) => f.path !== p) ?? null);
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
      <p className="text-xs text-muted-foreground">
        Finished videos are saved to <span className="font-mono text-foreground">{libraryShown}</span>.
      </p>

      {found === null ? (
        <p className="text-sm text-muted-foreground">Looking for footage and music on this computer…</p>
      ) : offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folders with video or music were found in Movies, Desktop, Documents, Downloads, Pictures or Music. Choose a folder below.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span role="status">
              {chosen.length} of {offered.length} selected
            </span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy || chosen.length === offered.length} onClick={() => setSelected(new Set(offered.map((f) => f.path)))}>
                Select all
              </Button>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={busy || chosen.length === 0} onClick={() => setSelected(new Set())}>
                Select none
              </Button>
            </div>
          </div>
          <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
            {offered.map((f) => (
              <li key={f.path}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-muted/40">
                  <Checkbox checked={selected.has(f.path)} onCheckedChange={(v) => toggle(f.path, v === true)} aria-label={f.name} disabled={busy} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{f.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{f.path}</span>
                    <span className="block text-xs text-muted-foreground">
                      {f.files} {f.files === 1 ? "file" : "files"} · changed {timeAgo(f.lastChanged)}
                    </span>
                  </span>
                  <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-xs", f.kind === "footage" ? "bg-muted text-foreground" : "bg-muted/60 text-muted-foreground")}>
                    {f.kind === "footage" ? "Footage" : "Music"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {truncated && <p className="text-xs text-muted-foreground">The search stopped early, so some folders may be missing. Choose a folder below.</p>}
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
            placeholder="/Volumes/Drive/Footage"
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
          Choose another folder
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
              Do not add folders
            </Button>
            <Button disabled={busy || chosen.length === 0} onClick={() => void addAll()}>
              {chosen.length > 0 ? `Add ${chosen.length} ${chosen.length === 1 ? "folder" : "folders"}` : "Add folders"}
            </Button>
          </>,
          actions,
        )}
    </div>
  );
}
