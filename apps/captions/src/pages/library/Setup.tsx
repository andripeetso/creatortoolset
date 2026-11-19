import { useState, type DragEvent, type ReactNode } from "react";
import { Cloud, FolderOpen, Gauge, ScanSearch, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, InfoTip, Row } from "@/components/settings/kit-rows";
import { hasThisMac } from "@/components/settings/ThisMacSection";
import { call, STORAGE_API } from "@/components/settings/StorageRows";
import { updateLibrary } from "@/lib/library";
import { chooseFolderOnMac, droppedOnMac, pairThisMac } from "@/lib/thisMac";
import { thisMacDevice } from "@/lib/providers";
import { useAuth, useMe } from "@/lib/auth";
import { currentProject, useWorkspace } from "@/lib/workspace";
import { ModelRows } from "./settings/Models";
import { HostedSwitches } from "./settings/Hosted";
import { EffortCost } from "./settings/Effort";
import { cn } from "@/lib/utils";
import {
  ANALYSIS_DEFAULT,
  ANALYSIS_LEVELS,
  LIBRARY_SETUP_DONE,
  LIBRARY_WORDS,
  LOOK_BUDGET_DEFAULT,
  PROXY_QUALITIES,
  WATCH_MODELS,
  flagsOf,
  HOSTED_DEFAULT,
  hostedSettings,
  type AnalysisLevel,
  type HostedMix,
  type LibrarySettings,
  type LibrarySummary,
  type ProxyQuality,
  type WatchModel,
} from "@contracts/library";
import { EXPORTS_NAME, FOLDER_LABELS, LIBRARY_NAME, LIBRARY_SUBFOLDERS, PROJECTS_NAME, THIS_COMPUTER, type StorageRole } from "@contracts/storage";

/**
 * The owner's Media Library setup (UNIFIED-PRD §3.3, SCREENS-COPY §4): one fixed-size sheet, the steps in dependency
 * order (where the media is, then proxies, analysis and organization, then hosted media on a server or Cloud). Done
 * writes the folder rows through the one folder list, then the library settings with setupAt, then dispatches
 * LIBRARY_SETUP_DONE. Until the library is set up it is the Library page itself (`inline`: no way to close it); opened
 * again later (?setup=1) it is a sheet, and Finish later closes it and writes nothing. Folders are picked in the Mac
 * app's folder window, or dropped on the step; a drop on the setup never reaches the Library behind it.
 */

export type Kind = "mac" | "server" | "cloud";
type Start = "scratch" | "existing";
type Step = "start" | "folders" | "proxy" | "analysis" | "hosted";

interface Answers {
  start: Start;
  /** Source media folders chosen on this computer; from scratch, none = the default folder */
  sources: string[];
  /** "" = the default: beside the first Source media folder (from scratch, in the workspace's folder) */
  projects: string;
  exports: string;
  /** How should imported media behave? true: copied into Source media (the default) */
  copy: boolean;
  proxy: boolean;
  proxyQuality: ProxyQuality;
  effort: AnalysisLevel;
  /** the Video breakdown model (shown at High and above) */
  watchModel: WatchModel;
  /** dollars a month; null: No limit (the default for a new library) */
  budget: number | null;
  organize: "ai" | "own";
  hosted: HostedMix;
}

const START: Answers = {
  start: "scratch",
  sources: [],
  projects: "",
  exports: "",
  copy: true,
  proxy: true,
  proxyQuality: "standard",
  effort: ANALYSIS_DEFAULT,
  watchModel: WATCH_MODELS[0]!.value,
  budget: null,
  organize: "ai",
  hosted: HOSTED_DEFAULT,
};

const stepsFor = (kind: Kind): Step[] => (kind === "mac" ? ["start", "folders", "proxy", "analysis"] : ["start", "folders", "proxy", "analysis", "hosted"]);

const TITLE: Record<Step, string> = {
  start: LIBRARY_WORDS.setupTitle,
  folders: LIBRARY_WORDS.foldersTitle,
  proxy: LIBRARY_WORDS.proxyTitle,
  analysis: LIBRARY_WORDS.analysisStep,
  hosted: LIBRARY_WORDS.hostedTitle,
};

const ICON: Record<Step, LucideIcon> = { start: FolderOpen, folders: FolderOpen, proxy: Gauge, analysis: ScanSearch, hosted: Cloud };

const BESIDE_SOURCE = "Beside your first Source media folder";
const NO_COMPUTER = "Connect this Mac to the server first: Settings → Computers.";
const PAIR_WAIT_MS = 10_000;
const PAIR_SLOW = "This Mac didn't answer. Open Settings → Computers and connect it, then press Done again.";
const NOT_KEPT = "The server didn't keep the setup. Press Done again; if it says this again, the server needs an update.";
/** A Mac-app call that may never answer (an older app, a closed bridge) stops waiting after `ms`, with `why`. */
const within = <T,>(p: Promise<T>, ms: number, why: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(why)), ms))]);
const MAC_DOWNLOAD = "https://creatortoolset.com/download";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Hosted media's Proxies forces the proxy switch on (SCREENS-COPY §1). */
const proxiesHosted = (a: Answers): boolean => a.hosted.proxies;
/** No folder picked by hand: the default folders (the owner page's Use default folders). */
const defaultsOf = (a: Answers): boolean => !a.projects && !a.exports && (a.start === "existing" || a.sources.length === 0);

/** The folders the answers name, as rows of the one folder list (the scratch paths sit in ~/Movies/Creator Toolset/<workspace>). */
export function rowsOf(a: Answers, workspace: string): { role: StorageRole; path: string }[] {
  const base = `~/Movies/${LIBRARY_NAME}/${workspace.replace(/\//g, "-")}`;
  const footage = a.start === "scratch" ? [a.sources[0] ?? `${base}/${LIBRARY_SUBFOLDERS.footage}`] : a.sources;
  // Project files and Final exports: beside the first Source media folder (the parent of it)
  const near = a.start === "scratch" && a.sources.length === 0 ? base : (footage[0] ?? "").replace(/\/[^/]*\/?$/, "");
  const projects = a.projects || `${near}/${PROJECTS_NAME}`;
  const exports = a.exports || `${near}/${EXPORTS_NAME}`;
  return [
    ...footage.map((path) => ({ role: "footage" as const, path })),
    { role: "projects", path: projects },
    { role: "library", path: exports },
  ];
}

/** The folders step is complete: from scratch always (the defaults), with existing folders once one is picked. */
const folderOk = (a: Answers): boolean => a.start === "scratch" || a.sources.length > 0;

/** The small picture of a Smart folders / Organize yourself option (decoration, read by no one). */
function OrganizeArt({ smart }: { smart: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 56 40" className="h-10 w-14 shrink-0 text-foreground/60">
      {smart ? (
        <>
          <rect x="4" y="8" width="20" height="24" rx="3" fill="currentColor" opacity=".25" />
          <rect x="32" y="8" width="20" height="24" rx="3" fill="currentColor" opacity=".25" />
          <circle cx="14" cy="20" r="3" fill="currentColor" />
          <circle cx="42" cy="20" r="3" fill="currentColor" />
        </>
      ) : (
        <>
          <rect x="6" y="6" width="44" height="6" rx="2" fill="currentColor" opacity=".35" />
          <rect x="6" y="17" width="34" height="6" rx="2" fill="currentColor" opacity=".35" />
          <rect x="6" y="28" width="40" height="6" rx="2" fill="currentColor" opacity=".35" />
        </>
      )}
    </svg>
  );
}

/** A radio option: the name, its ⓘ tip, a status line when it says why it is off, and an optional picture. */
function Pick({ on, disabled, label, tip, status, art, onPick }: { on: boolean; disabled?: boolean; label: string; tip?: string; status?: string; art?: ReactNode; onPick: () => void }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-xl border px-3 py-2.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--tint)]", on ? "border-[var(--tint)] bg-[color-mix(in_srgb,var(--tint)_7%,transparent)]" : "border-border/70")}>
      <button
        type="button"
        role="radio"
        aria-checked={on}
        disabled={disabled}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none disabled:opacity-50"
      >
        <span className={cn("size-4 shrink-0 rounded-full border", on ? "border-[var(--tint)] bg-[var(--tint)] shadow-[inset_0_0_0_3px_var(--background)]" : "border-foreground/25")} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          {status && <span className="block text-xs text-muted-foreground">{status}</span>}
        </span>
        {art}
      </button>
      {tip && <InfoTip text={tip} label={label} />}
    </div>
  );
}

/** A long path breaks after a slash, never inside a folder's name (a zero-width space; shown only, the path is kept as it is). */
const wrapAtSlashes = (p: string) => p.replace(/\//g, "/\u200b");

/** A folder row: its path (or `empty`), and a button that opens the Mac app's folder window. */
function FolderRow({ title, tip, path, empty = LIBRARY_WORDS.notSet, onPick }: { title: string; tip: string; path: string | null; empty?: string; onPick: (p: string) => void }) {
  return (
    <Row
      title={title}
      tip={tip}
      status={path ? <span title={path}>{wrapAtSlashes(path)}</span> : empty}
      control={
        <Button size="sm" variant="outline" onClick={() => void chooseFolderOnMac().then((p) => p && onPick(p))}>
          {path ? LIBRARY_WORDS.changeFolder : LIBRARY_WORDS.chooseFolder}
        </Button>
      }
    />
  );
}

/**
 * The setup. `watchAllowed`: the server reads this computer's folders (This Mac). `onDone` gets the saved library.
 * `inline`: the Library page itself until the library is set up, with nothing to close it.
 */
export function LibrarySetup({ library, watchAllowed, inline = false, onDone, onClose }: { library: LibrarySummary; watchAllowed: boolean; inline?: boolean; onDone: (l: LibrarySummary) => void; onClose: () => void }) {
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
  const levelIdx = ANALYSIS_LEVELS.findIndex((l) => l.value === a.effort);
  const videoLevel = levelIdx >= ANALYSIS_LEVELS.findIndex((l) => l.value === "high");

  // a row the folder list refuses because it is already there is what the person wanted; the scratch default is made first
  const addRow = (host: string, role: StorageRole, path: string, make: boolean) =>
    call(`${STORAGE_API}/folders`, "POST", { role, host, path, ...(make ? { make: true } : {}) }, workspace.id || undefined).catch((e: unknown) => {
      if (!/already/i.test(message(e))) throw e;
    });
  // the computer the folders are on: "this computer" where the server runs on it, else this Mac as the server knows it
  // (paired now when it isn't yet), as Settings → Folders adds them
  const computer = async (): Promise<string> => {
    if (kind === "mac") return THIS_COMPUTER;
    const id = thisMacDevice() ?? (await pairThisMac())?.device;
    if (!id) throw new Error(NO_COMPUTER);
    return id;
  };
  const addSources = (paths: string[]) => set({ sources: a.start === "scratch" ? paths.slice(0, 1) : [...a.sources, ...paths.filter((p) => !a.sources.includes(p))] });
  // Finder folders dropped on the setup: on the Folders step they are the Source media folders; anywhere, nothing is imported
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (step !== "folders" || !hasThisMac()) return;
    void droppedOnMac().then((items) => {
      const folders = (items ?? []).filter((i) => i.folder).map((i) => i.path);
      if (folders.length) addSources(folders);
    });
  };
  const holdDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    // every step names itself in the one red line if it fails; the settings (with setupAt) are saved last, so a setup
    // that stops part way is not marked done, and Done again picks up where it stopped (rows already there are skipped)
    let doing = "This Mac";
    try {
      // the folders are rows of the one list; without the Mac app there is no computer to add them on
      if (hasThisMac()) {
        const made = a.start === "scratch" && a.sources.length === 0;
        const host = await within(computer(), PAIR_WAIT_MS, PAIR_SLOW);
        for (const r of rowsOf(a, workspace.name)) {
          doing = `${FOLDER_LABELS[r.role]} folder`;
          await addRow(host, r.role, r.path, made && r.role === "footage");
        }
      }
      doing = "Saving the setup";
      const settings: Partial<LibrarySettings> = {
        importMode: a.copy ? "copy" : "in-place",
        // Smart folders need Analysis: with it off the answer is Organize yourself, kept as chosen while the pick is off
        organize: a.effort === "off" ? "own" : a.organize,
        proxy: a.proxy || proxiesHosted(a),
        proxyQuality: a.proxyQuality,
        ...flagsOf(a.effort),
        timelineModel: a.watchModel,
        lookBudget: a.budget,
        defaultFolders: defaultsOf(a),
        setupAt: new Date().toISOString(),
        // a library on This Mac has no server to upload to, so the hosted answers stay as they are
        ...(kind === "mac" ? {} : hostedSettings(a.hosted)),
      };
      const saved = await updateLibrary(library.id, { settings });
      // a reply without setupAt leaves this page on the setup: say so rather than do nothing
      if (!saved.settings.setupAt) throw new Error(NOT_KEPT);
      window.dispatchEvent(new CustomEvent(LIBRARY_SETUP_DONE, { detail: { workspace: workspace.id } }));
      onDone(saved);
    } catch (e) {
      setError(`${doing}: ${message(e)}`);
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
      const rows = rowsOf(a, workspace.name);
      const projects = rows.at(-2)!.path;
      const exports = rows.at(-1)!.path;
      const beside = a.start === "existing" && a.sources.length === 0;
      return (
        <div className="space-y-5">
          {!hasThisMac() ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{LIBRARY_WORDS.folderInMacApp}</p>
              <Button variant="outline" onClick={() => window.open(MAC_DOWNLOAD, "_blank", "noopener")}>
                {LIBRARY_WORDS.downloadMacApp}
              </Button>
            </div>
          ) : (
            <>
              <Card>
                {a.start === "scratch" ? (
                  <FolderRow title={FOLDER_LABELS.footage} tip={LIBRARY_WORDS.sourceMediaTip} path={rows[0]!.path} onPick={(p) => set({ sources: [p] })} />
                ) : (
                  <Row
                    title={FOLDER_LABELS.footage}
                    tip={LIBRARY_WORDS.sourceMediaTip}
                    status={a.sources.length ? undefined : LIBRARY_WORDS.notSet}
                    control={
                      <Button size="sm" variant="outline" onClick={() => void chooseFolderOnMac().then((p) => p && addSources([p]))}>
                        {LIBRARY_WORDS.addFolder}
                      </Button>
                    }
                  >
                    {a.sources.map((p) => (
                      <div key={p} className="flex items-center gap-2">
                        <span title={p} className="min-w-0 flex-1 text-xs text-muted-foreground">{wrapAtSlashes(p)}</span>
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => set({ sources: a.sources.filter((x) => x !== p) })}>
                          {LIBRARY_WORDS.removeFolder}
                        </Button>
                      </div>
                    ))}
                  </Row>
                )}
              </Card>
              <div className="space-y-2">
                <p className="text-sm font-medium">{LIBRARY_WORDS.importTitle}</p>
                <div role="radiogroup" aria-label={LIBRARY_WORDS.importTitle} className="space-y-2">
                  <Pick on={a.copy} label={LIBRARY_WORDS.importCopy.label} tip={LIBRARY_WORDS.importCopy.tip} onPick={() => set({ copy: true })} />
                  <Pick on={!a.copy} label={LIBRARY_WORDS.importInPlace.label} tip={LIBRARY_WORDS.importInPlace.tip} onPick={() => set({ copy: false })} />
                </div>
              </div>
              <Card>
                <FolderRow title={FOLDER_LABELS.projects} tip={LIBRARY_WORDS.projectFilesTip} path={beside && !a.projects ? null : projects} empty={BESIDE_SOURCE} onPick={(p) => set({ projects: p })} />
                <FolderRow title={FOLDER_LABELS.library} tip={LIBRARY_WORDS.finalExportsTip} path={beside && !a.exports ? null : exports} empty={BESIDE_SOURCE} onPick={(p) => set({ exports: p })} />
              </Card>
            </>
          )}
        </div>
      );
    }

    if (step === "proxy") {
      const hosted = proxiesHosted(a);
      return (
        <Card>
          <Row
            title={LIBRARY_WORDS.generateProxies.label}
            tip={LIBRARY_WORDS.generateProxies.tip}
            status={hosted ? LIBRARY_WORDS.proxiesHostedOn : undefined}
            control={<Switch aria-label={LIBRARY_WORDS.generateProxies.label} checked={a.proxy || hosted} disabled={hosted} onCheckedChange={(v) => set({ proxy: v })} />}
          />
          {(a.proxy || hosted) && (
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
    }

    if (step === "analysis")
      return (
        <div className="space-y-5">
          <Card>
            <Row title={LIBRARY_WORDS.effort} tip={LIBRARY_WORDS.effortTips[a.effort]} control={<EffortCost libraryId={library.id} level={a.effort} />}>
              <input
                type="range"
                min={0}
                max={ANALYSIS_LEVELS.length - 1}
                step={1}
                value={levelIdx}
                aria-label={LIBRARY_WORDS.effort}
                onChange={(e) => set({ effort: ANALYSIS_LEVELS[Number(e.target.value)]!.value })}
                className="w-full accent-[var(--tint)]"
              />
              <div className="mt-1 grid grid-cols-6 text-center text-xs text-muted-foreground">
                {ANALYSIS_LEVELS.map((l) => (
                  <span key={l.value}>
                    {l.label}
                    {l.value === ANALYSIS_DEFAULT && <span className="block text-[10px]">{LIBRARY_WORDS.recommended}</span>}
                  </span>
                ))}
              </div>
            </Row>
          </Card>
          <div className="text-center">
            <Popover>
              <PopoverTrigger className="text-sm text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline">
                {`${LIBRARY_WORDS.budget.label}: ${a.budget === null ? LIBRARY_WORDS.budget.noLimit : `$${a.budget}`}`}
              </PopoverTrigger>
              <PopoverContent className="w-72 space-y-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {LIBRARY_WORDS.budget.label}
                  <InfoTip text={LIBRARY_WORDS.budget.tip} label={LIBRARY_WORDS.budget.label} />
                </p>
                <div className="flex items-center gap-2 text-sm">
                  $
                  <Input
                    type="number"
                    min={0}
                    aria-label="Monthly budget in dollars"
                    value={a.budget ?? ""}
                    disabled={a.budget === null}
                    onChange={(e) => set({ budget: Math.max(0, Number(e.target.value) || 0) })}
                    className="w-24"
                  />
                  {LIBRARY_WORDS.budget.amount}
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" aria-label={LIBRARY_WORDS.budget.noLimit} checked={a.budget === null} onChange={(e) => set({ budget: e.target.checked ? null : LOOK_BUDGET_DEFAULT })} />
                  {LIBRARY_WORDS.budget.noLimit}
                </label>
              </PopoverContent>
            </Popover>
          </div>
          {a.effort !== "off" && (
            <div className="space-y-2">
              <p className="text-sm font-medium">{LIBRARY_WORDS.modelsTitle}</p>
              <Card>
                <ModelRows level={a.effort} timeline={videoLevel} transcribe video={a.watchModel} onVideo={(v) => set({ watchModel: v })} />
              </Card>
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">{LIBRARY_WORDS.organizationTitle}</p>
            <div role="radiogroup" aria-label={LIBRARY_WORDS.organizationTitle} className="space-y-2">
              <Pick
                on={a.organize === "ai"}
                disabled={a.effort === "off"}
                label={LIBRARY_WORDS.smartFolders.label}
                tip={LIBRARY_WORDS.smartFolders.tip}
                status={a.effort === "off" ? LIBRARY_WORDS.analysisOff : LIBRARY_WORDS.smartFoldersStatus}
                art={<OrganizeArt smart />}
                onPick={() => set({ organize: "ai" })}
              />
              <Pick
                on={a.organize === "own"}
                label={LIBRARY_WORDS.organizeYourself.label}
                tip={LIBRARY_WORDS.organizeYourself.tip}
                status={LIBRARY_WORDS.organizeYourselfStatus}
                art={<OrganizeArt smart={false} />}
                onPick={() => set({ organize: "own" })}
              />
            </div>
          </div>
        </div>
      );

    // hosted: only on a server or Cloud
    return (
      <Card>
        <HostedSwitches value={a.hosted} onChange={(m) => set({ hosted: m })} />
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
  const Icon = ICON[step];

  const head = (
    <>
      <span aria-hidden className="grid size-11 place-items-center rounded-2xl bg-[color-mix(in_srgb,var(--tint)_12%,transparent)] text-[var(--tint)]">
        <Icon className="size-5" />
      </span>
      {inline ? <h1 className="text-xl font-semibold">{TITLE[step]}</h1> : <DialogTitle className="text-xl font-semibold">{TITLE[step]}</DialogTitle>}
      {inline ? <p className="text-sm text-muted-foreground">{lead}</p> : <DialogDescription className="text-sm text-muted-foreground">{lead}</DialogDescription>}
    </>
  );
  const sheet = (
    <div className="flex h-full min-h-0 flex-col" onDragOver={holdDrag} onDragEnter={holdDrag} onDrop={onDrop}>
      <div className="space-y-2 px-6 pb-3 pt-6">{head}</div>
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {body()}
      </div>
      {/* by the buttons, never scrolled out of sight */}
      {error && (
        <p role="alert" className="border-t px-6 pt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t px-6 py-4">
        {inline ? (
          <span />
        ) : (
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Finish later
          </Button>
        )}
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
    </div>
  );

  // not set up yet: the page is the setup, in the sheet's own size, with nothing to close it
  if (inline)
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-8">
        <section aria-label={LIBRARY_WORDS.setupTitle} className="h-[min(38rem,calc(100dvh-8rem))] w-[min(36rem,100%)] overflow-hidden rounded-2xl border bg-background shadow-sm">
          {sheet}
        </section>
      </div>
    );
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      {/* no option focused on open: the first one showed a focus ring before anything was pressed */}
      <DialogContent onOpenAutoFocus={(e) => e.preventDefault()} className="flex h-[min(38rem,calc(100dvh-2rem))] w-[min(36rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        {sheet}
      </DialogContent>
    </Dialog>
  );
}
