import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ShareRow } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { createShare } from "@/lib/library";
import { daysLeft, knownLink, LINK_DAYS, linksOf, rememberLink } from "./clip";

/**
 * Share one clip. Opening it gives the link at once (this clip's newest one made on this device, else a new one:
 * watch only, 7 days, no password) with Copy. Under it, rows that change that same link in place (PATCH
 * /api/library/shares/:id): Allow download, Password, Stops working in. Below, the clip's other links that still work,
 * each with Copy (when this device made it) and Stop.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const out = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(out.error ?? `Request failed (${r.status})`);
  return out;
}

type Link = { row: ShareRow; url: string };

// one link in the making per clip: a second open while the first is on its way gets the same one
const making = new Map<string, Promise<Link>>();
function newLink(libraryId: string, assetId: string): Promise<Link> {
  let p = making.get(assetId);
  if (!p) {
    p = createShare(libraryId, { target: { kind: "asset", id: assetId }, scope: "view", expiresInDays: 7 })
      .then((s) => {
        const url = `${location.origin}${s.url}`;
        rememberLink(s.id, url);
        return { url, row: { id: s.id, target: { kind: "asset", id: assetId }, scope: "view", locked: false, createdBy: "", expiresAt: s.expiresAt, views: 0 } as ShareRow };
      })
      .finally(() => making.delete(assetId));
    making.set(assetId, p);
  }
  return p;
}

const ends = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

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
  const [link, setLink] = useState<Link | null>(null);
  const [others, setOthers] = useState<ShareRow[]>([]);
  const [lock, setLock] = useState(false); // the password row is on (its field shows)
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    (async () => {
      const all = linksOf((await call<{ shares: ShareRow[] }>(`/api/library/${libraryId}/shares`)).shares, assetId, versionId);
      const known = all.find((s) => knownLink(s.id)); // newest first: the list is by expiry
      const current = known ? { row: known, url: knownLink(known.id)! } : await newLink(libraryId, assetId);
      if (!live) return;
      setLink(current);
      setLock(current.row.locked);
      setPassword("");
      setFailed(null);
      setOthers(all.filter((s) => s.id !== current.row.id));
    })().catch((e) => live && setFailed(message(e)));
    return () => void (live = false);
  }, [open, libraryId, assetId, versionId]);

  const change = (patch: { scope?: "view" | "download"; expiresInDays?: number; password?: string | null }) => {
    if (!link) return;
    setFailed(null);
    call<ShareRow>(`/api/library/shares/${link.row.id}`, "PATCH", patch)
      .then((row) => setLink((l) => (l && l.row.id === row.id ? { ...l, row } : l)))
      .catch((e) => setFailed(message(e)));
  };

  const copy = (url: string) =>
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(url);
      window.setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    });

  const stop = (id: string) =>
    call(`/api/library/shares/${id}`, "DELETE")
      .then(() => setOthers((all) => all.filter((s) => s.id !== id)))
      .catch((e) => setFailed(message(e)));

  const row = link?.row;
  const left = row ? daysLeft(row.expiresAt) : 7;
  const choices = (LINK_DAYS as readonly number[]).includes(left) ? LINK_DAYS : [...LINK_DAYS, left].sort((x, y) => x - y);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[90dvh] flex-col gap-4 overflow-y-auto sm:max-w-md">
        <DialogTitle className="truncate pr-6 text-base">Share “{title}”</DialogTitle>

        <div className="flex items-center gap-2">
          <Input readOnly value={link?.url ?? ""} placeholder="Making the link…" aria-label="Share link address" onFocus={(e) => e.currentTarget.select()} className="h-9 text-xs" />
          <Button size="sm" disabled={!link} onClick={() => link && copy(link.url)} className="w-24 shrink-0">
            {copied === link?.url && link ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied === link?.url && link ? "Copied" : "Copy"}
          </Button>
        </div>

        <div className="flex flex-col divide-y divide-zinc-500/15 rounded-lg border border-zinc-500/20 text-sm">
          <label className="flex items-center justify-between gap-3 px-3 py-2.5">
            Allow download
            <Switch checked={row?.scope === "download"} disabled={!row} onCheckedChange={(on) => change({ scope: on ? "download" : "view" })} />
          </label>
          <div className="flex flex-col gap-2 px-3 py-2.5">
            <label className="flex items-center justify-between gap-3">
              Password
              <Switch
                checked={lock}
                disabled={!row}
                onCheckedChange={(on) => {
                  setLock(on);
                  setPassword("");
                  if (!on && row?.locked) change({ password: null });
                }}
              />
            </label>
            {lock && (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (password) change({ password });
                  setPassword("");
                }}
              >
                <Input
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={row?.locked ? "Set · type to change it" : "Password"}
                  aria-label="Link password"
                  autoComplete="new-password"
                  className="h-8"
                />
                <Button type="submit" size="sm" variant="outline" disabled={!password}>
                  Set
                </Button>
              </form>
            )}
          </div>
          <label className="flex items-center justify-between gap-3 px-3 py-2.5">
            Stops working in
            <select
              value={left}
              disabled={!row}
              onChange={(e) => change({ expiresInDays: Number(e.target.value) })}
              className="h-8 rounded-md border border-zinc-500/30 bg-transparent px-2"
            >
              {choices.map((d) => (
                <option key={d} value={d}>
                  {days(d)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {row && (
          <Button size="sm" variant="ghost" className="-mt-2 h-7 w-fit px-2 text-xs text-zinc-500 hover:text-red-400" onClick={() => void stop(row.id).then(() => onOpenChange(false))}>
            Stop this link
          </Button>
        )}

        {others.length > 0 && (
          <section aria-label="Other links" className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-500">Other links to this clip</span>
            {others.map((s) => {
              const url = knownLink(s.id);
              return (
                <div key={s.id} className="flex items-center gap-1 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {s.scope === "download" ? "Download allowed" : "Watch only"}
                    <span className="text-zinc-500">
                      {` · until ${ends(s.expiresAt)}`}
                      {s.locked && " · password"}
                    </span>
                  </span>
                  {url && (
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => copy(url)}>
                      {copied === url ? "Copied" : "Copy"}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-zinc-500 hover:text-red-400" onClick={() => void stop(s.id)}>
                    Stop
                  </Button>
                </div>
              );
            })}
          </section>
        )}
        {failed && <p className="text-xs text-red-400">{failed}</p>}
      </DialogContent>
    </Dialog>
  );
}
