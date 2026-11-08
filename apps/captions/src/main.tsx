import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import { TRPCProvider } from "@/providers/trpc";
import { initPersistence } from "@/lib/persist";
import { initLocalRecovery } from "@/lib/local-recovery";
import { AuthGate } from "@/components/AuthGate";
import { ShareThemeProvider } from "@/components/ShareTheme";
import App from "./App.tsx";

// ⌘S / Ctrl+S never opens the browser's "Save page" dialog: everything autosaves,
// and pages that keep pending edits (Content Workshop) flush them on the same keys.
window.addEventListener(
  "keydown",
  (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") e.preventDefault();
  },
  true,
);

async function bootstrap() {
  initPersistence();
  await initLocalRecovery();

  // not an installable web app: drop a service worker and caches a browser still has from an older version
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => void r.unregister()));
    if ("caches" in window) void caches.keys().then((keys) => keys.forEach((k) => void caches.delete(k)));
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <BrowserRouter>
        <TRPCProvider>
          <ShareThemeProvider>
            <AuthGate>
              <App />
            </AuthGate>
          </ShareThemeProvider>
        </TRPCProvider>
      </BrowserRouter>
    </StrictMode>,
  );
}

void bootstrap();
