import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { HELPER_CHECK_KIND, TRANSCRIBE_KIND, type HelperCheck } from "@contracts/devices";
import { DEFAULT_WEIGHT, LOAD_PREFERENCES, type Balance } from "@contracts/providers";
import { connectFor, sourcesOf, STORAGE_ROLES, type StorageFolder, type StorageView } from "@contracts/storage";
import { Button } from "@/components/ui/button";
import { Card, Row, SettingsSelect, Status } from "@/components/settings/ui";
import { call, ConnectDialog, type Computer } from "@/components/settings/StorageRows";
import { tell } from "@/components/settings/ThisMacSection";
import { useAuth } from "@/lib/auth";
import { useCachedLoad } from "@/lib/local-cache";
import { useProviders } from "@/lib/providers";
import { openSetupAt } from "@/lib/setup";

/**
 * Setting up a computer to help with heavy work, on one screen: what it needs (each row quiet when fine, else what to
 * do), the account's Media folders with Connect for each it can't read yet (its drives are read again
 * straight after, and when the window comes back from the Finder), and a test that reads a file in each folder and
 * times an encode, then sets its Prefer / Normal / Less often / Off from the result. Used by setup's Help screen, Add
 * computer once the new one is on the list, and a computer's Set up in Settings → Computers. Its result is on every
 * computer of the account at once (Device.check, the devices topic).
 */

/** "A", "A and B", "A, B and C". */
export const andList = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** What the computer takes, in words: a Mac draws and renders; a computer that only lists speech models takes transcripts. */
export const workOf = (d: Pick<Computer, "kinds" | "report">): string =>
  d.report?.machine?.os !== "mac" && (d.kinds ?? []).every((k) => k === TRANSCRIBE_KIND || k === HELPER_CHECK_KIND) ? "transcripts" : "drafts and renders";

/** What a test that went well ends on, the work this computer is used for; null while it has not, or a folder failed. */
export function readyLine(d: Pick<Computer, "kinds" | "report">, check: HelperCheck | undefined): string | null {
  if (!check || !check.ffmpeg || !check.encode || check.folders.some((f) => !f.ok)) return null;
  const work = workOf(d);
  // transcripts come from the server, never from a folder
  const from = work === "transcripts" ? [] : [...new Set(check.folders.map((f) => f.name))];
  return `Used for ${work}${from.length ? ` from ${andList(from)}` : ""}.`;
}

/** The Media folders another computer of the account added (each once, however many workspaces list it). */
export function sharedFolders(storage: StorageView | null, device: string): StorageFolder[] {
  const seen = new Set<string>();
  return sourcesOf(storage?.folders ?? []).filter((f) => {
    const key = `${f.origin.host}|${f.origin.path}`;
    if (f.role === "library" || f.origin.host === device || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A folder this computer doesn't reach: its files stay on the computer that has them, and are worked on there. */
export const skippedLine = (origin: string) => `Stays on ${origin}`;

const STORAGE_ALL = "/api/devices/storage?all=1";
const ok = <Check className="size-4 text-emerald-500" aria-label="Fine" />;

export function HelperSetup({ device }: { device: string }) {
  const me = useAuth((s) => s.me);
  const { data: view, refresh: refreshDevices } = useProviders();
  const { data: storage, refresh: refreshStorage } = useCachedLoad<StorageView>(STORAGE_ALL, () => call<StorageView>(STORAGE_ALL), { topic: "devices", own: true });
  const [connect, setConnect] = useState<StorageFolder | null>(null);
  const [waiting, setWaiting] = useState(false); // a Connect was used: look again when the window comes back
  const [testing, setTesting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [weight, setWeight] = useState<number | null>(null);
  const admin = me?.role === "admin";
  const d = view?.devices.find((x) => x.id === device);

  const look = useCallback(async () => {
    await call(`/api/devices/${encodeURIComponent(device)}/check`, "POST", { test: false }).catch(() => {});
    void refreshStorage().catch(() => {});
    void refreshDevices().catch(() => {});
  }, [device, refreshStorage, refreshDevices]);
  useEffect(() => {
    if (!waiting) return;
    const back = () => void look();
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [waiting, look]);
  useEffect(() => {
    if (admin) void call<Balance>("/api/devices/balance").then((b) => setWeight(b.weights[device] ?? DEFAULT_WEIGHT), () => {});
  }, [admin, device]);

  if (!view || !d) return <p className="text-sm text-muted-foreground">Waiting for the computer…</p>;

  const os = d.report?.machine?.os;
  const check = d.check;
  const ready = readyLine(d, check);
  const updated = d.kinds?.includes(HELPER_CHECK_KIND);
  const names = new Map(view.devices.map((x) => [x.id, x.name]));
  const folders = sharedFolders(storage, device);
  const aiShown = os === "mac" || !!d.report?.drivers.length;
  const aiIn = d.report?.drivers.some((x) => x.signedIn);
  const failed = new Map((check?.folders ?? []).filter((f) => !f.ok).map((f) => [f.id, f.error ?? "Could not read it"]));

  const test = async () => {
    setTesting(true);
    setProblem(null);
    try {
      const r = await call<{ weight?: number }>(`/api/devices/${encodeURIComponent(device)}/check`, "POST", { test: true });
      if (r.weight !== undefined) setWeight(r.weight);
      void refreshDevices().catch(() => {});
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  const pickWeight = (v: string) => {
    setWeight(Number(v));
    void call("/api/devices/balance", "PUT", { on: true, weights: { [device]: Number(v) } }).catch((e: Error) => setProblem(e.message));
  };

  return (
    <div className="space-y-5">
      <Card>
        <Row
          title="Creator Toolset"
          status={!d.online ? <Status tone="attention">Offline: open Creator Toolset on {d.name}</Status> : !updated ? <Status tone="attention">Update Creator Toolset on {d.name}</Status> : undefined}
          control={d.online && updated ? ok : undefined}
        />
        <Row
          title="Video renders"
          status={check && !check.ffmpeg ? <Status tone="broken">{os === "linux" ? "Needs ffmpeg: sudo apt install ffmpeg" : "Needs ffmpeg"}</Status> : undefined}
          control={check?.ffmpeg ? ok : undefined}
        />
        {aiShown && (
          <Row
            title="AI"
            description={aiIn ? undefined : "Runs AI jobs too once Claude Code or Codex is signed in on it."}
            control={aiIn ? ok : device === document.documentElement.dataset.macDevice ? (
              <Button size="sm" variant="outline" onClick={() => openSetupAt("agents", true)}>Set up</Button>
            ) : undefined}
          />
        )}
      </Card>

      {folders.length > 0 && (
        <Card>
          {folders.map((f) => {
            const has = !!f.reach[device];
            const how = !has && f.mount && os ? connectFor(f.mount, os) : null;
            const role = STORAGE_ROLES.find((r) => r.value === f.role)?.label;
            const origin = names.get(f.origin.host) ?? "the computer that has it";
            // a folder on the other computer's own disk names that computer once: "Stays on …" or the server copy
            const where = f.mount ? `${role} · ${f.mount.share} on ${f.mount.server}` : `${role}`;
            return (
              <Row
                key={f.id}
                title={f.name}
                description={has || how ? where : `${where} · ${skippedLine(origin)}`}
                status={failed.has(f.id) ? <Status tone="broken">{failed.get(f.id)}</Status> : undefined}
                control={has ? ok : how ? <Button size="sm" variant="outline" onClick={() => setConnect(f)}>Connect</Button> : undefined}
              />
            );
          })}
        </Card>
      )}

      <Card>
        <Row
          title="Test run"
          description={ready ?? "Reads a file in each folder and times a short video render."}
          status={problem ? <Status tone="broken">{problem}</Status> : check?.ffmpeg && !check.encode ? <Status tone="broken">Video render failed on {d.name}</Status> : undefined}
          control={
            <Button size="sm" variant="outline" className="min-w-20" disabled={testing || !d.online || !updated} onClick={() => void test()}>
              {testing ? "Testing…" : "Test"}
            </Button>
          }
        />
        {check && admin && weight !== null && (
          <Row
            title="Heavy work share"
            control={<SettingsSelect label="Heavy work share" value={String(weight)} onValueChange={pickWeight} options={LOAD_PREFERENCES.map((p) => ({ value: String(p.value), label: p.label }))} />}
          />
        )}
      </Card>

      {connect && connect.mount && (
        <ConnectDialog
          folder={connect}
          computer={d}
          onClose={() => setConnect(null)}
          onUsed={() => {
            setWaiting(true);
            void look();
          }}
        />
      )}
    </div>
  );
}

/** The Mac app's own Mac before it helps: the one switch that adds it (Settings → Computers, Take work from this server). */
export function HelperPair() {
  return (
    <Card>
      <Row
        title="Take work from this server"
        control={<Button size="sm" onClick={() => tell("ai:on")}>Turn on</Button>}
      />
    </Card>
  );
}
