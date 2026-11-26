import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import type { LibrarySummary } from "@contracts/library";
import { X } from "lucide-react";
import { TOOLS } from "@contracts/tools";
import type { Job } from "@contracts/work-prefs";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { saveFailed } from "@/components/settings/kit-controls";
import { AccountSetupView, offersAccount, useMacAccount } from "@/components/setup/AccountStep";
import { AgentsStep } from "@/components/setup/AgentsStep";
import { ConnectStep, HERE } from "@/components/setup/ConnectStep";
import { HelperPair, HelperSetup } from "@/components/setup/HelperStep";
import { hasThisMac, useThisMac } from "@/components/settings/ThisMacSection";
import type { ProvidersView } from "@contracts/providers";
import { useCachedLoad } from "@/lib/local-cache";
import { getProviders } from "@/lib/providers";
import { HowPicker, PictureCard } from "@/components/setup/HowPicker";
import { LookArt } from "@/components/setup/HowArt";
import { JobStep } from "@/components/setup/JobStep";
import { SetupChecklist } from "@/components/setup/SetupChecklist";
import { SocialStep } from "@/components/setup/SocialStep";
import { LibrarySetup } from "@/pages/library/Setup";
import { getWatch, listLibraries } from "@/lib/library";
import { useShareTheme, type ThemeChoice } from "@/components/ShareTheme";
import { OwnAiStep } from "@/components/setup/OwnAiStep";
import { canUse, useMe } from "@/lib/auth";
import { openAssistant } from "@/lib/assistant";
import { primeIntroSound } from "@/lib/intro-sound";
import { isPhoneHub } from "@/lib/mobile";
import {
  SETUP_PATH,
  dismissSetup,
  firstProjectName,
  markIntroSeen,
  introPlays,
  introSeen,
  rememberLater,
  setupFinished,
  setupOpen,
  setupOpensItself,
  setupStepFromParam,
  startIntro,
  stepsFor,
  setupAsked,
  stillMotion,
  toolsWithJob,
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

/** Each screen: its title and the line under it (none on the two that need none). The first five are the path, with `own` after them for an own-AI answer; the rest open alone from a `?setup=` link. */
const STEP: Record<SetupStep, { title: string; hint: string }> = {
  theme: { title: "Pick your look", hint: "" },
  job: { title: "What do you want to do first?", hint: "" },
  agents: { title: "Connect your AI", hint: "Creator Toolset works with the ChatGPT, Claude, Google, Grok or Meta plan you already have." },
  connect: { title: "Connect your computers", hint: "Add a phone or another computer." },
  folders: {
    title: "Where are your videos?",
    hint: "The folders with footage, music and sound effects, read by the Editor and the Media Library.",
  },
  how: { title: "How do you work best?", hint: "" },
  social: { title: "Connect your social accounts", hint: "A sign-in lets the app read your own numbers." },
  check: { title: "Setup checklist", hint: "What each tool turned on needs, and what else it can do." },
  own: { title: "Add Creator Toolset to an AI app", hint: "Installs Creator Toolset in the AI apps on this computer." },
  // the screen is a sign-in card with its own title and words (setup/AccountStep.tsx): this title is read out, not shown
  account: { title: "Account", hint: "" },
  // titled with the other computer's name when there is one (SetupDialog)
  helper: { title: "Help with heavy work", hint: "This computer makes drafts and renders when the other computer is busy." },
};

/** "Pick your look": the choices Settings → Appearance has, under setup's names. */
const LOOK_CHOICES: Array<{ id: ThemeChoice; name: string }> = [
  { id: "system", name: "System" },
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
];

const SAVED_NOTE = "Setup saved";
/** "Connect your AI" is about this computer only. */
const THIS_COMPUTER: ReadonlySet<string> = new Set([HERE]);
const PRIMARY = "min-w-28 bg-[var(--tint)] text-white hover:bg-[var(--tint)] hover:brightness-110";

/**
 * First-run setup in one window, four screens for everyone: your look (the theme, set as Settings → Appearance sets it)
 * → connect your AI → what you want to do first (the choice alone) → how you work best (in the app, or with an AI app too), then Home. "With an AI app" gets
 * one more screen first, where Creator Toolset is installed in the AI apps on this computer. Leaving the
 * last screen saves `done`; no job to do is asked of her. Not now (the X, the footer link, Escape) hides it for this
 * browser and remembers the screen; Home's card brings it back. A click outside never closes it. Never shown on a
 * phone. The other screens (`?setup=connect`, `folders`, `own`) open alone and close with Done, and so does any path
 * screen opened with `&alone=1` (the assistant's and a tool's Connect your AI open just that one).
 */
export function SetupDialog() {
  const me = useMe();
  const real = !!me;
  const view = useSetup((s) => s.view);
  const load = useSetup((s) => s.load);
  const save = useSetup((s) => s.save);
  const prefs = useWorkPrefs((s) => s.prefs);
  const loadPrefs = useWorkPrefs((s) => s.load);
  const { setTalk } = useWorkTalk();
  const theme = useShareTheme();
  const { projects, loaded, load: loadProjects } = useWorkspace();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState(false); // a press saves first: one press, one workspace
  const [library, setLibrary] = useState<LibrarySummary | null>(); // "Where are your videos?": the library its setup is for (null: none)
  const [ownSlot, setOwnSlot] = useState<HTMLElement | null>(null); // where the AI apps screen shows its rows
  const [accountStep, setAccountStep] = useState(false); // the Mac app offered a sign-in during this setup: its screen stays in the path
  const asked = setupAsked(useLocation().pathname, params.get("setup"));
  // the Help screen: this Mac, and the account's other computers. It opens only from a press (Settings → Setup, ?setup=helper)
  const macApp = hasThisMac();
  const bridge = useThisMac(macApp && !!me && asked === "helper"); // asked every 3 s: only while the Help screen is up
  // read only in the Mac app (the screen is about this computer): a browser never loads it for this
  const { data: providers } = useCachedLoad<ProvidersView>(macApp ? "/api/providers" : null, getProviders, { topic: ["providers", "devices"], own: true });
  const self = bridge?.device ?? document.documentElement.dataset.macDevice ?? null;
  const others = (providers?.devices ?? []).filter((d) => d.owner === me?.username && d.id !== self).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
  // by itself only on a first sign-in (setupOpensItself); Settings → Setup and ?setup= always open it; never on a phone
  const firstRun = setupOpensItself({ logins: me?.logins, loaded, projects: projects.length });
  const open = real && !!prefs && setupOpen(view, asked, { firstRun, phone: isPhoneHub() });
  const step: SetupStep = setupStepFromParam(asked) ?? SETUP_PATH[0];
  useEffect(() => {
    useSetupShown.setState({ shown: open });
    // Home's welcome opens on the name in its own typeface: fetched now, so it is there when Done is pressed
    if (open) void document.fonts?.load('900 1em "Archivo Expanded"').catch(() => {});
    return () => useSetupShown.setState({ shown: false });
  }, [open]);

  useEffect(() => {
    if (real) void load();
  }, [real, load]);
  useEffect(() => {
    if (open && step === "folders" && library === undefined)
      // the owner's only, as on the Media Library page: its watch list answers no one else
      void listLibraries()
        .then(async (l) => (l[0] && (await getWatch(l[0].id)) ? l[0] : null))
        .then(setLibrary, () => setLibrary(null));
  }, [open, step, library]);
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
  useSetupLive(open);
  // the person's Creator Toolset account, asked of the Mac app only while setup is up; once a sign-in was offered the
  // screen stays the path's last one, so signing in on it does not take it away from under her
  const account = useMacAccount({ on: open, first: "offered" });
  const accountOffered = offersAccount(account);
  useEffect(() => {
    if (accountOffered) setAccountStep(true);
  }, [accountOffered]);
  // signing in on the account screen is the end of setup: no second screen to confirm it and no Done to press
  const finish = useRef(() => {});
  const signedIn = account.account.state === "signedIn";
  const wasSignedOut = useRef(false);
  useEffect(() => {
    if (signedIn && wasSignedOut.current && step === "account") finish.current();
    // "checking" is not signed out: someone already signed in who opens this screen keeps it
    wasSignedOut.current = !signedIn && account.account.state !== "checking";
  }, [signedIn, account.account.state, step]);
  // the AI panel connected one: read the setup again now, so Continue lights up without waiting for the next look
  const onConnected = useCallback((on: boolean) => void (on && load()), [load]);

  const savedNote = note ? (
    <p role="status" className="fixed bottom-4 left-1/2 z-50 [translate:-50%_0] rounded-full border border-border bg-popover px-4 py-2 text-xs text-popover-foreground shadow-lg motion-safe:animate-in motion-safe:fade-in">
      {SAVED_NOTE}
    </p>
  ) : null;

  if (!real || !view || !prefs) return null;
  if (!open) return savedNote;

  const mine = TOOLS.filter((t) => canUse(me, t));
  // every tool the account may use is on from the start (owner, 2026-11-26: no screen asks which); Settings → Tools
  // turns one off, and what someone set there before is kept
  const tools = view.tools ?? mine;
  const path = stepsFor(prefs.talk, accountStep, tools);
  const at = path.indexOf(step);
  const side = at < 0 || params.has("alone"); // `&alone=1` (openSetupAt): a path screen shown on its own
  const connected = view.have.includes("ai");
  const to = (s: SetupStep) => setParams((p) => (p.set("setup", s), p), { replace: true });
  const leave = () => setParams((p) => (p.delete("setup"), p.delete("alone"), p), { replace: true });

  /** Whether leaving setup now plays Home's welcome (lib/setup.ts introPlays). */
  const welcomes = () => introPlays({ finishedBefore: setupFinished(view), seen: introSeen(), phone: isPhoneHub(), still: stillMotion() });
  const close = () => {
    if (side) return leave();
    rememberLater(step);
    // Not now on Home gets the welcome too, in place of the note (its sound is started here, in the press)
    const plays = window.location.pathname === "/" && welcomes();
    if (plays) (primeIntroSound(), markIntroSeen());
    else setNote(true);
    dismissSetup();
    leave();
    startIntro(plays);
  };
  const goHome = (plays: boolean) => {
    dismissSetup();
    // Home plays its welcome first (once: not again after a Not now that showed it); the assistant says hello when it ends
    if (plays) markIntroSeen();
    startIntro(plays, connected ? openAssistant : undefined);
    navigate("/");
  };
  const back = () => to(path[at - 1]!);
  const next = async () => {
    // the welcome has sound, and a browser lets sound start only from a press: this one, before anything is awaited
    const plays = at === path.length - 1 && welcomes(); // asked before the save below finishes setup
    if (plays) primeIntroSound();
    setBusy(true);
    try {
      // the first workspace is made on the first press, not at the end: the social accounts that follow belong to it.
      // Made once: creating it reloads the list, so the next press finds it
      const name = loaded ? firstProjectName(projects.length) : null;
      if (name) await createProject({ name }).catch(() => {});
      if (at === path.length - 1) {
        // the last screen: this is the end of setup, and it never opens by itself again
        await save({ tools: toolsWithJob(tools, prefs.job, mine), done: true });
        return goHome(plays);
      }
      to(path[at + 1]!);
    } catch {
      // the last screen's save did not go through: it stays up and says so, instead of a Done that does nothing
      saveFailed("Could not save");
    } finally {
      setBusy(false);
    }
  };
  finish.current = () => void (at === path.length - 1 && next());
  const pickJob = (j: Job) => void useWorkPrefs.getState().put({ job: j });
  const closeLabel = "Close";
  const { hint } = STEP[step];
  // "What do you want to do first?" with nothing picked has Skip for now in place of Continue, as Connect your AI has
  const skips = !side && ((step === "agents" && !connected) || (step === "job" && !prefs.job) || (step === "social" && !view.have.includes("instagram")) || (at >= 0 && step === "account" && account.account.state !== "signedIn"));

  // "Where are your videos?" is never on the first run's path (lib/setup.ts stepsFor): opened alone (the assistant's
  // next steps, a link) it is the Media Library's own setup, in place of this window. Nothing while it loads; with
  // none to set up (not the owner) the window's own screen shows
  if (step === "folders" && library === undefined) return null;
  if (step === "folders" && library) return <LibrarySetup library={library} onDone={() => (void load(), leave())} onClose={leave} />;

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        showCloseButton={false}
        // a press outside (the Mac window's title bar, the page behind) never closes setup
        onInteractOutside={(e) => e.preventDefault()}
        onOpenAutoFocus={(e) => e.preventDefault()}
        {...(!hint && { "aria-describedby": undefined })}
        className={cn(
          // as tall as the screen allows (680px at most): the header and footer stay put and only the body scrolls,
          // so a small window shows a usable step rather than a thin strip
          // text-pretty: no word left alone on a line anywhere in setup (owner, 11-13: "I don't like the hanging words")
          "flex h-[min(680px,calc(100dvh-2rem))] w-[min(820px,calc(100vw-3rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl p-0 text-pretty shadow-2xl shadow-black/40 sm:max-w-none",
          "max-sm:h-dvh max-sm:w-screen max-sm:rounded-none max-sm:border-0 max-sm:pt-[env(safe-area-inset-top)]",
        )}
      >
        <header className="shrink-0 px-6 pt-5 sm:px-8">
          <div className="flex items-center gap-3">
            {/* a plain count that never changes, whatever was answered */}
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
          <DialogTitle className={cn("mt-4 text-2xl font-semibold tracking-tight", step === "account" && "sr-only")}>
            {step === "helper" && others[0] ? `Help ${others[0].name} with heavy work` : STEP[step].title}
          </DialogTitle>
          {hint && <DialogDescription className="mt-1.5 text-sm">{hint}</DialogDescription>}
        </header>

        <div
          key={step}
          className={cn(
            "min-h-0 flex-1 px-6 pb-5 pt-5 sm:px-8 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200",
            // the bar's 8px are always kept, out of the right padding: nothing moves when a screen starts to scroll
            "overflow-y-scroll bars:pr-4 sm:bars:pr-6",
          )}
        >
          {step === "theme" && (
            <div role="radiogroup" aria-label="Pick your look" className="grid gap-4 sm:grid-cols-3">
              {LOOK_CHOICES.map((o) => (
                <PictureCard key={o.id} on={theme.choice === o.id} onClick={() => theme.setChoice(o.id)} art={<LookArt look={o.id} />} name={o.name} />
              ))}
            </div>
          )}

          {step === "agents" && <AgentsStep picked={THIS_COMPUTER} onConnectedChange={onConnected} />}


          {step === "connect" && <ConnectStep picked={THIS_COMPUTER} onPick={() => {}} />}

          {step === "helper" && (self && providers?.devices.some((d) => d.id === self) ? <HelperSetup device={self} /> : macApp ? <HelperPair /> : (
            <p className="text-sm text-muted-foreground">Open this in the Creator Toolset app on the other computer, or add that computer in Settings → Computers.</p>
          ))}

          {step === "job" && (
            <JobStep mine={mine} job={prefs.job ?? null} onPick={pickJob} />
          )}

          {step === "social" && <SocialStep />}

          {step === "check" && <SetupChecklist tools={view.tools ?? tools} have={view.have} />}

          {step === "how" && <HowPicker value={prefs.talk} onChange={(t) => void setTalk(t)} />}

          {step === "account" && <AccountSetupView account={account.account} providers={account.providers} busy={account.busy} onSignIn={account.signIn} />}

          {/* its rows are put here by the one OwnAiStep below */}
          {step === "own" && <div ref={setOwnSlot} />}
        </div>
        {/* Outside the body above, which starts over on every step: mounted from the question before it, so this
            computer's AI apps are read while that question is answered and the screen opens with its rows. */}
        {(step === "how" || step === "own") && <OwnAiStep into={step === "own" ? ownSlot : null} />}

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-8">
          {/* a side screen only has Done */}
          {!side ? (
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={close}>
              Close
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {!side && at > 0 && (
              <Button variant="ghost" onClick={() => void back()}>
                Back
              </Button>
            )}
            {side && (
              <Button onClick={close} className={PRIMARY}>
                Done
              </Button>
            )}
            {skips && (
              <Button variant="ghost" className="text-muted-foreground" onClick={() => void next()}>
                Skip
              </Button>
            )}
            {!side && !skips && (
              <Button onClick={() => void next()} disabled={busy} className={PRIMARY}>
                {at === path.length - 1 ? "Done" : "Continue"}
              </Button>
            )}
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
