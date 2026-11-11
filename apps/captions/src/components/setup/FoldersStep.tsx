import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Storage, getStorage } from "@/components/settings/DevicesSection";
import { useBigFolder } from "@/components/LibraryProcessing";
import { getProviders } from "@/lib/providers";
import { useAuth, useMe } from "@/lib/auth";
import { LIBRARY_NAME, THIS_COMPUTER, type SourceRole, type StorageView } from "@contracts/storage";
import type { ProvidersView } from "@contracts/providers";

const STORAGE = "/api/devices/storage";
const DEFAULT_LIBRARY_DISK = "~/Movies";
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

/** The folder list: the folders the person added on this computer, in the Settings → Devices storage the app reads. The
 *  folders are never searched for: the person types a path (the Media Library and the AI Editor ask for one with a picker).
 *  `actions`: the dialog footer's slot, where this step's buttons go (the footer has no Continue on this step). */
export function FoldersStep({ onNext, actions }: { onNext: () => void; actions: HTMLElement | null }) {
  const hosted = useAuth((s) => s.hosted);
  const me = useMe();
  const [storage, setStorage] = useState<StorageView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProvidersView | null>(null);
  const [typing, setTyping] = useState<SourceRole | null>(null); // the row whose typed path is open
  const [customPath, setCustomPath] = useState("");
  // hosted: the folders of the person's own computers; a failed read offers Try again (Continue stays either way)
  const [hostedError, setHostedError] = useState(false);
  // a big folder says first what taking it into the Media Library costs in time and usage
  const big = useBigFolder();

  const reload = () => getStorage().then(setStorage).catch(() => setStorage(null));
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
  }, [hosted]);

  // the folders the person already uses on this computer
  const added = (storage?.folders ?? []).filter((f) => f.role !== "library" && f.origin.host === THIS_COMPUTER);
  const library = storage?.folders.find((f) => f.role === "library");
  const libraryShown = library?.origin.path ?? `${DEFAULT_LIBRARY_DISK}/${LIBRARY_NAME}`;

  // the server checks the folder (it must be a folder on this computer); a refusal stays on the step with its reason
  const add = async (role: SourceRole, p: string) => {
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
  const addTyped = async (role: SourceRole) => {
    const p = customPath.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    try {
      await big.check(p, () => add(role, p), { music: role === "music" });
    } finally {
      setBusy(false);
    }
  };

  if (hosted) {
    // a hosted server has no disks of its own: the folders are the ones on the person's own computers
    // ponytail: hosted keeps the Settings storage panel for now; its rows need the computer's device id
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
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.origin.path}</span>
                <span className="shrink-0 text-xs text-muted-foreground">Added</span>
              </li>
            ))}
          </ul>
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

      {ROWS.map((r) => row(r.role, r.name, r.why))}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {big.dialog}

      {actions &&
        createPortal(
          added.length > 0 ? (
            <Button disabled={busy} onClick={onNext}>
              Continue
            </Button>
          ) : (
            <Button variant="ghost" disabled={busy} onClick={onNext}>
              Skip for now
            </Button>
          ),
          actions,
        )}
    </div>
  );
}
