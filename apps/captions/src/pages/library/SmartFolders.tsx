import { useEffect, useState } from "react";
import type { Collection, ReorganizeWay } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createCollection, deleteCollection } from "@/lib/library";
import { undoable } from "@/lib/undo";
import { setFolderRule, suggestWays } from "./api";

/**
 * Smart folders (api/library/smart.ts): a folder told what goes in it fills itself from the library, now and as clips
 * come in. "What goes here…" on a folder's menu sets that; Reorganize has the AI propose whole ways to sort the
 * library, and the one picked becomes smart folders.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What goes in one folder, in the person's own words. Saving sorts the library into it again. */
export function SmartFolderDialog({
  libraryId,
  folder,
  onClose,
  onSaved,
}: {
  libraryId: string;
  folder: Collection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRule(folder?.rule ?? "");
    setError(null);
  }, [folder]);
  const save = async (next: string | null) => {
    if (!folder) return;
    setBusy(true);
    try {
      await setFolderRule(libraryId, folder.id, next);
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!folder} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex flex-col gap-3 sm:max-w-md">
        <DialogTitle className="truncate pr-6 text-base">Rule for “{folder?.name}”</DialogTitle>
        <Textarea
          autoFocus
          rows={4}
          value={rule}
          maxLength={600}
          onChange={(e) => setRule(e.target.value)}
          placeholder="Describe the clips for this folder"
        />
        <p className="text-xs text-zinc-500">Clips that fit the rule are filed in this folder, now and when new ones are added.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          {folder?.rule && (
            <Button variant="ghost" disabled={busy} onClick={() => void save(null)} className="mr-auto">
              Delete rule
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || !rule.trim() || rule.trim() === folder?.rule} onClick={() => void save(rule.trim())}>
            {busy && <Spinner />}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reorganize: the dialog first says what it does and that it costs tokens; Read the library has the AI read it and
 * propose two or three ways to sort it, each folder with what goes in it and how many clips would. Use this makes them smart folders (a plain top-level folder of the same name gets the rule);
 * Undo takes them back.
 */
export function ReorganizeDialog({
  libraryId,
  open,
  folders,
  onClose,
  onDone,
}: {
  libraryId: string;
  open: boolean;
  folders: Collection[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [ways, setWays] = useState<ReorganizeWay[] | null>(null);
  const [about, setAbout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [using, setUsing] = useState<number | null>(null);
  // The AI only runs on a second, deliberate press inside the dialog: the page's button just explains it
  const [asked, setAsked] = useState(false);
  const ask = () => {
    setAsked(true);
    setWays(null);
    setError(null);
    suggestWays(libraryId).then(
      (r) => {
        setWays(r.ways);
        setAbout(r.about);
      },
      (e) => setError(message(e)),
    );
  };
  useEffect(() => {
    if (!open) return;
    setAsked(false);
    setWays(null);
    setError(null);
  }, [open, libraryId]);

  const use = async (way: ReorganizeWay, i: number) => {
    setUsing(i);
    const made: string[] = [];
    const ruled: { id: string; rule: string | null }[] = [];
    try {
      for (const f of way.folders) {
        const same = folders.find((c) => c.parentId === null && c.kind === "manual" && c.name.toLowerCase() === f.name.toLowerCase());
        if (same) {
          await setFolderRule(libraryId, same.id, f.rule);
          ruled.push({ id: same.id, rule: same.rule ?? null });
        } else made.push((await createCollection(libraryId, { name: f.name, rule: f.rule })).id);
      }
      onDone();
      onClose();
      undoable("library reorganized", async () => {
        for (const id of made) await deleteCollection(libraryId, id);
        for (const r of ruled) await setFolderRule(libraryId, r.id, r.rule);
        onDone();
      });
    } catch (e) {
      setError(message(e));
      onDone();
    } finally {
      setUsing(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[90dvh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogTitle className="text-base">Reorganize</DialogTitle>
        {!asked && (
          <div className="flex flex-col gap-2 text-sm text-zinc-500">
            <p>
              The AI reads the library's tags and up to 60 clips' descriptions and proposes two or three ways to sort it into folders. Then it checks up to 150 clips to count what
              each folder would hold.
            </p>
            <p>It runs on your AI provider, so it uses tokens each time. Nothing moves until you press Use this on one of the ways.</p>
          </div>
        )}
        {asked && !ways && !error && (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Reading the library
          </p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {ways?.map((w, i) => (
          <section key={w.name} className="flex flex-col gap-2 rounded-lg border border-zinc-500/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{w.name}</h3>
              <Button size="sm" disabled={using !== null} onClick={() => void use(w, i)}>
                {using === i && <Spinner />}
                Use this
              </Button>
            </div>
            <ul className="flex flex-col gap-1.5">
              {w.folders.map((f) => (
                <li key={f.name} className="text-sm" title={f.rule}>
                  <span className="font-medium">{f.name}</span>
                  {f.count !== undefined && <span className="ml-1.5 text-zinc-500 tabular-nums">{about ? `about ${f.count}` : f.count}</span>}
                  <span className="block text-xs text-zinc-500">{f.rule}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <div className="flex justify-end gap-2">
          {(ways || error) && (
            <Button variant="ghost" disabled={using !== null} onClick={ask} className="mr-auto">
              Other ideas
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {!asked && <Button onClick={ask}>Read the library</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
