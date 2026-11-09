import { CornerNav } from "@/components/CornerNav";
import { Routes, Route, Navigate, useLocation, useNavigate, useParams, type Location } from "react-router";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import ToolsetHome from "./pages/ToolsetHome";
import Home from "./pages/Home";
import EnhancePage from "./pages/EnhancePage";
import CleanPage from "./pages/CleanPage";
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
import LibraryPage from "./pages/LibraryPage";
import FinalsPage from "./pages/FinalsPage";
import FinalsPiecePage from "./pages/FinalsPiece";
import ScreenRecorderPage from "./pages/ScreenRecorderPage";
import ScreenProjectPage from "./pages/ScreenProjectPage";
import LibrarySharePage from "./pages/LibrarySharePage";
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
import { canUse, useAuth, useMe } from "@/lib/auth";
import { initTabGuard } from "@/lib/tabs";
import { useStudio } from "@/lib/store";
import { getProjectPersistenceStatus } from "@/lib/persistence-status";
import { useRootTint, useWorkspace } from "@/lib/workspace";
import { warmScreens } from "@/lib/warm-cache";
import { useAppearance } from "@/lib/settings";
import { historyDepth } from "@/lib/history-depth";
import { setupOpen, useSetup, useWorkTalk } from "@/lib/setup";
import { replacementFor } from "@/lib/plugin";
import { webPlugins } from "./plugins.gen";

// pages from plug-ins (plugins/<id>/web.tsx), routed like the built-in pages above
const pluginRoutes = webPlugins.flatMap((p) => p.routes ?? []);
// a plug-in's replacement for the editor pages (replaces in web.tsx); the built-in pages when none does
const EditorScreen = replacementFor(webPlugins, "editor") ?? EditorPage;
const EditorEditScreen = replacementFor(webPlugins, "editorEdit") ?? EditorEditPage;
const LibraryScreen = replacementFor(webPlugins, "media") ?? LibraryPage;

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

/** Settings, a modal over the page behind it: every signed-in account. */
function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useMe();
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

function WorkspaceSync() {
  const me = useAuth((s) => s.me);
  const load = useWorkspace((s) => s.load);
  const reset = useWorkspace((s) => s.reset);
  useEffect(() => {
    if (!me) {
      reset();
      return;
    }
    void load();
  }, [me, load, reset]);
  return null;
}

/** After sign-in (and when the project changes): fills every screen's saved lists (lib/warm-cache) and loads the
 *  route code that is lazy, so the first click doesn't wait for a chunk. */
function WarmCaches() {
  const signedIn = useAuth((s) => s.me?.username ?? null);
  const project = useWorkspace((s) => s.currentProjectId);
  useEffect(() => {
    if (!signedIn) return;
    const t = window.setTimeout(() => {
      warmScreens();
      void import("./pages/SettingsPage");
      void import("./pages/CommunityPage");
      if (isPhoneHub()) {
        void import("./pages/mobile/MobileCaptionPage");
        void import("./pages/mobile/MobileInstagramPage");
        void import("./pages/mobile/MobileWorkshopPage");
      }
    }, 0);
    return () => window.clearTimeout(t);
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
  useRootTint(useAppearance().projectTint);
  // "just chat" (talk === "chat") has no dock, no selection popup and no welcome
  const { talk } = useWorkTalk();
  const location = useLocation();
  // the setup window up: no dock, no popup, no bubble behind it (the assistant comes in after Done)
  const setupUp = setupOpen(useSetup((s) => s.view), new URLSearchParams(location.search).get("setup"));
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
      <ViewAsBanner />
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
          <Route path="/clean" element={<AppRoute tool="clean"><CleanPage /></AppRoute>} />
          <Route path="/record" element={<RecordRoute />} />
          <Route path="/record/:id" element={<ScreenProjectPage />} />
          <Route path="/clips" element={<ClipsRoute />} />
          <Route path="/clips/:clipId" element={<ClipsRoute />} />
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
          <Route path="/finals" element={<AppRoute tool="media"><FinalsPage /></AppRoute>} />
          <Route path="/finals/:pieceId" element={<AppRoute tool="media"><FinalsPiecePage /></AppRoute>} />
          <Route path="/stories" element={<AppRoute tool="stories"><StorySplitterPage /></AppRoute>} />
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
      {!onMobile && !publicPage && talk !== "chat" && !setupUp && <AssistantDock />}
      {!onMobile && !publicPage && talk !== "chat" && !setupUp && <AskAboutSelection />}
      {!onMobile && !publicPage && <CornerNav />}
      {inSettings && <SettingsModal onClose={closeSettings} />}
      {inCommunity && <CommunityModal onClose={closeSettings} />}
      {inProjects && <ProjectsRoute onClose={closeSettings} />}
    </>
  );
}
