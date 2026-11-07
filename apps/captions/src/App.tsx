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
import LibrarySharePage from "./pages/LibrarySharePage";
import EditorPage from "./pages/EditorPage";
import EditorEditPage from "./pages/EditorEditPage";
import type { Tool } from "@contracts/tools";
import { isPublicDownloadPath, isPublicLibraryPath, isPublicReviewPath, isPublicSharePath } from "@/components/AuthGate";
import { analyzerHome } from "@/lib/instagram";
import { isPhoneHub } from "@/lib/mobile";
import { ExportTray } from "@/components/ExportTray";
import { GuestWelcomeDialog } from "@/components/GuestWelcomeDialog";
import { SetupDialog } from "@/components/SetupDialog";
import { FirstOpen } from "@/components/setup/FirstOpen";
import LegalPage from "@/pages/LegalPage";
import { DemoBanner, ViewAsBanner } from "@/components/ViewAsBanner";
import { AppDialogs } from "@/components/AppDialogs";
import {
  canUse,
  isDemo,
  isGuest,
  useAuth,
  useViewedMe,
} from "@/lib/auth";
import { initTabGuard } from "@/lib/tabs";
import { useStudio } from "@/lib/store";
import { getProjectPersistenceStatus } from "@/lib/persistence-status";
import { useWorkspace } from "@/lib/workspace";

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
const DownloadPage = lazy(() => import("./pages/DownloadPage"));

function PhoneTool({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="h-dvh bg-[#0b0b10]" />}>{children}</Suspense>
  );
}

/** An app an admin can switch off for an account (Admin → Users). */
function AppRoute({ tool, children }: { tool: Tool; children: ReactNode }) {
  const me = useViewedMe();
  return canUse(me, tool) ? children : <Navigate to="/" replace />;
}

function ClipsRoute() {
  const { clipId } = useParams();
  const me = useViewedMe();
  if (clipId) return <ClipsPage />;
  return canUse(me, "notes") ? <ClipsPage /> : <Navigate to="/" replace />;
}

function DocumentsRoute() {
  const { docId } = useParams();
  const me = useViewedMe();
  if (docId && docId !== "new") return <DocumentsPage />;
  return canUse(me, "guides") ? <DocumentsPage /> : <Navigate to="/" replace />;
}

function InstagramRoute() {
  const me = useViewedMe();
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
  const me = useViewedMe();
  if (!canUse(me, "instagram")) return <Navigate to="/" replace />;
  if (isPhoneHub()) return <Navigate to={analyzerHome()} replace />;
  return <InstagramAccountPage />;
}

function WorkshopRoute() {
  const me = useViewedMe();
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
  const me = useViewedMe();
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
  const me = useViewedMe();
  if (isGuest(me) || (!canUse(me, "instagram") && !canUse(me, "workshop"))) {
    return <Navigate to="/" replace />;
  }
  return <ProjectsPage onClose={onClose} />;
}

/** Settings, a modal over the page behind it: every signed-in account except guests and the demo visitors. */
function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useViewedMe();
  if (!me || isGuest(me) || isDemo(me)) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={null}>
      <SettingsPage onClose={onClose} />
    </Suspense>
  );
}

/** ⌘, opens Settings (the account menu shows it). */
function SettingsShortcut() {
  const navigate = useNavigate();
  const me = useViewedMe();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== ",") return;
      if (!me || isGuest(me) || isDemo(me)) return;
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
    if (!me || me.role === "guest") {
      reset();
      return;
    }
    void load();
  }, [me, load, reset]);
  return null;
}

function InstagramAnalyzeRoute() {
  const me = useViewedMe();
  if (!canUse(me, "instagram")) return <Navigate to="/" replace />;
  if (isPhoneHub()) return <Navigate to={analyzerHome()} replace />;
  return <InstagramAnalysisPage />;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  // /settings/* and /projects are modals: the page you were on stays mounted behind (home when opened directly)
  const inSettings = /^\/settings(?:\/|$)/.test(location.pathname);
  const inProjects = location.pathname === "/projects";
  const behind = useRef<Location | null>(null);
  if (!inSettings && !inProjects) behind.current = location;
  const page = inSettings || inProjects ? (behind.current ?? { ...location, pathname: "/", search: "", hash: "" }) : location;
  const closeSettings = () => navigate(behind.current ? behind.current.pathname + behind.current.search + behind.current.hash : "/");
  const onMobile = location.pathname.startsWith("/m");
  const publicPage =
    isPublicSharePath(location.pathname) || isPublicReviewPath(location.pathname) || isPublicLibraryPath(location.pathname) ||
    isPublicDownloadPath(location.pathname);
  // a role preview: a banner on top, the page scrolls below it; the demo: a
  // frame round it, the page inside
  const viewAs = useAuth((state) => !!state.viewAs);
  const demo = useAuth((state) => isDemo(state.me));
  const framed = viewAs || demo;

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
        guest: isGuest(useAuth.getState().me),
      });
      if (status.workSafe) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, []);

  return (
    <div className={framed ? `flex h-dvh flex-col${demo ? " p-1.5" : ""}` : "contents"}>
      <WorkspaceSync />
      <SettingsShortcut />
      <ViewAsBanner />
      <DemoBanner />
      <AppDialogs />
      <main
        className={
          framed ? "view-as-viewport min-h-0 flex-1 overflow-auto" : "contents"
        }
      >
        <Routes location={page}>
          <Route path="/" element={<ToolsetHome />} />
          <Route path="/captions" element={<AppRoute tool="captions"><Home /></AppRoute>} />
          <Route path="/m" element={<ToolsetHome />} />
          <Route
            path="/m/captions"
            element={
              <AppRoute tool="captions">
                <Suspense fallback={<div className="h-dvh bg-[#0b0b10]" />}>
                  <MobileCaptionPage />
                </Suspense>
              </AppRoute>
            }
          />
          <Route path="/enhance" element={<AppRoute tool="enhance"><EnhancePage /></AppRoute>} />
          <Route path="/enhance/:sessionId" element={<AppRoute tool="enhance"><EnhancePage /></AppRoute>} />
          <Route path="/clean" element={<AppRoute tool="clean"><CleanPage /></AppRoute>} />
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
          <Route path="/download" element={<Suspense fallback={<div className="h-dvh bg-[#0b0b10]" />}><DownloadPage /></Suspense>} />
          <Route path="/privacy" element={<LegalPage page="/privacy" />} />
          <Route path="/terms" element={<LegalPage page="/terms" />} />
          <Route path="/data-deletion" element={<LegalPage page="/data-deletion" />} />
          <Route path="/library" element={<AppRoute tool="media"><LibraryPage /></AppRoute>} />
          <Route path="/stories" element={<AppRoute tool="stories"><StorySplitterPage /></AppRoute>} />
          <Route path="/editor" element={<AppRoute tool="editor"><EditorPage /></AppRoute>} />
          <Route path="/editor/:id" element={<AppRoute tool="editor"><EditorEditPage /></AppRoute>} />
          <Route path="/rp/:ptoken/:assetId" element={<ReviewAssetPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      {/* phones have their own export screens; the tray's memory of dismissed
          cards is per browser, so a new one (the iPhone app) got every old export */}
      {!onMobile && !publicPage && !isPhoneHub() && <ExportTray />}
      {!onMobile && !publicPage && <GuestWelcomeDialog />}
      {!publicPage && !inSettings && <SetupDialog />}
      {!publicPage && !inSettings && <FirstOpen />}
      {!onMobile && !publicPage && <CornerNav />}
      {inSettings && <SettingsModal onClose={closeSettings} />}
      {inProjects && <ProjectsRoute onClose={closeSettings} />}
    </div>
  );
}
