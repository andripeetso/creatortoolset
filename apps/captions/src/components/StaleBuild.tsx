import { Component, type ReactNode } from "react";
import { entryOf } from "./NewVersionPill";

/**
 * A deploy replaces the app's code files. A window opened before it still holds the old list of them, so the first
 * time it needs one it has not loaded yet (a tool opened for the first time) the server answers "not found", and
 * without this the page went blank. Here, when the screen someone just opened cannot load its code AND the server is
 * on a different build than this window, the window reloads onto that build, at the address they were going to.
 * A reload is only ever the answer to their own click, never done in the background (nothing typed is lost that way).
 * If the build is the same (the network dropped, say) or something else broke a render, a plain screen with a Reload
 * button shows, never a blank page.
 */

/** How a browser words "that code file did not load" (Chrome, WebKit, Firefox, and the bundler's own for a stylesheet). */
export const isMissingCode = (e: unknown): boolean =>
  /dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(e instanceof Error ? e.message : String(e));

/** True when the server now serves a different build than this window loaded; false when that cannot be read. */
async function buildChanged(): Promise<boolean> {
  try {
    const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src.split("/").pop();
    const res = await fetch("/", { cache: "no-store" });
    const live = res.ok ? entryOf(await res.text()) : null;
    return !!live && !!mine && live !== mine;
  } catch {
    return false;
  }
}

const KEY = "ct-reloaded-for-build";
/** Reloads onto the new build when there is one. Once: a second failure within 20 s is not answered with another reload. */
export async function reloadIfNewBuild(now = Date.now()): Promise<boolean> {
  try {
    if (now - Number(sessionStorage.getItem(KEY) ?? 0) < 20_000) return false;
    if (!(await buildChanged())) return false;
    sessionStorage.setItem(KEY, String(now));
  } catch {
    return false; // no storage to remember the reload in: no reload, the screen below shows
  }
  window.location.reload();
  return true;
}

type State = { broken: false | "checking" | true };

/** Around the whole app: see the note at the top of this file. */
export class RootBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { broken: false };
  static getDerivedStateFromError(error: unknown): State {
    return { broken: isMissingCode(error) ? "checking" : true };
  }
  componentDidCatch(error: unknown) {
    if (!isMissingCode(error)) return console.error(error);
    void reloadIfNewBuild().then((reloading) => !reloading && this.setState({ broken: true }));
  }
  render() {
    if (!this.state.broken) return this.props.children;
    // while the build is being checked (a moment), nothing: either the reload follows or the screen below does
    if (this.state.broken === "checking") return <div className="h-dvh bg-zinc-950" />;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-zinc-950 text-sm text-zinc-300">
        <p>This screen stopped working.</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg bg-violet-600 px-4 py-2 font-medium text-white hover:bg-violet-500"
        >
          Reload
        </button>
      </div>
    );
  }
}
