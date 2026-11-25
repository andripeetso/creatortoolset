import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { confirmDialog } from "@/lib/dialogs";

/**
 * The one sheet of an add (owner, 2026-11-24): how its files are processed (Generate proxies, Generate blurred versions,
 * Skip processing) and, for files from outside every folder this Mac reads, whether they are copied or used where they
 * are. What is uploaded is the library's Upload setting, never asked here. A blurred version takes the proxy's place, so
 * the three are one choice.
 */
export type Processing = "proxies" | "blur" | "skip";
export type ImportChoice = { process: Processing; copy: boolean };
export type ImportAsk = {
  id: number;
  count: number;
  /** the options shown (none: no Processing section) and the one picked at the start */
  processes: Processing[];
  process: Processing;
  /** files from outside every folder this Mac reads (0: no Location section) */
  outside: number;
  done: (c: ImportChoice | null) => void;
};

/**
 * The answer as an add's options (lib/import-queue.ts AddOptions). Blurred, or a skip where the library keeps only
 * proxies, the files are indexed on this Mac and nothing is sent (a blurred version goes later, in the proxy's place).
 * `asFilmed` unticks the library's Blur faces, `askBlur` sets it where the library doesn't blur, `proxy` is the file's
 * own answer over the library's Generate proxies.
 */
export function importOptions(process: Processing, at: { libraryBlurs: boolean; macRemote: boolean; onMac: boolean; hostsOriginals: boolean }) {
  const blur = process === "blur";
  return {
    mac: at.onMac || (at.macRemote && (blur || (process === "skip" && !at.hostsOriginals))),
    blur,
    asFilmed: at.libraryBlurs && !blur,
    askBlur: !at.libraryBlurs && blur,
    ...(blur ? {} : { proxy: process === "skip" ? ("no" as const) : ("yes" as const) }),
  };
}

/** A new add starts from its own choice (keyed by the ask), never the last one's. */
export function ImportChoices({ ask }: { ask: ImportAsk | null }) {
  return ask ? <Sheet key={ask.id} ask={ask} /> : null;
}

const PROCESS: Record<Processing, { title: string; line: string }> = {
  proxies: { title: "Generate proxies", line: "Smaller copies for faster playback and editing." },
  blur: { title: "Generate blurred versions", line: "Faces are blurred, and the blurred version is used in place of a proxy." },
  skip: { title: "Skip processing", line: "No proxy or blurred version is made." },
};

function Sheet({ ask }: { ask: ImportAsk }) {
  const [process, setProcess] = useState<Processing>(ask.process);
  const [where, setWhere] = useState<"copy" | "here">("copy");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    // only when the person moved off it: a folder kept as filmed starts off Blur faces
    if (ask.process === "blur" && process !== "blur" && !(await confirmDialog({ title: "Turn off Blur faces?", body: "These files will not be blurred. Faces will show in previews and to your team.", ok: "Turn off" }))) return;
    ask.done({ process, copy: where === "copy" });
  };
  const option = (group: string, value: string, title: string, line: string, extra?: React.ReactNode) => (
    <div key={value} className="flex items-start gap-2.5 text-sm">
      <RadioGroupItem id={`${group}-${value}`} value={value} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <label htmlFor={`${group}-${value}`} className="font-medium">
          {title}
        </label>
        <span className="text-xs text-zinc-500">{line}</span>
        {extra}
      </span>
    </div>
  );
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
          {ask.processes.length > 0 &&
            section(
              "Processing",
              <RadioGroup value={process} onValueChange={(v) => setProcess(v as Processing)} aria-label="Processing" className="gap-3">
                {ask.processes.map((p) =>
                  option(
                    "process",
                    p,
                    PROCESS[p].title,
                    PROCESS[p].line,
                    p === "blur" && (
                      <Link to="/settings/blur-faces" className="w-fit text-xs text-violet-500 hover:underline">
                        Face Blur settings
                      </Link>
                    ),
                  ),
                )}
              </RadioGroup>,
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
