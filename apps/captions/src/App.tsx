// first, so its ⌘Z listener is ahead of every page's own (lib/undo.ts)
import "@/lib/undo";
import { CornerNav } from "@/components/CornerNav";
import { Routes, Route, Navigate, useLocation, useNavigate, useParams, type Location } from "react-router";
import { useTelemetry } from "@/lib/telemetry";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import ToolsetHome from "./pages/ToolsetHome";
import Home from "./pages/Home";
import EnhancePage from "./pages/EnhancePage";
import ClipsPage from "./pages/ClipsPage";
import DocumentsPage from "./pages/DocumentsPage";
import InstagramPage from "./pages/InstagramPage";
import InstagramAccountPage from "./pages/InstagramAccountPage";
import InstagramAnalysisPage from "./pages/InstagramAnalysisPage";
import WorkshopPage from "./pages/WorkshopPage";
import WorkshopSessionPage from "./pages/WorkshopSessionPage";
import ProjectsPage from "./pages/ProjectsPage";
import ReviewPage from "./pages/ReviewPage";
import ReviewAssetPage from "./pages/ReviewAssetPage";
import ReviewSharedProjectPage from "./pages/ReviewSharedProjectPage";
import WorkshopSharePage from "./pages/WorkshopSharePage";
import StorySplitterPage from "./pages/StorySplitterPage";
import DesignPage from "./pages/DesignPage";
import DesignsPage from "./pages/DesignsPage";
import LibraryPage from "./pages/LibraryPage";
import FinalsPage from "./pages/FinalsPage";
import FinalsPiecePage from "./pages/FinalsPiece";
import ScreenRecorderPage from "./pages/ScreenRecorderPage";
import ScreenProjectPage from "./pages/ScreenProjectPage";
import LibrarySharePage from "./pages/LibrarySharePage";
import SharedFolderPage from "./pages/SharedFolderPage";
import EditorPage from "./pages/EditorPage";
import EditorEditPage from "./pages/EditorEditPage";
import type { Tool } from "@contracts/tools";
import { isPublicLibraryPath, isPublicReviewPath, isPublicSharePath } from "@/components/AuthGate";
import { analyzerHome } from "@/lib/instagram";
import { isPhoneHub } from "@/lib/mobile";
import { ExportTray } from "@/components/ExportTray";
import { SetupDialog } from "@/components/SetupDialog";
import { FirstOpen } from "@/components/setup/FirstOpen";
import { AssistantDock } from "@/components/assistant/AssistantDock";
import { AskAboutSelection } from "@/components/assistant/AskAboutSelection";
import { AppDialogs } from "@/components/AppDialogs";
import { ViewAsBanner } from "@/components/ViewAsBanner";
import { MacAppUpdateBanner } from "@/components/MacAppUpdateBanner";
import { Toaster } from "@/components/ui/sonner";
import { useShareTheme } from "@/components/ShareTheme";
import { canUse, useAuth, useMe } from "@/lib/auth";
import { initTabGuard } from "@/lib/tabs";
import { useStudio } from "@/lib/store";
import { getProjectPersistenceStatus } from "@/lib/persistence-status";
import { applyWorkspace, fetchWorkspace, useRootTint, useWorkspace, WORKSPACE_KEY, type Workspace } from "@/lib/workspace";
import { useCachedLoad } from "@/lib/local-cache";
import { warmScreens } from "@/lib/warm-cache";
import { useAppearance } from "@/lib/settings";
import { historyDepth } from "@/lib/history-depth";
import { SETTINGS_CLOSED, endIntro, useIntro, useSetupShown, useSetupSync } from "@/lib/setup";
import { replacementFor } from "@/lib/plugin";
import { webPlugins } from "./plugins.gen";

// Read when the app is first drawn, not when this file loads: the plug-ins switched on in the Mac app join the list
// just before that (lib/folder-plugins.tsx). Made once, so each screen keeps one identity between renders.
function pluginScreens() {
  return {
    // pages from plug-ins (plugins/<id>/web.tsx), routed like the built-in pages above
    pluginRoutes: webPlugins.flatMap((p) => p.routes ?? []),
    // a plug-in's replacement for the editor pages (replaces in web.tsx); the built-in pages when none does
    EditorScreen: replacementFor(webPlugins, "editor") ?? EditorPage,
    EditorEditScreen: replacementFor(webPlugins, "editorEdit") ?? EditorEditPage,
    LibraryScreen: replacementFor(webPlugins, "media") ?? LibraryPage,
    FinalsScreen: replacementFor(webPlugins, "finals") ?? FinalsPage,
  };
}
let screens: ReturnType<typeof pluginScreens> | undefined;

const MobileCaptionPage = lazy(
  () => import("./pages/mobile/MobileCaptionPage"),
);
const MobileInstagramPage = lazy(
  () => import("./pages/mobile/MobileInstagramPage"),
);
const MobileWorkshopPage = lazy(
  () => import("./pages/mobile/MobileWorkshopPage"),
);
const MobileWorkshopSessionPage = lazy(() =>
  import("./pages/mobile/MobileWorkshopPage").then((m) => ({
    default: m.MobileWorkshopSessionPage,
  })),
);
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const CommunityPage = lazy(() => import("./pages/CommunityPage"));

function PhoneTool({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="h-dvh bg-zinc-950" />}>{children}</Suspense>
  );
}

/** An app that can be switched off for an account (users.json `off`). */
function AppRoute({ tool, children }: { tool: Tool; children: ReactNode }) {
  const me = useMe();
  return canUse(me, tool) ? children : <Navigate to="/" replace />;
}

function RecordRoute() {
  const me = useMe();
  return canUse(me, "review") || canUse(me, "notes") ? <ScreenRecorderPage /> : <Navigate to="/" replace />;
}

function ClipsRoute() {
  const { clipId } = useParams();
  const me = useMe();
  if (clipId) return <ClipsPage />;
  return canUse(me, "notes") ? <ClipsPage /> : <Navigate to="/" replace />;
}

function DocumentsRoute() {
  const { docId } = useParams();
  const me = useMe();
  if (docId && docId !== "new") return <DocumentsPage />;
  return canUse(me, "guides") ? <DocumentsPage /> : <Navigate to="/" replace />;
}

function InstagramRoute() {
  const me = useMe();
  if (!canUse(me, "instagram")) return <Navigate to="/" replace />;
  return isPhoneHub() ? (
    <PhoneTool>
      <MobileInstagramPage />
    </PhoneTool>
  ) : (
    <InstagramPage />
  );
}

function InstagramAccountRoute() {
  const me = useMe();
  if (!canUse(me, "instagram")) return <Navigate to="/" replace />;
  if (isPhoneHub()) return <Navigate to={analyzerHome()} replace />;
  return <InstagramAccountPage />;
}

function WorkshopRoute() {
  const me = useMe();
  if (!canUse(me, "workshop")) return <Navigate to="/" replace />;
  return isPhoneHub() ? (
    <PhoneTool>
      <MobileWorkshopPage />
    </PhoneTool>
  ) : (
    <WorkshopPage />
  );
}

function WorkshopSessionRoute() {
  const me = useMe();
  const { sessionId } = useParams();
  if (!canUse(me, "workshop")) return <Navigate to="/" replace />;
  return isPhoneHub() ? (
    <PhoneTool>
      <MobileWorkshopSessionPage />
    </PhoneTool>
  ) : (
    // keyed by session: a link to another session in the page must not keep this one's pinned, quotes or toggles
    <WorkshopSessionPage key={sessionId} />
  );
}

function ProjectsRoute({ onClose }: { onClose: () => void }) {
  const me = useMe();
  if ((!canUse(me, "instagram") && !canUse(me, "workshop"))) {
    return <Navigate to="/" replace />;
  }
  return <ProjectsPage onClose={onClose} />;
}

/** The toasts (a failed save in Settings, and the rest), in the app's own theme rather than the device's. */
function AppToaster() {
  const { dark } = useShareTheme();
  return <Toaster theme={dark ? "dark" : "light"} />;
}

/** Settings, a modal over the page behind it: every signed-in account. */
function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useMe();
  // closing (however it closes) tells the page behind it that Settings may have changed its AI, keys or tools
  useEffect(() => () => void window.dispatchEvent(new Event(SETTINGS_CLOSED)), []);
  if (!me) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={null}>
      <SettingsPage onClose={onClose} />
    </Suspense>
  );
}

/** Community, a modal over the page behind it: every signed-in account. */
function CommunityModal({ onClose }: { onClose: () => void }) {
  const me = useMe();
  if (!me) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={null}>
      <CommunityPage onClose={onClose} />
    </Suspense>
  );
}

/** ⌘, opens Settings (the account menu shows it). */
function SettingsShortcut() {
  const navigate = useNavigate();
  const me = useMe();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ",") return;
      if (!me) return;
      e.preventDefault();
      navigate("/settings");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [me, navigate]);
  return null;
}

/** The projects and the setup, from their saved copies and live while signed in (lib/workspace.ts, lib/setup.ts). */
function WorkspaceSync() {
  const user = useAuth((s) => s.me?.username ?? null);
  const { data } = useCachedLoad<Workspace>(user ? WORKSPACE_KEY : null, fetchWorkspace);
  useEffect(() => {
    if (!user) useWorkspace.getState().reset();
  }, [user]);
  useEffect(() => applyWorkspace(data), [data]);
  useSetupSync();
  return null;
}

/** After sign-in (and when the project changes): fills every screen's saved lists (lib/warm-cache), then, when the
 *  browser is idle, loads the route code that is lazy so no tool waits for its chunk. */
function WarmCaches() {
  const signedIn = useAuth((s) => s.me?.username ?? null);
  const project = useWorkspace((s) => s.currentProjectId);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const fill = window.setTimeout(() => live && void warmScreens(), 0);
    // the route code in idle time: requestIdleCallback where the browser has it (a web view may not), else a timer
    const idle = (fn: () => void) =>
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(fn, { timeout: 2000 })
        : window.setTimeout(fn, 0);
    idle(() => {
      if (!live) return;
      void import("./pages/SettingsPage");
      void import("./pages/CommunityPage");
      if (isPhoneHub()) {
        void import("./pages/mobile/MobileCaptionPage");
        void import("./pages/mobile/MobileInstagramPage");
        void import("./pages/mobile/MobileWorkshopPage");
      }
    });
    return () => {
      live = false;
      window.clearTimeout(fill);
    };
  }, [signedIn, project]);
  return null;
}

function InstagramAnalyzeRoute() {
  const me = useMe();
  if (!canUse(me, "instagram")) return <Navigate to="/" replace />;
  if (isPhoneHub()) return <Navigate to={analyzerHome()} replace />;
  return <InstagramAnalysisPage />;
}

export default function App() {
  const { pluginRoutes, EditorScreen, EditorEditScreen, LibraryScreen, FinalsScreen } = (screens ??= pluginScreens());
  const look = useAppearance();
  useRootTint(look.projectTint, look.ownColour);
  const location = useLocation();
  useTelemetry(location.pathname);
  // the setup window on screen: no dock, no popup, no bubble behind it. Not "setup unfinished": an account that never
  // pressed Done but has projects gets no setup window, and lost its assistant with the old check
  const setupUp = useSetupShown((s) => s.shown);
  // Home's welcome animation: the dock and the popup wait for it, and leaving Home (or opening Settings over it) ends it
  const introOn = useIntro((s) => s.on);
  useEffect(() => {
    if (location.pathname !== "/") endIntro();
  }, [location.pathname]);
  const navigate = useNavigate();
  // /settings/*, /community/* and /projects are modals: the page you were on stays mounted behind (home when opened directly)
  const inSettings = /^\/settings(?:\/|$)/.test(location.pathname);
  const inCommunity = /^\/community(?:\/|$)/.test(location.pathname);
  const inProjects = location.pathname === "/projects";
  const behind = useRef<Location | null>(null);
  const behindIdx = useRef<number | null>(null); // react-router's history index of the page behind
  if (inSettings || inProjects || inCommunity) historyDepth.modal.add(window.history.state?.idx ?? 0);
  else {
    historyDepth.modal.delete(window.history.state?.idx ?? 0);
    behind.current = location;
    behindIdx.current = window.history.state?.idx ?? null;
  }
  const page = inSettings || inProjects || inCommunity ? (behind.current ?? { ...location, pathname: "/", search: "", hash: "" }) : location;
  // closing steps back to the page behind, so Back never reopens the modal; opened straight from a URL there is
  // nothing behind it, so it is replaced by that page (or home)
  const closeSettings = () => {
    const steps = behindIdx.current === null ? 0 : behindIdx.current - (window.history.state?.idx ?? 0);
    if (behind.current && steps < 0) {
      navigate(steps);
    } else {
      navigate(behind.current ? behind.current.pathname + behind.current.search + behind.current.hash : "/", { replace: true });
    }
  };
  const onMobile = location.pathname.startsWith("/m");
  const publicPage =
    isPublicSharePath(location.pathname) || isPublicReviewPath(location.pathname) || isPublicLibraryPath(location.pathname);

  useEffect(() => {
    initTabGuard(() => useStudio.getState().setTabConflict(true));
  }, []);

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      const state = useStudio.getState();
      const status = getProjectPersistenceStatus({
        projectId: state.projectId,
        serverProjectReady: state.serverProjectReady,
        saveState: state.saveState,
        localSaveState: state.localSaveState,
        clips: state.clips,
      });
      if (status.workSafe) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, []);

  return (
    <>
      <WorkspaceSync />
      <WarmCaches />
      <SettingsShortcut />
      <AppDialogs />
      <AppToaster />
      <ViewAsBanner />
      <MacAppUpdateBanner />
      <main className="contents">
        <Routes location={page}>
          <Route path="/" element={<ToolsetHome />} />
          <Route path="/captions" element={<AppRoute tool="captions"><Home /></AppRoute>} />
          <Route path="/m" element={<ToolsetHome />} />
          <Route
            path="/m/captions"
            element={
              <AppRoute tool="captions">
                <Suspense fallback={<div className="h-dvh bg-zinc-950" />}>
                  <MobileCaptionPage />
                </Suspense>
              </AppRoute>
            }
          />
          <Route path="/enhance" element={<AppRoute tool="enhance"><EnhancePage /></AppRoute>} />
          <Route path="/enhance/:sessionId" element={<AppRoute tool="enhance"><EnhancePage /></AppRoute>} />
          <Route path="/record" element={<RecordRoute />} />
          <Route path="/record/:id" element={<ScreenProjectPage />} />
          <Route path="/clips" element={<ClipsRoute />} />
          <Route path="/clips/:clipId" element={<ClipsRoute />} />
          <Route path="/clips/f/:token" element={<SharedFolderPage />} />
          <Route path="/documents" element={<DocumentsRoute />} />
          <Route path="/documents/:docId" element={<DocumentsRoute />} />
          <Route path="/video-notes" element={<ClipsRoute />} />
          <Route path="/video-notes/:clipId" element={<ClipsRoute />} />
          <Route path="/guides" element={<DocumentsRoute />} />
          <Route path="/guides/:docId" element={<DocumentsRoute />} />
          <Route path="/instagram" element={<InstagramRoute />} />
          <Route path="/instagram/analyze" element={<InstagramAnalyzeRoute />} />
          <Route path="/instagram/accounts/:accountId" element={<InstagramAccountRoute />} />
          <Route path="/instagram/:postId" element={<InstagramRoute />} />
          <Route path="/analyzer" element={<InstagramRoute />} />
          <Route path="/analyzer/analyze" element={<InstagramAnalyzeRoute />} />
          <Route path="/analyzer/accounts/:accountId" element={<InstagramAccountRoute />} />
          <Route path="/analyzer/:postId" element={<InstagramRoute />} />
          <Route path="/workshop" element={<WorkshopRoute />} />
          <Route path="/workshop/sessions/:sessionId" element={<WorkshopSessionRoute />} />
          <Route path="/review" element={<AppRoute tool="review"><ReviewPage /></AppRoute>} />
          <Route path="/review/:assetId" element={<AppRoute tool="review"><ReviewAssetPage /></AppRoute>} />
          <Route path="/r/:token" element={<ReviewAssetPage />} />
          <Route path="/rp/:ptoken" element={<ReviewSharedProjectPage />} />
          <Route path="/ws/:token" element={<WorkshopSharePage />} />
          <Route path="/library/s/:token" element={<LibrarySharePage />} />
          <Route path="/library" element={<AppRoute tool="media"><LibraryScreen /></AppRoute>} />
          <Route path="/finals" element={<AppRoute tool="media"><FinalsScreen /></AppRoute>} />
          <Route path="/finals/:pieceId" element={<AppRoute tool="media"><FinalsPiecePage /></AppRoute>} />
          <Route path="/stories" element={<AppRoute tool="stories"><StorySplitterPage /></AppRoute>} />
          {/* a design belongs to the piece or the video it was made from: opened from there, with no tile of its own */}
          <Route path="/design" element={<AppRoute tool="design"><DesignsPage /></AppRoute>} />
          <Route path="/design/:id" element={<AppRoute tool="design"><DesignPage /></AppRoute>} />
          <Route path="/editor" element={<AppRoute tool="editor"><EditorScreen /></AppRoute>} />
          <Route path="/editor/:id" element={<AppRoute tool="editor"><EditorEditScreen /></AppRoute>} />
          <Route path="/rp/:ptoken/:assetId" element={<ReviewAssetPage />} />
          {pluginRoutes.map((r) => <Route key={r.path} path={r.path} element={r.element} />)}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {/* phones have their own export screens; the tray's memory of dismissed
          cards is per browser, so a new one (the iPhone app) got every old export */}
      {!onMobile && !publicPage && !isPhoneHub() && <ExportTray />}
      {!publicPage && !inSettings && !inCommunity && <SetupDialog />}
      {!publicPage && !inSettings && !inCommunity && <FirstOpen />}
      {/* the assistant is there in every way of working (owner, 2026-11-10: "it shouldn't be gone"); talk only says
          whether the person's own AI also gets Creator Toolset */}
      {!onMobile && !publicPage && !setupUp && !introOn && <AssistantDock />}
      {!onMobile && !publicPage && !setupUp && !introOn && <AskAboutSelection />}
      {!onMobile && !publicPage && <CornerNav />}
      {inSettings && <SettingsModal onClose={closeSettings} />}
      {inCommunity && <CommunityModal onClose={closeSettings} />}
      {inProjects && <ProjectsRoute onClose={closeSettings} />}
    </>
  );
}
