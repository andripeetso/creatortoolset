import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/lib/auth";
import { getProviders, removeDevice, renameDevice } from "@/lib/providers";
import type { ProvidersView } from "@contracts/providers";
import { ConfirmButton } from "@/components/instagram/ConfirmButton";
import { Button } from "@/components/ui/button";
import { useMacRelease } from "@/components/MacAppDownload";
import { Dot, Group, Loading, Notice } from "./ui";
import { fmtAgo, msg, selectCls } from "./helpers";

type Device = ProvidersView["devices"][number];

/** Settings → Devices: this account's Macs (and the workspace's, for admins), rename, remove, and how to connect one. */
export function DevicesSection() {
  const me = useAuth((s) => s.me);
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const release = useMacRelease();

  const reload = () =>
    getProviders()
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(msg(e)));

  useEffect(() => {
    void reload();
  }, []);

  if (error && !view) return <Notice tone="error">Could not load devices: {error}</Notice>;
  if (!view || !me) return <Loading />;

  const mine = view.devices.filter((d) => d.owner === me.username);
  const workspace = me.role === "admin" ? view.devices.filter((d) => d.owner === "workspace") : [];

  return (
    <>
      {error && <Notice tone="error">{error}</Notice>}

      <Group title="Your Macs" hint="The Macs that run your AI. Rename one, or remove it to disconnect it.">
        {mine.length === 0 ? (
          <Notice>No Mac is connected to this account yet. Connect one below.</Notice>
        ) : (
          <DeviceList devices={mine} canManage onChanged={reload} />
        )}
      </Group>

      {workspace.length > 0 && (
        <Group title="Workspace" hint="The Macs the team's providers run on. Only admins see them.">
          <DeviceList devices={workspace} canManage onChanged={reload} />
        </Group>
      )}

      <Group title="Connect a Mac" hint="The Creator Toolset Mac app runs your AI on a Mac you sign in on.">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-foreground">
          <li>Install the Creator Toolset Mac app on the Mac.</li>
          <li>Sign in with this account.</li>
          <li>When it asks, allow it to run your AI on this Mac. It shows up here as online within a minute.</li>
        </ol>
        <div className="mt-3">
          {release ? (
            <Button asChild size="sm">
              <a href="/api/mac-app/download">Download the Mac app ({release.version})</a>
            </Button>
          ) : (
            <Notice>The download link for the Mac app comes later.</Notice>
          )}
        </div>
      </Group>
    </>
  );
}

function DeviceList({ devices, canManage, onChanged }: { devices: Device[]; canManage: boolean; onChanged: () => void }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {devices.map((d) => (
        <DeviceRow key={d.id} device={d} canManage={canManage} onChanged={onChanged} />
      ))}
    </ul>
  );
}

function DeviceRow({ device: d, canManage, onChanged }: { device: Device; canManage: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const installed = d.report?.drivers.filter((x) => x.installed) ?? [];

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await renameDevice(d.id, name.trim());
      setEditing(false);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setErr(null);
    try {
      await removeDevice(d.id);
      onChanged();
    } catch (x) {
      setErr(msg(x));
    }
  };

  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form onSubmit={rename} className="flex flex-wrap gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                aria-label="Mac name"
                className={`${selectCls} min-w-0 flex-1 py-1.5 text-sm`}
              />
              <Button type="submit" size="sm" disabled={busy || !name.trim()}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setName(d.name);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <Dot on={d.online} />
              <span>{d.name}</span>
              {canManage && (
                <button type="button" onClick={() => setEditing(true)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                  Rename
                </button>
              )}
            </div>
          )}
          <div className="mt-0.5 text-xs text-muted-foreground">
            Creator Toolset Mac app · {d.online ? "online" : `last seen ${fmtAgo(d.lastSeen)}`}
            {d.version ? ` · app v${d.version}` : ""}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {d.report
              ? installed.length
                ? `Coding tools: ${installed.map((x) => `${x.driver}${x.version ? ` ${x.version}` : ""}`).join(", ")}`
                : "No coding tools found on it."
              : "Has not reported its coding tools yet."}
            {d.report ? ` · reported ${fmtAgo(d.report.at)}` : ""}
          </div>
          {err && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
        </div>
        {canManage && (
          <ConfirmButton
            label="Remove"
            confirmLabel="Click again to remove"
            title="Disconnect this Mac. Its providers stop answering."
            onConfirm={remove}
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-300"
            armedClassName="border-red-500/60 text-red-600 dark:text-red-300"
          />
        )}
      </div>
    </li>
  );
}
