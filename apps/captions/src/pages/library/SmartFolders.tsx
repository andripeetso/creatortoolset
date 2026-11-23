import { useEffect, useRef, useState } from "react";
import type { Collection, ReorganizeWay, SearchQuery } from "@contracts/library";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { createCollection, deleteCollection } from "@/lib/library";
import { undoable } from "@/lib/undo";
import { confirmDialog } from "@/lib/dialogs";
import { suggestWays } from "./api";

/**
 * Smart folders (api/library/smart.ts): a folder told what goes in it fills itself from the library, now and as clips
 * come in. Folder settings sets that (its Rule); Reorganize has the AI propose whole ways to sort the
 * library, and the one picked becomes smart folders.
 */

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Read = { ways: ReorganizeWay[]; about: boolean; at: number };
/** Each library's last Reorganize read, or the one still running, kept while the app runs: closing the dialog or leaving
 * the page never loses a paid read (owner, 2026-11-19: a stray click made him read the library three times) */
const reads = new Map<string, Promise<Read>>();
const STRIP = ["bg-lime-500", "bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-teal-500", "bg-orange-500", "bg-fuchsia-500"];

/**
 * The automatic folders New folder offers (owner, 2026-11-22: offered, never made for everyone). Each fills itself: a
 * saved search (`query`, at once and free) or a rule (`rule`, each clip read to file it, smart.ts).
 */
export const AUTOMATIC: { name: string; about: string; query?: SearchQuery; rule?: string }[] = [
  { name: "A-roll", about: "Clips marked A-roll: someone talking to camera", query: { roll: "a" } },
  { name: "B-roll", about: "Clips marked B-roll: no one talking to camera", query: { roll: "b" } },
  { name: "Unsorted", about: "Videos in no folder", query: { kind: ["video"], unfiled: true } },
  { name: "Vertical", about: "Clips taller than wide", query: { orientation: "vertical" } },
  { name: "Horizontal", about: "Clips wider than tall", query: { orientation: "horizontal" } },
  { name: "Audio", about: "Songs, sound effects and recordings", query: { kind: ["audio"] } },
  { name: "Screen recordings", about: "Each clip is read to file it", rule: "Screen recordings and screenshots of a computer or phone" },
];

/** Two saved searches the same, whatever order the server keeps their keys in */
const sameQuery = (a: SearchQuery | undefined, b: SearchQuery | undefined) =>
  !!a && !!b && JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** The line under an automatic folder's name: its rule, or what its saved search is when it is one of AUTOMATIC */
export const automaticAbout = (c: Collection): string | undefined => c.rule ?? AUTOMATIC.find((a) => sameQuery(a.query, c.query))?.about;

/** New folder: a plain one, one with a rule, or one of AUTOMATIC. `parentId` undefined: closed */
export function NewFolderDialog({
  libraryId,
  parentId,
  folders,
  onClose,
  onCreated,
}: {
  libraryId: string;
  parentId: string | null | undefined;
  folders: Collection[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [rule, setRule] = useState("");
  const [preset, setPreset] = useState<(typeof AUTOMATIC)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = parentId !== undefined;
  useEffect(() => {
    setName("");
    setRule("");
    setPreset(null);
    setError(null);
  }, [open]);
  // the A-roll or B-roll folder is the library's one place for that mark: offered once
  const offered = AUTOMATIC.filter((a) => !a.query?.roll || !folders.some((f) => sameQuery(f.query, a.query)));
  const pick = (a: (typeof AUTOMATIC)[number]) => {
    const off = preset === a;
    setPreset(off ? null : a);
    // the name follows the button only while it is the button's own (empty, or the last one's name); a typed name stays
    const ours = !name.trim() || name === preset?.name;
    if (ours) setName(off ? "" : a.name);
    setRule(off || !a.rule ? "" : a.rule);
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    const r = rule.trim();
    const parent = parentId ? { parentId } : {};
    setBusy(true);
    try {
      await createCollection(libraryId, preset?.query ? { name: n, kind: "smart", query: preset.query, ...parent } : { name: n, ...(r ? { rule: r } : {}), ...parent });
      onCreated();
      onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <form onSubmit={(e) => void create(e)} className="flex flex-col gap-3">
          <DialogTitle className="text-base">New folder</DialogTitle>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Name
            {/* no leading spaces: a name of spaces is empty, and `required` says so at the field */}
            <Input autoFocus required value={name} maxLength={80} onChange={(e) => setName(e.target.value.trimStart())} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            What goes here
            <Textarea
              rows={2}
              value={preset?.query ? preset.about : rule}
              disabled={!!preset?.query}
              maxLength={600}
              placeholder="Optional"
              onChange={(e) => {
                setRule(e.target.value);
                if (preset) setPreset(null);
              }}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">Automatic folders</p>
            <div className="flex flex-wrap gap-1.5">
              {offered.map((a) => (
                <button
                  key={a.name}
                  type="button"
                  aria-pressed={preset === a}
                  onClick={() => pick(a)}
                  className={
                    preset === a
                      ? "rounded-full border border-violet-500 bg-violet-500/15 px-2.5 py-1 text-xs text-violet-300"
                      : "rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:border-zinc-500"
                  }
                >
                  {a.name}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">
              {busy && <Spinner />}
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What Folder settings changed: only the rows that moved */
export type FolderChanges = { name?: string; rule?: string | null; blur?: boolean; offline?: boolean };

/**
 * A folder's settings, one form with one Save (owner, 2026-11-22: out of the tab's menu). A row is drawn only where it
 * is given: `name` and `rule` for who may change the folder, `blur` where the library blurs and this person may keep
 * files as filmed, `offline` on This Mac. An empty rule takes the rule off.
 */
export function FolderSettingsDialog({
  folder,
  name: nameShown,
  rule: ruleShown,
  blur,
  offline,
  onClose,
  onSave,
}: {
  folder: Collection | null;
  name: boolean;
  rule: boolean;
  blur?: boolean;
  offline?: boolean;
  onClose: () => void;
  onSave: (folder: Collection, changes: FolderChanges) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [rule, setRule] = useState("");
  const [blurs, setBlurs] = useState(true);
  const [keeps, setKeeps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(folder?.name ?? "");
    setRule(folder?.rule ?? "");
    setBlurs(blur ?? true);
    setKeeps(offline ?? false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filled once per folder opened, never while typing
  }, [folder]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folder) return;
    const changes: FolderChanges = {};
    if (nameShown && name.trim() !== folder.name) changes.name = name.trim();
    if (ruleShown && rule.trim() !== (folder.rule ?? "")) changes.rule = rule.trim() || null;
    if (blur !== undefined && blurs !== blur) changes.blur = blurs;
    if (offline !== undefined && keeps !== offline) changes.offline = keeps;
    if (changes.blur === false && !(await confirmDialog({ title: "Turn off Blur faces?", body: "Clips in this folder will not be blurred. Faces will show in previews and to your team.", ok: "Turn off" }))) return;
    setBusy(true);
    try {
      if (Object.keys(changes).length > 0) await onSave(folder, changes);
      onClose();
    } catch (e) {
      setError(`Could not save the folder: ${message(e)}`); // what was typed stays
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!folder} onOpenChange={(o) => !o && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <DialogTitle className="text-base">Folder settings</DialogTitle>
          {nameShown && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Name
              <Input required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          {ruleShown && (
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Rule
              <span className="text-xs font-normal text-zinc-500">Clips that fit the rule are filed in this folder, now and when new ones are added.</span>
              <Textarea rows={3} value={rule} maxLength={600} onChange={(e) => setRule(e.target.value)} placeholder="Describe the clips for this folder" />
            </label>
          )}
          {blur !== undefined && (
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox className="mt-0.5" checked={blurs} onCheckedChange={(v) => setBlurs(v === true)} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Blur faces</span>
                <span className="text-xs text-zinc-500">Off keeps every clip in this folder as filmed, later ones too.</span>
              </span>
            </label>
          )}
          {offline !== undefined && (
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox className="mt-0.5" checked={keeps} onCheckedChange={(v) => setKeeps(v === true)} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Available offline</span>
                <span className="text-xs text-zinc-500">Keeps a copy of every clip in this folder on this computer.</span>
              </span>
            </label>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />}
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Reorganize: the dialog first says what it does and that it costs tokens; Read the library has the AI read it and
 * propose two or three ways to sort it. The ways stand side by side, each folder one line with how many clips would go
 * in it; a tap on a folder shows its rule. Use this makes them smart folders (a plain top-level folder of the same name
 * gets the rule, marked "exists"); Undo takes them back. Only Other ideas reads the library again.
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
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [using, setUsing] = useState<number | null>(null);
  const [ruleOf, setRuleOf] = useState<string | null>(null); // the folder ("way.folder") whose rule is open
  // The AI only runs on a second, deliberate press inside the dialog: the page's button just explains it
  const [asked, setAsked] = useState(false);
  const shown = useRef(libraryId);
  /** Shows a read once it lands, unless another library is open or Other ideas started a newer one by then */
  const follow = (lib: string, p: Promise<Read>) => {
    setAsked(true);
    setRead(null);
    setError(null);
    setRuleOf(null);
    const current = () => shown.current === lib && reads.get(lib) === p;
    p.then(
      (r) => current() && setRead(r),
      (e) => {
        const showing = current();
        if (reads.get(lib) === p) reads.delete(lib); // a failed read is not kept
        if (showing) setError(message(e));
      },
    );
  };
  const ask = () => {
    const p = suggestWays(libraryId).then((r) => ({ ...r, at: Date.now() }));
    reads.set(libraryId, p);
    follow(libraryId, p);
  };
  useEffect(() => {
    shown.current = libraryId;
    const p = reads.get(libraryId);
    if (p) return follow(libraryId, p);
    setAsked(false);
    setRead(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId]);

  const sameFolder = (name: string) => folders.find((c) => c.parentId === null && c.kind === "manual" && c.name.toLowerCase() === name.toLowerCase());
  const use = async (way: ReorganizeWay, i: number) => {
    setUsing(i);
    const made: string[] = [];
    const ruled: { id: string; rule: string | null }[] = [];
    try {
      for (const f of way.folders) {
        const same = sameFolder(f.name);
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

  const ways = read?.ways;
  const about = read?.about;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        // a click or a screenshot outside never closes it: only Close, the X or Escape do
        onInteractOutside={(e) => e.preventDefault()}
        className={`flex max-h-[90dvh] flex-col gap-4 overflow-y-auto ${ways ? "sm:max-w-4xl" : "sm:max-w-lg"}`}
      >
        <div className="flex items-baseline gap-2 pr-6">
          <DialogTitle className="text-base">Reorganize</DialogTitle>
          {read && (
            <span className="text-xs text-zinc-500">
              {read.ways.length} ways · read at {new Date(read.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        {!asked && (
          <div className="flex flex-col gap-2 text-sm text-zinc-500">
            <p>
              The AI reads the library's tags and up to 60 clips' descriptions and proposes two or three ways to sort it into folders. Then it checks up to 150 clips to count what
              each folder would hold.
            </p>
            <p>It runs on the AI provider set in Settings, so it uses tokens each time. Nothing moves until you press Use this on one of the ways.</p>
          </div>
        )}
        {asked && !read && !error && (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Spinner /> Reading the library
          </p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        {ways && (
          <div className={`grid gap-3 ${ways.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
            {ways.map((w, i) => {
              const most = Math.max(1, ...w.folders.map((f) => f.count ?? 0));
              const counted = w.folders.some((f) => f.count);
              return (
                <section key={w.name} className="flex flex-col gap-2 rounded-lg border border-zinc-500/20 p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-medium">{w.name}</h3>
                    <span className="shrink-0 text-xs text-zinc-500">{w.folders.length} folders</span>
                  </div>
                  {/* how the clips split between its folders: one folder taking everything shows at a glance */}
                  {counted && (
                    <div aria-hidden className="flex h-1.5 gap-px overflow-hidden rounded-full">
                      {w.folders.map((f, k) => (
                        <span key={f.name} className={STRIP[k % STRIP.length]} style={{ flex: f.count ?? 0 }} />
                      ))}
                    </div>
                  )}
                  <ul className="flex flex-col gap-0.5">
                    {w.folders.map((f, k) => {
                      const id = `${i}.${k}`;
                      return (
                        <li key={f.name}>
                          <button
                            type="button"
                            aria-expanded={ruleOf === id}
                            onClick={() => setRuleOf(ruleOf === id ? null : id)}
                            className="relative flex w-full items-center gap-1.5 overflow-hidden rounded px-1.5 py-1 text-left text-sm hover:bg-zinc-500/10"
                          >
                            {counted && <span aria-hidden className="absolute inset-y-0 left-0 bg-zinc-500/15" style={{ width: `${((f.count ?? 0) / most) * 100}%` }} />}
                            <span className="relative truncate font-medium">{f.name}</span>
                            {sameFolder(f.name) && <span className="relative shrink-0 rounded border border-zinc-500/30 px-1 text-[10px] text-zinc-500">exists</span>}
                            {f.count !== undefined && (
                              <span className="relative ml-auto shrink-0 text-xs text-zinc-500 tabular-nums">{about ? `about ${f.count}` : f.count}</span>
                            )}
                          </button>
                          {ruleOf === id && <p className="px-1.5 pt-0.5 pb-1 text-xs text-zinc-500">{f.rule}</p>}
                        </li>
                      );
                    })}
                  </ul>
                  <Button size="sm" className="mt-auto" disabled={using !== null} onClick={() => void use(w, i)}>
                    {using === i && <Spinner />}
                    Use this
                  </Button>
                </section>
              );
            })}
          </div>
        )}
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
