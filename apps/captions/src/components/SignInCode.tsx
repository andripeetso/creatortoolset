import { useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { ToolsetLogo } from "@/components/HomeLink";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useCachedLoad } from "@/lib/local-cache";
import type { Me } from "@/lib/auth";
import { FormDialog, Row } from "@/components/settings/ui";

/**
 * The sign-in code (api/auth.ts, /api/auth/code…): the code step after a password on the sign-in page, and Settings →
 * Account's row that switches it on (a QR to scan, one code to confirm, the recovery codes once) and off.
 */

type Secret = { secret: string; uri: string };
const JSON_HEADERS = { "Content-Type": "application/json" };
const post = async <T,>(path: string, body: unknown): Promise<{ ok: boolean; status: number; d: T & { error?: string; code?: string } }> => {
  const r = await fetch(path, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, d: (await r.json().catch(() => ({}))) as T & { error?: string; code?: string } };
};

/** The secret as an authenticator app shows it: groups of four. */
const grouped = (s: string) => s.match(/.{1,4}/g)?.join(" ") ?? s;

function Qr({ uri }: { uri: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    void QRCode.toDataURL(uri, { margin: 1, width: 176 }).then(setSrc);
  }, [uri]);
  return src ? <img src={src} alt="QR code for your authenticator app" className="size-44 rounded-lg bg-white" /> : <div className="size-44" />;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const copy = () =>
    navigator.clipboard.writeText(codes.join("\n")).then(
      () => toast.success("Recovery codes copied"),
      () => toast.error("Couldn't copy them. Select them and copy instead."),
    );
  return (
    <div className="space-y-2">
      <ul className="grid select-text grid-cols-2 gap-x-4 gap-y-1 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
        <Copy className="size-3.5" /> Copy
      </Button>
    </div>
  );
}

/**
 * The sign-in page after a right password, when the account has the code on (`setup` false) or the server asks
 * everyone for one and it has none yet (`setup`: the QR first). No cookie exists before this step ends.
 */
export function CodeStep({ step, setup, onDone, onExpired }: { step: string; setup: boolean; onDone: (user: Me | null) => void; onExpired: (message: string) => void }) {
  const [secret, setSecret] = useState<Secret | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ user: Me | null; recovery: string[] } | null>(null);

  useEffect(() => {
    if (!setup) return;
    void post<Secret>("/api/auth/code/new", { step }).then((r) => (r.ok ? setSecret(r.d) : onExpired(r.d.error || "That sign-in expired. Sign in again.")));
    // one secret per step token: a new onExpired from the page must not make another
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup, step]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await post<{ user?: Me; recovery?: string[] }>("/api/auth/code", { step, code });
      if (r.ok && r.d.recovery) setDone({ user: r.d.user ?? null, recovery: r.d.recovery });
      else if (r.ok) onDone(r.d.user ?? null);
      else if (r.d.code === "STEP_EXPIRED") onExpired(r.d.error ?? "");
      else setError(r.d.error || "That didn't work");
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 py-8 text-zinc-200">
      <div className="mb-6 flex items-center gap-3">
        <ToolsetLogo className="h-11 w-11" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Creator Toolset</h1>
          <p className="text-sm text-zinc-500">{done ? "Recovery codes" : setup ? "Set up a sign-in code" : "Code from your authenticator app"}</p>
        </div>
      </div>
      {done ? (
        <div className="flex w-72 flex-col gap-4">
          <RecoveryCodes codes={done.recovery} />
          <button type="button" onClick={() => onDone(done.user)} className="rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500">
            Continue
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="flex w-72 flex-col gap-2">
          {setup && (
            <div className="mb-2 flex flex-col items-center gap-2">
              {secret ? <Qr uri={secret.uri} /> : <div className="size-44" />}
              <p className="select-text text-center font-mono text-xs text-zinc-500">{secret ? grouped(secret.secret) : " "}</p>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 focus-within:border-violet-500">
            <KeyRound className="h-4 w-4 shrink-0 text-zinc-500" />
            <input
              autoFocus
              autoCapitalize="none"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={setup ? "6-digit code" : "6-digit code or recovery code"}
              aria-label="Code"
              className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
            />
          </div>
          <button type="submit" disabled={busy || !code.trim() || (setup && !secret)} className="rounded-lg bg-violet-600 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            {busy ? "Checking…" : setup ? "Continue" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}

/** GET /api/auth/code: on for this account, asked of everyone on this server, this Mac's own window (switches off with no code). */
export interface CodeState {
  on: boolean;
  required: boolean;
  mac: boolean;
}

/** Shared by Settings → Account and Admin (same saved copy). */
export function useCodeState() {
  return useCachedLoad<CodeState>("/api/auth/code", () =>
    fetch("/api/auth/code").then((r) => (r.ok ? (r.json() as Promise<CodeState>) : Promise.reject(new Error(`Request failed (${r.status})`)))),
  );
}

/** Settings → Account: the sign-in code's switch, with its dialogs. */
export function SignInCodeRow() {
  const state = useCodeState();
  const s = state.data;
  const [dialog, setDialog] = useState<"on" | "off" | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = async (which: "on" | "off") => {
    setCode("");
    setError(null);
    setSecret(null);
    setDialog(which);
    if (which === "off") return;
    const r = await post<Secret>("/api/auth/code/new", {});
    if (r.ok) setSecret(r.d);
    else setError(r.d.error || "Could not start it");
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ recovery?: string[] }>(dialog === "on" ? "/api/auth/code/on" : "/api/auth/code/off", { code });
      if (!r.ok) throw new Error(r.d.error || `Could not save it (${r.status})`);
      state.set((v) => v && { ...v, on: dialog === "on" });
      if (dialog === "on") {
        setRecovery(r.d.recovery ?? []);
        toast.success("Sign-in code is on. Other devices are signed out.");
      }
      setDialog(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save it");
    } finally {
      setBusy(false);
    }
  };

  if (!s) return null;
  return (
    <>
      <Row
        id="sign-in-code"
        title="Sign-in code"
        description="Ask for a code from an authenticator app when you sign in with your password"
        control={<Switch checked={s.on} disabled={s.on && s.required} aria-label="Sign-in code" onCheckedChange={(on) => void open(on ? "on" : "off")} />}
      />
      <FormDialog
        open={dialog === "on"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Sign-in code"
        submitLabel="Switch on"
        submitDisabled={!secret || !code.trim()}
        busy={busy}
        error={error}
        onSubmit={submit}
      >
        <div className="flex flex-col items-center gap-2">
          {secret ? <Qr uri={secret.uri} /> : <div className="size-44" />}
          <p className="select-text text-center font-mono text-xs text-muted-foreground">{secret ? grouped(secret.secret) : " "}</p>
        </div>
        <Input aria-label="Code" placeholder="6-digit code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      </FormDialog>
      <FormDialog
        open={dialog === "off"}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Switch off the sign-in code"
        submitLabel="Switch off"
        submitDisabled={!s.mac && !code.trim()}
        busy={busy}
        error={error}
        onSubmit={submit}
      >
        {!s.mac && <Input aria-label="Code" placeholder="Code or recovery code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />}
      </FormDialog>
      <Dialog open={!!recovery} onOpenChange={(o) => !o && setRecovery(null)}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Recovery codes</DialogTitle>
          </DialogHeader>
          <RecoveryCodes codes={recovery ?? []} />
          <DialogFooter>
            <Button size="sm" onClick={() => setRecovery(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
