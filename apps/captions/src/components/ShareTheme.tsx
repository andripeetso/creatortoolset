import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { Moon, Sun } from "lucide-react";
import { isPublicLibraryPath, isPublicReviewPath, isPublicSharePath } from "@/components/AuthGate";
import { applyDocumentTheme, persistShareTheme, storedThemeChoice, systemShareTheme, type ShareTheme } from "@/lib/share-theme";
import { Switch } from "@/components/ui/switch";

/** What the owner picked: follow the system, or one of the two. */
export type ThemeChoice = "system" | ShareTheme;

type ShareThemeContextValue = {
  dark: boolean;
  choice: ThemeChoice;
  setDark: (dark: boolean) => void;
  setChoice: (choice: ThemeChoice) => void;
};

const ShareThemeContext = createContext<ShareThemeContextValue>({
  dark: true,
  choice: "system",
  setDark: () => {},
  setChoice: () => {},
});

const isChoiceDark = (c: ThemeChoice) => (c === "system" ? systemShareTheme() === "dark" : c === "dark");

/**
 * The theme (Settings → Appearance): every page takes the stored choice; nothing stored = dark in the app, the
 * system's on a public share page (caption, document, Review, Finals and Workshop links). index.html paints it first.
 */
export function ShareThemeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const share = isPublicSharePath(pathname) || isPublicReviewPath(pathname) || isPublicLibraryPath(pathname);
  const isDark = isChoiceDark;
  const [choice, setChoiceState] = useState<ThemeChoice>(() => storedThemeChoice(share));
  const [dark, setDarkState] = useState(() => isDark(storedThemeChoice(share)));

  // "system" follows the Mac's light/dark as it changes
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const c = storedThemeChoice(share);
      applyDocumentTheme(isDark(c));
      setChoiceState(c);
      setDarkState(isDark(c));
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [share]);

  const value = useMemo(() => {
    const apply = (next: ThemeChoice) => {
      persistShareTheme(next);
      const d = isChoiceDark(next);
      applyDocumentTheme(d);
      setChoiceState(next);
      setDarkState(d);
    };
    return { dark, choice, setDark: (on: boolean) => apply(on ? "dark" : "light"), setChoice: apply };
  }, [dark, choice]);

  return <ShareThemeContext.Provider value={value}>{children}</ShareThemeContext.Provider>;
}

export function useShareTheme() {
  return useContext(ShareThemeContext);
}

export function ShareThemeSwitch({ compact }: { compact?: boolean }) {
  const { dark, setDark } = useShareTheme();
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setDark(!dark)}
        aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Sun className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <Switch
        checked={dark}
        onCheckedChange={setDark}
        aria-label="Dark mode"
      />
      <Moon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
    </div>
  );
}
