import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormDialog, InUse, Status } from "@/components/settings/ui";
import { inputCls } from "@/components/settings/helpers";
import { bodyOf } from "@/lib/body";

/** The person's own Instagram sign-in (api/library/instagram-add.ts). */
interface Login {
  allowed: boolean;
  chrome: boolean;
  signedIn: boolean;
  signingIn: boolean;
  error: string | null;
}

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const b = (await bodyOf(r)) as T & { error?: string };
  if (!r.ok) throw new Error(b.error ?? `Could not reach the server (${r.status})`);
  return b;
}

const LOGIN = "/api/library/instagram/login";

/** Media Library → Add from Instagram: a post or reel by its link, read with the person's own Instagram account. */
export function InstagramAdd({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [login, setLogin] = useState<Login | null>(null);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => call<Login>(LOGIN).then((l) => live && setLogin(l)).catch((e: unknown) => live && setError(String((e as Error).message)));
    void load();
    // the sign-in happens in Chrome: follow it until the window closes
    const t = login?.signingIn ? setInterval(load, 2000) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [open, login?.signingIn]);

  const signIn = () => call<Login>(LOGIN, "POST").then((l) => setLogin((was) => ({ ...was!, ...l }))).catch((e: unknown) => setError((e as Error).message));
  const disconnect = () => call<Login>(LOGIN, "DELETE").then((l) => setLogin((was) => ({ ...was!, ...l }))).catch((e: unknown) => setError((e as Error).message));

  const add = async () => {
    if (!login?.signedIn) return signIn();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ added: { name: string }[] }>("/api/library/instagram/add", "POST", { link });
      toast.success(r.added.length === 1 ? `Added ${r.added[0]!.name}` : `Added ${r.added.length} files`);
      setLink("");
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
      // a sign-out Instagram made shows as Sign in again
      void call<Login>(LOGIN).then(setLogin).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const ready = !!login?.allowed && login.chrome;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add from Instagram"
      description="Reads the post with an Instagram account signed in on this Mac; a second account keeps the main one safe."
      submitLabel={login?.signedIn ? "Add" : login?.signingIn ? "Signing in" : "Sign in"}
      onSubmit={add}
      busy={busy}
      submitDisabled={!ready || !!login?.signingIn}
      error={error ?? login?.error ?? (login && !login.allowed ? "Only this Mac's owner can add from Instagram" : login && !login.chrome ? "Needs Google Chrome on this Mac" : null)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">Instagram account</span>
        {login?.signedIn ? (
          <span className="flex items-center gap-2">
            <InUse>Signed in</InUse>
            <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect()}>
              Disconnect
            </Button>
          </span>
        ) : (
          <Status tone="attention">{login?.signingIn ? "Signing in in Chrome" : "Not signed in"}</Status>
        )}
      </div>
      {login?.signedIn && (
        <label className="block space-y-1 text-sm">
          <span>Link</span>
          <input className={inputCls} type="url" required value={link} onChange={(e) => setLink(e.target.value)} autoFocus />
        </label>
      )}
    </FormDialog>
  );
}
