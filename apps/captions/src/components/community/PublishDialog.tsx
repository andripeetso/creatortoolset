import { useState, type ReactNode } from "react";
import { ChevronDown, Download, Globe } from "lucide-react";
import type { Pack } from "@contracts/packs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { CatalogError, publishFromMac, submitPack } from "@/lib/pack-catalog";
import { useMe } from "@/lib/auth";
import { msg } from "../settings/helpers";
import { Notice } from "../settings/ui";
import { exportPack } from "./packs-api";
import { LICENCES, slugify } from "./packs-helpers";

/** One of the person's own items, published on its own. */
export type PublishItem = { defaultName: string; defaultDescription?: string } & (
  | { kind: "framework" | "captionStyle" | "skill"; /** The framework id, the caption style's preset id or the skill's id. */ id: string }
  | { kind: "home"; /** The Home tiles switched off (Settings → Tools). */ hidden: string[] }
);

type Licence = (typeof LICENCES)[number];

const FIELD = { framework: "frameworks", captionStyle: "presets", skill: "skills" } as const;

/** The entry point on an item, for a signed-in account: opens the publish dialog. */
export function PublishButton({ item, compact, className }: { item: PublishItem; compact?: boolean; className?: string }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Publish to Community"
        aria-label={compact ? "Publish to Community" : undefined}
        className={className}
      >
        <Globe className="h-3 w-3" />
        {!compact && " Publish to Community"}
      </button>
      {open && <PublishDialog item={item} onClose={() => setOpen(false)} />}
    </>
  );
}

function download(pack: Pack) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${pack.id}.ctpack.json`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Publish one item to Community: name, description, niche, licence, version and the rights box. The pack is built and
 * checked here; this server only reads the catalog, so it answers with the catalog's site and the file to send there.
 */
export function PublishDialog({ item, onClose }: { item: PublishItem; onClose: () => void }) {
  const [name, setName] = useState(item.defaultName);
  const [description, setDescription] = useState((item.defaultDescription ?? "").slice(0, 300));
  const [niche, setNiche] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [license, setLicense] = useState<Licence>("CC-BY-4.0");
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Where the file goes when this window can't send it: the catalog's site; `signedOut`: the Mac app could, once signed in. */
  const [sendAt, setSendAt] = useState<{ pack: Pack; href: string; signedOut?: boolean } | null>(null);
  const [sent, setSent] = useState(false);

  const id = slugify(name);
  const canPublish = rights && !busy && !!id && description.trim().length > 0;

  const publish = async () => {
    setBusy(true);
    setProblems([]);
    setError(null);
    setSendAt(null);
    let pack: Pack | null = null;
    try {
      pack = (
        await exportPack({
          id,
          name: name.trim(),
          version: version.trim(),
          description: description.trim(),
          license,
          niche: niche.trim() || undefined,
          ...(item.kind === "home" ? { home: { hidden: item.hidden } } : { [FIELD[item.kind]]: [item.id] }),
        })
      ).pack;
      await submitPack(pack);
      setSent(true);
    } catch (e) {
      if (pack && e instanceof CatalogError && e.publishAt && /^https?:\/\//.test(e.publishAt)) {
        // this server only reads the catalog: the Mac app sends it with its own account, after its own alert
        const mac = await publishFromMac(pack);
        if (mac?.state === "sent") setSent(true);
        else if (mac?.state === "error") setError(mac.message || "It didn't send. Try again.");
        else if (mac?.state !== "cancelled") setSendAt({ pack, href: e.publishAt, signedOut: mac?.state === "signedOut" });
      } else if (e instanceof CatalogError && e.problems.length) setProblems(e.problems);
      else setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-md">
        <DialogTitle className="text-base font-semibold">Publish to Community</DialogTitle>
        <DialogDescription className="sr-only">Build a pack from this and send it to the community catalog.</DialogDescription>

        {sent ? (
          <div className="space-y-3">
            <Notice>Sent for review. Once it&apos;s listed, it shows in Community.</Notice>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : sendAt ? (
          <div className="space-y-3">
            <Notice>
              {sendAt.signedOut
                ? "It passed the checks. Sign in to your Creator Toolset account in Settings → Account to publish it from here, or download the file and send it on the community catalog's site."
                : "It passed the checks. Packs are published on the community catalog's site: download the file, then send it there."}
            </Notice>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => download(sendAt.pack)}>
                <Download className="h-3 w-3" /> Download .ctpack.json
              </Button>
              <a
                href={sendAt.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-8 items-center rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500"
              >
                Open the catalog
              </a>
            </div>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canPublish) void publish();
            }}
          >
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
              {name.trim() && !id && <span className="text-[11px] text-red-600 dark:text-red-300">Use letters or numbers.</span>}
            </Field>
            <Field label="Description">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} rows={2} required />
            </Field>
            <Field label="Niche" hint="Optional: who it's for, like fitness or B2B.">
              <Input value={niche} onChange={(e) => setNiche(e.target.value)} maxLength={40} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Licence">
                <LicenceMenu value={license} onChange={setLicense} />
              </Field>
              <Field label="Version" hint="Raise it for a new version.">
                <Input value={version} onChange={(e) => setVersion(e.target.value)} required />
              </Field>
            </div>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} />
              <span>
                This is mine to share: I wrote it, or it&apos;s under a licence that allows this. It copies no text from books, courses or other
                people&apos;s posts, and nothing from my Knowledge.
              </span>
            </label>

            {problems.length > 0 && (
              <div className="rounded-md bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">
                <div className="font-medium">Not ready to share yet:</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && <Notice tone="error">{error}</Notice>}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canPublish}>
                {busy ? "Checking…" : "Publish"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      <div className="space-y-1">{children}</div>
    </label>
  );
}

/** The licence, as a menu of the three the catalog takes. */
function LicenceMenu({ value, onChange }: { value: Licence; onChange: (l: Licence) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2.5 text-xs text-foreground">
          {value}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as Licence)}>
          {LICENCES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} className="text-xs">
              {l}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
