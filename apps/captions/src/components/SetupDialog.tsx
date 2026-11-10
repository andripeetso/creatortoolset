import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  AtSign,
  CircleEllipsis,
  GalleryHorizontalEnd,
  GraduationCap,
  Mail,
  Megaphone,
  Mic,
  MonitorPlay,
  Newspaper,
  ScreenShare,
  Smartphone,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { TOOLS, type Tool } from "@contracts/tools";
import { MAKES, type Make } from "@contracts/work-prefs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentsStep } from "@/components/setup/AgentsStep";
import { Choice } from "@/components/setup/Choice";
import { ConnectStep, HERE } from "@/components/setup/ConnectStep";
import { FoldersStep } from "@/components/setup/FoldersStep";
import { HowPicker } from "@/components/setup/HowPicker";
import { ToolsPicker } from "@/components/setup/ToolNeeds";
import { TryStep } from "@/components/setup/TryStep";
import { canUse, useMe } from "@/lib/auth";
import { openAssistant } from "@/lib/assistant";
import { isPhoneHub } from "@/lib/mobile";
import {
  MAKE_NAMES,
  SETUP_PATH,
  dismissSetup,
  firstProjectName,
  rememberLater,
  setupFinished,
  setupOpen,
  setupOpensItself,
  setupStepFromParam,
  stepsFor,
  toolsFor,
  useSetup,
  useSetupLive,
  useSetupShown,
  useWorkPrefs,
  useWorkTalk,
  type SetupStep,
} from "@/lib/setup";
import { createProject } from "@/lib/workshop";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/** Each screen: its title and the line under it. The first three are the path; the rest open alone from a `?setup=` link. */
const STEP: Record<SetupStep, { title: string; hint: string }> = {
  agents: { title: "Connect your AI", hint: "Creator Toolset works with the ChatGPT or Claude plan you already have." },
  make: { title: "What do you make?", hint: "Pick what fits. It turns on the right tools." },
  try: { title: "Try it", hint: "Drop a video and get captions. It runs on this computer and nothing is uploaded." },
  connect: { title: "Connect your computers", hint: "Add your phone or another computer." },
  folders: {
    title: "Where are your videos?",
    hint: "Pick the folders where you keep your footage and music. The AI Editor and Media Library find your clips there. Nothing is moved or uploaded.",
  },
  how: { title: "How do you work best?", hint: "Pick where you talk to your AI." },
};

const MAKE_ICONS: Record<Make, LucideIcon> = {
  reel: Smartphone, youtube: MonitorPlay, carousel: GalleryHorizontalEnd, ad: Megaphone, podcast: Mic, course: GraduationCap,
  recording: ScreenShare, newsletter: Mail, thread: AtSign, article: Newspaper, other: CircleEllipsis,
};

const SAVED_NOTE = "Your setup is saved. You'll find the rest on Home.";
/** "Connect your AI" is about this computer only. */
const THIS_COMPUTER: ReadonlySet<string> = new Set([HERE]);
const PRIMARY = "min-w-28 bg-[var(--tint)] text-white hover:bg-[var(--tint)] hover:brightness-110";

/**
 * First-run setup in one window, the same three screens for everyone: connect your AI → what you make (ticks the tools,
 * makes the first project quietly) → try it (drop a video, get captions). Arriving on the last screen saves `done`.
 * Not now (the X, the footer link, Escape) hides it for this browser and remembers the screen; Home's card brings it
 * back. A click outside never closes it. Never shown on a phone. The other screens (`?setup=connect`, `folders`, `how`)
 * open alone and close with Done.
 */
export function SetupDialog() {
  const me = useMe();
  const real = !!me;
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const save = useSetup((s) => s.save);
  const prefs = useWorkPrefs((s) => s.prefs);
  const loadPrefs = useWorkPrefs((s) => s.load);
  const { talk, setTalk } = useWorkTalk();
  const { projects, loaded, load: loadProjects } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [ticked, setTicked] = useState<Tool[] | null>(null);
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState(false); // leaving "What do you make?" saves first: one press, one project
  const [from, setFrom] = useState<SetupStep | null>(null); // the screen a side screen was opened from: Done goes back to it
  const [footerSlot, setFooterSlot] = useState<HTMLElement | null>(null); // the folders screen portals its buttons in
  const [unsure, setUnsure] = useState<boolean | null>(null); // "Not sure yet" ticked here; null = read it from the saved answers
  const asked = params.get("setup");
  // by itself only on a first sign-in (setupOpensItself); Settings → Setup and ?setup= always open it; never on a phone
  const firstRun = setupOpensItself({ logins: me?.logins, loaded, projects: projects.length });
  const open = real && !!prefs && setupOpen(view, asked, { firstRun, phone: isPhoneHub() });
  const step: SetupStep = setupStepFromParam(asked) ?? SETUP_PATH[0];
  const arrived = open && step === "try";
  useEffect(() => {
    useSetupShown.setState({ shown: open });
    return () => useSetupShown.setState({ shown: false });
  }, [open]);

  useEffect(() => {
    if (real) void load();
  }, [real, load]);
  useEffect(() => {
    if (real) void loadPrefs();
  }, [real, loadPrefs]);
  useEffect(() => {
    if (real && !loaded) void loadProjects();
  }, [real, loaded, loadProjects]);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(false), 4000);
    return () => window.clearTimeout(t);
  }, [note]);
  // arriving on "Try it" is the end of setup, whatever she does next: it never opens by itself again
  useEffect(() => {
    if (!arrived) return;
    const v = useSetup.getState().view;
    if (!v || setupFinished(v)) return;
    const makes = useWorkPrefs.getState().prefs?.makes ?? [];
    void save({ done: true, ...(v.tools === null ? { tools: toolsFor(makes, TOOLS.filter((t) => canUse(me, t))) } : {}) }).catch(() => {});
  }, [arrived, save, me]);
  useSetupLive(open);
  // the AI panel connected one: read the setup again now, so Continue lights up without waiting for the next look
  const onConnected = useCallback((on: boolean) => void (on && load()), [load]);

  const savedNote = note ? (
    <p role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-popover px-4 py-2 text-xs text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in">
      {SAVED_NOTE}
    </p>
  ) : null;

  if (!real || !view || !prefs) return null;
  if (!open) return savedNote;

  const mine = TOOLS.filter((t) => canUse(me, t));
  const makes = prefs.makes;
  const tools = ticked ?? view.tools ?? toolsFor(makes, mine);
  const path = stepsFor();
  const at = path.indexOf(step);
  const side = at < 0;
  const connected = view.have.includes("ai");
  const to = (s: SetupStep) => setParams((p) => (p.set("setup", s), p), { replace: true });
  const leave = () => setParams((p) => (p.delete("setup"), p), { replace: true });

  const close = () => {
    if (side) {
      setFrom(null);
      return from ? to(from) : leave();
    }
    // on "Try it" setup is already saved as done: nothing to come back to
    if (step !== "try") {
      rememberLater(step);
      setNote(true);
    }
    dismissSetup();
    leave();
  };
  const saveMakes = () => useWorkPrefs.getState().put({ makes });
  const back = async () => {
    if (step === "make") await saveMakes(); // the answers survive Back
    to(path[at - 1]!);
  };
  const next = async () => {
    setBusy(true);
    try {
      if (step === "make") {
        await saveMakes();
        await save({ tools });
        const name = loaded ? firstProjectName(makes, projects.length) : null;
        if (name) await createProject({ name }).catch(() => {});
      }
      to(path[at + 1]!);
    } finally {
      setBusy(false);
    }
  };
  const goHome = () => {
    dismissSetup();
    if (connected) openAssistant();
    navigate("/");
  };
  /** A video was taken on "Try it": setup closes and Caption Studio opens with it. */
  const captioning = async () => {
    dismissSetup();
    // the tool she just used is on her Home
    if (mine.includes("captions") && !tools.includes("captions")) await save({ tools: mine.filter((t) => t === "captions" || tools.includes(t)) }).catch(() => {});
    navigate("/captions");
  };
  const setMakes = (next: Make[]) => {
    useWorkPrefs.setState({ prefs: { ...prefs, makes: next } });
    setTicked(toolsFor(next, mine));
  };
  const toggleMake = (m: Make) => {
    setUnsure(false);
    setMakes(makes.includes(m) ? makes.filter((x) => x !== m) : MAKES.filter((x) => x === m || makes.includes(x)));
  };
  // "Not sure yet" is exclusive: on = every tool on and no answer ticked; picking an answer turns it off again
  const notSure = unsure ?? (makes.length === 0 && tools.length > 0 && tools.length === mine.length);
  const pickNotSure = () => {
    setMakes([]);
    setUnsure(!notSure);
    if (!notSure) setTicked([...mine]);
  };
  const closeLabel = side ? "Close" : "Not now";

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        // a press outside (the Mac window's title bar, the page behind) never closes setup
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn(
          // as tall as the screen allows (680px at most): the header and footer stay put and only the body scrolls,
          // so a small window shows a usable step rather than a thin strip
          "flex h-[min(680px,calc(100dvh-2rem))] w-[min(820px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl shadow-black/40 sm:max-w-none",
          "max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]",
        )}
      >
        <header className="shrink-0 px-6 pt-5 sm:px-8">
          <div className="flex items-center gap-3">
            {/* a plain count that never changes: three screens, whatever was answered */}
            <p className="flex-1 text-xs font-medium tabular-nums text-muted-foreground">{!side && `${at + 1} of ${path.length}`}</p>
            <button
              type="button"
              onClick={close}
              aria-label={closeLabel}
              title={closeLabel}
              className="-mr-2 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
          <DialogTitle className="mt-4 text-2xl font-semibold tracking-tight">{STEP[step].title}</DialogTitle>
          <DialogDescription className="mt-1.5 text-sm">{STEP[step].hint}</DialogDescription>
        </header>

        <div
          key={step}
          className={cn(
            "min-h-0 flex-1 px-6 pb-5 pt-5 sm:px-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200",
            // "Connect your AI": the list scrolls by itself, so the two controls under it are always in view
            step === "agents" ? "flex flex-col overflow-hidden" : "overflow-y-auto",
          )}
        >
          {step === "agents" && (
            <>
              <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 sm:-mx-8 sm:px-8">
                <AgentsStep picked={THIS_COMPUTER} onConnectedChange={onConnected} />
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 px-1 pt-4">
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted-foreground hover:text-foreground">
                  <Checkbox
                    checked={talk === "both" || talk === "chat"}
                    onCheckedChange={(v) => void setTalk(v === true ? "both" : "app")}
                    className="data-[state=checked]:border-[var(--tint)] data-[state=checked]:bg-[var(--tint)] data-[state=checked]:text-white dark:data-[state=checked]:bg-[var(--tint)]"
                  />
                  Also let my own Claude Code or Codex use Creator Toolset
                </label>
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  onClick={() => {
                    setFrom(step);
                    to("connect");
                  }}
                >
                  I was invited to a team
                </button>
              </div>
            </>
          )}

          {step === "make" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-1.5 min-[720px]:grid-cols-3" role="group" aria-label="What do you make?">
                {MAKES.map((m) => (
                  <Choice key={m} dense multi on={!notSure && makes.includes(m)} onClick={() => toggleMake(m)} icon={MAKE_ICONS[m]} name={MAKE_NAMES[m]} />
                ))}
                <Choice dense multi on={notSure} onClick={pickNotSure} icon={Sparkles} name="Not sure yet, show me everything" />
              </div>
              <details className="group rounded-xl border border-border/60 bg-card/40">
                <summary className="cursor-pointer list-none px-4 py-3 text-sm text-muted-foreground hover:text-foreground">Your tools: {tools.length} on</summary>
                <div className="px-4 pb-4">
                  <ToolsPicker tools={mine} value={tools} onChange={setTicked} />
                </div>
              </details>
            </div>
          )}

          {step === "try" && <TryStep onStart={captioning} />}

          {step === "connect" && <ConnectStep picked={THIS_COMPUTER} onPick={() => {}} />}

          {step === "folders" && <FoldersStep onNext={close} actions={footerSlot} />}

          {step === "how" && <HowPicker value={prefs.talk} onChange={(t) => void setTalk(t)} />}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
          {/* a side screen only has Done */}
          {!side ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={close}>
              Not now
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {at > 0 && (
              <Button variant="ghost" onClick={() => void back()}>
                Back
              </Button>
            )}
            {/* the folders screen puts its own buttons here (Skip for now, Use these N folders) */}
            {step === "folders" && <div ref={setFooterSlot} className="flex items-center gap-2" />}
            {side && step !== "folders" && (
              <Button onClick={close} className={PRIMARY}>
                Done
              </Button>
            )}
            {step === "agents" && !connected && (
              <Button variant="ghost" className="text-muted-foreground" onClick={() => void next()}>
                Skip for now
              </Button>
            )}
            {(step === "agents" || step === "make") && (
              <Button onClick={() => void next()} disabled={busy || (step === "agents" && !connected)} className={PRIMARY}>
                Continue
              </Button>
            )}
            {step === "try" && (
              <Button variant="ghost" className="text-muted-foreground" onClick={goHome}>
                Skip, take me to Home
              </Button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
