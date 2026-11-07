import type { ReactNode } from "react";
import { Download, Monitor, Server } from "lucide-react";
import { ToolsetLogo } from "@/components/HomeLink";
import { GuideArticle } from "@/components/GuideArticle";
import { useMacRelease } from "@/components/MacAppDownload";
import guide from "../../../../SELF_HOSTING.md?raw";

/**
 * Download page, public (no account needed): the Mac app this server serves (api/mac-app.ts), and the guide to run
 * a server of your own (SELF_HOSTING.md at the repository root, rendered here).
 */
export default function DownloadPage() {
  const release = useMacRelease();
  const inMacApp = document.documentElement.classList.contains("mac-app");
  return (
    <div className="min-h-dvh bg-[#0b0b10] text-zinc-200">
      <header className="mx-auto flex max-w-4xl items-center gap-3 px-4 pt-8">
        <ToolsetLogo className="h-8 w-8" />
        <h1 className="text-lg font-semibold tracking-tight">Creator Toolset</h1>
      </header>
      <main className="mx-auto max-w-4xl px-4 pb-16 pt-8">
        <div className="grid gap-4 md:grid-cols-2">
          <Card icon={<Monitor className="h-4 w-4" />} title="Mac" meta="macOS 14 or later · Apple silicon">
            {inMacApp ? (
              <p className="text-sm text-zinc-400">You're in the Mac app. It updates itself.</p>
            ) : release ? (
              <>
                <a
                  href="/api/mac-app/download"
                  className="inline-flex items-center justify-center gap-1.5 rounded-md bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500"
                >
                  <Download className="h-4 w-4" /> Download for Mac ({release.version})
                </a>
                <p className="text-xs text-zinc-500">
                  It runs the whole app and its server on your Mac, with your AI from your own Claude Code or Codex. It
                  updates itself.
                </p>
              </>
            ) : (
              <p className="text-sm text-zinc-400">
                This server has no Mac app build yet. Build it from source with{" "}
                <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[.9em] text-zinc-200">pnpm build:mac</code>.
              </p>
            )}
          </Card>
          <Card icon={<Server className="h-4 w-4" />} title="Your own server" meta="Linux, Docker, your domain">
            <a
              href="#self-hosting"
              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-zinc-700 px-3.5 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
            >
              Read the self-hosting guide
            </a>
            <p className="text-xs text-zinc-500">For you and your team: the app in Docker, HTTPS, your accounts and your data.</p>
          </Card>
        </div>
        <details id="self-hosting" className="mt-10 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <summary className="cursor-pointer font-medium text-zinc-100">Self-hosting Creator Toolset</summary>
          <GuideArticle source={guide} idPrefix="self-hosting-" />
        </details>
      </main>
    </div>
  );
}

function Card({ icon, title, meta, children }: { icon: ReactNode; title: string; meta: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex items-center gap-2">
        <span className="text-violet-300">{icon}</span>
        <h2 className="font-medium text-zinc-100">{title}</h2>
      </div>
      <p className="mt-1 text-xs text-zinc-500">{meta}</p>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}
