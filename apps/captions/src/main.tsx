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

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
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
