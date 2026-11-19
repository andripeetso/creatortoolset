import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Card, InfoTip, Row } from "@/components/settings/kit-rows";
import { hasThisMac } from "@/components/settings/ThisMacSection";
import { call, STORAGE_API } from "@/components/settings/StorageRows";
import { updateLibrary } from "@/lib/library";
import { useAuth, useMe } from "@/lib/auth";
import { currentProject, useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";
import {
  ANALYSIS_DEFAULT,
  ANALYSIS_LEVELS,
  LIBRARY_SETUP_DONE,
  LIBRARY_WORDS,
  LOOK_BUDGET_DEFAULT,
  PROXY_QUALITIES,
  flagsOf,
  uploadFrom,
  type AnalysisLevel,
  type LibrarySettings,
  type LibrarySummary,
  type ProxyQuality,
} from "@contracts/library";
import { EXPORTS_NAME, LIBRARY_NAME, LIBRARY_SUBFOLDERS, PROJECTS_NAME, THIS_COMPUTER, type StorageRole } from "@contracts/storage";

/**
 * The owner's Media Library setup (UNIFIED-PRD §3.3, SCREENS-COPY §4): one fixed-size sheet, the steps in dependency
 * order (where the media is, then proxies, analysis and organization, then hosted media on a server or Cloud). Done
 * writes the folder rows through the one folder list, then the library settings with setupAt, then dispatches
 * LIBRARY_SETUP_DONE. Finish later closes it and writes nothing.
 */

export type Kind = "mac" | "server" | "cloud";
type Start = "scratch" | "existing";
type Step = "start" | "folders" | "proxy" | "analysis" | "hosted";

interface Answers {
  start: Start;
  /** Use default folders: the scratch paths, or Project files and Final exports beside the first Source media folder */
  defaults: boolean;
  /** Source media folders on this computer (scratch with the switch off: the one folder) */
  sources: string[];
  projects: string;
  exports: string;
  /** How should imported media behave? true: copied into Source media (the default) */
  copy: boolean;
  proxy: boolean;
  proxyQuality: ProxyQuality;
  effort: AnalysisLevel;
  /** dollars a month; null: No limit (the default for a new library) */
  budget: number | null;
  organize: "ai" | "own";
  upload: boolean;
  originals: boolean;
  proxies: boolean;
  finals: boolean;
}

const START: Answers = {
  start: "scratch",
  defaults: true,
  sources: [],
  projects: "",
  exports: "",
  copy: true,
  proxy: true,
  proxyQuality: "standard",
  effort: ANALYSIS_DEFAULT,
  budget: null,
  organize: "ai",
  upload: false,
  originals: false,
  proxies: false,
  finals: true,
};

const stepsFor = (kind: Kind): Step[] => (kind === "mac" ? ["start", "folders", "proxy", "analysis"] : ["start", "folders", "proxy", "analysis", "hosted"]);

const TITLE: Record<Step, string> = {
  start: "Let's set up the Media Library",
  folders: "Folders",
  proxy: "Proxy workflow",
  analysis: "Analysis and organization",
  hosted: "Hosted media",
};

// the words only this sheet shows (the folder labels and their tips are not on any other surface yet)
const SOURCE_TIP = "Where your media is kept, with all its subfolders. Files you add in the app are saved to the first folder.";
const PROJECTS_TIP = "Where project work is saved: edits, renders and test renders.";
const EXPORTS_TIP = "Where finished, clean exports are saved.";
const NEXT_TO_SOURCE = "Project files and Final exports are made next to your first Source media folder.";
const BUDGET_TIP = "Analysis waits until next month once this workspace's library has spent this.";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The folders the answers name, as rows of the one folder list (the scratch paths sit in ~/Movies/Creator Toolset/<workspace>). */
export function rowsOf(a: Answers, workspace: string): { role: StorageRole; path: string }[] {
  const base = `~/Movies/${LIBRARY_NAME}/${workspace.replace(/\//g, "-")}`;
  const scratchDefault = a.start === "scratch" && a.defaults;
  const footage = scratchDefault ? [`${base}/${LIBRARY_SUBFOLDERS.footage}`] : a.start === "scratch" ? a.sources.slice(0, 1) : a.sources;
  // Project files and Final exports: beside the first Source media folder (the parent of it)
  const near = a.start === "scratch" ? base : (footage[0] ?? "").replace(/\/[^/]*\/?$/, "");
  const projects = a.defaults ? `${near}/${PROJECTS_NAME}` : a.projects;
  const exports = a.defaults ? `${near}/${EXPORTS_NAME}` : a.exports;
  return [
    ...footage.map((path) => ({ role: "footage" as const, path })),
    { role: "projects", path: projects },
    { role: "library", path: exports },
  ];
}

/** The folders step is complete: the scratch Set… rows, or at least one Source media folder and, switch off, both others. */
const folderOk = (a: Answers): boolean => {
  if (a.start === "scratch" && a.defaults) return true;
  if (a.start === "scratch") return a.sources.length > 0 && !!a.projects && !!a.exports;
  return a.sources.length > 0 && (a.defaults || (!!a.projects && !!a.exports));
};

/** A radio option: the name, its ⓘ tip, and a status line when it says why it is off. */
function Pick({ on, disabled, label, tip, status, onPick }: { on: boolean; disabled?: boolean; label: string; tip?: string; status?: string; onPick: () => void }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-xl border px-3 py-2.5", on ? "border-[var(--tint)] bg-[color-mix(in_srgb,var(--tint)_7%,transparent)]" : "border-border/70")}>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={disabled}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint)] disabled:opacity-50"
      >
        <span className={cn("size-4 shrink-0 rounded-full border", on ? "border-[var(--tint)] bg-[var(--tint)] shadow-[inset_0_0_0_3px_var(--background)]" : "border-foreground/25")} />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          {status && <span className="block text-xs text-muted-foreground">{status}</span>}
        </span>
      </button>
      {tip && <InfoTip text={tip} label={label} />}
    </div>
  );
}

/** A folder row: its paths (or Not set), and a button that opens a typed path. `submit`: the typed path's button. */
function FolderRow({ title, tip, paths, button, submit, onAdd }: { title: string; tip: string; paths: string[]; button: string; submit: string; onAdd: (p: string) => void }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  return (
    <Row
      title={title}
      tip={tip}
      status={paths.length ? <span className="font-mono">{paths.join(", ")}</span> : LIBRARY_WORDS.notSet}
      control={
        <Button size="sm" variant="outline" onClick={() => setTyping((t) => !t)}>
          {button}
        </Button>
      }
    >
      {typing && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const p = text.trim();
            if (!p) return;
            onAdd(p);
            setText("");
            setTyping(false);
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} aria-label={`${title} folder path`} placeholder="Folder path" className="min-w-0 flex-1 font-mono" autoFocus />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            {submit}
          </Button>
        </form>
      )}
    </Row>
  );
}

/**
 * The setup sheet. `watchAllowed`: the server reads this computer's folders (This Mac). `onDone` gets the saved library.
 */
export function LibrarySetup({ library, watchAllowed, onDone, onClose }: { library: LibrarySummary; watchAllowed: boolean; onDone: (l: LibrarySummary) => void; onClose: () => void }) {
  const hosted = useAuth((s) => s.hosted);
  const me = useMe();
  const project = useWorkspace((s) => currentProject(s));
  const workspace = { id: project?.id ?? "", name: project?.name ?? "Media Library" };
  const kind: Kind = hosted ? "cloud" : watchAllowed ? "mac" : "server";
  const serverName = hosted ? "Creator Toolset Cloud" : `${me?.name ?? me?.username ?? "Your"}'s server`;
  const steps = stepsFor(kind);
  const [at, setAt] = useState(0);
  const [a, setA] = useState<Answers>(START);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = steps[at]!;
  const set = (p: Partial<Answers>) => setA((x) => ({ ...x, ...p }));
  const last = at === steps.length - 1;
  // without the Mac app no folder can be added here (the step says so), so it does not hold Continue
  const ok = step !== "folders" || !hasThisMac() || folderOk(a);

  const addRow = (role: StorageRole, path: string) =>
    call(`${STORAGE_API}/folders`, "POST", { role, host: THIS_COMPUTER, path }, workspace.id || undefined).catch((e: unknown) => {
      // a folder already in the list is what the person wanted
      if (!/already/i.test(message(e))) throw e;
    });

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      // the folders are rows of the one list; without the Mac app there is no computer to add them on
      if (hasThisMac()) for (const r of rowsOf(a, workspace.name)) await addRow(r.role, r.path);
      const settings: Partial<LibrarySettings> = {
        importMode: a.copy ? "copy" : "in-place",
        organize: a.organize,
        proxy: a.proxy,
        proxyQuality: a.proxyQuality,
        ...flagsOf(a.effort),
        lookBudget: a.budget,
        defaultFolders: a.defaults,
        setupAt: new Date().toISOString(),
        // a library on This Mac has no server to upload to, so the hosted answers stay as they are
        ...(kind === "mac" ? {} : { upload: a.upload ? uploadFrom(a.originals, a.proxies) : "none", finalsUpload: a.finals ? "all" : "none" }),
      };
      const saved = await updateLibrary(library.id, { settings });
      window.dispatchEvent(new CustomEvent(LIBRARY_SETUP_DONE, { detail: { workspace: workspace.id } }));
      onDone(saved);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const next = () => (last ? void finish() : setAt(at + 1));

  const body = (): ReactNode => {
    if (step === "start")
      return (
        <div role="radiogroup" aria-label="Where do you keep your media?" className="space-y-2">
          <Pick on={a.start === "scratch"} label="Start from scratch" tip="The app makes the folders and keeps your media in them." onPick={() => set({ start: "scratch" })} />
          <Pick on={a.start === "existing"} label="Use my existing folders" tip="Use the folders where you already keep media, for example on a NAS. Their structure is never changed." onPick={() => set({ start: "existing" })} />
        </div>
      );

    if (step === "folders") {
      if (!hasThisMac())
        return (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Folders are added in the Mac app.</p>
          </div>
        );
      return (
        <div className="space-y-5">
          {a.start === "scratch" ? (
            <Card>
              <Row title={LIBRARY_WORDS.defaultFolders.label} tip={LIBRARY_WORDS.defaultFolders.tip} control={<Switch aria-label={LIBRARY_WORDS.defaultFolders.label} checked={a.defaults} onCheckedChange={(v) => set({ defaults: v })} />} />
              {!a.defaults && (
                <>
                  <FolderRow title="Source media" tip={SOURCE_TIP} paths={a.sources} button="Set…" submit="Set" onAdd={(p) => set({ sources: [p] })} />
                  <FolderRow title="Project files" tip={PROJECTS_TIP} paths={a.projects ? [a.projects] : []} button="Set…" submit="Set" onAdd={(p) => set({ projects: p })} />
                  <FolderRow title="Final exports" tip={EXPORTS_TIP} paths={a.exports ? [a.exports] : []} button="Set…" submit="Set" onAdd={(p) => set({ exports: p })} />
                </>
              )}
            </Card>
          ) : (
            <>
              <Card>
                <FolderRow title="Source media" tip={SOURCE_TIP} paths={a.sources} button="Add folder…" submit="Add" onAdd={(p) => set({ sources: [...a.sources, p] })} />
              </Card>
              <Card>
                <Row title={LIBRARY_WORDS.defaultFolders.label} tip={NEXT_TO_SOURCE} control={<Switch aria-label={LIBRARY_WORDS.defaultFolders.label} checked={a.defaults} onCheckedChange={(v) => set({ defaults: v })} />} />
                {!a.defaults && (
                  <>
                    <FolderRow title="Project files" tip={PROJECTS_TIP} paths={a.projects ? [a.projects] : []} button="Set…" submit="Set" onAdd={(p) => set({ projects: p })} />
                    <FolderRow title="Final exports" tip={EXPORTS_TIP} paths={a.exports ? [a.exports] : []} button="Set…" submit="Set" onAdd={(p) => set({ exports: p })} />
                  </>
                )}
              </Card>
            </>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">{LIBRARY_WORDS.importTitle}</p>
            <div role="radiogroup" aria-label={LIBRARY_WORDS.importTitle} className="space-y-2">
              <Pick on={a.copy} label={LIBRARY_WORDS.importCopy.label} tip={LIBRARY_WORDS.importCopy.tip} onPick={() => set({ copy: true })} />
              <Pick on={!a.copy} label={LIBRARY_WORDS.importInPlace.label} tip={LIBRARY_WORDS.importInPlace.tip} onPick={() => set({ copy: false })} />
            </div>
          </div>
        </div>
      );
    }

    if (step === "proxy")
      return (
        <Card>
          <Row title={LIBRARY_WORDS.generateProxies.label} tip={LIBRARY_WORDS.generateProxies.tip} control={<Switch aria-label={LIBRARY_WORDS.generateProxies.label} checked={a.proxy} onCheckedChange={(v) => set({ proxy: v })} />} />
          {a.proxy && (
            <Row title={LIBRARY_WORDS.proxyQuality.label} tip={LIBRARY_WORDS.proxyQuality.tip}>
              <div role="radiogroup" aria-label={LIBRARY_WORDS.proxyQuality.label} className="space-y-2">
                {PROXY_QUALITIES.map((q) => (
                  <Pick key={q.value} on={a.proxyQuality === q.value} label={q.label} onPick={() => set({ proxyQuality: q.value })} />
                ))}
              </div>
            </Row>
          )}
        </Card>
      );

    if (step === "analysis") {
      const idx = ANALYSIS_LEVELS.findIndex((l) => l.value === a.effort);
      return (
        <div className="space-y-5">
          <Card>
            <Row title={LIBRARY_WORDS.effort} tip={LIBRARY_WORDS.effortTips[a.effort]}>
              <input
                type="range"
                min={0}
                max={ANALYSIS_LEVELS.length - 1}
                step={1}
                value={idx}
                aria-label={LIBRARY_WORDS.effort}
                onChange={(e) => {
                  const level = ANALYSIS_LEVELS[Number(e.target.value)]!.value;
                  // Smart folders sort by descriptions, so with Analysis off they are Organize yourself
                  set(level === "off" ? { effort: level, organize: "own" } : { effort: level });
                }}
                className="w-full accent-[var(--tint)]"
              />
              <div className="mt-1 grid grid-cols-6 text-center text-xs text-muted-foreground">
                {ANALYSIS_LEVELS.map((l) => (
                  <span key={l.value}>
                    {l.label}
                    {l.value === ANALYSIS_DEFAULT && <span className="block text-[10px]">Recommended</span>}
                  </span>
                ))}
              </div>
            </Row>
            <Row
              title="Monthly budget"
              tip={BUDGET_TIP}
              control={
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" aria-label="No limit" checked={a.budget === null} onChange={(e) => set({ budget: e.target.checked ? null : LOOK_BUDGET_DEFAULT })} />
                  No limit
                </label>
              }
            >
              {a.budget !== null && (
                <Input
                  type="number"
                  min={0}
                  aria-label="Monthly budget in dollars"
                  value={a.budget}
                  onChange={(e) => set({ budget: Math.max(0, Number(e.target.value) || 0) })}
                  className="w-32"
                />
              )}
            </Row>
          </Card>
          <div className="space-y-2">
            <p className="text-sm font-medium">{LIBRARY_WORDS.organizationTitle}</p>
            <div role="radiogroup" aria-label={LIBRARY_WORDS.organizationTitle} className="space-y-2">
              <Pick
                on={a.organize === "ai"}
                disabled={a.effort === "off"}
                label={LIBRARY_WORDS.smartFolders.label}
                tip={LIBRARY_WORDS.smartFolders.tip}
                status={a.effort === "off" ? "Analysis is Off" : undefined}
                onPick={() => set({ organize: "ai" })}
              />
              <Pick on={a.organize === "own"} label={LIBRARY_WORDS.organizeYourself.label} tip={LIBRARY_WORDS.organizeYourself.tip} onPick={() => set({ organize: "own" })} />
            </div>
          </div>
        </div>
      );
    }

    // hosted: only on a server or Cloud
    return (
      <Card>
        <Row
          title={LIBRARY_WORDS.uploadToServer}
          control={<Switch aria-label={LIBRARY_WORDS.uploadToServer} checked={a.upload} onCheckedChange={(v) => set({ upload: v, ...(v ? { proxies: true, proxy: true } : {}) })} />}
        />
        {a.upload && (
          <>
            <Row title={LIBRARY_WORDS.originals} control={<Switch aria-label={LIBRARY_WORDS.originals} checked={a.originals} onCheckedChange={(v) => set({ originals: v })} />} />
            <Row title={LIBRARY_WORDS.proxies} control={<Switch aria-label={LIBRARY_WORDS.proxies} checked={a.proxies} onCheckedChange={(v) => set({ proxies: v, ...(v ? { proxy: true } : {}) })} />} />
          </>
        )}
        <Row title={LIBRARY_WORDS.finalExportsUpload.label} tip={LIBRARY_WORDS.finalExportsUpload.tip} control={<Switch aria-label={LIBRARY_WORDS.finalExportsUpload.label} checked={a.finals} onCheckedChange={(v) => set({ finals: v })} />} />
      </Card>
    );
  };

  const lead =
    step === "start"
      ? "Where do you keep your media?"
      : step === "folders"
        ? "Where your media and your work are kept."
        : step === "proxy"
          ? "Smaller copies keep playback and editing fast."
          : step === "analysis"
            ? "Clips are described and tagged so you can search by what's in them. Higher effort looks closer and costs more."
            : `Choose what goes to ${serverName}, so your team can play it.`;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="flex h-[min(38rem,calc(100dvh-2rem))] w-[min(36rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <div className="space-y-1 px-6 pb-3 pt-6">
          <DialogTitle className="text-xl font-semibold">{TITLE[step]}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{lead}</DialogDescription>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {body()}
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Finish later
          </Button>
          <div className="flex items-center gap-1.5" aria-label="Steps">
            {steps.map((s, i) => (
              <span key={s} className={cn("size-1.5 rounded-full", i === at ? "bg-foreground" : "bg-foreground/20")} />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {at > 0 && (
              <Button variant="outline" disabled={busy} onClick={() => setAt(at - 1)}>
                Back
              </Button>
            )}
            <Button disabled={busy || !ok} onClick={next}>
              {last ? "Done" : "Continue"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
