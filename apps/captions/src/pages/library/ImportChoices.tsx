import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { confirmDialog } from "@/lib/dialogs";

/**
 * What runs on the files of one add (owner, 2026-11-24: "for the Sony stuff I would like to generate proxies and blur"):
 * asked on each drop or Upload where there is a choice, starting from the library's and the folder's settings.
 * One choice (owner: blur "essentially creates a blurred proxy"), each option the action it takes: Upload proxies, Upload
 * blurred proxies or Keep on this computer; with no proxy question, Keep as filmed or Blur faces. `blur`/`proxies` absent: no such option.
 */
export type ImportChoice = { blur: boolean; proxies: boolean };
export type ImportAsk = { id: number; count: number; blur?: boolean; proxies?: boolean; done: (c: ImportChoice | null) => void };

/**
 * The answer as an add's options (lib/import-queue.ts AddOptions): blurred, or no proxy asked for, the files are indexed on
 * this Mac and nothing is sent (the blurred video goes later, as the proxy). `asFilmed` unticks the library's Blur faces;
 * `askBlur` ticks it where the library doesn't blur.
 */
export function importOptions(c: ImportChoice, at: { libraryBlurs: boolean; macRemote: boolean; onMac: boolean }) {
  return {
    mac: at.onMac || (at.macRemote && (c.blur || !c.proxies)),
    blur: c.blur,
    asFilmed: at.libraryBlurs && !c.blur,
    askBlur: !at.libraryBlurs && c.blur,
  };
}

/** A new add starts from its own choice (keyed by the ask), never the last one's. */
export function ImportChoices({ ask }: { ask: ImportAsk | null }) {
  return ask ? <Sheet key={ask.id} ask={ask} /> : null;
}

type Pick = "proxy" | "blur" | "none";
const ROW = "flex items-start gap-2.5 text-sm";

function Sheet({ ask }: { ask: ImportAsk }) {
  const [pick, setPick] = useState<Pick>(ask.blur ? "blur" : "proxy");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    // only when the person moved off it: a folder kept as filmed starts off Blur faces
    if (ask.blur && pick !== "blur" && !(await confirmDialog({ title: "Turn off Blur faces?", body: "These files will not be blurred. Faces will show in previews and to your team.", ok: "Turn off" }))) return;
    ask.done({ blur: pick === "blur", proxies: pick !== "none" });
  };
  const proxies = ask.proxies !== undefined;
  const option = (value: Pick, title: string, line: string, extra?: React.ReactNode) => (
    <div className={ROW}>
      <RadioGroupItem id={`import-${value}`} value={value} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <label htmlFor={`import-${value}`} className="font-medium">
          {title}
        </label>
        <span className="text-xs text-zinc-500">{line}</span>
        {extra}
      </span>
    </div>
  );
  return (
    <Dialog open onOpenChange={(o) => !o && ask.done(null)}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3">
          <DialogTitle className="text-base">
            Add {ask.count.toLocaleString()} {ask.count === 1 ? "file" : "files"}
          </DialogTitle>
          {/* one choice: the blurred video is the proxy, so Blur faces and Proxies never go together */}
          <RadioGroup value={pick} onValueChange={(v) => setPick(v as Pick)} aria-label="Processing" className="gap-3">
            {proxies
              ? option("proxy", "Upload proxies", "A smaller copy of each clip goes to the server for playback.")
              : option("proxy", "Keep as filmed", "Faces are not blurred.")}
            {ask.blur !== undefined &&
              option(
                "blur",
                proxies ? "Upload blurred proxies" : "Blur faces",
                proxies ? "The proxy has faces blurred, and the originals stay on this computer." : "Only the blurred copy of each clip leaves this computer.",
                <Link to="/settings/blur-faces" className="w-fit text-xs text-violet-400 hover:underline">
                  Face Blur settings
                </Link>,
              )}
            {proxies && option("none", "Keep on this computer", "No video is uploaded.")}
          </RadioGroup>
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
