import { useEffect, useId, useState } from "react";
import { Check, QrCode } from "lucide-react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { accessName, atTime, endpointName, expiresIn, hostOf, ms, READ_ONLY, STANDARD, createPairingLink, type AccessScope, type CreatedLink, type PairingLink } from "@/lib/access";
import { FormDialog } from "./ui";
import { inputCls } from "./helpers";

const ACCESS: { id: "read" | "standard"; title: string; description: string; scopes: AccessScope[] }[] = [
  { id: "read", title: "Read only", description: "Sees your work, changes nothing", scopes: READ_ONLY },
  { id: "standard", title: "Standard", description: "Works as you do, and can add or revoke other devices", scopes: STANDARD },
];

/** Create link: a one-time link another device signs in with, its name and what it may do. */
export function CreateLinkDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (link: CreatedLink) => void }) {
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<"read" | "standard">("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) return;
    setLabel("");
    setAccess("standard");
    setError(null);
  }, [open]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const name = label.trim();
      const link = await createPairingLink({ ...(name ? { label: name } : {}), scopes: ACCESS.find((a) => a.id === access)!.scopes });
      onCreated(link);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the link.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title="Create link" submitLabel="Create link" busy={busy} error={error} onSubmit={create}>
      <label className="block space-y-1.5">
        <span className="block text-xs font-medium">Name (optional)</span>
        <input className={cn(inputCls, "w-full text-sm")} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Living room iPad" disabled={busy} autoFocus />
      </label>
      <div role="radiogroup" aria-label="Access" className="divide-y divide-border/50 rounded-lg border border-border/60">
        {ACCESS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={access === a.id}
            disabled={busy}
            onClick={() => setAccess(a.id)}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{a.title}</span>
              <span className="block text-xs text-muted-foreground">{a.description}</span>
            </span>
            <Check className={cn("size-4 shrink-0 text-foreground", access !== a.id && "invisible")} aria-hidden />
          </button>
        ))}
      </div>
    </FormDialog>
  );
}

/** Copies a value; where the clipboard can't, `onFail` gets the value to show for copying by hand. */
async function copy(value: string, what: string, onFail: (value: string) => void) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(value);
    toast.success(`${what} copied`);
  } catch {
    onFail(value);
  }
}

/**
 * One live pairing link: its name, "Expires in …" (the time itself on hover), what it may do, and Revoke. The link made in
 * this page also has its code: the QR code with the address it opens (a list of addresses when there are several), Copy
 * link and Copy code. A link that ran out is not drawn.
 */
export function PairingLinkCard({ link, created, now, startOpen = false, onRevoke }: {
  link: PairingLink;
  /** the code and addresses, only where this page made the link */
  created?: CreatedLink;
  now: number;
  startOpen?: boolean;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(startOpen);
  const [pick, setPick] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [byHand, setByHand] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const panel = useId();
  const urls = created?.urls ?? [];
  const url = urls[Math.min(pick, urls.length - 1)]?.url;
  useEffect(() => {
    if (!open || !url) return;
    let live = true;
    void QRCode.toDataURL(url, { margin: 1, width: 176 }).then((d) => live && setQr(d), () => live && setQr(null));
    return () => void (live = false);
  }, [open, url]);
  if (ms(link.expiresAt) <= now) return null;
  const revoke = async () => {
    setRevoking(true);
    await onRevoke(link.id).catch((e: Error) => toast.error("Could not revoke the link", { description: e.message }));
    setRevoking(false);
  };
  return (
    <div data-pairing-link={link.id} className="px-3 py-2.5 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{link.label || "Pairing link"}</div>
          <div className="text-xs text-muted-foreground">
            <span title={atTime(link.expiresAt)}>{expiresIn(link.expiresAt, now)}</span> · {accessName(link.scopes)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {created && url && (
            <Button size="sm" variant={open ? "secondary" : "outline"} aria-expanded={open} aria-controls={panel} onClick={() => setOpen((o) => !o)}>
              <QrCode /> QR code
            </Button>
          )}
          {created && (
            <Button size="sm" variant="outline" onClick={() => void copy(created.credential, "Code", setByHand)}>
              Copy code
            </Button>
          )}
          <Button size="sm" variant="outline" className="text-red-600 dark:text-red-400" disabled={revoking} onClick={() => void revoke()}>
            Revoke
          </Button>
        </div>
      </div>
      {!created && <p className="pt-1 text-xs text-muted-foreground">Its code shows only in the window that made it.</p>}
      {byHand && (
        <label className="block space-y-1 pt-2">
          <span className="block text-xs text-muted-foreground">Copying is not available here. Copy it by hand:</span>
          <input readOnly value={byHand} className={cn(inputCls, "w-full font-mono")} onFocus={(e) => e.currentTarget.select()} autoFocus />
        </label>
      )}
      {open && created && url && (
        <div id={panel} className="mt-3 flex flex-col gap-4 border-t border-border/50 pt-3 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 space-y-3">
            {urls.length > 1 && (
              <div role="radiogroup" aria-label="Address the QR code and link use" className="divide-y divide-border/50 rounded-lg border border-border/60">
                {urls.map((u, i) => (
                  <button key={u.url} type="button" role="radio" aria-checked={u.url === url} onClick={() => setPick(i)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/40">
                    <span className="text-xs font-medium">{endpointName(u.kind, u.url)}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{hostOf(u.url)}</span>
                    <Check className={cn("size-3.5 shrink-0", u.url !== url && "invisible")} aria-hidden />
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
              <code title={url} className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{url}</code>
              <Button size="xs" variant="ghost" onClick={() => void copy(url, "Link", setByHand)}>
                Copy link
              </Button>
            </div>
          </div>
          {qr && <img src={qr} alt="QR code: scan it with the phone or iPad to sign in" width={176} height={176} className="self-center rounded-lg bg-white p-1.5 sm:self-start" />}
        </div>
      )}
    </div>
  );
}
