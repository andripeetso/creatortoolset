import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { confirmDialog } from "@/lib/dialogs";

/**
 * What runs on the files of one add (owner, 2026-11-24: "for the Sony stuff I would like to generate proxies and blur"):
 * asked on each drop or Upload where there is a choice, starting from the library's and the folder's settings.
 * `blur`/`proxies` absent: no such row. Proxies hides while Blur faces is ticked: the blurred video is then the proxy.
 */
export type ImportChoice = { blur: boolean; proxies: boolean };
export type ImportAsk = { count: number; blur?: boolean; proxies?: boolean; libraryBlurs: boolean; done: (c: ImportChoice | null) => void };

export function ImportChoices({ ask }: { ask: ImportAsk | null }) {
  const [blur, setBlur] = useState(false);
  const [proxies, setProxies] = useState(true);
  useEffect(() => {
    if (!ask) return;
    setBlur(!!ask.blur);
    setProxies(ask.proxies ?? true);
  }, [ask]);
  if (!ask) return null;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (ask.libraryBlurs && !blur && !(await confirmDialog({ title: "Turn off Blur faces?", body: "These files will not be blurred. Faces will show in previews and to your team.", ok: "Turn off" }))) return;
    ask.done({ blur, proxies });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && ask.done(null)}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3">
          <DialogTitle className="text-base">
            Add {ask.count.toLocaleString()} {ask.count === 1 ? "file" : "files"}
          </DialogTitle>
          {ask.blur !== undefined && (
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox className="mt-0.5" checked={blur} onCheckedChange={(v) => setBlur(v === true)} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Blur faces</span>
                <span className="text-xs text-zinc-500">Only the blurred video of each clip leaves this computer.</span>
              </span>
            </label>
          )}
          {ask.proxies !== undefined && !blur && (
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox className="mt-0.5" checked={proxies} onCheckedChange={(v) => setProxies(v === true)} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Proxies</span>
                <span className="text-xs text-zinc-500">A lighter copy of each clip goes to the server, so it plays anywhere.</span>
              </span>
            </label>
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
