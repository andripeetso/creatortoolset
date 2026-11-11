import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Share2 } from "lucide-react";
import type { ShareRow } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createShare } from "@/lib/library";
import { linksOf } from "./clip";

/**
 * Share one clip: a button that opens a small dialog. You pick what the link lets someone do (watch, or watch and
 * download), how long it works and an optional password, then Create link shows the address once, with Copy. Below,
 * the clip's links that still work, each with Stop (api/library/shares.ts).
 */

const DAYS = [1, 7, 30, 90] as const;
const SCOPE = { view: "Watch", download: "Watch and download" } as const;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function call<T>(url: string, method = "GET"): Promise<T> {
  const r = await fetch(url, { method });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `Request failed (${r.status})`);
  return body;
}

const ends = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function ClipShare({
  libraryId,
  assetId,
  versionId,
  title,
  open,
  onOpenChange,
}: {
  libraryId: string;
  assetId: string;
  versionId: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [scope, setScope] = useState<"view" | "download">("view");
  const [days, setDays] = useState<number>(7);
  const [password, setPassword] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<ShareRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const reload = () =>
    call<{ shares: ShareRow[] }>(`/api/library/${libraryId}/shares`)
      .then((r) => setLive(linksOf(r.shares, assetId, versionId)))
      .catch((e) => setFailed(message(e)));

  useEffect(() => {
    if (!open) return;
    setLink(null);
    setFailed(null);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, assetId]);

  const make = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const s = await createShare(libraryId, { target: { kind: "asset", id: assetId }, scope, expiresInDays: days, ...(password ? { password } : {}) });
      setLink(`${location.origin}${s.url}`);
      setPassword("");
      void reload();
    } catch (e) {
      setFailed(message(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const stop = (id: string) =>
    call(`/api/library/shares/${id}`, "DELETE")
      .then(() => setLive((all) => all?.filter((s) => s.id !== id) ?? all))
      .catch((e) => setFailed(message(e)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-4 overflow-y-auto sm:max-w-md">
        <div className="flex flex-col gap-1 pr-6">
          <DialogTitle className="truncate text-base">Share “{title}”</DialogTitle>
          <DialogDescription className="text-xs">Anyone with the link can open it, no account needed.</DialogDescription>
        </div>

        {link ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Input readOnly value={link} aria-label="Share link address" onFocus={(e) => e.currentTarget.select()} className="h-9 text-xs" />
              <Button size="sm" onClick={copy}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-zinc-500">The address shows only now.</p>
            <Button size="sm" variant="ghost" className="w-fit" onClick={() => setLink(null)}>
              Make another link
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3 text-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void make();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-500">They can</span>
              <div role="group" aria-label="They can" className="flex gap-1.5">
                {(Object.keys(SCOPE) as (keyof typeof SCOPE)[]).map((k) => (
                  <Button key={k} type="button" size="sm" variant={scope === k ? "default" : "outline"} aria-pressed={scope === k} onClick={() => setScope(k)}>
                    {SCOPE[k]}
                  </Button>
                ))}
              </div>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-500">Link works for</span>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="h-9 w-fit rounded-md border border-zinc-500/30 bg-transparent px-2"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "1 day" : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-500">Password</span>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="None" autoComplete="new-password" className="h-9" />
            </label>
            <Button type="submit" className="w-fit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
              Create link
            </Button>
          </form>
        )}

        {live && live.length > 0 && (
          <section aria-label="Links that work now" className="flex flex-col gap-1 border-t border-zinc-500/20 pt-3">
            <span className="text-xs font-medium text-zinc-500">Links that work now</span>
            {live.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {s.scope === "download" ? SCOPE.download : SCOPE.view}
                  <span className="text-zinc-500">
                    {" · until "}
                    {ends(s.expiresAt)}
                    {s.locked && " · password"}
                    {s.views > 0 && ` · opened ${s.views}×`}
                  </span>
                </span>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-zinc-500 hover:text-red-400" onClick={() => void stop(s.id)}>
                  Stop
                </Button>
              </div>
            ))}
          </section>
        )}
        {failed && <p className="text-xs text-red-400">{failed}</p>}
      </DialogContent>
    </Dialog>
  );
}
