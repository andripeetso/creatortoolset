import { useState } from "react";
import { Link } from "react-router";
import { LIBRARY_WORDS } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { confirmDialog } from "@/lib/dialogs";

/**
 * The one sheet of an add (owner, 2026-11-24): how its files are processed and, for files from outside every folder this
 * Mac reads, whether they are copied or used where they are. Processing is two ticks of the one chain (Original →
 * Blurred copy → Proxy), Blur faces and Generate proxies: a file can get both, and neither is no processing. What is
 * uploaded is the library's Upload setting, never asked here.
 */
export type Processing = { blur: boolean; proxy: boolean };
export type ImportChoice = Processing & { copy: boolean };
export type ImportAsk = {
  id: number;
  count: number;
  /** the ticks as the sheet opens: the library's and the folder's settings */
  start: Processing;
  /** Blur faces is a choice here; where it is not, the files keep `start.blur` */
  blurOffered: boolean;
  /** files from outside every folder this Mac reads (0: no Location section) */
  outside: number;
  done: (c: ImportChoice | null) => void;
};

/**
 * The answer as an add's options (lib/import-queue.ts AddOptions). Blurred, or with no proxy where the library keeps no
 * originals, the files are indexed on this Mac and nothing is sent (a blurred copy goes later, as Upload says).
 * `asFilmed` unticks the library's Blur faces, `askBlur` sets it where the library doesn't blur. `proxy` is the file's
 * own answer over the library's Generate proxies, kept only when the person moved its tick off `start` (what the
 * library's settings gave): Add as it opened keeps nothing, so turning proxies on later still covers these files.
 */
export function importOptions(c: Processing, at: { start: Processing; libraryBlurs: boolean; macRemote: boolean; onMac: boolean; hostsOriginals: boolean }) {
  return {
    mac: at.onMac || (at.macRemote && (c.blur || (!c.proxy && !at.hostsOriginals))),
    blur: c.blur,
    asFilmed: at.libraryBlurs && !c.blur,
    askBlur: !at.libraryBlurs && c.blur,
    ...(c.proxy === at.start.proxy ? {} : { proxy: c.proxy ? ("yes" as const) : ("no" as const) }),
  };
}

/** A new add starts from its own choice (keyed by the ask), never the last one's. */
export function ImportChoices({ ask }: { ask: ImportAsk | null }) {
  return ask ? <Sheet key={ask.id} ask={ask} /> : null;
}

function Sheet({ ask }: { ask: ImportAsk }) {
  const [blur, setBlur] = useState(ask.start.blur);
  const [proxy, setProxy] = useState(ask.start.proxy);
  const [where, setWhere] = useState<"copy" | "here">("copy");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    // only when the person moved off it: a folder kept as filmed starts off Blur faces
    if (ask.start.blur && !blur && !(await confirmDialog({ title: "Turn off Blur faces?", body: "These files will not be blurred. Faces will show in previews and to your team.", ok: "Turn off" }))) return;
    ask.done({ blur, proxy, copy: where === "copy" });
  };
  const row = (id: string, control: React.ReactNode, title: string, line: string, extra?: React.ReactNode) => (
    <div key={id} className="flex items-start gap-2.5 text-sm">
      {control}
      <span className="flex flex-col gap-0.5">
        <label htmlFor={id} className="font-medium">
          {title}
        </label>
        <span className="text-xs text-zinc-500">{line}</span>
        {extra}
      </span>
    </div>
  );
  const option = (group: string, value: string, title: string, line: string) => row(`${group}-${value}`, <RadioGroupItem id={`${group}-${value}`} value={value} className="mt-0.5" />, title, line);
  // a form with one Add: an on/off choice is a checkbox
  const tick = (id: string, on: boolean, set: (on: boolean) => void, words: { label: string; tip: string }, extra?: React.ReactNode) =>
    row(id, <Checkbox id={id} checked={on} onCheckedChange={(v) => set(v === true)} className="mt-0.5" />, words.label, words.tip, extra);
  const section = (title: string, body: React.ReactNode, line?: string) => (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="text-xs font-medium text-zinc-500">{title}</div>
        {line && <div className="text-xs text-zinc-500">{line}</div>}
      </div>
      {body}
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && ask.done(null)}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <form onSubmit={(e) => void add(e)} className="flex flex-col gap-4">
          <DialogTitle className="text-base">
            Add {ask.count.toLocaleString()} {ask.count === 1 ? "file" : "files"}
          </DialogTitle>
          {section(
            "Processing",
            // in the order of the chain: the proxy is made from the blurred copy
            <div role="group" aria-label="Processing" className="flex flex-col gap-3">
              {ask.blurOffered &&
                tick(
                  "process-blur",
                  blur,
                  setBlur,
                  LIBRARY_WORDS.blurFaces,
                  <Link to="/settings/blur-faces" className="w-fit text-xs text-violet-500 hover:underline">
                    Face Blur settings
                  </Link>,
                )}
              {tick("process-proxy", proxy, setProxy, LIBRARY_WORDS.generateProxies)}
            </div>,
          )}
          {ask.outside > 0 &&
            section(
              "Location",
              <RadioGroup value={where} onValueChange={(v) => setWhere(v as "copy" | "here")} aria-label="Location" className="gap-3">
                {option("where", "copy", "Copy to Media Library", "Copied once into your Media folder.")}
                {option("where", "here", "Use where they are", "Their folders are added to Folder access.")}
              </RadioGroup>,
              // some files are in a folder this Mac reads already: those are used where they are
              ask.outside < ask.count ? `${ask.outside.toLocaleString()} of ${ask.count.toLocaleString()} files are outside Folder access.` : undefined,
            )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => ask.done(null)}>
              Cancel
            </Button>
            <Button type="submit" autoFocus>
              Add
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
